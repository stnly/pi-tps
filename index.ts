/**
 * Token Performance Extension
 *
 * Displays model performance stats in the pi status line:
 * - TTFT: Time to First Token (request → first output token, including thinking)
 * - TPS:  Tokens Per Second (output throughput using actual provider token counts)
 *
 * Updates status on message_end with chunk stats, switches to session
 * medians on agent_end. TPS is only shown when streaming time >= 500ms.
 *
 * Tracking hierarchy:
 * - Chunk: each assistant message (message_start → message_end)
 * - Exchange: each user prompt (agent_start → agent_end), containing 1+ chunks
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// --- Inline event types (not re-exported from the main barrel) ---

interface AssistantMessageUpdate {
  type: string;
  delta?: string;
}

interface MessageUpdateEvent {
  type: "message_update";
  message: { role: string; usage: { output?: number } };
  assistantMessageEvent: AssistantMessageUpdate;
}

interface MessageEndEvent {
  type: "message_end";
  message: {
    role: string;
    content?: Array<{ type: string; text?: string; input?: unknown }>;
    usage?: { output?: number };
  };
}

// The main barrel omits message_start/update/end overloads from ExtensionAPI,
// but pi loads .ts directly so these work at runtime. Cast to bypass the type gap.
type FullExtensionAPI = ExtensionAPI & {
  on(event: "message_start", handler: (event: { type: "message_start"; message: { role: string; usage: { output?: number } } }, ctx: ExtensionContext) => void): void;
  on(event: "message_update", handler: (event: MessageUpdateEvent, ctx: ExtensionContext) => void): void;
  on(event: "message_end", handler: (event: MessageEndEvent, ctx: ExtensionContext) => void): void;
  on(event: "agent_start", handler: (event: any, ctx: ExtensionContext) => void): void;
  on(event: "agent_end", handler: (event: any, ctx: ExtensionContext) => void): void;
};

// --- Internal types ---

interface ExchangeRecord {
  startTime: number;
  endTime: number | null;
  totalActualTokens: number;
  ttftMs: number | null;
  streamingMs: number;
  tps: number;
}

// --- Constants ---

const STATUS_KEY = "perf";
const MAX_HISTORY = 50;
const MIN_STREAMING_MS = 500;
const OUTPUT_EVENTS = new Set([
  "thinking_start", "thinking_delta",
  "text_start", "text_delta",
  "toolcall_start", "toolcall_delta",
]);

// --- Helpers ---

const median = (arr: number[]): number | null => {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

const fmtDuration = (ms: number): string => {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
};

export default function tpsExtension(pi: FullExtensionAPI): void {
  // Per-chunk state (reset each message_start for assistant)
  let chunkStart = 0;
  let firstTokenTs: number | null = null;
  let chunkTtft: number | null = null;
  let chunkTokens = 0;
  let chunkStreamingMs = 0;

  // Exchange tracking
  let currentExchange: ExchangeRecord | null = null;
  let exchanges: ExchangeRecord[] = [];

  // Streaming time tracking within current exchange
  let streamStartTs: number | null = null;

  let statusCtx: ExtensionContext | null = null;

  // --- Status rendering ---

  const renderStats = (ttftMs: number | null, tps: number | null): void => {
    if (!statusCtx?.hasUI) return;
    const theme = statusCtx.ui.theme;
    const ttft = ttftMs !== null ? fmtDuration(ttftMs) : "—";
    const tpsStr = tps !== null ? tps.toFixed(1) : "—";
    updateStatus(`${theme.fg("dim", `TTFT ${ttft}`)}  ${theme.fg("dim", `TPS ${tpsStr}`)}`);
  };

  const updateStatus = (text: string): void => {
    if (statusCtx?.hasUI) {
      statusCtx.ui.setStatus(STATUS_KEY, text);
    }
  };

  const computeTps = (tokens: number | null, streamingMs: number): number | null =>
    (tokens !== null && tokens > 0 && streamingMs >= MIN_STREAMING_MS)
      ? tokens / (streamingMs / 1000)
      : null;

  // --- Streaming time helpers ---

  const closeStreamingPeriod = (): void => {
    if (streamStartTs !== null && currentExchange) {
      currentExchange.streamingMs += Date.now() - streamStartTs;
      streamStartTs = null;
    }
  };

  // --- Events ---

  pi.on("session_start", (_event, ctx) => {
    chunkStart = 0;
    firstTokenTs = null;
    chunkTtft = null;
    chunkTokens = 0;
    chunkStreamingMs = 0;
    currentExchange = null;
    exchanges = [];
    streamStartTs = null;
    statusCtx = ctx;
    renderStats(null, null);
  });

  pi.on("agent_start", () => {
    currentExchange = {
      startTime: Date.now(),
      endTime: null,
      totalActualTokens: 0,
      ttftMs: null,
      streamingMs: 0,
      tps: 0,
    };
  });

  pi.on("agent_end", () => {
    if (!currentExchange) return;

    currentExchange.endTime = Date.now();
    closeStreamingPeriod();

    currentExchange.tps = computeTps(currentExchange.totalActualTokens, currentExchange.streamingMs) ?? 0;

    exchanges.push(currentExchange);
    if (exchanges.length > MAX_HISTORY) exchanges.shift();
    currentExchange = null;

    const medTtft = median(exchanges.filter(e => e.ttftMs !== null).map(e => e.ttftMs!));
    const medTps = median(exchanges.map(e => e.tps).filter(t => t > 0));
    renderStats(medTtft, medTps);
  });

  pi.on("message_start", (event, ctx) => {
    statusCtx = ctx;
    if (event.message.role !== "assistant") return;

    // Close streaming gap between chunks within the same exchange
    closeStreamingPeriod();

    // Reset per-chunk state
    chunkStart = Date.now();
    firstTokenTs = null;
    chunkTtft = null;
    chunkTokens = 0;
    chunkStreamingMs = 0;
  });

  pi.on("message_update", (event: MessageUpdateEvent, _ctx) => {
    const update = event.assistantMessageEvent;
    if (!update || !OUTPUT_EVENTS.has(update.type)) return;

    const now = Date.now();

    // TTFT on first output event (includes thinking start)
    if (firstTokenTs === null) {
      firstTokenTs = now;
      chunkTtft = now - chunkStart;
      if (currentExchange && currentExchange.ttftMs === null) {
        currentExchange.ttftMs = now - currentExchange.startTime;
      }
    }

    // Start streaming period on first output event
    if (streamStartTs === null) {
      streamStartTs = now;
    }
  });

  pi.on("message_end", (event: MessageEndEvent, ctx) => {
    statusCtx = ctx;
    if (event.message.role !== "assistant") return;

    const now = Date.now();
    const actualTokens = event.message.usage?.output ?? null;

    // Close streaming period for this chunk
    closeStreamingPeriod();

    // Compute chunk stats
    chunkStreamingMs = firstTokenTs !== null ? now - firstTokenTs : 0;
    chunkTokens = actualTokens ?? 0;

    // Debug log
    const fs = require("node:fs");
    fs.appendFileSync("/tmp/pi-perf-debug.log",
      `[perf] actualTokens=${actualTokens} chunkStreamingMs=${chunkStreamingMs} firstTokenTs=${firstTokenTs} now=${now} chunkStart=${chunkStart} TTFT=${chunkTtft}\n`);

    // Accumulate into exchange
    if (currentExchange) {
      currentExchange.streamingMs += chunkStreamingMs;
      if (actualTokens !== null) {
        currentExchange.totalActualTokens += actualTokens;
      }
    }

    renderStats(chunkTtft, computeTps(chunkTokens, chunkStreamingMs));
  });

  pi.on("session_shutdown", () => {});
}
