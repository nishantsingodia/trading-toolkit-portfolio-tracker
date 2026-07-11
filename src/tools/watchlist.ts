import { z } from "zod";
import { ToolResponse, Env, SqlAgent } from "../types";
import { UPSTOX_API_BASE_URL, HEADERS } from "../constants";
import { WATCHLIST_SEED } from "../data/watchlist-seed";
import {
  sma, rsi, stochastic, bollingerBands, supertrend, macd,
  crossover, crossunder,
} from "../../backtester/src/engine/indicators";
import type { Candle } from "../../backtester/src/engine/types";

// ─── Table Init ───────────────────────────────────────────────────────────────

export function initWatchlistTables(agent: SqlAgent) {
  agent.sql`CREATE TABLE IF NOT EXISTS watchlist (
    symbol TEXT PRIMARY KEY,
    instrument_key TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('LARGECAP','MIDCAP')),
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

  agent.sql`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('BUY','SELL')),
    price REAL NOT NULL,
    quantity INTEGER NOT NULL,
    trade_date TEXT NOT NULL,
    broker TEXT NOT NULL DEFAULT 'MANUAL',
    portfolio TEXT NOT NULL DEFAULT 'LEGACY',
    source TEXT NOT NULL DEFAULT 'MANUAL',
    signal_strategy TEXT,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

  // Migrate: add columns if they don't exist (for existing DBs)
  // Check if columns exist first to avoid ALTER TABLE errors
  const colCheck = [...agent.sql`PRAGMA table_info(positions)`] as any[];
  const existingCols = new Set(colCheck.map((c: any) => c.name));
  if (!existingCols.has('broker')) { agent.sql`ALTER TABLE positions ADD COLUMN broker TEXT NOT NULL DEFAULT 'MANUAL'`; }
  if (!existingCols.has('portfolio')) { agent.sql`ALTER TABLE positions ADD COLUMN portfolio TEXT NOT NULL DEFAULT 'LEGACY'`; }
  if (!existingCols.has('source')) { agent.sql`ALTER TABLE positions ADD COLUMN source TEXT NOT NULL DEFAULT 'MANUAL'`; }
  if (!existingCols.has('signal_strategy')) { agent.sql`ALTER TABLE positions ADD COLUMN signal_strategy TEXT`; }

  // F&O position tracking
  agent.sql`CREATE TABLE IF NOT EXISTS fno_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id TEXT NOT NULL,
    underlying TEXT NOT NULL,
    expiry TEXT NOT NULL,
    strike INTEGER NOT NULL,
    option_type TEXT NOT NULL CHECK(option_type IN ('CE','PE')),
    action TEXT NOT NULL CHECK(action IN ('BUY','SELL')),
    lots INTEGER NOT NULL DEFAULT 1,
    lot_size INTEGER NOT NULL DEFAULT 75,
    entry_price REAL NOT NULL,
    entry_date TEXT NOT NULL,
    entry_time TEXT,
    exit_price REAL,
    exit_date TEXT,
    exit_reason TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
    strategy TEXT,
    broker TEXT NOT NULL DEFAULT 'MANUAL',
    source TEXT NOT NULL DEFAULT 'MANUAL',
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

  agent.sql`CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`;

  // Candle cache for historical data persistence
  agent.sql`CREATE TABLE IF NOT EXISTS candle_cache (
    symbol TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL DEFAULT 0,
    oi REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (symbol, trade_date)
  )`;

  // Scan snapshots — full strategy fingerprint per stock per scan
  agent.sql`CREATE TABLE IF NOT EXISTS scan_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    scan_date TEXT NOT NULL,
    scan_time TEXT NOT NULL,
    ltp REAL,
    bb_rsi TEXT,
    stoch_rsi TEXT,
    rsi_obos TEXT,
    canslim TEXT,
    dual_mom TEXT,
    supertrend TEXT,
    fingerprint TEXT NOT NULL,
    buy_count INTEGER NOT NULL DEFAULT 0,
    sell_count INTEGER NOT NULL DEFAULT 0
  )`;
  agent.sql`CREATE INDEX IF NOT EXISTS idx_scan_snap_symbol_date ON scan_snapshots(symbol, scan_date)`;

  // Migrate: add signal_fingerprint to positions if missing
  const posColCheck = [...agent.sql`PRAGMA table_info(positions)`] as any[];
  const posCols = new Set(posColCheck.map((c: any) => c.name));
  if (!posCols.has('signal_fingerprint')) { agent.sql`ALTER TABLE positions ADD COLUMN signal_fingerprint TEXT`; }
  // ISIN is the stable, broker-independent identity for a stock (the printed name varies/truncates per
  // broker, which fragmented positions across spellings). Stored on import for dedup + grouping by ISIN.
  if (!posCols.has('isin')) { agent.sql`ALTER TABLE positions ADD COLUMN isin TEXT`; }

  // Seed watchlist if empty
  const count = [...agent.sql`SELECT COUNT(*) as cnt FROM watchlist`];
  if ((count[0] as any).cnt === 0) {
    for (const s of WATCHLIST_SEED) {
      agent.sql`INSERT INTO watchlist (symbol, instrument_key, category) VALUES (${s.symbol}, ${s.instrument_key}, ${s.category})`;
    }
  }
}

// ─── show-watchlist ───────────────────────────────────────────────────────────

export const showWatchlistSchema = {
  category: z.enum(["LARGECAP", "MIDCAP", "ALL"]).optional().describe("Filter by category (default: ALL)"),
};

interface ShowWatchlistArgs {
  category?: string;
}

export async function showWatchlistHandler(
  args: ShowWatchlistArgs,
  env: Env,
  agent: SqlAgent
): Promise<ToolResponse> {
  const cat = args.category || "ALL";
  let rows: any[];
  if (cat === "ALL") {
    rows = [...agent.sql`SELECT symbol, instrument_key, category, added_at FROM watchlist ORDER BY category, symbol`];
  } else {
    rows = [...agent.sql`SELECT symbol, instrument_key, category, added_at FROM watchlist WHERE category = ${cat} ORDER BY symbol`];
  }

  // Check which symbols have open positions
  const posRows = [...agent.sql`SELECT symbol, SUM(CASE WHEN action='BUY' THEN quantity ELSE -quantity END) as net_qty FROM positions GROUP BY symbol HAVING net_qty > 0`];
  const invested = new Set((posRows as any[]).map((r: any) => r.symbol));

  const stocks = rows.map((r: any) => ({
    symbol: r.symbol,
    instrument_key: r.instrument_key,
    category: r.category,
    invested: invested.has(r.symbol),
    added_at: r.added_at,
  }));

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        total: stocks.length,
        largecap: stocks.filter(s => s.category === "LARGECAP").length,
        midcap: stocks.filter(s => s.category === "MIDCAP").length,
        stocks,
      }, null, 2),
    }],
  };
}

// ─── add-to-watchlist ─────────────────────────────────────────────────────────

export const addToWatchlistSchema = {
  symbol: z.string().min(1, "Stock symbol is required"),
  instrument_key: z.string().min(1, "Instrument key is required"),
  category: z.enum(["LARGECAP", "MIDCAP"]).describe("Stock category"),
};

interface AddToWatchlistArgs {
  symbol: string;
  instrument_key: string;
  category: string;
}

export async function addToWatchlistHandler(
  args: AddToWatchlistArgs,
  env: Env,
  agent: SqlAgent
): Promise<ToolResponse> {
  try {
    agent.sql`INSERT OR REPLACE INTO watchlist (symbol, instrument_key, category) VALUES (${args.symbol}, ${args.instrument_key}, ${args.category})`;
    return {
      content: [{ type: "text", text: `Added ${args.symbol} (${args.category}) to watchlist.` }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error adding to watchlist: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── remove-from-watchlist ────────────────────────────────────────────────────

export const removeFromWatchlistSchema = {
  symbol: z.string().min(1, "Stock symbol is required"),
};

interface RemoveFromWatchlistArgs {
  symbol: string;
}

export async function removeFromWatchlistHandler(
  args: RemoveFromWatchlistArgs,
  env: Env,
  agent: SqlAgent
): Promise<ToolResponse> {
  agent.sql`DELETE FROM watchlist WHERE symbol = ${args.symbol}`;
  return {
    content: [{ type: "text", text: `Removed ${args.symbol} from watchlist.` }],
  };
}

// ─── scan-watchlist (Multi-Strategy Scanner) ─────────────────────────────────

export const scanWatchlistSchema = {
  category: z.enum(["LARGECAP", "MIDCAP", "ALL"]).optional().describe("Filter by category (default: ALL)"),
};

interface ScanWatchlistArgs {
  category?: string;
}

type SignalType = "FRESH_BUY" | "RECENT_BUY" | "FRESH_SELL" | "RECENT_SELL" | "BULLISH" | "BEARISH" | "NEUTRAL";
type StrategyName = "BB_RSI" | "STOCH_RSI" | "RSI_OBOS" | "CANSLIM" | "DUAL_MOM" | "SUPERTREND";

interface Condition {
  label: string;
  threshold: number | string;
  current: number | string;
  met: boolean;
  gap: string;
  join?: "AND" | "OR";
}

interface StrategySignal {
  strategy: StrategyName;
  signal: SignalType;
  trigger_price: number | null;
  days_since: number | null;
  indicators: Record<string, number | string | Condition[]>;
}

interface StockResult {
  symbol: string;
  category: string;
  ltp: number;
  correction_from_52w_high_pct: number;
  invested: boolean;
  entry_strategy: string | null;
  entry_portfolio: string | null;
  entry_fingerprints: string[] | null;
  brokers: string[] | null;
  strategies: StrategySignal[];
  buy_count: number;
  sell_count: number;
  fresh_buy_count: number;
  fresh_sell_count: number;
  fresh_today: boolean;
  // Data quality fields
  data_source: "cache" | "api" | "mixed" | "failed";
  has_intraday: boolean;
  candle_count: number;
  last_candle_date: string;
}

// ─── Candle fetch helpers ───

async function fetchCandles(
  instrumentKey: string,
  env: Env
): Promise<Array<[string, number, number, number, number, number, number]> | null> {
  const today = new Date();
  const toDate = today.toISOString().slice(0, 10);
  const fromDate = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const encodedKey = encodeURIComponent(instrumentKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    // 1. Fetch historical daily candles (completed days only)
    const histUrl = `${UPSTOX_API_BASE_URL}/v2/historical-candle/${encodedKey}/day/${toDate}/${fromDate}`;
    const histResponse = await fetch(histUrl, {
      method: "GET",
      headers: { Accept: HEADERS.ACCEPT, Authorization: `Bearer ${env.UPSTOX_ACCESS_TOKEN}` },
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!histResponse.ok) return null;

    const histJson = (await histResponse.json()) as {
      data?: { candles?: Array<[string, number, number, number, number, number, number]> };
    };

    const candles = histJson.data?.candles || [];

    // 2. Fetch today's intraday candle (30min) and build today's OHLCV
    try {
      const intradayUrl = `${UPSTOX_API_BASE_URL}/v2/historical-candle/intraday/${encodedKey}/30minute`;
      const intradayResp = await fetch(intradayUrl, {
        method: "GET",
        headers: { Accept: HEADERS.ACCEPT, Authorization: `Bearer ${env.UPSTOX_ACCESS_TOKEN}` },
      });

      if (intradayResp.ok) {
        const intradayJson = (await intradayResp.json()) as {
          data?: { candles?: Array<[string, number, number, number, number, number, number]> };
        };
        const intradayCandles = intradayJson.data?.candles || [];

        if (intradayCandles.length > 0) {
          // Build today's daily candle from intraday bars
          const todayDate = toDate + "T00:00:00+05:30";
          let todayOpen = intradayCandles[intradayCandles.length - 1][1]; // earliest bar's open
          let todayHigh = -Infinity;
          let todayLow = Infinity;
          let todayClose = intradayCandles[0][4]; // latest bar's close
          let todayVolume = 0;

          for (const bar of intradayCandles) {
            if (bar[2] > todayHigh) todayHigh = bar[2];
            if (bar[3] < todayLow) todayLow = bar[3];
            todayVolume += bar[5];
          }

          const todayCandle: [string, number, number, number, number, number, number] =
            [todayDate, todayOpen, todayHigh, todayLow, todayClose, todayVolume, 0];

          candles.push(todayCandle);
        }
      }
    } catch {
      // Intraday fetch is best-effort — don't fail if it errors
    }

    if (candles.length === 0) return null;

    candles.sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());
    return candles;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

async function fetchLtpBatch(
  instrumentKeys: string[],
  env: Env
): Promise<Record<string, number>> {
  const ltpMap: Record<string, number> = {};
  if (instrumentKeys.length === 0) return ltpMap;

  const batchSize = 500;
  for (let i = 0; i < instrumentKeys.length; i += batchSize) {
    const batch = instrumentKeys.slice(i, i + batchSize);
    const keysParam = batch.join(",");
    const url = `${UPSTOX_API_BASE_URL}/v2/market-quote/ltp?instrument_key=${encodeURIComponent(keysParam)}`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: HEADERS.ACCEPT, Authorization: `Bearer ${env.UPSTOX_ACCESS_TOKEN}` },
      });
      if (!response.ok) continue;
      const json = (await response.json()) as {
        data?: Record<string, { last_price?: number; instrument_token?: string }>;
      };
      if (json.data) {
        for (const [, val] of Object.entries(json.data)) {
          const v = val as { last_price?: number; instrument_token?: string };
          if (v.last_price != null && v.instrument_token) {
            ltpMap[v.instrument_token] = v.last_price;
          }
        }
      }
    } catch { /* best-effort */ }
  }
  return ltpMap;
}

async function checkAuthStatus(env: Env): Promise<string> {
  try {
    // Decode JWT to check expiry directly
    const token = env.UPSTOX_ACCESS_TOKEN || "";
    let tokenExpiry = "";
    try {
      const payload = token.split(".")[1];
      const decoded = JSON.parse(atob(payload));
      const expDate = new Date(decoded.exp * 1000);
      const now = new Date();
      if (now > expDate) {
        return `EXPIRED (token died ${expDate.toISOString().slice(0, 10)}). REGENERATE NOW at login.upstox.com`;
      }
      tokenExpiry = ` (expires ${expDate.toISOString().slice(0, 16).replace('T', ' ')} IST)`;
    } catch { /* JWT decode failed — fall through to API check */ }

    const response = await fetch(`${UPSTOX_API_BASE_URL}/v2/user/profile`, {
      headers: { Accept: HEADERS.ACCEPT, Authorization: `Bearer ${env.UPSTOX_ACCESS_TOKEN}` },
    });
    return response.ok ? `VALID${tokenExpiry}` : "EXPIRED — API returned 401. Regenerate token.";
  } catch { return "EXPIRED — network error"; }
}

// ─── Helper: detect fresh/recent signal from a boolean condition ───

function classifyCondition(
  isBuyToday: boolean,
  isSellToday: boolean,
  wasBuyYesterday: boolean,
  wasSellYesterday: boolean,
  isBullishNow: boolean,
  closes: number[],
  last: number,
  lookback: number = 3
): { signal: SignalType; days_since: number | null; trigger_index: number | null } {
  // Fresh today
  if (isBuyToday && !wasBuyYesterday) return { signal: "FRESH_BUY", days_since: 0, trigger_index: last };
  if (isSellToday && !wasSellYesterday) return { signal: "FRESH_SELL", days_since: 0, trigger_index: last };

  // Recent (1-3 days)
  if (isBuyToday && wasBuyYesterday) {
    // Check when the condition first became true
    for (let d = 1; d <= lookback; d++) {
      if (last - d < 1) break;
      // If it was NOT true d+1 days ago, then the signal started d days ago
    }
    return { signal: "RECENT_BUY", days_since: 1, trigger_index: last - 1 };
  }
  if (isSellToday && wasSellYesterday) {
    return { signal: "RECENT_SELL", days_since: 1, trigger_index: last - 1 };
  }

  // Trend state
  if (isBullishNow) return { signal: "BULLISH", days_since: null, trigger_index: null };
  return { signal: "BEARISH", days_since: null, trigger_index: null };
}

// ─── Condition helpers ───
function pctGap(current: number, threshold: number): string {
  const pct = ((threshold - current) / current) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}
function ptsGap(current: number, threshold: number): string {
  const diff = threshold - current;
  return `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} pts`;
}
function r2(n: number): number { return Math.round(n * 100) / 100; }

// ─── 6 Strategy Classifiers (Backtested 2012-2026, survivorship-bias-free) ───
// PRIMARY: BB_RSI (6/6, 16d), STOCH_RSI (6/6, 101d), RSI_OBOS (6/6, 98d), CANSLIM (5/6, 30d), DUAL_MOM (5/6, 38d)
// CONDITIONAL: SUPERTREND (4/6, 44d)

function classifyBbRsi(
  upper: number[], middle: number[], lower: number[], rsiArr: number[],
  closes: number[], last: number
): StrategySignal {
  // BUY: price ≤ lower BB AND RSI < 30. SELL: price ≥ middle BB OR RSI > 70.
  const i = last;
  if (isNaN(lower[i]) || isNaN(rsiArr[i]) || isNaN(middle[i])) {
    return { strategy: "BB_RSI", signal: "NEUTRAL", trigger_price: null, days_since: null, indicators: {} };
  }

  const isBuy = closes[i] <= lower[i] && rsiArr[i] < 30;
  const isSell = closes[i] >= middle[i] || rsiArr[i] > 70;
  const wasBuy = i > 0 && !isNaN(lower[i-1]) && !isNaN(rsiArr[i-1]) && closes[i-1] <= lower[i-1] && rsiArr[i-1] < 30;
  const wasSell = i > 0 && !isNaN(middle[i-1]) && !isNaN(rsiArr[i-1]) && (closes[i-1] >= middle[i-1] || rsiArr[i-1] > 70);

  let signal: SignalType = "NEUTRAL";
  let days_since: number | null = null;

  if (isBuy && !wasBuy) { signal = "FRESH_BUY"; days_since = 0; }
  else if (isSell && !wasSell) { signal = "FRESH_SELL"; days_since = 0; }
  else if (isBuy) { signal = "RECENT_BUY"; days_since = 1; }
  else {
    for (let d = 1; d <= 3; d++) {
      const j = i - d;
      if (j < 1 || isNaN(lower[j]) || isNaN(rsiArr[j])) continue;
      if (closes[j] <= lower[j] && rsiArr[j] < 30) { signal = "RECENT_BUY"; days_since = d; break; }
    }
    if (signal === "NEUTRAL") signal = rsiArr[i] < 40 ? "BEARISH" : "BULLISH";
  }

  const curClose = r2(closes[i]);
  const curRsi = r2(rsiArr[i]);
  const lbb = r2(lower[i]);
  const mbb = r2(middle[i]);

  const buyConditions: Condition[] = [
    { label: "Price ≤ Lower BB", threshold: lbb, current: curClose, met: closes[i] <= lower[i], gap: pctGap(closes[i], lower[i]) },
    { label: "RSI < 30", threshold: 30, current: curRsi, met: rsiArr[i] < 30, gap: ptsGap(rsiArr[i], 30) },
  ];
  const sellConditions: Condition[] = [
    { label: "Price ≥ Middle BB", threshold: mbb, current: curClose, met: closes[i] >= middle[i], gap: pctGap(closes[i], middle[i]), join: "OR" },
    { label: "RSI > 70", threshold: 70, current: curRsi, met: rsiArr[i] > 70, gap: ptsGap(rsiArr[i], 70), join: "OR" },
  ];

  return {
    strategy: "BB_RSI", signal,
    trigger_price: (signal === "FRESH_BUY" || signal === "FRESH_SELL") ? curClose : null,
    days_since,
    indicators: {
      rsi: curRsi, lower_bb: lbb, middle_bb: mbb,
      buy_conditions: buyConditions, sell_conditions: sellConditions,
      buy_met: `${buyConditions.filter(c => c.met).length}/${buyConditions.length}`,
      sell_met: `${sellConditions.filter(c => c.met).length}/${sellConditions.length}`,
    },
  };
}

function classifyStochRsi(
  kArr: number[], dArr: number[], rsiArr: number[], last: number, closes: number[]
): StrategySignal {
  // BUY: %K(14)<20 AND RSI<35 AND %K crosses above %D. SELL: %K>80 AND RSI>65 AND %K crosses below %D.
  const i = last;
  if (isNaN(kArr[i]) || isNaN(dArr[i]) || isNaN(rsiArr[i])) {
    return { strategy: "STOCH_RSI", signal: "NEUTRAL", trigger_price: null, days_since: null, indicators: {} };
  }

  const isBuy = kArr[i] < 20 && rsiArr[i] < 35 && crossover(kArr, dArr, i);
  const isSell = kArr[i] > 80 && rsiArr[i] > 65 && crossunder(kArr, dArr, i);

  let signal: SignalType = "NEUTRAL";
  let days_since: number | null = null;

  if (isBuy) { signal = "FRESH_BUY"; days_since = 0; }
  else if (isSell) { signal = "FRESH_SELL"; days_since = 0; }
  else {
    for (let d = 1; d <= 3; d++) {
      const j = i - d;
      if (j < 1 || isNaN(kArr[j]) || isNaN(rsiArr[j])) continue;
      if (kArr[j] < 20 && rsiArr[j] < 35 && crossover(kArr, dArr, j)) { signal = "RECENT_BUY"; days_since = d; break; }
      if (kArr[j] > 80 && rsiArr[j] > 65 && crossunder(kArr, dArr, j)) { signal = "RECENT_SELL"; days_since = d; break; }
    }
    if (signal === "NEUTRAL") {
      if (kArr[i] < 30 && rsiArr[i] < 40) signal = "BEARISH";
      else if (kArr[i] > 70 && rsiArr[i] > 60) signal = "BULLISH";
      else signal = "NEUTRAL";
    }
  }

  const curK = r2(kArr[i]);
  const curD = r2(dArr[i]);
  const curRsi = r2(rsiArr[i]);
  const kAboveD = kArr[i] > dArr[i];

  const buyConditions: Condition[] = [
    { label: "%K < 20", threshold: 20, current: curK, met: kArr[i] < 20, gap: ptsGap(kArr[i], 20) },
    { label: "RSI < 35", threshold: 35, current: curRsi, met: rsiArr[i] < 35, gap: ptsGap(rsiArr[i], 35) },
    { label: "%K crosses above %D", threshold: `D=${curD}`, current: `K=${curK}`, met: kAboveD && i > 0 && kArr[i-1] <= dArr[i-1], gap: kAboveD ? "K > D" : `K below D by ${r2(dArr[i] - kArr[i])}` },
  ];
  const sellConditions: Condition[] = [
    { label: "%K > 80", threshold: 80, current: curK, met: kArr[i] > 80, gap: ptsGap(kArr[i], 80) },
    { label: "RSI > 65", threshold: 65, current: curRsi, met: rsiArr[i] > 65, gap: ptsGap(rsiArr[i], 65) },
    { label: "%K crosses below %D", threshold: `D=${curD}`, current: `K=${curK}`, met: !kAboveD && i > 0 && kArr[i-1] >= dArr[i-1], gap: !kAboveD ? "K < D" : `K above D by ${r2(kArr[i] - dArr[i])}` },
  ];

  return {
    strategy: "STOCH_RSI", signal,
    trigger_price: (signal === "FRESH_BUY" || signal === "FRESH_SELL") ? r2(closes[i]) : null,
    days_since,
    indicators: {
      k: curK, d: curD, rsi: curRsi,
      buy_conditions: buyConditions, sell_conditions: sellConditions,
      buy_met: `${buyConditions.filter(c => c.met).length}/${buyConditions.length}`,
      sell_met: `${sellConditions.filter(c => c.met).length}/${sellConditions.length}`,
    },
  };
}

function classifyRsiObos(
  rsiArr: number[], last: number, closes: number[]
): StrategySignal {
  // BUY: RSI crosses above 30 from below. SELL: RSI crosses below 70 from above.
  const i = last;
  if (isNaN(rsiArr[i]) || i < 1 || isNaN(rsiArr[i-1])) {
    return { strategy: "RSI_OBOS", signal: "NEUTRAL", trigger_price: null, days_since: null, indicators: {} };
  }

  const isBuy = rsiArr[i-1] <= 30 && rsiArr[i] > 30;
  const isSell = rsiArr[i-1] >= 70 && rsiArr[i] < 70;

  let signal: SignalType = "NEUTRAL";
  let days_since: number | null = null;

  if (isBuy) { signal = "FRESH_BUY"; days_since = 0; }
  else if (isSell) { signal = "FRESH_SELL"; days_since = 0; }
  else {
    for (let d = 1; d <= 3; d++) {
      const j = i - d;
      if (j < 1 || isNaN(rsiArr[j]) || isNaN(rsiArr[j-1])) continue;
      if (rsiArr[j-1] <= 30 && rsiArr[j] > 30) { signal = "RECENT_BUY"; days_since = d; break; }
      if (rsiArr[j-1] >= 70 && rsiArr[j] < 70) { signal = "RECENT_SELL"; days_since = d; break; }
    }
    if (signal === "NEUTRAL") {
      if (rsiArr[i] < 35) signal = "BEARISH";
      else if (rsiArr[i] > 65) signal = "BULLISH";
      else signal = "NEUTRAL";
    }
  }

  const curRsi = r2(rsiArr[i]);
  const prevRsi = i > 0 && !isNaN(rsiArr[i-1]) ? r2(rsiArr[i-1]) : null;
  const belowOS = rsiArr[i] <= 30;
  const aboveOB = rsiArr[i] >= 70;

  const buyConditions: Condition[] = [
    { label: "RSI was ≤ 30", threshold: 30, current: prevRsi ?? curRsi, met: prevRsi !== null && prevRsi <= 30, gap: belowOS ? "currently ≤ 30, waiting for bounce" : (curRsi < 35 ? `${ptsGap(curRsi, 30)} to oversold` : `far from oversold`) },
    { label: "RSI crosses back above 30", threshold: 30, current: curRsi, met: prevRsi !== null && prevRsi <= 30 && curRsi > 30, gap: belowOS ? "still below 30" : (prevRsi !== null && prevRsi <= 30 ? "crossed ✓" : "needs dip first") },
  ];
  const sellConditions: Condition[] = [
    { label: "RSI was ≥ 70", threshold: 70, current: prevRsi ?? curRsi, met: prevRsi !== null && prevRsi >= 70, gap: aboveOB ? "currently ≥ 70, waiting for drop" : `${ptsGap(curRsi, 70)} to overbought` },
    { label: "RSI crosses back below 70", threshold: 70, current: curRsi, met: prevRsi !== null && prevRsi >= 70 && curRsi < 70, gap: aboveOB ? "still above 70" : (prevRsi !== null && prevRsi >= 70 ? "crossed ✓" : "needs spike first") },
  ];

  return {
    strategy: "RSI_OBOS", signal,
    trigger_price: (signal === "FRESH_BUY" || signal === "FRESH_SELL") ? r2(closes[i]) : null,
    days_since,
    indicators: {
      rsi: curRsi,
      buy_conditions: buyConditions, sell_conditions: sellConditions,
      buy_met: `${buyConditions.filter(c => c.met).length}/${buyConditions.length}`,
      sell_met: `${sellConditions.filter(c => c.met).length}/${sellConditions.length}`,
    },
  };
}

function classifyCanslim(
  sma50Arr: number[], rsiArr: number[], volAvg20: number[], volumes: number[],
  highs: number[], closes: number[], last: number, entryPrice: number | null = null
): StrategySignal {
  // BUY: price > SMA50 AND vol > 1.5× avg AND within 10% of 52W high AND RSI 50-80
  // SELL: price < SMA50  OR  -8% hard stop from entry price (only for held positions — mirrors the backtest exit)
  const i = last;
  if (i < 252 || isNaN(sma50Arr[i]) || isNaN(rsiArr[i]) || isNaN(volAvg20[i]) || volAvg20[i] === 0) {
    return { strategy: "CANSLIM", signal: "NEUTRAL", trigger_price: null, days_since: null, indicators: {} };
  }

  const high52w = Math.max(...highs.slice(Math.max(0, i - 252), i + 1));
  const pctFromHigh = high52w > 0 ? ((high52w - closes[i]) / high52w) * 100 : 100;
  const aboveSma = closes[i] > sma50Arr[i];
  const highVol = volumes[i] > 1.5 * volAvg20[i];
  const rsiOk = rsiArr[i] >= 50 && rsiArr[i] <= 80;
  const nearHigh = pctFromHigh <= 10;

  const isBuy = aboveSma && highVol && nearHigh && rsiOk;
  const prevAboveSma = i > 0 && closes[i-1] > sma50Arr[i-1];
  // -8% protective stop: only meaningful when we actually hold the stock (entryPrice known).
  // Mirrors the backtest's in_pos "-8% from entry" exit that the live signal was missing.
  // Unlike the SMA50 cross (edge-triggered on the crossing day), the stop stays SELL every day
  // the position is ≥8% underwater, so the exit prompt persists until acted on.
  const lossPct = entryPrice != null && entryPrice > 0 ? ((closes[i] - entryPrice) / entryPrice) * 100 : null;
  const stopLossHit = lossPct != null && lossPct <= -8;
  const isSell = (!aboveSma && prevAboveSma) || stopLossHit;

  let signal: SignalType = "NEUTRAL";
  let days_since: number | null = null;

  if (isBuy) { signal = "FRESH_BUY"; days_since = 0; }
  else if (isSell) { signal = "FRESH_SELL"; days_since = 0; }
  else {
    for (let d = 1; d <= 3; d++) {
      const j = i - d;
      if (j < 252 || isNaN(sma50Arr[j]) || isNaN(rsiArr[j]) || isNaN(volAvg20[j]) || volAvg20[j] === 0) continue;
      const h52 = Math.max(...highs.slice(Math.max(0, j - 252), j + 1));
      const pfh = h52 > 0 ? ((h52 - closes[j]) / h52) * 100 : 100;
      if (closes[j] > sma50Arr[j] && volumes[j] > 1.5 * volAvg20[j] && pfh <= 10 && rsiArr[j] >= 50 && rsiArr[j] <= 80) {
        signal = "RECENT_BUY"; days_since = d; break;
      }
    }
    if (signal === "NEUTRAL") {
      signal = aboveSma ? "BULLISH" : "BEARISH";
    }
  }

  const curClose = r2(closes[i]);
  const curSma50 = r2(sma50Arr[i]);
  const curRsi = r2(rsiArr[i]);
  const curVolRatio = r2(volumes[i] / volAvg20[i]);
  const curPctHigh = r2(pctFromHigh);

  const buyConditions: Condition[] = [
    { label: "Price > SMA50", threshold: curSma50, current: curClose, met: aboveSma, gap: aboveSma ? `+${r2(((closes[i] - sma50Arr[i]) / sma50Arr[i]) * 100)}% above` : pctGap(closes[i], sma50Arr[i]) },
    { label: "Vol > 1.5x avg", threshold: "1.5x", current: `${curVolRatio}x`, met: highVol, gap: highVol ? `${curVolRatio}x ✓` : `need ${r2(1.5 - curVolRatio)}x more` },
    { label: "Within 10% of 52W High", threshold: "≤10%", current: `${curPctHigh}%`, met: nearHigh, gap: nearHigh ? `${curPctHigh}% ✓` : `${r2(pctFromHigh - 10)}% too far` },
    { label: "RSI 50-80", threshold: "50-80", current: curRsi, met: rsiOk, gap: rsiArr[i] < 50 ? ptsGap(rsiArr[i], 50) : (rsiArr[i] > 80 ? ptsGap(rsiArr[i], 80) : "in range ✓") },
  ];
  const sellConditions: Condition[] = [
    { label: "Price < SMA50", threshold: curSma50, current: curClose, met: !aboveSma, gap: aboveSma ? `+${r2(((closes[i] - sma50Arr[i]) / sma50Arr[i]) * 100)}% above` : `${r2(((sma50Arr[i] - closes[i]) / sma50Arr[i]) * 100)}% below` },
  ];
  // Surface the -8% stop only when we know the entry price (i.e. it's a held position)
  if (lossPct != null) {
    sellConditions.push({
      label: "-8% stop from entry",
      threshold: entryPrice != null ? `≤ ${r2(entryPrice * 0.92)}` : "-8%",
      current: curClose,
      met: stopLossHit,
      gap: stopLossHit ? `${r2(lossPct)}% — STOP HIT` : `${r2(lossPct)}% from entry`,
    });
  }

  return {
    strategy: "CANSLIM", signal,
    trigger_price: (signal === "FRESH_BUY" || signal === "FRESH_SELL") ? curClose : null,
    days_since,
    indicators: {
      sma50: curSma50, rsi: curRsi, pct_from_high: curPctHigh, vol_ratio: curVolRatio,
      buy_conditions: buyConditions, sell_conditions: sellConditions,
      buy_met: `${buyConditions.filter(c => c.met).length}/${buyConditions.length}`,
      sell_met: `${sellConditions.filter(c => c.met).length}/${sellConditions.length}`,
    },
  };
}

function classifyDualMom(
  sma200Arr: number[], macdLineArr: number[], highs: number[], closes: number[], last: number
): StrategySignal {
  // BUY: price > SMA200 AND in top 75% of 52W range AND MACD > 0
  // SELL: price < SMA200 OR below 50% range OR MACD < 0
  const i = last;
  if (i < 252 || isNaN(sma200Arr[i]) || isNaN(macdLineArr[i])) {
    return { strategy: "DUAL_MOM", signal: "NEUTRAL", trigger_price: null, days_since: null, indicators: {} };
  }

  const high52w = Math.max(...highs.slice(Math.max(0, i - 252), i + 1));
  const low52w = Math.min(...closes.slice(Math.max(0, i - 252), i + 1));
  const range52w = high52w - low52w;
  const pctInRange = range52w > 0 ? ((closes[i] - low52w) / range52w) * 100 : 50;
  const aboveSma200 = closes[i] > sma200Arr[i];
  const macdPos = macdLineArr[i] > 0;

  const isBuy = aboveSma200 && pctInRange >= 75 && macdPos;
  const isSell = !aboveSma200 || pctInRange < 50 || !macdPos;

  // Check if state changed
  let prevBuy = false;
  let prevSell = false;
  if (i > 0 && !isNaN(sma200Arr[i-1]) && !isNaN(macdLineArr[i-1])) {
    const pH52 = Math.max(...highs.slice(Math.max(0, i - 1 - 252), i));
    const pL52 = Math.min(...closes.slice(Math.max(0, i - 1 - 252), i));
    const pR = pH52 - pL52;
    const pPct = pR > 0 ? ((closes[i-1] - pL52) / pR) * 100 : 50;
    prevBuy = closes[i-1] > sma200Arr[i-1] && pPct >= 75 && macdLineArr[i-1] > 0;
    prevSell = !prevBuy;
  }

  let signal: SignalType = "NEUTRAL";
  let days_since: number | null = null;

  if (isBuy && !prevBuy) { signal = "FRESH_BUY"; days_since = 0; }
  else if (isSell && !prevSell) { signal = "FRESH_SELL"; days_since = 0; }
  else if (isBuy) { signal = "BULLISH"; }
  else { signal = "BEARISH"; }

  const curClose = r2(closes[i]);
  const curSma200 = r2(sma200Arr[i]);
  const curMacd = r2(macdLineArr[i]);
  const curPctRange = r2(pctInRange);

  const buyConditions: Condition[] = [
    { label: "Price > SMA200", threshold: curSma200, current: curClose, met: aboveSma200, gap: aboveSma200 ? `+${r2(((closes[i] - sma200Arr[i]) / sma200Arr[i]) * 100)}% above` : pctGap(closes[i], sma200Arr[i]) },
    { label: "52W Range ≥ 75%", threshold: "75%", current: `${curPctRange}%`, met: pctInRange >= 75, gap: pctInRange >= 75 ? `${curPctRange}% ✓` : `need +${r2(75 - pctInRange)}%` },
    { label: "MACD > 0", threshold: 0, current: curMacd, met: macdPos, gap: macdPos ? `+${curMacd} ✓` : `${curMacd} (need +${r2(-macdLineArr[i])})` },
  ];
  const sellConditions: Condition[] = [
    { label: "Price < SMA200", threshold: curSma200, current: curClose, met: !aboveSma200, gap: aboveSma200 ? `+${r2(((closes[i] - sma200Arr[i]) / sma200Arr[i]) * 100)}% above` : `${r2(((sma200Arr[i] - closes[i]) / sma200Arr[i]) * 100)}% below`, join: "OR" },
    { label: "52W Range < 50%", threshold: "50%", current: `${curPctRange}%`, met: pctInRange < 50, gap: pctInRange < 50 ? `${curPctRange}% ✓` : `${r2(pctInRange - 50)}% above threshold`, join: "OR" },
    { label: "MACD < 0", threshold: 0, current: curMacd, met: !macdPos, gap: macdPos ? `+${curMacd}` : `${curMacd} ✓`, join: "OR" },
  ];

  return {
    strategy: "DUAL_MOM", signal,
    trigger_price: (signal === "FRESH_BUY" || signal === "FRESH_SELL") ? curClose : null,
    days_since,
    indicators: {
      sma200: curSma200, macd: curMacd, pct_52w_range: curPctRange,
      buy_conditions: buyConditions, sell_conditions: sellConditions,
      buy_met: `${buyConditions.filter(c => c.met).length}/${buyConditions.length}`,
      sell_met: `${sellConditions.filter(c => c.met).length}/${sellConditions.length}`,
    },
  };
}

function classifySupertrend(
  stArr: number[], dirArr: number[], closes: number[], last: number
): StrategySignal {
  const i = last;
  if (dirArr[i] === 0 || dirArr[i - 1] === undefined) {
    return { strategy: "SUPERTREND", signal: "NEUTRAL", trigger_price: null, days_since: null, indicators: {} };
  }

  const isBuyFlip = dirArr[i] === 1 && dirArr[i - 1] === -1;
  const isSellFlip = dirArr[i] === -1 && dirArr[i - 1] === 1;

  let signal: SignalType = "NEUTRAL";
  let days_since: number | null = null;

  if (isBuyFlip) { signal = "FRESH_BUY"; days_since = 0; }
  else if (isSellFlip) { signal = "FRESH_SELL"; days_since = 0; }
  else {
    for (let d = 1; d <= 3; d++) {
      const j = i - d;
      if (j < 1) break;
      if (dirArr[j] === 1 && dirArr[j - 1] === -1 && dirArr[i] === 1) { signal = "RECENT_BUY"; days_since = d; break; }
      if (dirArr[j] === -1 && dirArr[j - 1] === 1 && dirArr[i] === -1) { signal = "RECENT_SELL"; days_since = d; break; }
    }
    if (signal === "NEUTRAL") signal = dirArr[i] === 1 ? "BULLISH" : "BEARISH";
  }

  const curClose = r2(closes[i]);
  const curST = r2(stArr[i] || 0);
  const curDir = dirArr[i];
  const isBullish = curDir === 1;

  const buyConditions: Condition[] = [
    { label: "Price crosses above Supertrend", threshold: curST, current: curClose, met: isBuyFlip, gap: isBullish ? "already bullish" : pctGap(closes[i], stArr[i] || closes[i]) },
  ];
  const sellConditions: Condition[] = [
    { label: "Price crosses below Supertrend", threshold: curST, current: curClose, met: isSellFlip, gap: !isBullish ? "already bearish" : pctGap(closes[i], stArr[i] || closes[i]) },
  ];

  return {
    strategy: "SUPERTREND", signal,
    trigger_price: (signal === "FRESH_BUY" || signal === "FRESH_SELL") ? curClose : null,
    days_since,
    indicators: {
      supertrend: curST, direction: curDir,
      buy_conditions: buyConditions, sell_conditions: sellConditions,
      buy_met: `${buyConditions.filter(c => c.met).length}/${buyConditions.length}`,
      sell_met: `${sellConditions.filter(c => c.met).length}/${sellConditions.length}`,
    },
  };
}

// ─── Smart Candle Functions (SQLite cache + intraday) ───

function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  // Skip weekends
  if (d.getDay() === 0) d.setDate(d.getDate() - 2); // Sunday → Friday
  if (d.getDay() === 6) d.setDate(d.getDate() - 1); // Saturday → Friday
  return d.toISOString().slice(0, 10);
}

function readCachedCandles(
  agent: SqlAgent,
  symbol: string
): Array<{ trade_date: string; open: number; high: number; low: number; close: number; volume: number; oi: number }> {
  return [...agent.sql`SELECT trade_date, open, high, low, close, volume, oi FROM candle_cache WHERE symbol = ${symbol} ORDER BY trade_date`] as any[];
}

function getLastCachedDate(agent: SqlAgent, symbol: string): string | null {
  const rows = [...agent.sql`SELECT MAX(trade_date) as last_date FROM candle_cache WHERE symbol = ${symbol}`] as any[];
  return rows[0]?.last_date || null;
}

function insertCandles(
  agent: SqlAgent,
  symbol: string,
  candles: Array<[string, number, number, number, number, number, number]>
) {
  for (const c of candles) {
    const date = c[0].slice(0, 10);
    agent.sql`INSERT OR IGNORE INTO candle_cache (symbol, trade_date, open, high, low, close, volume, oi)
      VALUES (${symbol}, ${date}, ${c[1]}, ${c[2]}, ${c[3]}, ${c[4]}, ${c[5]}, ${c[6] ?? 0})`;
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  label: string,
  timeoutMs = 15000,
  maxRetries = 3
): Promise<Response | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
      clearTimeout(timeout);

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const backoffMs = retryAfter ? parseInt(retryAfter) * 1000 : 1000 * Math.pow(2, attempt);
        if (attempt < maxRetries) {
          console.warn(`[${label}] 429 rate-limited, retry ${attempt + 1}/${maxRetries} after ${backoffMs}ms`);
          await sleep(backoffMs);
          continue;
        }
        const body = await response.text().catch(() => "");
        console.error(`[${label}] FAILED after ${maxRetries} retries — HTTP 429 | ${body.slice(0, 200)}`);
        return null;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.error(`[${label}] FAILED — HTTP ${response.status} ${response.statusText} | ${body.slice(0, 200)}`);
        return null;
      }

      return response;
    } catch (err) {
      if (attempt < maxRetries) {
        const backoffMs = 1000 * Math.pow(2, attempt);
        console.warn(`[${label}] error, retry ${attempt + 1}/${maxRetries} after ${backoffMs}ms —`, err instanceof Error ? err.message : err);
        await sleep(backoffMs);
        continue;
      }
      console.error(`[${label}] ERROR after ${maxRetries} retries —`, err instanceof Error ? err.message : err);
      return null;
    }
  }
  return null;
}

async function fetchHistoricalGap(
  instrumentKey: string,
  env: Env,
  fromDate: string,
  toDate: string
): Promise<Array<[string, number, number, number, number, number, number]>> {
  const encodedKey = encodeURIComponent(instrumentKey);
  const url = `${UPSTOX_API_BASE_URL}/v2/historical-candle/${encodedKey}/day/${toDate}/${fromDate}`;
  const response = await fetchWithRetry(
    url,
    { Accept: HEADERS.ACCEPT, Authorization: `Bearer ${env.UPSTOX_ACCESS_TOKEN}` },
    `fetchHistoricalGap ${instrumentKey}`
  );
  if (!response) return [];
  const json = (await response.json()) as {
    data?: { candles?: Array<[string, number, number, number, number, number, number]> };
  };
  return json.data?.candles || [];
}

async function fetchIntradayCandle(
  instrumentKey: string,
  env: Env
): Promise<[string, number, number, number, number, number, number] | null> {
  const encodedKey = encodeURIComponent(instrumentKey);
  const url = `${UPSTOX_API_BASE_URL}/v2/historical-candle/intraday/${encodedKey}/30minute`;
  const response = await fetchWithRetry(
    url,
    { Accept: HEADERS.ACCEPT, Authorization: `Bearer ${env.UPSTOX_ACCESS_TOKEN}` },
    `fetchIntradayCandle ${instrumentKey}`,
    10000
  );
  if (!response) return null;
  const json = (await response.json()) as {
    data?: { candles?: Array<[string, number, number, number, number, number, number]> };
  };
  const bars = json.data?.candles || [];
  if (bars.length === 0) return null;

  // Build daily OHLCV from 30min bars
  const todayStr = new Date().toISOString().slice(0, 10) + "T00:00:00+05:30";
  let todayOpen = bars[bars.length - 1][1]; // earliest bar's open
  let todayHigh = -Infinity, todayLow = Infinity;
  let todayClose = bars[0][4]; // latest bar's close
  let todayVolume = 0;
  for (const bar of bars) {
    if (bar[2] > todayHigh) todayHigh = bar[2];
    if (bar[3] < todayLow) todayLow = bar[3];
    todayVolume += bar[5];
  }
  return [todayStr, todayOpen, todayHigh, todayLow, todayClose, todayVolume, 0];
}

async function getSmartCandles(
  symbol: string,
  instrumentKey: string,
  env: Env,
  agent: SqlAgent,
  skipIntraday = false
): Promise<{ candles: Array<[string, number, number, number, number, number, number]>; source: "cache" | "api" | "mixed"; hasIntraday: boolean }> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = getYesterday();

  // 1. Read cached historical
  const cached = readCachedCandles(agent, symbol);
  const lastCachedDate = cached.length > 0 ? cached[cached.length - 1].trade_date : null;

  let historicalCandles: Array<[string, number, number, number, number, number, number]> = cached.map(c =>
    [c.trade_date + "T00:00:00+05:30", c.open, c.high, c.low, c.close, c.volume, c.oi] as [string, number, number, number, number, number, number]
  );

  let source: "cache" | "api" | "mixed" = "cache";

  // 2. Gap-fill if needed
  if (!lastCachedDate) {
    // Empty cache → fetch full 1yr
    const fromDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const candles = await fetchHistoricalGap(instrumentKey, env, fromDate, today);
    if (candles.length > 0) {
      // Filter out today's date (we'll get it via intraday)
      const historical = candles.filter(c => !c[0].startsWith(today));
      historical.sort((a, b) => a[0].localeCompare(b[0]));
      insertCandles(agent, symbol, historical);
      historicalCandles = historical;
      source = "api";
    }
  } else if (lastCachedDate < yesterday) {
    // Stale → fetch only the gap
    const gapFrom = lastCachedDate; // day after last cached
    const candles = await fetchHistoricalGap(instrumentKey, env, gapFrom, today);
    if (candles.length > 0) {
      const newCandles = candles.filter(c => {
        const d = c[0].slice(0, 10);
        return d > lastCachedDate && d < today;
      });
      newCandles.sort((a, b) => a[0].localeCompare(b[0]));
      insertCandles(agent, symbol, newCandles);
      historicalCandles = [...historicalCandles, ...newCandles];
      source = "mixed";
    }
  }
  // else: cache is fresh (up to yesterday or today) → no historical fetch needed

  // 3. Fetch intraday candle to get today's data for strategy calculation
  let hasIntraday = false;
  if (!skipIntraday) {
    try {
      const todayCandle = await fetchIntradayCandle(instrumentKey, env);
      if (todayCandle) {
        // Remove any historical candle for today (in case of overlap)
        historicalCandles = historicalCandles.filter(c => !c[0].startsWith(today));
        historicalCandles.push(todayCandle);
        historicalCandles.sort((a, b) => a[0].localeCompare(b[0]));
        hasIntraday = true;
      }
    } catch {
      // Best-effort — strategies will use yesterday's close if intraday fails
    }
  }

  return { candles: historicalCandles, source, hasIntraday };
}

// ─── Corporate-action guard ───
// Demergers are NOT back-adjusted by the historical feed and show up as an impossible single-session gap
// (a real NSE equity can't move >25% in one day — circuit limits cap it). Indicators computed across such
// a price cliff produce false signals — e.g. a demerged stock (VEDL -65%, TMPV -40%) looks crashed, so
// price falls "below the lower Bollinger Band" and RSI tanks → a fake oversold BUY. Return the series from
// the most recent such gap onward so indicators only see the clean post-action regime. Splits/bonuses are
// already adjusted upstream and stay well under the threshold. Freshly-demerged names end up with <60
// clean candles and are skipped by the guard below (emitting no signal beats emitting a wrong one).
const CORP_ACTION_GAP_THRESHOLD = 0.25;
function stripPreCorpActionCandles(
  candles: Array<[string, number, number, number, number, number, number]>
): Array<[string, number, number, number, number, number, number]> {
  let cutIdx = 0;
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1][4];
    if (prevClose > 0 && Math.abs(candles[i][4] - prevClose) / prevClose > CORP_ACTION_GAP_THRESHOLD) {
      cutIdx = i; // keep from the gap day (the new, post-action price level) onward
    }
  }
  return cutIdx > 0 ? candles.slice(cutIdx) : candles;
}

// ─── Main Scanner Handler ───

export async function scanWatchlistHandler(
  args: ScanWatchlistArgs,
  env: Env,
  agent: SqlAgent
): Promise<ToolResponse> {
  try {
    const authStatus = await checkAuthStatus(env);

    const cat = args.category || "ALL";
    let rows: any[];
    if (cat === "ALL") {
      rows = [...agent.sql`SELECT symbol, instrument_key, category FROM watchlist ORDER BY category, symbol`];
    } else {
      rows = [...agent.sql`SELECT symbol, instrument_key, category FROM watchlist WHERE category = ${cat} ORDER BY symbol`];
    }

    const posRows = [...agent.sql`SELECT symbol, SUM(CASE WHEN action='BUY' THEN quantity ELSE -quantity END) as net_qty FROM positions GROUP BY symbol HAVING net_qty > 0`];
    const invested = new Set((posRows as any[]).map((r: any) => r.symbol));

    // Which broker(s) currently hold each stock — net qty > 0 per (symbol, broker).
    // Feeds the broker badge stacked in the scanner's Entry cell. MANUAL is dropped (mirrors the trade-history badge).
    const brokerRows = [...agent.sql`SELECT symbol, broker, SUM(CASE WHEN action='BUY' THEN quantity ELSE -quantity END) as net_qty FROM positions GROUP BY symbol, broker HAVING net_qty > 0`];
    const brokerMap = new Map<string, string[]>();
    for (const r of brokerRows as any[]) {
      if (!r.broker || r.broker === 'MANUAL') continue;
      if (!brokerMap.has(r.symbol)) brokerMap.set(r.symbol, []);
      brokerMap.get(r.symbol)!.push(r.broker);
    }

    // Weighted-avg entry price for currently-held stocks → feeds the CANSLIM -8% protective stop.
    // Only held stocks (net_qty > 0) get an entry price; everything else passes null (no stop).
    const entryPriceRows = [...agent.sql`SELECT symbol,
        SUM(CASE WHEN action='BUY' THEN price * quantity ELSE 0 END) as buy_cost,
        SUM(CASE WHEN action='BUY' THEN quantity ELSE 0 END) as buy_qty,
        SUM(CASE WHEN action='BUY' THEN quantity ELSE -quantity END) as net_qty
      FROM positions GROUP BY symbol HAVING net_qty > 0`];
    const entryPriceMap = new Map<string, number>();
    for (const r of entryPriceRows as any[]) {
      if (r.buy_qty > 0) entryPriceMap.set(r.symbol, r.buy_cost / r.buy_qty);
    }

    // Get entry strategies + fingerprints for invested stocks
    const entryStratRows = [...agent.sql`SELECT p.symbol, p.signal_strategy, p.signal_fingerprint, p.portfolio FROM positions p
      INNER JOIN (SELECT symbol, MAX(id) as max_id FROM positions WHERE action='BUY' AND (signal_strategy IS NOT NULL OR signal_fingerprint IS NOT NULL) GROUP BY symbol) latest
      ON p.id = latest.max_id`];
    const entryStratMap = new Map<string, { strategy: string | null; portfolio: string; fingerprint: string | null }>();
    for (const r of entryStratRows as any[]) {
      entryStratMap.set(r.symbol, { strategy: r.signal_strategy, portfolio: r.portfolio, fingerprint: r.signal_fingerprint || null });
    }
    // Also collect ALL fingerprints per symbol (multiple buys)
    const allFpRows = [...agent.sql`SELECT symbol, signal_fingerprint FROM positions WHERE action='BUY' AND signal_fingerprint IS NOT NULL ORDER BY symbol, id`] as any[];
    const allFpMap = new Map<string, string[]>();
    for (const r of allFpRows) {
      if (!allFpMap.has(r.symbol)) allFpMap.set(r.symbol, []);
      allFpMap.get(r.symbol)!.push(r.signal_fingerprint);
    }

    const results: StockResult[] = [];
    const errors: string[] = [];
    let cacheHits = 0;
    let apiFetches = 0;
    let intradayOk = 0;
    let intradayFail = 0;

    // Parallel processing in batches of 3 with 1s delay between batches to avoid 429s
    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 1000;
    const allRows = rows as any[];
    let skipIntraday = false;           // early-terminate intraday if API is down
    let consecutiveIntradayFails = 0;
    const INTRADAY_FAIL_THRESHOLD = 10; // after 10 consecutive fails, stop trying

    for (let batchStart = 0; batchStart < allRows.length; batchStart += BATCH_SIZE) {
      // Delay between batches to respect Upstox rate limits
      if (batchStart > 0) await sleep(BATCH_DELAY_MS);
      const batch = allRows.slice(batchStart, batchStart + BATCH_SIZE);
      const candleResults = await Promise.all(
        batch.map(row => getSmartCandles(row.symbol, row.instrument_key, env, agent, skipIntraday).catch(err => {
          console.error(`[getSmartCandles] CRASH ${row.symbol} (${row.instrument_key}) —`, err instanceof Error ? err.message : err);
          return null;
        }))
      );

      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const result = candleResults[j];
        let rawCandles = result?.candles;

        if (result) {
          if (result.source === "cache") cacheHits++;
          else apiFetches++;
          // Intraday is counted separately in Phase 2 below
        }

      // Corporate-action guard: drop history before an unadjusted demerger gap (see helper above).
      if (rawCandles && rawCandles.length > 1) {
        rawCandles = stripPreCorpActionCandles(rawCandles);
      }

      if (!rawCandles || rawCandles.length < 60) {
        const reason = !result ? "getSmartCandles returned null" : `only ${rawCandles?.length ?? 0} candles`;
        console.error(`[scan] SKIP ${row.symbol} — ${reason}`);
        errors.push(`${row.symbol}: insufficient data (${rawCandles?.length ?? 0} candles)`);
        continue;
      }

      const closes = rawCandles.map(c => c[4]);
      const highs = rawCandles.map(c => c[2]);
      const lows = rawCandles.map(c => c[3]);
      const last = closes.length - 1;

      // Build Candle[] for indicator functions that need it
      const candleObjs: Candle[] = rawCandles.map(c => ({
        timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5], oi: c[6] ?? 0,
      }));

      // Compute all indicators once
      const volumes = rawCandles.map(c => c[5]);
      const rsiArr = rsi(closes, 14);
      const sma50Arr = sma(closes, 50);
      const sma200Arr = sma(closes, 200);
      const bbResult = bollingerBands(closes, 20, 2);
      const stochResult = stochastic(candleObjs, 14, 3);  // K=14 for STOCH_RSI_DBL
      const volAvg20 = sma(volumes, 20);
      const macdResult = macd(closes, 12, 26, 9);
      const stResult = supertrend(candleObjs, 10, 3);

      // Classify all 6 strategies
      const strategies: StrategySignal[] = [
        classifyBbRsi(bbResult.upper, bbResult.middle, bbResult.lower, rsiArr, closes, last),
        classifyStochRsi(stochResult.k, stochResult.d, rsiArr, last, closes),
        classifyRsiObos(rsiArr, last, closes),
        classifyCanslim(sma50Arr, rsiArr, volAvg20, volumes, highs, closes, last, entryPriceMap.get(row.symbol) ?? null),
        classifyDualMom(sma200Arr, macdResult.macdLine, highs, closes, last),
        classifySupertrend(stResult.supertrend, stResult.direction, closes, last),
      ];

      const buyCount = strategies.filter(s => s.signal.includes("BUY")).length;
      const sellCount = strategies.filter(s => s.signal.includes("SELL")).length;
      const freshBuyCount = strategies.filter(s => s.signal === "FRESH_BUY").length;
      const freshSellCount = strategies.filter(s => s.signal === "FRESH_SELL").length;
      const freshToday = freshBuyCount > 0 || freshSellCount > 0;

      // 52-week high
      const lookback = Math.min(252, highs.length);
      const high52w = Math.max(...highs.slice(-lookback));
      const correctionPct = ((high52w - closes[last]) / high52w) * 100;

      results.push({
        symbol: row.symbol,
        category: row.category,
        ltp: Math.round(closes[last] * 100) / 100,
        correction_from_52w_high_pct: Math.round(correctionPct * 100) / 100,
        invested: invested.has(row.symbol),
        entry_strategy: entryStratMap.get(row.symbol)?.strategy || null,
        entry_portfolio: entryStratMap.get(row.symbol)?.portfolio || (invested.has(row.symbol) ? 'LEGACY' : null),
        entry_fingerprints: allFpMap.get(row.symbol) || null,
        brokers: brokerMap.get(row.symbol) || null,
        strategies,
        buy_count: buyCount,
        sell_count: sellCount,
        fresh_buy_count: freshBuyCount,
        fresh_sell_count: freshSellCount,
        fresh_today: freshToday,
        data_source: result?.source || "failed",
        has_intraday: result?.hasIntraday || false,
        candle_count: rawCandles.length,
        last_candle_date: rawCandles[last][0].slice(0, 10),
      });

      } // end for j (stock in batch)

      // Early-terminate intraday if API appears down (all recent fetches failed)
      if (!skipIntraday) {
        const batchIntradayFailed = candleResults.filter(r => r && !r.hasIntraday).length;
        if (batchIntradayFailed === batch.length) {
          consecutiveIntradayFails += batch.length;
        } else {
          consecutiveIntradayFails = 0;
        }
        if (consecutiveIntradayFails >= INTRADAY_FAIL_THRESHOLD) {
          console.error(`[scan] Intraday early-termination triggered after ${consecutiveIntradayFails} consecutive failures at batch ${Math.floor(batchStart / BATCH_SIZE)}`);
          skipIntraday = true;
        }
      }
    } // end for batchStart (batch loop)

    // ── Phase 2: Count intraday stats (intraday already fetched in getSmartCandles) ──
    for (const r of results) {
      if (r.has_intraday) intradayOk++;
      else intradayFail++;
    }

    // Fetch live LTP
    const instrumentKeyMap: Record<string, string> = {};
    for (const row of rows as any[]) { instrumentKeyMap[row.instrument_key] = row.symbol; }
    const ltpData = await fetchLtpBatch(Object.keys(instrumentKeyMap), env);

    for (const r of results) {
      const ikEntry = (rows as any[]).find((row: any) => row.symbol === r.symbol);
      if (ikEntry) {
        const liveLtp = ltpData[ikEntry.instrument_key];
        if (liveLtp != null) { r.ltp = Math.round(liveLtp * 100) / 100; }
      }
    }

    // Sort: FRESH BUY first → FRESH SELL (invested) → high buy_count → rest
    results.sort((a, b) => {
      // 1. Clean FRESH BUY (no conflicts) at very top
      const aClean = a.fresh_buy_count > 0 && a.sell_count === 0;
      const bClean = b.fresh_buy_count > 0 && b.sell_count === 0;
      if (aClean !== bClean) return aClean ? -1 : 1;
      // 2. Conflicted FRESH BUY next
      if (a.fresh_buy_count !== b.fresh_buy_count) return b.fresh_buy_count - a.fresh_buy_count;
      // 3. FRESH SELL on invested stocks (action needed)
      const aSell = a.fresh_sell_count > 0 && a.invested ? 1 : 0;
      const bSell = b.fresh_sell_count > 0 && b.invested ? 1 : 0;
      if (aSell !== bSell) return bSell - aSell;
      // 4. Higher buy count wins
      if (a.buy_count !== b.buy_count) return b.buy_count - a.buy_count;
      // 5. Fewer sells = better
      return a.sell_count - b.sell_count;
    });

    // ── Persist scan snapshot (full strategy fingerprint per stock) ──
    const scanDate = new Date().toISOString().slice(0, 10);
    const scanTime = new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });

    for (const r of results) {
      const stratMap: Record<string, string> = {};
      for (const s of r.strategies) { stratMap[s.strategy] = s.signal; }

      const STRAT_ORDER = ["BB_RSI", "STOCH_RSI", "RSI_OBOS", "CANSLIM", "DUAL_MOM", "SUPERTREND"] as const;
      const fingerprint = STRAT_ORDER
        .map(name => {
          const sig = stratMap[name] || "N/A";
          const star = sig.includes("BUY") ? "*" : "";
          const short = sig === "NEUTRAL" ? "-" : sig;
          return `${name}:${short}${star}`;
        })
        .join(" | ");

      agent.sql`INSERT INTO scan_snapshots (symbol, scan_date, scan_time, ltp, bb_rsi, stoch_rsi, rsi_obos, canslim, dual_mom, supertrend, fingerprint, buy_count, sell_count)
        VALUES (${r.symbol}, ${scanDate}, ${scanTime}, ${r.ltp},
          ${stratMap["BB_RSI"] || null}, ${stratMap["STOCH_RSI"] || null}, ${stratMap["RSI_OBOS"] || null},
          ${stratMap["CANSLIM"] || null}, ${stratMap["DUAL_MOM"] || null}, ${stratMap["SUPERTREND"] || null},
          ${fingerprint}, ${r.buy_count}, ${r.sell_count})`;
    }

    // Summary with detailed data quality info
    const noIntradaySymbols = results.filter(r => !r.has_intraday).map(r => r.symbol);
    const staleSymbols = results.filter(r => {
      const today = new Date().toISOString().slice(0, 10);
      return r.last_candle_date < today && !r.has_intraday;
    }).map(r => ({ symbol: r.symbol, last_date: r.last_candle_date }));

    const summary = {
      total_watchlist: allRows.length,
      total_scanned: results.length,
      fresh_today: results.filter(r => r.fresh_today).length,
      with_buys: results.filter(r => r.buy_count > 0).length,
      with_sells: results.filter(r => r.sell_count > 0).length,
      // Data quality
      data: {
        cache_hits: cacheHits,
        api_fetches: apiFetches,
        total_fetched: cacheHits + apiFetches,
      },
      intraday: {
        success: intradayOk,
        failed: intradayFail,
        skipped: skipIntraday,
        failed_symbols: noIntradaySymbols.length <= 30 ? noIntradaySymbols : noIntradaySymbols.slice(0, 30),
      },
      failed: {
        count: errors.length,
        stocks: errors,
      },
      stale: {
        count: staleSymbols.length,
        stocks: staleSymbols.length <= 20 ? staleSymbols : staleSymbols.slice(0, 20),
      },
      scan_time: new Date().toISOString(),
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          auth_status: authStatus,
          scanned: results.length,
          summary,
          stocks: results,
        }, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ scan_error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : "" }) }],
      isError: true,
    };
  }
}

// ─── backfill-snapshots ──────────────────────────────────────────────────────
// Replays classifiers on cached candle data for past dates to generate historical
// scan snapshots. Then stamps signal_fingerprint on BUY trades that match.

export const backfillSnapshotsSchema = {
  dates: z.array(z.string()).optional().describe("Specific dates to backfill (YYYY-MM-DD). Omit to auto-detect all BUY trade dates missing snapshots."),
};

export async function backfillSnapshotsHandler(
  args: { dates?: string[] },
  env: Env,
  agent: SqlAgent
): Promise<ToolResponse> {
  try {
    // Determine which dates to backfill
    let targetDates: string[];
    if (args.dates && args.dates.length > 0) {
      targetDates = args.dates.sort();
    } else {
      // Find all BUY trade dates that have no scan_snapshot yet
      const rows = [...agent.sql`SELECT DISTINCT p.trade_date FROM positions p
        WHERE p.action = 'BUY' AND p.signal_fingerprint IS NULL
        AND NOT EXISTS (SELECT 1 FROM scan_snapshots s WHERE s.scan_date = p.trade_date)
        ORDER BY p.trade_date`] as any[];
      targetDates = rows.map((r: any) => r.trade_date);
    }

    if (targetDates.length === 0) {
      return { content: [{ type: "text", text: JSON.stringify({ message: "No dates need backfilling — all BUY trades already have snapshots." }) }] };
    }

    // Get all watchlist symbols
    const watchlistRows = [...agent.sql`SELECT symbol FROM watchlist ORDER BY symbol`] as any[];
    const symbols = watchlistRows.map((r: any) => r.symbol as string);

    let totalSnapshots = 0;
    let totalTagged = 0;
    const dateResults: any[] = [];

    for (const date of targetDates) {
      let dateSnapshots = 0;
      let dateTagged = 0;
      let dateSkipped = 0;

      for (const symbol of symbols) {
        // Read cached candles up to this date (inclusive)
        const candles = [...agent.sql`SELECT trade_date, open, high, low, close, volume, oi
          FROM candle_cache WHERE symbol = ${symbol} AND trade_date <= ${date}
          ORDER BY trade_date`] as any[];

        if (candles.length < 60) {
          dateSkipped++;
          continue; // not enough history for indicators
        }

        // Build arrays like scanWatchlistHandler does (+ same corporate-action guard as the live scan)
        const rawCandlesRaw = candles.map((c: any) => [c.trade_date, c.open, c.high, c.low, c.close, c.volume, c.oi || 0]);
        const rawCandles = stripPreCorpActionCandles(rawCandlesRaw as any);
        if (rawCandles.length < 60) { dateSkipped++; continue; }
        const closes = rawCandles.map(c => c[4]);
        const highs = rawCandles.map(c => c[2]);
        const lows = rawCandles.map(c => c[3]);
        const volumes = rawCandles.map(c => c[5]);
        const last = closes.length - 1;

        const candleObjs: Candle[] = rawCandles.map(c => ({
          timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5], oi: c[6] ?? 0,
        }));

        // Compute indicators
        const rsiArr = rsi(closes, 14);
        const sma50Arr = sma(closes, 50);
        const sma200Arr = sma(closes, 200);
        const bbResult = bollingerBands(closes, 20, 2);
        const stochResult = stochastic(candleObjs, 14, 3);
        const volAvg20 = sma(volumes, 20);
        const macdResult = macd(closes, 12, 26, 9);
        const stResult = supertrend(candleObjs, 10, 3);

        // Classify all 6 strategies
        const strategies: StrategySignal[] = [
          classifyBbRsi(bbResult.upper, bbResult.middle, bbResult.lower, rsiArr, closes, last),
          classifyStochRsi(stochResult.k, stochResult.d, rsiArr, last, closes),
          classifyRsiObos(rsiArr, last, closes),
          classifyCanslim(sma50Arr, rsiArr, volAvg20, volumes, highs, closes, last),
          classifyDualMom(sma200Arr, macdResult.macdLine, highs, closes, last),
          classifySupertrend(stResult.supertrend, stResult.direction, closes, last),
        ];

        const buyCount = strategies.filter(s => s.signal.includes("BUY")).length;
        const sellCount = strategies.filter(s => s.signal.includes("SELL")).length;

        const stratMap: Record<string, string> = {};
        for (const s of strategies) { stratMap[s.strategy] = s.signal; }

        const STRAT_ORDER = ["BB_RSI", "STOCH_RSI", "RSI_OBOS", "CANSLIM", "DUAL_MOM", "SUPERTREND"] as const;
        const fingerprint = STRAT_ORDER
          .map(name => {
            const sig = stratMap[name] || "N/A";
            const star = sig.includes("BUY") ? "*" : "";
            const short = sig === "NEUTRAL" ? "-" : sig;
            return `${name}:${short}${star}`;
          })
          .join(" | ");

        agent.sql`INSERT INTO scan_snapshots (symbol, scan_date, scan_time, ltp, bb_rsi, stoch_rsi, rsi_obos, canslim, dual_mom, supertrend, fingerprint, buy_count, sell_count)
          VALUES (${symbol}, ${date}, ${"15:20:00"}, ${closes[last]},
            ${stratMap["BB_RSI"] || null}, ${stratMap["STOCH_RSI"] || null}, ${stratMap["RSI_OBOS"] || null},
            ${stratMap["CANSLIM"] || null}, ${stratMap["DUAL_MOM"] || null}, ${stratMap["SUPERTREND"] || null},
            ${fingerprint}, ${buyCount}, ${sellCount})`;
        dateSnapshots++;
      }

      // Now stamp fingerprints on BUY trades for this date
      const buyTrades = [...agent.sql`SELECT id, symbol FROM positions
        WHERE action = 'BUY' AND trade_date = ${date} AND signal_fingerprint IS NULL`] as any[];

      for (const trade of buyTrades) {
        const snapRows = [...agent.sql`SELECT fingerprint FROM scan_snapshots
          WHERE symbol = ${trade.symbol} AND scan_date = ${date}
          ORDER BY scan_time DESC LIMIT 1`] as any[];
        if (snapRows.length > 0) {
          agent.sql`UPDATE positions SET signal_fingerprint = ${snapRows[0].fingerprint} WHERE id = ${trade.id}`;
          dateTagged++;
        }
      }

      totalSnapshots += dateSnapshots;
      totalTagged += dateTagged;
      dateResults.push({
        date,
        snapshots_created: dateSnapshots,
        skipped_insufficient_data: dateSkipped,
        trades_tagged: dateTagged,
      });
    }

    // Final pass: tag any remaining BUY trades that still have no fingerprint
    // (e.g. old 2024-01-01 holdings where no candle data existed — use nearest available snapshot)
    const orphanTrades = [...agent.sql`SELECT id, symbol, trade_date FROM positions
      WHERE action = 'BUY' AND signal_fingerprint IS NULL`] as any[];
    let orphanTagged = 0;
    for (const trade of orphanTrades) {
      const snapRows = [...agent.sql`SELECT fingerprint FROM scan_snapshots
        WHERE symbol = ${trade.symbol}
        ORDER BY scan_date ASC LIMIT 1`] as any[];
      if (snapRows.length > 0) {
        agent.sql`UPDATE positions SET signal_fingerprint = ${snapRows[0].fingerprint} WHERE id = ${trade.id}`;
        orphanTagged++;
      }
    }
    totalTagged += orphanTagged;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          total_dates_backfilled: targetDates.length,
          total_snapshots_created: totalSnapshots,
          total_trades_tagged: totalTagged,
          orphan_trades_tagged: orphanTagged,
          dates: dateResults,
        }, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : "" }) }],
      isError: true,
    };
  }
}
