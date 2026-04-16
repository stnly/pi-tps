# pi-tps

A [pi](https://github.com/badlogic/pi-coding-agent) extension that displays model performance stats in the status line.

## Metrics

| Metric | Description |
|--------|-------------|
| **TTFT** | Time to First Token — from request start to first output token (includes thinking) |
| **TPS** | Tokens Per Second — output throughput using actual provider token counts |

During streaming, the extension calculates stats in the background. The status line only updates on `agent_end`, showing session median values for both metrics.

TPS is only computed when streaming time is >= 500ms. Short responses (e.g., tool calls) arrive as bursts with unreliable timing and show "—" instead.

## Example

The extension adds a `TTFT` and `TPS` entry to pi's status line:

```
──────────────────────────────────
                                  
──────────────────────────────────
↑3.2M ↓51k R2.9M 48.4%/205k (auto)
TTFT 3.7s TPS 67.0
```

- During streaming: calculates stats in background, displays previous session medians (e.g. `TTFT 2.1s TPS 51.3`)
- On `message_end`: accumulates chunk stats into exchange, display unchanged
- When idle (after `agent_end`): shows updated session medians (e.g. `TTFT 2.1s TPS 51.3`)
- Short burst responses show `TPS —` (streaming time < 500ms)

## Installation

```bash
pi install git:github.com/stnly/pi-tps
```

Or add to your pi packages configuration:

```json
{
  "packages": [
    {
      "source": "git:github.com/stnly/pi-tps"
    }
  ]
}
```

Or add manually to your extensions configuration:

```json
{
  "pi": {
    "extensions": ["pi-tps"]
  }
}
```

Or copy/symlink this directory into your pi extensions path.

## Development

```bash
npm install
npm run check    # type-check with tsc
npm test         # run test suite
```

## How It Works

- **Token counting**: Uses actual token counts from provider `usage.output`. No estimation.
- **Exchange tracking**: Groups assistant messages into exchanges (user prompt → final response via `agent_start`/`agent_end`). Exchange TPS is calculated from actual tokens divided by accumulated streaming time.
- **Streaming time**: Measured from first output event (including `thinking_start`) to `message_end`, excluding idle gaps between chunks (e.g., during tool execution).
- **Session medians**: Persists TTFT and TPS from each completed exchange, capped at 50 entries. Only exchanges with >= 500ms streaming time contribute TPS values.
