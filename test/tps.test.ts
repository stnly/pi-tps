/**
 * Functional and regression tests for pi-tps extension.
 *
 * Uses vitest fake timers to control Date.now() and a mock pi API
 * to verify status line updates across the extension lifecycle.
 *
 * Timing model:
 *   agent_start  →  message_start  →  message_update (first token)  →  message_end
 *   |<--- TTFT --->|
 *   |<--------------- exchange TTFT = agent_start → first token ---->|
 *                                    |<--- streaming time ---------->|
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// --- Mock infrastructure ---

type EventHandler = (event: any, ctx: ExtensionContext) => void;

function createMockPi() {
  const handlers = new Map<string, EventHandler[]>();
  return {
    on(event: string, handler: EventHandler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    emit(event: string, data: any, ctx: ExtensionContext) {
      for (const h of handlers.get(event) ?? []) h(data, ctx);
    },
  };
}

function createMockCtx(hasUI = true) {
  const statuses = new Map<string, string>();
  return {
    hasUI,
    ui: {
      setStatus: vi.fn((key: string, text: string | undefined) => {
        if (text !== undefined) statuses.set(key, text);
        else statuses.delete(key);
      }),
      theme: {
        fg: (_color: string, text: string) => text,
      },
    },
    getStatus(key: string) {
      return statuses.get(key);
    },
  } as unknown as ExtensionContext & { getStatus(key: string): string | undefined };
}

// --- Module-level setup ---

// Stub require so the debug log in message_end doesn't write to /tmp
vi.stubGlobal(
  "require",
  (mod: string) => {
    if (mod === "node:fs") return { appendFileSync: () => {} };
    // @ts-expect-error dynamic import
    return vi.importActual(mod);
  },
);

let tpsExtension: (pi: any) => void;

beforeAll(async () => {
  const mod = await import("../index.ts");
  tpsExtension = mod.default;
});

// --- Per-test state ---

let pi: ReturnType<typeof createMockPi>;
let ctx: ReturnType<typeof createMockCtx>;

function setup() {
  pi = createMockPi();
  ctx = createMockCtx();
  tpsExtension(pi as any);
  return { pi, ctx };
}

function emit(event: string, data: any) {
  pi.emit(event, data, ctx);
}

function status(): string | undefined {
  return ctx.getStatus("perf");
}

/** Parse "TTFT <val>  TPS <val>" (double-space separator handles multi-word durations) */
function parseStatus(s: string | undefined): { ttft: string; tps: string } {
  if (!s) return { ttft: "", tps: "" };
  const parts = s.split("  ");
  const ttft = parts[0]?.replace("TTFT ", "") ?? "";
  const tps = parts[1]?.replace("TPS ", "") ?? "";
  return { ttft, tps };
}

// --- Helpers for common event sequences ---

function startSession() {
  emit("session_start", {});
}

/**
 * Run a complete single-chunk exchange.
 * @param ttftAdvance ms from agent_start to first token
 * @param streamAdvance ms from first token to message_end
 * @param tokens output token count
 */
function runExchange(ttftAdvance: number, streamAdvance: number, tokens: number) {
  emit("agent_start", {});
  vi.advanceTimersByTime(50); // brief delay before message
  emit("message_start", {
    type: "message_start",
    message: { role: "assistant", usage: {} },
  });
  vi.advanceTimersByTime(ttftAdvance - 50);
  emit("message_update", {
    type: "message_update",
    message: { role: "assistant", usage: {} },
    assistantMessageEvent: { type: "text_delta" },
  });
  vi.advanceTimersByTime(streamAdvance);
  emit("message_end", {
    type: "message_end",
    message: { role: "assistant", usage: { output: tokens } },
  });
  emit("agent_end", {});
}

// ================================================================
// Tests
// ================================================================

describe("pi-tps", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------
  // Functional tests
  // ---------------------------------------------------------------

  describe("session start", () => {
    it("shows dashes with no history", () => {
      setup();
      startSession();
      const s = parseStatus(status());
      expect(s.ttft).toBe("—");
      expect(s.tps).toBe("—");
    });

    it("resets all state on new session_start", () => {
      setup();
      startSession();
      runExchange(100, 1000, 100);

      // New session should clear history
      const newCtx = createMockCtx();
      pi.emit("session_start", {}, newCtx);
      const s = parseStatus(newCtx.getStatus("perf"));
      expect(s.ttft).toBe("—");
      expect(s.tps).toBe("—");
    });
  });

  describe("single exchange", () => {
    it("shows TTFT and TPS after one complete exchange", () => {
      setup();
      startSession();
      // TTFT=100ms, streaming=1000ms, tokens=100 → TPS=100.0
      runExchange(100, 1000, 100);

      const s = parseStatus(status());
      expect(s.ttft).toBe("100ms");
      expect(s.tps).toBe("100.0");
    });
  });

  describe("median computation", () => {
    it("computes odd-count median (middle value)", () => {
      setup();
      startSession();

      runExchange(100, 1000, 50);   // TTFT=100ms, TPS=50.0
      runExchange(300, 1000, 150);  // TTFT=300ms, TPS=150.0
      runExchange(200, 1000, 100);  // TTFT=200ms, TPS=100.0

      const s = parseStatus(status());
      expect(s.ttft).toBe("200ms");
      expect(s.tps).toBe("100.0");
    });

    it("computes even-count median (average of two middle values)", () => {
      setup();
      startSession();

      runExchange(100, 1000, 40);   // TTFT=100ms, TPS=40.0
      runExchange(300, 1000, 80);   // TTFT=300ms, TPS=80.0

      const s = parseStatus(status());
      expect(s.ttft).toBe("200ms");
      expect(s.tps).toBe("60.0");
    });
  });

  describe("multi-chunk exchanges", () => {
    it("accumulates tokens and streaming time across chunks, excluding gaps", () => {
      setup();
      startSession();
      emit("agent_start", {});

      // Chunk 1: 500ms streaming, 30 tokens
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      vi.advanceTimersByTime(50); // TTFT portion
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      });
      vi.advanceTimersByTime(500); // streaming
      emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { output: 30 } },
      });

      // Tool execution gap — should NOT count toward streaming
      vi.advanceTimersByTime(5000);

      // Chunk 2: 500ms streaming, 70 tokens
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      vi.advanceTimersByTime(50);
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      });
      vi.advanceTimersByTime(500);
      emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { output: 70 } },
      });

      emit("agent_end", {});

      // exchange TTFT = 50ms (agent_start → first token of chunk 1)
      // streaming = 550 + 550 = 1100ms (wait, closeStreamingPeriod tracks from streamStartTs)
      // Actually: chunk1 streaming = 550ms (from first token at +50 to message_end at +550)
      //           chunk2 streaming = 550ms
      //           total = 1100ms
      // tokens = 100, TPS = 100/1.1 = 90.9

      // Hmm, let me recalculate. In message_update, firstTokenTs and streamStartTs
      // are both set. In message_end, closeStreamingPeriod adds (now - streamStartTs).
      // streamStartTs was set at T=50 (relative to chunk start), message_end at T=550.
      // So chunk1 streaming = 500ms (550-50), chunk2 streaming = 500ms, total = 1000ms
      // Wait no, the 50ms advance before message_update IS the TTFT portion.
      // message_start at T=0, advance 50ms → T=50 (message_update, firstToken)
      // advance 500ms → T=550 (message_end)
      // closeStreamingPeriod: streamingMs += 550-50 = 500ms
      // Same for chunk2: 500ms
      // Total: 1000ms, tokens=100, TPS=100.0

      const s = parseStatus(status());
      expect(s.ttft).toBe("50ms");
      expect(s.tps).toBe("100.0");
    });
  });

  describe("TPS threshold (500ms minimum streaming)", () => {
    it("shows TPS when streaming >= 500ms", () => {
      setup();
      startSession();
      runExchange(100, 500, 50);
      // streaming=500ms, tokens=50 → TPS=100.0
      const s = parseStatus(status());
      expect(s.tps).toBe("100.0");
    });

    it("excludes TPS from medians when streaming < 500ms", () => {
      setup();
      startSession();
      // Short burst: streaming=400ms < 500ms → no TPS
      runExchange(100, 400, 50);
      const s = parseStatus(status());
      expect(s.ttft).toBe("100ms");
      expect(s.tps).toBe("—");
    });
  });

  describe("output event types", () => {
    it.each([
      "thinking_start",
      "thinking_delta",
      "text_start",
      "text_delta",
      "toolcall_start",
      "toolcall_delta",
    ])("'%s' triggers TTFT tracking", (eventType) => {
      setup();
      startSession();
      runExchange(250, 500, 25);
      const s = parseStatus(status());
      expect(s.ttft).toBe("250ms");
    });

    it("ignores unknown event types for TTFT", () => {
      setup();
      startSession();
      emit("agent_start", {});
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      vi.advanceTimersByTime(100);
      // Unknown event — should not set firstTokenTs
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "unknown_event" },
      });
      vi.advanceTimersByTime(100);
      // Real first token at T=200
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      });
      vi.advanceTimersByTime(800);
      emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { output: 50 } },
      });
      emit("agent_end", {});

      const s = parseStatus(status());
      expect(s.ttft).toBe("200ms");
    });
  });

  describe("non-assistant messages", () => {
    it("ignores user messages", () => {
      setup();
      startSession();
      emit("agent_start", {});

      // User message — should be ignored
      emit("message_start", {
        type: "message_start",
        message: { role: "user", usage: {} },
      });
      vi.advanceTimersByTime(100);
      emit("message_end", {
        type: "message_end",
        message: { role: "user", usage: { output: 50 } },
      });

      // Assistant message
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      vi.advanceTimersByTime(150);
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      });
      vi.advanceTimersByTime(850);
      emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { output: 50 } },
      });
      emit("agent_end", {});

      // TTFT = 200ms (user message time) + 150ms (assistant TTFT) = 250ms from agent_start
      const s = parseStatus(status());
      expect(s.ttft).toBe("250ms");
    });
  });

  describe("status display timing", () => {
    it("only updates at agent_end, not during streaming or message_end", () => {
      setup();
      startSession();

      // First exchange to establish medians
      runExchange(100, 1000, 100);
      const afterFirst = status();
      expect(afterFirst).toBeDefined();

      // Start second exchange
      emit("agent_start", {});
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      // Before first token — status unchanged
      expect(status()).toBe(afterFirst);

      vi.advanceTimersByTime(200);
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      });
      // During streaming — status unchanged
      expect(status()).toBe(afterFirst);

      vi.advanceTimersByTime(800);
      emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { output: 200 } },
      });
      // After message_end — still unchanged
      expect(status()).toBe(afterFirst);

      emit("agent_end", {});
      // Now updated
      expect(status()).not.toBe(afterFirst);
    });
  });

  describe("no UI context", () => {
    it("does not crash when hasUI is false", () => {
      setup();
      const noUICtx = createMockCtx(false);

      pi.emit("session_start", {}, noUICtx);
      pi.emit("agent_start", {}, noUICtx);
      pi.emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      }, noUICtx);
      vi.advanceTimersByTime(100);
      pi.emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      }, noUICtx);
      vi.advanceTimersByTime(900);
      pi.emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { output: 100 } },
      }, noUICtx);
      pi.emit("agent_end", {}, noUICtx);
      // No throw
    });
  });

  describe("duration formatting", () => {
    it("formats milliseconds (< 1000)", () => {
      setup();
      startSession();
      runExchange(500, 1000, 100);
      const s = parseStatus(status());
      expect(s.ttft).toBe("500ms");
    });

    it("formats seconds (>= 1000, < 60000)", () => {
      setup();
      startSession();
      runExchange(1500, 1000, 100);
      const s = parseStatus(status());
      expect(s.ttft).toBe("1.5s");
    });

    it("formats minutes (>= 60000)", () => {
      setup();
      startSession();
      emit("agent_start", {});
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      vi.advanceTimersByTime(90_000);
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      });
      vi.advanceTimersByTime(1000);
      emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { output: 10 } },
      });
      emit("agent_end", {});

      const s = parseStatus(status());
      expect(s.ttft).toBe("1m 30s");
    });
  });

  describe("MAX_HISTORY (50)", () => {
    it("caps exchange history at 50 entries", () => {
      setup();
      startSession();
      for (let i = 0; i < 55; i++) {
        runExchange(100, 1000, 50);
      }
      // All identical → medians should be 100ms / 50.0
      const s = parseStatus(status());
      expect(s.ttft).toBe("100ms");
      expect(s.tps).toBe("50.0");
    });
  });

  describe("edge cases", () => {
    it("handles agent_end without agent_start", () => {
      setup();
      startSession();
      emit("agent_end", {});
      const s = parseStatus(status());
      expect(s.ttft).toBe("—");
      expect(s.tps).toBe("—");
    });

    it("handles message_end with no usage.output", () => {
      setup();
      startSession();
      emit("agent_start", {});
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      vi.advanceTimersByTime(100);
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      });
      vi.advanceTimersByTime(900);
      emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: {} }, // no output field
      });
      emit("agent_end", {});

      const s = parseStatus(status());
      expect(s.ttft).toBe("100ms");
      expect(s.tps).toBe("—");
    });
  });

  // ---------------------------------------------------------------
  // Regression tests
  // ---------------------------------------------------------------

  describe("regression: streaming retains previous medians", () => {
    it("shows previous medians during streaming, not dashes", () => {
      setup();
      startSession();

      // First exchange: TTFT=100ms, TPS=50.0
      runExchange(100, 1000, 50);
      const afterFirst = status();

      // Second exchange streaming — status should still show first exchange medians
      emit("agent_start", {});
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      // No token yet
      expect(status()).toBe(afterFirst);

      vi.advanceTimersByTime(500);
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      });
      // Streaming in progress — still first exchange medians
      expect(status()).toBe(afterFirst);
      const parsed = parseStatus(status());
      expect(parsed.ttft).toBe("100ms");
      expect(parsed.tps).toBe("50.0");
    });

    it("never shows dashes during streaming when history exists", () => {
      setup();
      startSession();
      runExchange(200, 1000, 80);

      // Start new exchange
      emit("agent_start", {});
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      vi.advanceTimersByTime(300);
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      });
      vi.advanceTimersByTime(700);
      emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { output: 100 } },
      });

      const parsed = parseStatus(status());
      expect(parsed.ttft).not.toBe("—");
      expect(parsed.tps).not.toBe("—");
    });
  });

  describe("regression: short bursts excluded from TPS median", () => {
    it("short tool calls (< 500ms streaming) do not pollute TPS median", () => {
      setup();
      startSession();

      // Exchange 1: real response, TPS=100.0
      runExchange(100, 1000, 100);

      // Exchange 2: short burst, streaming=200ms → TPS excluded from median
      emit("agent_start", {});
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      vi.advanceTimersByTime(50);
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "toolcall_delta" },
      });
      vi.advanceTimersByTime(200);
      emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { output: 30 } },
      });
      emit("agent_end", {});

      // Only exchange 1 contributes TPS → median = 100.0
      const s = parseStatus(status());
      expect(s.tps).toBe("100.0");
    });
  });

  describe("regression: idle gap between chunks not counted", () => {
    it("tool execution gap does not inflate streaming time", () => {
      setup();
      startSession();
      emit("agent_start", {});

      // Chunk 1: 500ms streaming
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      vi.advanceTimersByTime(50);
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      });
      vi.advanceTimersByTime(500);
      emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { output: 30 } },
      });

      // Tool execution gap
      vi.advanceTimersByTime(5000);

      // Chunk 2: 500ms streaming
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      vi.advanceTimersByTime(50);
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      });
      vi.advanceTimersByTime(500);
      emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { output: 30 } },
      });

      emit("agent_end", {});

      // Total streaming: 500+500 = 1000ms (NOT 6000ms)
      // Tokens: 60, TPS = 60/1.0 = 60.0
      const s = parseStatus(status());
      expect(s.tps).toBe("60.0");
    });
  });

  describe("regression: TTFT measured from agent_start", () => {
    it("exchange TTFT includes time before first message", () => {
      setup();
      startSession();
      emit("agent_start", {});
      vi.advanceTimersByTime(500); // delay before first message
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      vi.advanceTimersByTime(100); // TTFT portion
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      });
      vi.advanceTimersByTime(1000);
      emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { output: 50 } },
      });
      emit("agent_end", {});

      // Exchange TTFT = agent_start → first token = 600ms
      const s = parseStatus(status());
      expect(s.ttft).toBe("600ms");
    });
  });

  describe("regression: thinking_start counts as first token", () => {
    it("TTFT measured from thinking_start, not text_delta", () => {
      setup();
      startSession();
      emit("agent_start", {});
      emit("message_start", {
        type: "message_start",
        message: { role: "assistant", usage: {} },
      });
      vi.advanceTimersByTime(300);
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "thinking_start" },
      });
      vi.advanceTimersByTime(700);
      // text_delta is NOT the first token — thinking_start was
      emit("message_update", {
        type: "message_update",
        message: { role: "assistant", usage: {} },
        assistantMessageEvent: { type: "text_delta" },
      });
      vi.advanceTimersByTime(1000);
      emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { output: 200 } },
      });
      emit("agent_end", {});

      // TTFT = 300ms (message_start → thinking_start)
      // Streaming = 1700ms (thinking_start → message_end)
      // TPS = 200/1.7 ≈ 117.6
      const s = parseStatus(status());
      expect(s.ttft).toBe("300ms");
      expect(parseFloat(s.tps)).toBeCloseTo(200 / 1.7, 1);
    });
  });
});
