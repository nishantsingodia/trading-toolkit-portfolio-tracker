# Trading Toolkit & Portfolio Tracker

A full-stack trading toolkit built on **Cloudflare Workers** (Durable Objects + embedded SQLite). What began as an [Upstox](https://upstox.com/) MCP server grew into a self-contained signal scanner, portfolio tracker, and backtesting suite — all running from a single edge worker with no external database.

> ⚠️ **Disclaimer — not financial advice.** This project is for **educational and personal-research purposes only**. Nothing here is investment advice or a recommendation to buy or sell any security. Signals and backtest results are illustrative, may contain bugs, and are **not** indicative of future returns. Trading involves substantial risk of loss. You are solely responsible for any decisions made with this software. The author accepts no liability for any losses. See [LICENSE](LICENSE) (provided "as is", without warranty).

---

## What it does

| Module | Description |
|--------|-------------|
| 📈 **Signal Scanner** | Scans a universe of **251 NSE stocks** (large + mid cap) across **6 equity strategies**, ranks them by cross-strategy consensus, and surfaces fresh buy/sell signals. |
| 💼 **Portfolio Tracker** | Records BUY/SELL trades, computes live P&L, and buckets positions by the strategy that triggered them. |
| 🔁 **Backtesters** | An equity strategy engine (multiple strategies + indicators + optimizer) and a separate **12-strategy F&O backtester** (straddles, iron condors, spreads, …). |
| 🤖 **Upstox MCP Server** | Natural-language access to your Upstox account (holdings, positions, orders, funds) from Claude Desktop / Cursor. |

---

## Architecture

```
┌─────────────────────────── Cloudflare Worker ───────────────────────────┐
│                                                                          │
│   Static SPA (static/index.html)        MCP endpoint (/sse)              │
│   4 tabs: Scanner · F&O · Watchlist · Portfolio                          │
│                          │                          │                    │
│                          ▼                          ▼                    │
│   ┌──────────────────── Durable Object (MyMCP) ────────────────────┐     │
│   │  REST API · OAuth flow · MCP tool registry                     │     │
│   │  ┌─────────────── embedded SQLite (6 tables) ──────────────┐   │     │
│   │  │ watchlist · candle_cache · scan_snapshots ·             │   │     │
│   │  │ positions · fno_positions · config                      │   │     │
│   │  └─────────────────────────────────────────────────────────┘   │     │
│   └────────────────────────────────────────────────────────────────┘     │
│                          │                                               │
│   KV namespace (OAuth state only)                                        │
└──────────────────────────┼───────────────────────────────────────────────┘
                           ▼
                  Upstox REST API (candles, quotes, holdings, orders)
```

**Highlights**
- **No external DB** — state lives in SQLite *inside* the Durable Object, so the whole app is one deployable worker.
- **Resilient data layer** — rolling 1-year candle cache with gap-fill, batched fetches, and exponential-backoff retry to survive Upstox's HTTP 429 rate limits.
- **Long-running scans** — a full 251-stock scan (~90s) runs inside the Durable Object, sidestepping the Workers 30s request timeout.

---

## Tech stack

- **Runtime:** Cloudflare Workers + Durable Objects, Workers KV
- **Storage:** SQLite (embedded in the Durable Object)
- **Language:** TypeScript
- **Tooling:** Wrangler, Vitest, Biome
- **Auth:** Upstox OAuth 2.0
- **Protocol:** Model Context Protocol (MCP) over SSE

---

## The 6 equity strategies

| Strategy | BUY signal | SELL signal |
|----------|-----------|-------------|
| **BB_RSI** | Price ≤ lower Bollinger Band **and** RSI < 30 | Price ≥ mid band **or** RSI > 70 |
| **STOCH_RSI** | %K < 20, RSI < 35, %K crosses %D up | %K > 80, RSI > 65, %K crosses %D down |
| **RSI_OBOS** | RSI crosses above 30 | RSI crosses below 70 |
| **CANSLIM** | Price > SMA50, volume > 1.5× avg, near 52-week high, RSI 50–80 | Price < SMA50 |
| **DUAL_MOM** | Price > SMA200, top 75% of 52-week range, MACD > 0 | Price < SMA200 **or** MACD < 0 |
| **SUPERTREND** | Price crosses above Supertrend(10, 3) | Price crosses below |

Each stock gets a consensus **fingerprint** (e.g. `BB_RSI:FRESH_BUY* | STOCH_RSI:BULLISH | RSI_OBOS:- | …`) and signal type: `FRESH_BUY` (today), `RECENT_BUY` (1–3d), `BULLISH`, `BEARISH`, `NEUTRAL`. Indicators (RSI, SMA, Bollinger, Stochastic, MACD, Supertrend) are implemented as pure functions.

The **F&O backtester** (`fno-backtester/`) runs 12 options strategies — short straddle, iron condor, bull-call spread, and more — with its own pricing, risk-manager, and expiry-calendar engines.

---

## Screenshots

> _TODO: add screenshots of the Signal Scanner and Portfolio tabs here — they're the most compelling part of the UI._
> _e.g._ `![Signal Scanner](img/scanner.png)`

MCP integration in action:

![Available tools](img/available-tools.png)
![Successful tool call](img/mcp-inspector-successful-tool-call.png)

---

## Quick Start

### Setup

1. Clone the repository:
```bash
git clone https://github.com/nishantsingodia/trading-toolkit-portfolio-tracker.git
cd trading-toolkit-portfolio-tracker
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.dev.vars` file with your Upstox app credentials (see `.dev.vars.example`):
```
UPSTOX_API_KEY=your_api_key
UPSTOX_API_SECRET=your_api_secret
UPSTOX_ACCESS_TOKEN=your_access_token
```
> 🔒 Never commit `.dev.vars` — it's gitignored. Credentials are read from the environment, never hardcoded.

### Run the Server

```bash
npm run start
```

The app runs at `http://localhost:8787` — open it in a browser for the UI, or point an MCP client at `/sse`. Authenticate via the badge in the UI (Upstox OAuth → token saved to the embedded DB).

### Test

```bash
npm test
```

---

## MCP Configuration

### Claude Desktop

```json
{
  "mcpServers": {
    "mcp-server-upstox-api": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8787/sse"]
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "mcp-server-upstox-api": {
      "url": "http://localhost:8787/sse"
    }
  }
}
```

### Example prompts

- "What's my Upstox profile information?"
- "What's my available margin in the equity segment?"
- "What stocks do I currently hold, and their current values?"
- "What are my open positions and their unrealized P&L?"
- "Show me my trades for today."
- "Show me the details / history / trades of order ID `xxxxxxxxxxxxxxx`."

---

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/scan?category=ALL` | GET | Run the full 6-strategy scan |
| `/api/watchlist` | GET | List watched stocks |
| `/api/trade` | POST | Record a BUY/SELL with its signal strategy |
| `/api/positions` | GET | Portfolio P&L (`?portfolio=STRATEGY`) |
| `/api/cache/status` | GET | Candle-cache stats |
| `/api/cache` | DELETE | Force a cache refresh |
| `/api/fno/scan` | GET | F&O options-chain analysis |

### Upstox MCP tools

| Tool | Description |
|------|-------------|
| `get-profile` | User profile information |
| `get-funds-margin` | Funds and margin (`SEC` equity / `COM` commodity) |
| `get-holdings` | Long-term holdings |
| `get-positions` | Short-term positions |
| `get-mtf-positions` | Margin Trade Funding positions |
| `get-order-book` | Current-day orders and status |
| `get-order-details` | Detail for a specific order ID |
| `get-order-trades` | Trades executed for an order ID |
| `get-order-history` | Order history by order ID or tag |
| `get-trades` | Trades executed for the current day |

---

## Project Structure

```
src/
  index.ts              # Entry point — REST routes, OAuth, MCP tool registration
  tools/
    watchlist.ts        # Scan engine: 6 strategy classifiers, indicators, candle cache
    portfolio.ts        # Trade recording, P&L, position bucketing
    get-*.ts            # MCP tool wrappers for Upstox endpoints
    run-backtest.ts     # Equity backtest runner
    run-fno-backtest.ts # F&O backtest runner
  data/
    stock-master.ts     # 251-stock universe with instrument keys
  constants/            # API base URL, headers
static/index.html       # Single-page UI (Scanner · F&O · Watchlist · Portfolio)
backtester/             # Equity strategy engine + optimizer
fno-backtester/         # 12-strategy F&O backtester (pricing, risk, expiry calendar)
```

---

## License

[MIT](LICENSE) © Nishant Singodia
