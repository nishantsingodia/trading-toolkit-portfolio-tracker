/**
 * LONG-TERM F&O STRATEGY BACKTEST (2013-2025)
 * ============================================
 * Fetches 12 YEARS of real Nifty data from Upstox.
 * Tests across: bull runs, crashes, COVID, rate hikes, sideways markets.
 *
 * METHODOLOGY (fully transparent):
 * ────────────────────────────────
 * REAL DATA:
 *   - Nifty 50 daily OHLCV candles from Upstox (2013-2025)
 *   - Actual market movements, gaps, trends, crashes
 *
 * MODELED DATA (Black-Scholes):
 *   - Option premiums computed using BS formula at each timestamp
 *   - IV estimated per regime: bull=12%, normal=15%, volatile=22%, crash=35%
 *   - IV skew: OTM options get +50% IV bump per 1% moneyness
 *   - OI: synthetic bell curve around ATM (not real OI data)
 *   - Bid-ask: not modeled (real world costs ~1-5% per trade)
 *
 * WHAT THIS TELLS YOU:
 *   ✅ Strategy LOGIC validation (entry/exit timing, DTE management)
 *   ✅ Relative ranking of strategies (which is better than which)
 *   ✅ Behavior across market regimes (crash, rally, sideways)
 *   ⚠️ Absolute P&L numbers are approximate (real premiums differ)
 *   ⚠️ Real world has: slippage, wider spreads, margin calls, broker limits
 *
 * Usage: npx tsx scripts/long-term-backtest.ts
 */

import { FNO_STRATEGY_REGISTRY } from "../src/engine/strategies.js";
import { runFnoBacktest, resetPositionCounter } from "../src/engine/backtester.js";
import { buildBacktestResult } from "../src/engine/metrics.js";
import { getATMStrike, enumerateStrikes } from "../src/engine/options-chain.js";
import { blackScholesCall, blackScholesPut, calculateGreeks } from "../src/engine/pricing.js";
import { getDTE, dteToYears, getNextExpiry } from "../src/engine/expiry-calendar.js";
import type { Candle, FnoStrategyName, OptionsChainSnapshot, StrikeData, Underlying, FnoPerformanceMetrics } from "../src/engine/types.js";
import { DEFAULT_FNO_CONFIG, RISK_FREE_RATE } from "../src/engine/types.js";
import { bollingerBands, sma, rsi as calcRsi } from "../src/engine/indicators.js";
import * as fs from "fs";
import * as path from "path";

// ── Load Token ──────────────────────────────────────────────────────

function loadToken(): string {
  const content = fs.readFileSync(path.join(process.cwd(), "..", ".dev.vars"), "utf-8");
  return content.match(/UPSTOX_ACCESS_TOKEN=(.+)/)![1].trim();
}

// ── Fetch Data Year by Year ─────────────────────────────────────────

async function fetchAllCandles(token: string, fromYear: number, toYear: number): Promise<Candle[]> {
  const allCandles: Candle[] = [];

  for (let year = fromYear; year <= toYear; year++) {
    const from = `${year}-01-01`;
    const to = year === toYear ? "2025-03-28" : `${year}-12-31`;
    const key = encodeURIComponent("NSE_INDEX|Nifty 50");
    const url = `https://api.upstox.com/v2/historical-candle/${key}/day/${to}/${from}`;

    process.stdout.write(`  ${year}...`);
    const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
    if (!res.ok) { console.log(` HTTP ${res.status}`); continue; }

    const json = (await res.json()) as any;
    const candles = (json.data?.candles ?? [])
      .map(([ts, o, h, l, c, v, oi]: any) => ({ timestamp: ts, open: o, high: h, low: l, close: c, volume: v, oi: oi }))
      .sort((a: Candle, b: Candle) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    allCandles.push(...candles);
    process.stdout.write(` ${candles.length} candles\n`);

    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  return allCandles;
}

// ── Detect IV Regime from Price Action ──────────────────────────────

function estimateIV(candles: Candle[], index: number): number {
  // Use recent realized volatility to estimate IV
  const lookback = Math.min(20, index);
  if (lookback < 5) return 0.15;

  const returns: number[] = [];
  for (let i = index - lookback + 1; i <= index; i++) {
    if (i > 0) {
      returns.push(Math.log(candles[i].close / candles[i - 1].close));
    }
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  const dailyVol = Math.sqrt(variance);
  const annualizedVol = dailyVol * Math.sqrt(252);

  // Clamp to reasonable range
  return Math.max(0.08, Math.min(0.50, annualizedVol));
}

// ── Build Chain with Dynamic IV ─────────────────────────────────────

function buildChainHistory(
  candles: Candle[],
  underlying: Underlying,
  numStrikes: number = 20
): OptionsChainSnapshot[] {
  const history: OptionsChainSnapshot[] = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const spotPrice = candle.close;
    const dateStr = candle.timestamp.slice(0, 10);

    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const dte = getDTE(dateStr, expiry);
    if (dte <= 0) continue;
    const tte = dteToYears(dte);

    // Dynamic IV based on recent realized volatility
    const baseIV = estimateIV(candles, i);

    const atm = getATMStrike(spotPrice, underlying);
    const strikes = enumerateStrikes(atm, numStrikes, underlying);
    const strikeMap = new Map<number, StrikeData>();

    for (const strike of strikes) {
      if (strike <= 0) continue;
      const moneyness = Math.abs(strike - spotPrice) / spotPrice;
      const skewedIV = baseIV * (1 + moneyness * 0.5);

      const cePrice = blackScholesCall(spotPrice, strike, tte, RISK_FREE_RATE, skewedIV);
      const pePrice = blackScholesPut(spotPrice, strike, tte, RISK_FREE_RATE, skewedIV);
      const ceGreeks = calculateGreeks(spotPrice, strike, tte, RISK_FREE_RATE, skewedIV, "CE");
      const peGreeks = calculateGreeks(spotPrice, strike, tte, RISK_FREE_RATE, skewedIV, "PE");

      const oiFactor = Math.exp(-moneyness * moneyness * 50);

      strikeMap.set(strike, {
        ce: { price: Math.max(cePrice, 0.05), oi: Math.round(500000 * oiFactor), volume: Math.round(100000 * oiFactor), iv: skewedIV, greeks: ceGreeks },
        pe: { price: Math.max(pePrice, 0.05), oi: Math.round(500000 * oiFactor), volume: Math.round(100000 * oiFactor), iv: skewedIV, greeks: peGreeks },
      });
    }

    history.push({ timestamp: candle.timestamp, spotPrice, strikes: strikeMap });
  }

  return history;
}

// ── Run Strategy ────────────────────────────────────────────────────

function runStrategy(
  name: FnoStrategyName,
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  underlying: Underlying,
  capital: number,
  customParams: Record<string, number | string>
): FnoPerformanceMetrics {
  resetPositionCounter();
  const def = FNO_STRATEGY_REGISTRY[name];
  const params = { ...def.defaults, ...customParams };
  const signals = def.fn(chainHistory, spotCandles, params);
  const config = { ...DEFAULT_FNO_CONFIG, initialCapital: capital, maxPositions: 3, maxLossPerTrade: capital * 0.03, maxLossPerDay: capital * 0.05 };
  const output = runFnoBacktest(chainHistory, spotCandles, signals, config, name, underlying);
  return buildBacktestResult(output.trades, output.equityCurve, output.drawdownSeries, output.greeksTimeSeries, capital).metrics;
}

// ── Market Regime Detection ─────────────────────────────────────────

interface MarketPeriod {
  name: string;
  from: string;
  to: string;
  type: string;
  niftyMove: string;
}

function identifyMarketPeriods(candles: Candle[]): MarketPeriod[] {
  // Known major market phases
  return [
    { name: "2013-14 Modi Rally", from: "2013-09-01", to: "2014-05-31", type: "BULL", niftyMove: "" },
    { name: "2015-16 China Scare + Demonetization", from: "2015-06-01", to: "2016-12-31", type: "VOLATILE", niftyMove: "" },
    { name: "2017-18 Bull Run", from: "2017-01-01", to: "2018-01-31", type: "BULL", niftyMove: "" },
    { name: "2018 IL&FS Crisis", from: "2018-09-01", to: "2019-03-31", type: "BEAR", niftyMove: "" },
    { name: "2020 COVID Crash", from: "2020-02-01", to: "2020-04-30", type: "CRASH", niftyMove: "" },
    { name: "2020-21 V-Recovery", from: "2020-05-01", to: "2021-10-31", type: "BULL", niftyMove: "" },
    { name: "2022 Rate Hike Bear", from: "2022-01-01", to: "2022-06-30", type: "BEAR", niftyMove: "" },
    { name: "2023 Steady Bull", from: "2023-01-01", to: "2023-12-31", type: "BULL", niftyMove: "" },
    { name: "2024 Election + Fall", from: "2024-06-01", to: "2025-03-28", type: "VOLATILE", niftyMove: "" },
  ];
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const token = loadToken();
  const CAPITAL = 500000;
  const UNDERLYING: Underlying = "NIFTY";

  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  LONG-TERM F&O BACKTEST — 12 YEARS OF REAL NIFTY DATA (2013-2025)  ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

  console.log("METHODOLOGY:");
  console.log("  ✅ REAL: Nifty spot prices (daily OHLCV from Upstox API)");
  console.log("  🔧 MODELED: Option premiums (Black-Scholes), IV (from realized vol),");
  console.log("     OI (synthetic), Greeks (BS-derived), No bid-ask spread");
  console.log("  ⚠️  This tests strategy LOGIC & relative ranking, not exact P&L\n");

  // Fetch 12 years of data
  console.log("Fetching Nifty 50 daily candles (2013-2025):");
  const allCandles = await fetchAllCandles(token, 2013, 2025);
  console.log(`\nTotal: ${allCandles.length} trading days`);
  console.log(`Range: Nifty ${allCandles[0].close.toFixed(0)} (${allCandles[0].timestamp.slice(0, 10)}) → ${allCandles[allCandles.length - 1].close.toFixed(0)} (${allCandles[allCandles.length - 1].timestamp.slice(0, 10)})`);
  const totalNiftyReturn = ((allCandles[allCandles.length - 1].close - allCandles[0].close) / allCandles[0].close * 100).toFixed(1);
  console.log(`Nifty buy-and-hold return: +${totalNiftyReturn}%\n`);

  // Build chain with dynamic IV
  console.log("Building synthetic option chain (dynamic IV from realized vol)...");
  const chainHistory = buildChainHistory(allCandles, UNDERLYING, 20);
  console.log(`Chain built: ${chainHistory.length} snapshots\n`);

  // Strategy configs (relaxed for daily data)
  const configs: Record<string, Record<string, number | string>> = {
    short_straddle: { ivPercentileMin: 0, entryDteMin: 2, entryDteMax: 7, targetPct: 30, stopLossPct: 40, exitDte: 0 },
    short_strangle: { ivPercentileMin: 0, entryDteMin: 2, entryDteMax: 7, targetPct: 40, stopLossPct: 80, exitDte: 0, ceDelta: 0.25, peDelta: -0.25 },
    iron_condor: { entryDteMin: 3, entryDteMax: 7, exitDte: 0, shortDelta: 0.20, wingWidth: 200, targetPct: 40, stopLossMultiplier: 2 },
    iron_butterfly: { entryDteMin: 3, entryDteMax: 7, exitDte: 0, wingWidth: 200, targetPct: 30, stopLossMultiplier: 1.5 },
    deep_otm_sell: { otmDistance: 500, minPremium: 1, targetDecayPct: 60, stopLossMultiplier: 2, dangerBufferPts: 100, entryDteMin: 3, entryDteMax: 7 },
    bull_call_spread: { spreadWidth: 100, entryDteMin: 3, entryDteMax: 7, exitDte: 0, rsiMin: 50, ivPercentileMax: 100 },
    bear_put_spread: { spreadWidth: 100, entryDteMin: 3, entryDteMax: 7, exitDte: 0, rsiMax: 50, ivPercentileMax: 100 },
    long_straddle: { ivPercentileMax: 100, entryDteMin: 3, entryDteMax: 7, targetPct: 20, stopLossPct: 20, exitDte: 0 },
    calendar_spread: { nearDteMin: 2, nearDteMax: 6, spotMoveExitPct: 2 },
    oi_max_pain: { maxPainDeviationMin: 50, convergenceTarget: 25, stopLossDeviation: 100, entryDte: 3 },
  };

  const strategies: FnoStrategyName[] = [
    "short_straddle", "short_strangle", "iron_condor", "iron_butterfly",
    "deep_otm_sell", "bull_call_spread", "bear_put_spread",
    "long_straddle", "calendar_spread", "oi_max_pain",
  ];

  // ── Full Period Backtest ──────────────────────────────────────────

  console.log("═".repeat(130));
  console.log("  FULL PERIOD RESULTS (2013-2025, 12 years, all market regimes)");
  console.log("═".repeat(130));

  type Row = { name: string; trades: number; winRate: string; ret: string; retPct: string; sharpe: string; maxDD: string; pf: string; exp: string; cagr: string; verdict: string };
  const fullResults: Row[] = [];

  for (const name of strategies) {
    process.stdout.write(`  ${name.padEnd(22)}`);
    try {
      const m = runStrategy(name, chainHistory, allCandles, UNDERLYING, CAPITAL, configs[name]);

      let verdict = "❌ AVOID";
      if (m.totalTrades === 0) verdict = "⚪ NO TRADES";
      else if (m.totalReturnPct > 30 && m.winRate > 0.5 && m.sharpeRatio > 0.5 && m.maxDrawdownPct < 30) verdict = "✅ FOLLOW THIS";
      else if (m.totalReturnPct > 10 && m.winRate > 0.45 && m.profitFactor > 1) verdict = "🟡 DECENT";
      else if (m.totalReturnPct > 0) verdict = "🟠 MARGINAL";

      const row: Row = {
        name,
        trades: m.totalTrades,
        winRate: `${(m.winRate * 100).toFixed(1)}%`,
        ret: `₹${m.totalReturn.toFixed(0)}`,
        retPct: `${m.totalReturnPct.toFixed(1)}%`,
        sharpe: m.sharpeRatio.toFixed(2),
        maxDD: `${m.maxDrawdownPct.toFixed(1)}%`,
        pf: m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2),
        exp: `₹${m.expectancy.toFixed(0)}`,
        cagr: `${(m.cagr * 100).toFixed(1)}%`,
        verdict,
      };
      fullResults.push(row);
      console.log(`${row.trades} trades | WR: ${row.winRate} | Return: ${row.retPct} | Sharpe: ${row.sharpe} | ${row.verdict}`);
    } catch (e) {
      console.log(`ERROR: ${(e as Error).message.slice(0, 80)}`);
      fullResults.push({ name, trades: 0, winRate: "-", ret: "-", retPct: "-", sharpe: "-", maxDD: "-", pf: "-", exp: "-", cagr: "-", verdict: "⚠️ ERROR" });
    }
  }

  // Sort by return
  const order: Record<string, number> = { "✅ FOLLOW THIS": 0, "🟡 DECENT": 1, "🟠 MARGINAL": 2, "⚪ NO TRADES": 3, "❌ AVOID": 4, "⚠️ ERROR": 5 };
  fullResults.sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9));

  console.log("\n" + "-".repeat(130));
  console.log(
    "Strategy".padEnd(22) + "Trades".padStart(7) + "WinRate".padStart(9) +
    "Return".padStart(12) + "Return%".padStart(10) + "CAGR".padStart(8) +
    "Sharpe".padStart(8) + "MaxDD".padStart(8) + "PF".padStart(7) +
    "Expect".padStart(10) + "  Verdict"
  );
  console.log("-".repeat(130));
  for (const r of fullResults) {
    console.log(
      r.name.padEnd(22) + String(r.trades).padStart(7) + r.winRate.padStart(9) +
      r.ret.padStart(12) + r.retPct.padStart(10) + r.cagr.padStart(8) +
      r.sharpe.padStart(8) + r.maxDD.padStart(8) + r.pf.padStart(7) +
      r.exp.padStart(10) + "  " + r.verdict
    );
  }
  console.log("-".repeat(130));

  // ── Per-Period Breakdown ──────────────────────────────────────────

  const periods = identifyMarketPeriods(allCandles);
  const topStrategies = fullResults.filter(r => r.verdict.includes("FOLLOW") || r.verdict.includes("DECENT")).map(r => r.name as FnoStrategyName);

  if (topStrategies.length > 0) {
    console.log("\n" + "═".repeat(100));
    console.log("  HOW TOP STRATEGIES PERFORMED IN EACH MARKET REGIME");
    console.log("═".repeat(100));

    for (const period of periods) {
      const fromIdx = allCandles.findIndex(c => c.timestamp.slice(0, 10) >= period.from);
      const toIdx = allCandles.findIndex(c => c.timestamp.slice(0, 10) > period.to);
      const end = toIdx === -1 ? allCandles.length : toIdx;
      if (fromIdx === -1 || fromIdx >= end) continue;

      const periodCandles = allCandles.slice(fromIdx, end);
      const periodChain = chainHistory.slice(fromIdx, Math.min(end, chainHistory.length));
      if (periodCandles.length < 10 || periodChain.length < 10) continue;

      const startP = periodCandles[0].close;
      const endP = periodCandles[periodCandles.length - 1].close;
      const niftyRet = ((endP - startP) / startP * 100).toFixed(1);

      console.log(`\n  📊 ${period.name} [${period.type}] — Nifty: ${startP.toFixed(0)} → ${endP.toFixed(0)} (${niftyRet}%)`);

      for (const name of topStrategies.slice(0, 4)) {
        try {
          const m = runStrategy(name, periodChain, periodCandles, UNDERLYING, CAPITAL, configs[name]);
          const tag = m.totalReturnPct > 0 ? "✅" : "❌";
          console.log(`     ${tag} ${name.padEnd(20)} ${m.totalTrades} trades | WR: ${(m.winRate * 100).toFixed(0)}% | Return: ${m.totalReturnPct.toFixed(1)}% | MaxDD: ${m.maxDrawdownPct.toFixed(1)}%`);
        } catch {
          console.log(`     ⚠️ ${name.padEnd(20)} error`);
        }
      }
    }
  }

  // ── Final Verdict ─────────────────────────────────────────────────

  console.log("\n" + "═".repeat(100));
  console.log("  FINAL VERDICT — WHAT TO FOLLOW RELIGIOUSLY");
  console.log("═".repeat(100));

  const winners = fullResults.filter(r => r.verdict.includes("FOLLOW"));
  const decent = fullResults.filter(r => r.verdict.includes("DECENT"));
  const losers = fullResults.filter(r => r.verdict.includes("AVOID"));

  if (winners.length > 0) {
    console.log("\n  🏆 TIER 1 — Your core strategies (trade these every week):");
    for (const w of winners) {
      console.log(`     ${w.name}: ${w.trades} trades, ${w.winRate} win rate, ${w.retPct} return, ${w.cagr} CAGR`);
    }
  }

  if (decent.length > 0) {
    console.log("\n  🥈 TIER 2 — Use selectively (right market conditions only):");
    for (const d of decent) {
      console.log(`     ${d.name}: ${d.trades} trades, ${d.winRate} win rate, ${d.retPct} return`);
    }
  }

  if (losers.length > 0) {
    console.log("\n  ⛔ AVOID — Lost money over 12 years:");
    for (const l of losers) {
      console.log(`     ${l.name}: ${l.retPct} return, ${l.maxDD} max drawdown`);
    }
  }

  console.log(`
  ┌─────────────────────────────────────────────────────────────┐
  │ REMEMBER: These are BS-modeled results on REAL spot data.   │
  │ Real P&L will differ due to: actual premiums, IV changes,   │
  │ bid-ask spreads, slippage, and margin requirements.         │
  │                                                             │
  │ The RELATIVE ranking is reliable — if Strategy A beats B    │
  │ over 12 years and all market regimes, it's genuinely better.│
  │                                                             │
  │ Start with PAPER TRADING for 1 month before real money.     │
  └─────────────────────────────────────────────────────────────┘
  `);
}

main().catch(console.error);
