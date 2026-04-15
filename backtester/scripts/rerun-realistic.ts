/**
 * Rerun all 10 equity delivery strategies on REAL multi-year data from Upstox API.
 * Compares legacy (zero-cost) vs realistic (Zerodha costs + slippage + next-bar).
 * Also runs walk-forward validation and parameter sensitivity on 5-year data.
 *
 * Usage: npx tsx scripts/rerun-realistic.ts
 */
import { execSync } from "node:child_process";
import { STRATEGY_REGISTRY } from "../src/engine/strategies.js";
import { runBacktest } from "../src/engine/backtester.js";
import { calculateMetrics } from "../src/engine/metrics.js";
import {
  walkForwardOptimize,
  parameterSensitivity,
} from "../src/commands/optimize-strategy.js";
import type { Candle, StrategyName, BacktestConfig } from "../src/engine/types.js";
import { STOCK_MASTER } from "../../src/data/stock-master.js";

const DB_PATH = "/Users/nishant-singodia/Upstox-MCP-Server/.wrangler/state/v3/do/my-mcp-server-MyMCP/25d0ea35c2be8b6e7e6c72541a7e835ab421975bd9e4bd352fddb7f854aab033.sqlite";

// ─── Access Token from SQLite ───

function getAccessToken(): string {
  const cmd = `sqlite3 "${DB_PATH}" "SELECT value FROM config WHERE key='access_token'"`;
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

// ─── Fetch candles from Upstox API (5 years) ───

async function fetchCandles(instrumentKey: string, accessToken: string): Promise<Candle[]> {
  // Fetch ALL available data — Upstox has equity data from ~2012
  // API limits per-call range, so fetch year by year and merge
  const toYear = new Date().getFullYear();
  const fromYear = 2012;
  const allCandles: Candle[] = [];

  for (let yr = fromYear; yr <= toYear; yr++) {
    const from = `${yr}-01-01`;
    const to = yr === toYear ? new Date().toISOString().slice(0, 10) : `${yr}-12-31`;
    const encoded = encodeURIComponent(instrumentKey);
    const url = `https://api.upstox.com/v2/historical-candle/${encoded}/day/${to}/${from}`;

    const resp = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) continue; // skip years with no data

    const json = (await resp.json()) as {
      data?: { candles?: Array<[string, number, number, number, number, number, number]> };
    };

    const raw = json.data?.candles ?? [];
    for (const [ts, o, h, l, c, v, oi] of raw) {
      allCandles.push({ timestamp: ts, open: o, high: h, low: l, close: c, volume: v, oi });
    }

    // Rate limit between year fetches
    await new Promise(r => setTimeout(r, 100));
  }

  return allCandles.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

// ─── Configs ───

const INITIAL_CAPITAL = 100_000;
const QUANTITY = 10;

const LEGACY: BacktestConfig = {
  initialCapital: INITIAL_CAPITAL,
  quantity: QUANTITY,
  allowAccumulation: false,
  slippagePct: 0,
  costs: null,
  nextBarExecution: false,
};

const REALISTIC: BacktestConfig = {
  initialCapital: INITIAL_CAPITAL,
  quantity: QUANTITY,
  allowAccumulation: false,
  // defaults: Zerodha costs, 0.05% slippage, next-bar execution
};

// ─── Main ───

async function main() {
  const accessToken = getAccessToken();
  const strategies = Object.keys(STRATEGY_REGISTRY) as StrategyName[];

  // Full stock-master: 100 LARGECAP (Nifty 100) + 159 MIDCAP (Nifty Midcap 150)
  const selected = STOCK_MASTER.map(s => ({
    symbol: s.symbol,
    instrumentKey: s.instrument_key,
    category: s.category,
  }));

  const largecapCount = selected.filter(s => s.category === "LARGECAP").length;
  const midcapCount = selected.filter(s => s.category === "MIDCAP").length;
  console.log(`\n📊 Full universe: ${largecapCount} LARGECAP + ${midcapCount} MIDCAP = ${selected.length} stocks`);
  console.log(`   Fetching data from 2012 to present from Upstox API...\n`);

  // Fetch all candles (batch of 5 for rate limiting)
  const candleMap = new Map<string, Candle[]>();
  // Fetch sequentially — each stock needs ~13 API calls (one per year 2012-2025)
  // Total: ~259 × 13 = ~3,367 API calls
  let fetched = 0;
  let failed = 0;

  for (const s of selected) {
    try {
      const candles = await fetchCandles(s.instrumentKey, accessToken);
      if (candles.length >= 200) {
        candleMap.set(s.symbol, candles);
        fetched++;
        if (fetched % 10 === 0 || fetched <= 5) {
          console.log(`  [${fetched}/${selected.length}] ${s.symbol}: ${candles.length} candles (${(candles.length / 252).toFixed(1)} yrs)`);
        }
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
      if (failed <= 5) console.log(`  ⚠️  ${s.symbol}: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  console.log(`  ... ${fetched} stocks loaded, ${failed} skipped`);

  console.log(`\nLoaded ${candleMap.size} stocks with sufficient data.\n`);

  if (candleMap.size === 0) {
    console.log("❌ No data fetched. Check access token validity.");
    return;
  }

  // ─── Part 1: Before/After Comparison ───

  interface StratAgg {
    totalTradesLegacy: number;
    totalTradesRealistic: number;
    totalReturnLegacy: number;
    totalReturnRealistic: number;
    totalCosts: number;
    stocksTested: number;
    avgWinRateRealistic: number;
    avgSharpeRealistic: number;
    avgMaxDDRealistic: number;
  }

  const aggResults: Record<string, StratAgg> = {};
  for (const s of strategies) {
    aggResults[s] = {
      totalTradesLegacy: 0, totalTradesRealistic: 0,
      totalReturnLegacy: 0, totalReturnRealistic: 0,
      totalCosts: 0, stocksTested: 0,
      avgWinRateRealistic: 0, avgSharpeRealistic: 0, avgMaxDDRealistic: 0,
    };
  }

  console.log("Running backtests...");
  for (const [symbol, candles] of candleMap) {
    for (const stratName of strategies) {
      const stratDef = STRATEGY_REGISTRY[stratName];
      const signals = stratDef.fn(candles, stratDef.defaults);
      const isAccum = stratName === "buy_the_dip";

      const legacyResult = runBacktest(candles, signals, { ...LEGACY, allowAccumulation: isAccum });
      const legacyMetrics = calculateMetrics(legacyResult.trades, legacyResult.equityCurve, INITIAL_CAPITAL);

      const realisticResult = runBacktest(candles, signals, { ...REALISTIC, allowAccumulation: isAccum });
      const realisticMetrics = calculateMetrics(realisticResult.trades, realisticResult.equityCurve, INITIAL_CAPITAL);

      const agg = aggResults[stratName];
      agg.totalTradesLegacy += legacyMetrics.totalTrades;
      agg.totalTradesRealistic += realisticMetrics.totalTrades;
      agg.totalReturnLegacy += legacyMetrics.totalReturnPct;
      agg.totalReturnRealistic += realisticMetrics.totalReturnPct;
      agg.totalCosts += realisticResult.totalCosts;
      agg.avgWinRateRealistic += realisticMetrics.winRate;
      agg.avgSharpeRealistic += realisticMetrics.sharpeRatio;
      agg.avgMaxDDRealistic += realisticMetrics.maxDrawdownPct;
      agg.stocksTested++;
    }
  }

  const nStocks = candleMap.size;
  const sampleCandles = candleMap.values().next().value as Candle[];
  const dataYears = sampleCandles ? ((new Date(sampleCandles[sampleCandles.length - 1].timestamp).getTime() - new Date(sampleCandles[0].timestamp).getTime()) / (365.25 * 86_400_000)).toFixed(1) : "?";

  console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║                    BEFORE/AFTER: Legacy vs Realistic (Zerodha Costs + Slippage)                     ║`);
  console.log(`║                    ${nStocks} stocks × ~${dataYears} years of daily data each                                        ║`);
  console.log(`╠══════════════════════╦═══════════╦═══════════╦═══════════╦════════╦════════╦════════╦═══════╦════════╣`);
  console.log(`║ Strategy             ║ Legacy %  ║ Realist % ║ Impact %  ║ Trades ║ WR %   ║ Sharpe ║ MaxDD ║ Cost ₹ ║`);
  console.log(`╠══════════════════════╬═══════════╬═══════════╬═══════════╬════════╬════════╬════════╬═══════╬════════╣`);

  for (const s of strategies) {
    const a = aggResults[s];
    const n = a.stocksTested || 1;
    const avgLeg = a.totalReturnLegacy / n;
    const avgReal = a.totalReturnRealistic / n;
    const impact = avgReal - avgLeg;
    const avgWR = a.avgWinRateRealistic / n * 100;
    const avgSharpe = a.avgSharpeRealistic / n;
    const avgDD = a.avgMaxDDRealistic / n;
    const name = s.padEnd(20);
    const leg = avgLeg.toFixed(2).padStart(9);
    const real = avgReal.toFixed(2).padStart(9);
    const imp = impact.toFixed(2).padStart(9);
    const trades = a.totalTradesRealistic.toString().padStart(6);
    const wr = avgWR.toFixed(1).padStart(6);
    const sharpe = avgSharpe.toFixed(2).padStart(6);
    const dd = avgDD.toFixed(1).padStart(5);
    const costs = (Math.round(a.totalCosts / 1000)).toString().padStart(5) + "K";
    console.log(`║ ${name} ║ ${leg} ║ ${real} ║ ${imp} ║ ${trades} ║ ${wr} ║ ${sharpe} ║ ${dd}% ║ ${costs} ║`);
  }
  console.log(`╚══════════════════════╩═══════════╩═══════════╩═══════════╩════════╩════════╩════════╩═══════╩════════╝`);

  // ─── Part 2: Walk-Forward on key stocks (5yr data → 5 folds) ───

  console.log("\n\n── Walk-Forward Validation (5 folds, 75% train / 25% test) ──\n");

  const wfStocks = ["RELIANCE", "TCS", "HDFCBANK", "BAJFINANCE"].filter(s => candleMap.has(s));
  const wfConfigs: Array<{ name: StrategyName; ranges: Record<string, (number | string)[]> }> = [
    { name: "ema_crossover", ranges: { fastPeriod: [5, 12, 20], slowPeriod: [26, 50] } },
    { name: "supertrend", ranges: { period: [7, 10, 14], multiplier: [2, 3, 4] } },
    { name: "rsi_overbought_oversold", ranges: { period: [10, 14, 21], oversold: [25, 30, 35] } },
    { name: "atr_trailing_stop", ranges: { atrPeriod: [10, 14, 20], multiplier: [2, 3, 4] } },
    { name: "buy_the_dip", ranges: { buyDropPct: [-1, -2, -3], sellTargetPct: [3, 5, 8] } },
  ];

  for (const sym of wfStocks) {
    const candles = candleMap.get(sym)!;
    console.log(`  ${sym} (${candles.length} candles, ~${((candles.length) / 252).toFixed(1)} yrs):`);

    for (const wf of wfConfigs) {
      try {
        const result = walkForwardOptimize(
          candles, wf.name, wf.ranges, "totalReturnPct",
          5, 0.75, INITIAL_CAPITAL, QUANTITY
        );
        const flag = Math.abs(result.avgDegradation) > 50 ? " ⚠️" : result.avgOutOfSample > 0 ? " ✅" : "";
        console.log(
          `    ${wf.name.padEnd(24)} IS:${result.avgInSample.toFixed(1).padStart(6)}%  OOS:${result.avgOutOfSample.toFixed(1).padStart(6)}%  Deg:${result.avgDegradation.toFixed(0).padStart(5)}%  Stab:${result.paramStability}${flag}`
        );
      } catch (e) {
        console.log(`    ${wf.name.padEnd(24)} ${(e as Error).message.slice(0, 60)}`);
      }
    }
    console.log();
  }

  // ─── Part 3: Parameter Sensitivity on RELIANCE ───

  console.log("\n── Parameter Sensitivity (RELIANCE, 5yr data) ──\n");

  const sensSymbol = candleMap.has("RELIANCE") ? "RELIANCE" : wfStocks[0];
  const sensCandles = candleMap.get(sensSymbol)!;

  const sensConfigs: Array<{ name: StrategyName; ranges: Record<string, (number | string)[]> }> = [
    { name: "ema_crossover", ranges: { fastPeriod: [5, 8, 12, 15, 20, 25], slowPeriod: [20, 26, 35, 50, 75, 100] } },
    { name: "supertrend", ranges: { period: [5, 7, 10, 14, 20, 25], multiplier: [1.5, 2, 2.5, 3, 4, 5] } },
    { name: "rsi_overbought_oversold", ranges: { period: [7, 10, 14, 21], oversold: [20, 25, 30, 35, 40], overbought: [60, 65, 70, 75, 80] } },
    { name: "macd_signal_cross", ranges: { fastPeriod: [8, 10, 12, 15], slowPeriod: [20, 26, 30, 40], signalPeriod: [7, 9, 12] } },
    { name: "buy_the_dip", ranges: { buyDropPct: [-0.5, -1, -1.5, -2, -3, -5], sellTargetPct: [1, 2, 3, 5, 8, 10] } },
  ];

  for (const sc of sensConfigs) {
    try {
      const report = parameterSensitivity(
        sensCandles, sc.name, sc.ranges, "totalReturnPct", INITIAL_CAPITAL, QUANTITY
      );
      const icon = report.verdict === "ROBUST" ? "✅" : report.verdict === "MODERATE" ? "🟡" : "🔴";
      console.log(`  ${sc.name}: ${icon} ${report.verdict} (${report.overallRobustness})`);
      for (const p of report.params) {
        const vals = p.values.map(v => `${v.value}→${(v.metrics.totalReturnPct).toFixed(1)}%`).join(", ");
        console.log(`    ${p.paramName.padEnd(15)}: plateau=${p.plateauScore.toFixed(2)} ${p.isRobust ? "✓" : "✗"}  [${vals}]`);
      }
      console.log();
    } catch (e) {
      console.log(`  ${sc.name}: ${(e as Error).message}\n`);
    }
  }

  console.log("✅ Done.");
}

main().catch(console.error);
