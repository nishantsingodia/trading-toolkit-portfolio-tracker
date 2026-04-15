# Upstox MCP Server — CLAUDE.md

## What is this?
A Cloudflare Workers (wrangler) app that started as a simple Upstox MCP server and grew into a **full-stack stock signal scanner + portfolio tracker**. Runs locally at `localhost:8787`.

## Quick Start
```bash
npm start          # wrangler dev on port 8787
# Auth: click badge in UI → Upstox OAuth → token saved to DB
```

## Architecture

### Runtime
- **Cloudflare Workers** with Durable Objects (MyMCP class in `src/index.ts`)
- **SQLite** inside Durable Object (not external DB)
- **KV** for OAuth state only
- **Static assets** served from `static/`
- Env vars in `.dev.vars`: `UPSTOX_API_KEY`, `UPSTOX_API_SECRET`, `UPSTOX_ACCESS_TOKEN`

### Source Files

| File | What it does |
|------|-------------|
| `src/index.ts` | Entry point — all REST API routes, OAuth flow, MCP tool registration |
| `src/tools/watchlist.ts` | **The heart** — 6 strategy classifiers, scan engine, candle cache, rate-limit retry |
| `src/tools/portfolio.ts` | Trade recording (BUY/SELL), P&L calc, portfolio bucketing (LEGACY/STRATEGY) |
| `src/data/stock-master.ts` | Master list of 250 stocks (102 LARGECAP + 152 MIDCAP) with instrument keys |
| `src/data/watchlist-seed.ts` | Initial 50-stock seed for empty watchlist |
| `src/constants/index.ts` | API base URL, headers |
| `src/tools/get-*.ts` | MCP tool wrappers for individual Upstox API endpoints |
| `src/tools/run-backtest.ts` | Equity backtest runner |
| `src/tools/run-fno-backtest.ts` | F&O backtest runner |
| `src/tools/portfolio.ts` | Position tracking, P&L |
| `static/index.html` | Single-page UI — 4 tabs: Signal Scanner, F&O Signals, Watchlist, Portfolio |

### F&O Backtester (separate engine)
Lives in `fno-backtester/src/engine/`:
- `backtester.ts` — Main loop
- `strategies.ts` — 12 F&O strategies (short_straddle, iron_condor, bull_call_spread, etc.)
- `indicators.ts` — Technical indicators shared with equity
- `pricing.ts`, `risk-manager.ts`, `expiry-calendar.ts`, `metrics.ts`

## Database Schema (6 tables in Durable Object SQLite)

| Table | Purpose |
|-------|---------|
| `watchlist` | symbol, instrument_key, category (LARGECAP/MIDCAP) |
| `candle_cache` | symbol, trade_date, OHLCV+OI — rolling 1yr daily cache |
| `scan_snapshots` | Per-scan per-stock: all 6 strategy signals + fingerprint |
| `positions` | Trade log: symbol, action, price, qty, signal_strategy, signal_fingerprint, portfolio |
| `fno_positions` | Options trades: underlying, strike, CE/PE, lots, entry/exit |
| `config` | Key-value store (access_token, etc.) |

## The 6 Equity Strategies (all in `watchlist.ts`)

| Strategy | BUY signal | SELL signal |
|----------|-----------|------------|
| **BB_RSI** | Price <= lower BB AND RSI < 30 | Price >= mid BB OR RSI > 70 |
| **STOCH_RSI** | %K < 20, RSI < 35, K crosses D up | %K > 80, RSI > 65, K crosses D down |
| **RSI_OBOS** | RSI crosses above 30 | RSI crosses below 70 |
| **CANSLIM** | Price > SMA50, Vol > 1.5x avg, near 52W high, RSI 50-80 | Price < SMA50 |
| **DUAL_MOM** | Price > SMA200, top 75% of 52W range, MACD > 0 | Price < SMA200 or MACD < 0 |
| **SUPERTREND** | Price crosses above Supertrend(10,3) | Price crosses below |

Signal types: `FRESH_BUY` (today), `RECENT_BUY` (1-3d), `BULLISH`, `BEARISH`, `NEUTRAL`

Fingerprint format: `BB_RSI:FRESH_BUY* | STOCH_RSI:BULLISH | RSI_OBOS:- | ...`

## Scan Data Flow (GET /api/scan)

1. Load all stocks from `watchlist` table
2. **Candle fetch** (batches of 3, 1s delay between batches):
   - Read `candle_cache` → gap-fill from Upstox `/v2/historical-candle/` if stale
   - Fetch intraday 30min bars → build today's OHLCV → append
   - Retry on 429 with exponential backoff (max 3 retries)
3. **Compute indicators**: RSI(14), SMA(50/200), BB(20,2), Stoch(14,3), MACD(12,26,9), Supertrend(10,3)
4. **Classify** all 6 strategies per stock
5. **Sort** by consensus: clean FRESH_BUY first → conflicted → FRESH_SELL on invested
6. **Persist** to `scan_snapshots`
7. **Fetch live LTP** batch from `/v2/market-quote/ltp`

## Key API Routes

| Route | Method | What |
|-------|--------|------|
| `/api/scan?category=ALL` | GET | Run full 6-strategy scan |
| `/api/watchlist` | GET | List watched stocks |
| `/api/trade` | POST | Record BUY/SELL with signal_strategy |
| `/api/positions` | GET | Portfolio P&L (supports ?portfolio=STRATEGY) |
| `/api/cache/status` | GET | Candle cache stats |
| `/api/cache` | DELETE | Force cache refresh |
| `/api/fno/scan` | GET | F&O options chain analysis |

## Known Gotchas & Past Fixes

### Upstox API Rate Limiting (HTTP 429)
- Upstox returns 429 after ~130 requests in quick succession
- **Fix**: `fetchWithRetry()` in watchlist.ts — batch size 3, 1s delay, exponential backoff
- If 10 consecutive intraday fetches fail → early-terminate intraday for remaining stocks
- Scan takes ~90s for 259 stocks (vs ~30s without throttling)

### Token Expiry (silent failure)
- Access token expires after ~6 hours; silently expired for 18 days once
- `checkAuthStatus()` decodes JWT and checks `exp` claim
- UI badge shows "EXPIRED" state — re-auth via OAuth popup
- ALWAYS check token expiry first when data issues are reported

### Cache Source Label
- `source: "mixed"` (cache + small gap-fill) counts as "API" in the summary counter
- Not a real problem — second scan of the day shows "cache" correctly

### Minimum Candle Requirement
- Stocks with < 60 candles are skipped (need enough for SMA(50) + buffer)
- SMA(200) returns null for first 199 candles — strategies handle gracefully

### Cloudflare 30s Timeout
- Individual fetch calls have 15s (historical) / 10s (intraday) AbortController timeouts
- Full scan can exceed 30s — Durable Object handles this (no Workers timeout)

## Conventions
- All indicator functions are pure (arrays in, arrays out) in watchlist.ts
- Strategy classifiers return `{ strategy, signal, trigger_price, days_since, indicators }`
- Symbols use NSE format: `RELIANCE`, `TCS`, `INFY` (not BSE codes)
- Instrument keys: `NSE_EQ|INE002A01018` format for Upstox API
- Dates: ISO format `YYYY-MM-DD`, candle timestamps include `T00:00:00+05:30`
