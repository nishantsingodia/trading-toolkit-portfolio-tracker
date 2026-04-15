/**
 * BANKNIFTY LONG-TERM BACKTEST (2018–2025)
 * =========================================
 * Runs all 12 strategies + deep OTM sell variants on 7 years of real BANKNIFTY spot data.
 * Applies learnings from NIFTY backtest audit:
 *   - Realistic slippage (50bps, not 5bps)
 *   - Year-by-year breakdown to detect regime degradation
 *   - Multiple deep_otm_sell parameter variants
 *   - BANKNIFTY-specific scaling (100-pt strikes, higher IV, lot size 30)
 *   - Transaction cost estimate in summary
 *
 * Usage: npx tsx scripts/banknifty-long-term-backtest.ts
 */

import { FNO_STRATEGY_REGISTRY } from "../src/engine/strategies.js";
import { runFnoBacktest, resetPositionCounter } from "../src/engine/backtester.js";
import { buildBacktestResult } from "../src/engine/metrics.js";
import { getATMStrike, enumerateStrikes } from "../src/engine/options-chain.js";
import { blackScholesCall, blackScholesPut, calculateGreeks } from "../src/engine/pricing.js";
import { getDTE, dteToYears, getNextExpiry, getWeeklyExpiries } from "../src/engine/expiry-calendar.js";
import type { Candle, FnoStrategyName, OptionsChainSnapshot, StrikeData, Underlying, FnoPerformanceMetrics, FnoBacktestConfig } from "../src/engine/types.js";
import { DEFAULT_FNO_CONFIG, RISK_FREE_RATE, INDIA_FNO_TXN_COSTS } from "../src/engine/types.js";
import * as fs from "fs";
import * as path from "path";

const UNDERLYING: Underlying = "BANKNIFTY";
const CAPITAL = 500_000; // ₹5 Lakh

// ── Realistic config (applying AUDIT.md learnings) ──────────────────
const REALISTIC_CONFIG: FnoBacktestConfig = {
  ...DEFAULT_FNO_CONFIG,
  initialCapital: CAPITAL,
  maxPositions: 3,
  maxLossPerTrade: CAPITAL * 0.03,
  maxLossPerDay: CAPITAL * 0.05,
  slippageBps: 50,  // 0.5% — AUDIT finding: 5bps was 10x too low
  portfolioGreeksLimits: {
    maxAbsDelta: 500,
    maxGamma: 50,
    maxVega: 800,  // Bumped for BANKNIFTY (higher notional → higher vega)
  },
  txnCosts: INDIA_FNO_TXN_COSTS,  // Real India costs: brokerage + STT + exchange + GST + stamp
};

// ── Fetch Real Spot Data (no auth needed for index candles) ─────────

async function fetchSpotCandles(
  fromDate: string,
  toDate: string,
): Promise<Candle[]> {
  const indexKey = "NSE_INDEX|Nifty Bank";
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(indexKey)}/day/${toDate}/${fromDate}`;

  console.log(`  Fetching BANKNIFTY daily candles: ${fromDate} → ${toDate}...`);
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upstox API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const json = (await response.json()) as {
    data: { candles: Array<[string, number, number, number, number, number, number]> };
  };

  return (json.data?.candles ?? [])
    .map(([timestamp, open, high, low, close, volume, oi]) => ({ timestamp, open, high, low, close, volume, oi }))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

// ── Build Synthetic Chain ───────────────────────────────────────────

function buildChainHistory(
  spotCandles: Candle[],
  baseIV: number = 0.18,
  numStrikes: number = 30
): OptionsChainSnapshot[] {
  const history: OptionsChainSnapshot[] = [];

  for (const candle of spotCandles) {
    const spotPrice = candle.close;
    const dateStr = candle.timestamp.slice(0, 10);

    const expiry = getNextExpiry(UNDERLYING, dateStr, "weekly");
    const dte = getDTE(dateStr, expiry);
    if (dte <= 0) continue;
    const tte = dteToYears(dte);

    const atm = getATMStrike(spotPrice, UNDERLYING);
    const strikes = enumerateStrikes(atm, numStrikes, UNDERLYING);
    const strikeMap = new Map<number, StrikeData>();

    for (const strike of strikes) {
      if (strike <= 0) continue;
      const moneyness = Math.abs(strike - spotPrice) / spotPrice;
      // Volatility skew: higher IV for OTM strikes (smile effect)
      const skewedIV = baseIV * (1 + moneyness * 0.6);

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

// ── Run Single Strategy ─────────────────────────────────────────────

interface ExtendedMetrics extends FnoPerformanceMetrics {
  trades_detail: string[];
  exitBreakdown: { target: number; sl: number; time: number; other: number };
}

function runStrategy(
  name: FnoStrategyName,
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  customParams?: Record<string, number | string>,
  config?: FnoBacktestConfig,
): ExtendedMetrics {
  resetPositionCounter();

  const def = FNO_STRATEGY_REGISTRY[name];
  const params = { ...def.defaults, ...(customParams ?? {}), __underlying: UNDERLYING };
  const signals = def.fn(chainHistory, spotCandles, params);

  const cfg = config ?? REALISTIC_CONFIG;
  const output = runFnoBacktest(chainHistory, spotCandles, signals, cfg, name, UNDERLYING);
  const result = buildBacktestResult(output.trades, output.equityCurve, output.drawdownSeries, output.greeksTimeSeries, cfg.initialCapital);

  const trades_detail = output.trades.slice(0, 5).map(t =>
    `${t.entryDate.slice(0, 10)} → ${t.exitDate.slice(0, 10)} | PnL: ₹${t.exitPnl.toFixed(0)} | ${t.exitReason}`
  );

  // Exit breakdown
  let target = 0, sl = 0, time = 0, other = 0;
  for (const t of output.trades) {
    if (t.exitReason === "target_hit") target++;
    else if (t.exitReason === "stop_loss") sl++;
    else if (t.exitReason === "time_exit" || t.exitReason === "expiry_settlement") time++;
    else other++;
  }

  return { ...result.metrics, trades_detail, exitBreakdown: { target, sl, time, other } };
}

// ── Year-by-year breakdown ──────────────────────────────────────────

function runYearByYear(
  name: FnoStrategyName,
  allChain: OptionsChainSnapshot[],
  allSpot: Candle[],
  params: Record<string, number | string>,
): void {
  // Group by year
  const years = new Map<string, { chain: OptionsChainSnapshot[]; spot: Candle[] }>();
  for (let i = 0; i < allChain.length && i < allSpot.length; i++) {
    const year = allChain[i].timestamp.slice(0, 4);
    if (!years.has(year)) years.set(year, { chain: [], spot: [] });
    years.get(year)!.chain.push(allChain[i]);
    years.get(year)!.spot.push(allSpot[i]);
  }

  console.log(`\n  Year-by-Year Breakdown for ${name.toUpperCase()}:`);
  console.log("  " + "-".repeat(110));
  console.log(
    "  Year".padEnd(8) +
    "Trades".padStart(8) +
    "Win%".padStart(8) +
    "Return".padStart(12) +
    "Return%".padStart(10) +
    "MaxDD".padStart(8) +
    "PF".padStart(8) +
    "Avg P&L".padStart(10) +
    "Target".padStart(8) +
    "SL".padStart(6) +
    "Time".padStart(6) +
    "Other".padStart(7) +
    "  Regime"
  );
  console.log("  " + "-".repeat(110));

  for (const [year, data] of [...years.entries()].sort()) {
    if (data.chain.length < 20) continue; // skip partial years
    try {
      const m = runStrategy(name, data.chain, data.spot, params);
      const avgPnl = m.totalTrades > 0 ? m.totalReturn / m.totalTrades : 0;

      // Detect regime
      const startP = data.spot[0].close;
      const endP = data.spot[data.spot.length - 1].close;
      const yReturn = ((endP - startP) / startP) * 100;
      const regime = Math.abs(yReturn) < 5 ? "FLAT" : yReturn > 0 ? `UP ${yReturn.toFixed(0)}%` : `DOWN ${yReturn.toFixed(0)}%`;

      console.log(
        `  ${year}`.padEnd(8) +
        String(m.totalTrades).padStart(8) +
        `${(m.winRate * 100).toFixed(1)}%`.padStart(8) +
        `₹${m.totalReturn.toFixed(0)}`.padStart(12) +
        `${m.totalReturnPct.toFixed(2)}%`.padStart(10) +
        `${m.maxDrawdownPct.toFixed(2)}%`.padStart(8) +
        (m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)).padStart(8) +
        `₹${avgPnl.toFixed(0)}`.padStart(10) +
        String(m.exitBreakdown.target).padStart(8) +
        String(m.exitBreakdown.sl).padStart(6) +
        String(m.exitBreakdown.time).padStart(6) +
        String(m.exitBreakdown.other).padStart(7) +
        `  ${regime}`
      );
    } catch (e) {
      console.log(`  ${year}`.padEnd(8) + `  ERROR: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  console.log("  " + "-".repeat(110));
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("╔════════════════════════════════════════════════════════════════════════╗");
  console.log("║  BANKNIFTY LONG-TERM BACKTEST — 2018 to 2025 (7 Years)               ║");
  console.log("║  Real spot data, BS-model chain, 50bps slippage, all 12 strategies    ║");
  console.log("╚════════════════════════════════════════════════════════════════════════╝\n");

  // ── Fetch 7 years of spot data in chunks (Upstox returns max ~2000 candles) ──
  const periods = [
    ["2018-01-01", "2019-12-31"],
    ["2020-01-01", "2021-12-31"],
    ["2022-01-01", "2023-12-31"],
    ["2024-01-01", "2025-04-05"],
  ];

  let allSpot: Candle[] = [];
  for (const [from, to] of periods) {
    const candles = await fetchSpotCandles(from, to);
    allSpot.push(...candles);
  }

  // Deduplicate by date
  const seen = new Set<string>();
  allSpot = allSpot.filter(c => {
    const d = c.timestamp.slice(0, 10);
    if (seen.has(d)) return false;
    seen.add(d);
    return true;
  }).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const startPrice = allSpot[0].close;
  const endPrice = allSpot[allSpot.length - 1].close;
  const totalReturn = ((endPrice - startPrice) / startPrice * 100).toFixed(2);

  console.log(`\n📊 BANKNIFTY: ${startPrice.toFixed(0)} → ${endPrice.toFixed(0)} (${totalReturn}%)`);
  console.log(`📅 ${allSpot[0].timestamp.slice(0, 10)} → ${allSpot[allSpot.length - 1].timestamp.slice(0, 10)} (${allSpot.length} trading days)`);
  console.log(`💰 Capital: ₹${(CAPITAL / 100000).toFixed(0)} Lakh | Slippage: 50bps | Lot: 30\n`);

  // Build chain (BANKNIFTY IV typically 18-22%)
  console.log("  Building synthetic option chain (BS model, IV ~18%, skew 0.6x)...");
  const chainHistory = buildChainHistory(allSpot, 0.18, 30);
  console.log(`  Chain: ${chainHistory.length} snapshots, ${chainHistory[0]?.strikes.size} strikes each\n`);

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 1: ALL 12 STRATEGIES — FULL PERIOD
  // ═══════════════════════════════════════════════════════════════════

  console.log("═".repeat(130));
  console.log("  SECTION 1: ALL 12 STRATEGIES ON BANKNIFTY (2018-2025, 50bps slippage)");
  console.log("═".repeat(130));

  // BANKNIFTY-scaled parameters (AUDIT learning: scale OTM/wing to index level)
  // BANKNIFTY ~51K → OTM 1000pts ≈ 2% away (vs NIFTY ~23K → 500pts ≈ 2%)
  const strategyConfigs: Record<string, Record<string, number | string>> = {
    short_straddle:   { ivPercentileMin: 0, entryDteMin: 2, entryDteMax: 5, targetPct: 20, stopLossPct: 30, exitDte: 0 },
    short_strangle:   { ivPercentileMin: 0, entryDteMin: 4, entryDteMax: 8, targetPct: 30, stopLossPct: 80, exitDte: 1, ceDelta: 0.20, peDelta: -0.20 },
    iron_condor:      { entryDteMin: 5, entryDteMax: 8, exitDte: 0, shortDelta: 0.20, wingWidth: 300, targetPct: 20, stopLossMultiplier: 2 },
    iron_butterfly:   { entryDteMin: 3, entryDteMax: 7, exitDte: 0, wingWidth: 400, targetPct: 30, stopLossMultiplier: 1.5 },
    deep_otm_sell:    { otmDistance: 1000, minPremium: 20, targetDecayPct: 40, stopLossMultiplier: 2, dangerBufferPts: 300, entryDteMin: 7, entryDteMax: 14 },
    bull_call_spread:  { spreadWidth: 200, entryDteMin: 3, entryDteMax: 7, exitDte: 0, rsiMin: 55, ivPercentileMax: 100 },
    bear_put_spread:   { spreadWidth: 200, entryDteMin: 3, entryDteMax: 7, exitDte: 0, rsiMax: 45, ivPercentileMax: 100 },
    ema50_directional: {},
    long_straddle:     { ivPercentileMax: 100, entryDteMin: 3, entryDteMax: 10, targetPct: 20, stopLossPct: 25, exitDte: 0 },
    calendar_spread:   { nearDteMin: 2, nearDteMax: 6, spotMoveExitPct: 2 },
    straddle_920:      {},
    oi_max_pain:       { maxPainDeviationMin: 100, convergenceTarget: 50, stopLossDeviation: 200, entryDte: 3 },
  };

  const positionalStrategies: FnoStrategyName[] = [
    "short_straddle", "short_strangle", "iron_condor", "iron_butterfly",
    "deep_otm_sell", "bull_call_spread", "bear_put_spread",
    "long_straddle", "calendar_spread", "oi_max_pain",
  ];

  type ResultRow = {
    strategy: string;
    totalTrades: number;
    winRate: string;
    totalReturn: string;
    totalReturnPct: string;
    sharpe: string;
    maxDD: string;
    profitFactor: string;
    expectancy: string;
    target: number;
    sl: number;
    timeExit: number;
    other: number;
    verdict: string;
  };

  const results: ResultRow[] = [];

  for (const name of positionalStrategies) {
    process.stdout.write(`  Running ${name}...`);
    try {
      const m = runStrategy(name, chainHistory, allSpot, strategyConfigs[name]);

      let verdict = "❌ AVOID";
      if (m.totalTrades === 0) {
        verdict = "⚪ NO TRADES";
      } else if (m.totalReturnPct > 20 && m.winRate > 0.6 && m.sharpeRatio > 0.5) {
        verdict = "✅ STRONG";
      } else if (m.totalReturnPct > 5 && m.winRate > 0.5 && m.profitFactor > 1) {
        verdict = "🟡 DECENT";
      } else if (m.totalReturnPct > 0) {
        verdict = "🟠 MARGINAL";
      }

      results.push({
        strategy: name,
        totalTrades: m.totalTrades,
        winRate: `${(m.winRate * 100).toFixed(1)}%`,
        totalReturn: `₹${m.totalReturn.toFixed(0)}`,
        totalReturnPct: `${m.totalReturnPct.toFixed(2)}%`,
        sharpe: m.sharpeRatio.toFixed(2),
        maxDD: `${m.maxDrawdownPct.toFixed(2)}%`,
        profitFactor: m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2),
        expectancy: `₹${m.expectancy.toFixed(0)}`,
        target: m.exitBreakdown.target,
        sl: m.exitBreakdown.sl,
        timeExit: m.exitBreakdown.time,
        other: m.exitBreakdown.other,
        verdict,
      });
      console.log(` ${m.totalTrades} trades, ${(m.winRate * 100).toFixed(1)}% WR, ${m.totalReturnPct.toFixed(2)}%`);
    } catch (e) {
      console.log(` ERROR: ${(e as Error).message.slice(0, 80)}`);
      results.push({
        strategy: name, totalTrades: 0, winRate: "-", totalReturn: "-",
        totalReturnPct: "-", sharpe: "-", maxDD: "-", profitFactor: "-", expectancy: "-",
        target: 0, sl: 0, timeExit: 0, other: 0, verdict: "⚠️ ERROR",
      });
    }
  }

  // Sort by verdict then return
  const verdictOrder: Record<string, number> = {
    "✅ STRONG": 0, "🟡 DECENT": 1, "🟠 MARGINAL": 2,
    "⚪ NO TRADES": 3, "❌ AVOID": 4, "⚠️ ERROR": 5,
  };
  results.sort((a, b) => (verdictOrder[a.verdict] ?? 9) - (verdictOrder[b.verdict] ?? 9));

  console.log("\n" + "-".repeat(130));
  console.log(
    "Strategy".padEnd(22) +
    "Trades".padStart(7) +
    "Win%".padStart(8) +
    "Return".padStart(12) +
    "Return%".padStart(10) +
    "Sharpe".padStart(8) +
    "MaxDD".padStart(8) +
    "PF".padStart(7) +
    "Expect".padStart(10) +
    "Tgt".padStart(5) +
    "SL".padStart(5) +
    "Time".padStart(5) +
    "Oth".padStart(5) +
    "  Verdict"
  );
  console.log("-".repeat(130));

  for (const r of results) {
    console.log(
      r.strategy.padEnd(22) +
      String(r.totalTrades).padStart(7) +
      r.winRate.padStart(8) +
      r.totalReturn.padStart(12) +
      r.totalReturnPct.padStart(10) +
      r.sharpe.padStart(8) +
      r.maxDD.padStart(8) +
      r.profitFactor.padStart(7) +
      r.expectancy.padStart(10) +
      String(r.target).padStart(5) +
      String(r.sl).padStart(5) +
      String(r.timeExit).padStart(5) +
      String(r.other).padStart(5) +
      "  " + r.verdict
    );
  }
  console.log("-".repeat(130));

  // Transaction cost estimate
  const totalTrades = results.reduce((s, r) => s + r.totalTrades, 0);
  const avgLegsPerTrade = 2.5; // weighted avg across strategies
  const brokPerLeg = 20;  // discount broker ₹20/order
  const sttPerLotSell = 30 * 0.0005 * 50000 * 0.01; // rough: lot * stt_rate * notional proxy
  const totalBrokerage = totalTrades * avgLegsPerTrade * 2 * brokPerLeg; // round trip
  console.log(`\n  📝 Transaction cost estimate (NOT included in P&L above):`);
  console.log(`     Total trades across strategies: ${totalTrades}`);
  console.log(`     Est. brokerage: ₹${totalBrokerage.toLocaleString()} (₹20/order × ${avgLegsPerTrade} legs × 2 sides)`);
  console.log(`     Est. STT+exchange: ~₹${(totalTrades * 80).toLocaleString()} (₹80/round-trip)`);

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 2: DEEP OTM SELL — PARAMETER VARIANTS
  // ═══════════════════════════════════════════════════════════════════

  console.log("\n\n" + "═".repeat(130));
  console.log("  SECTION 2: DEEP OTM SELL — PARAMETER VARIANTS ON BANKNIFTY");
  console.log("  (NIFTY best was: otm=500-700, target=40%, SL=50%, DTE 7-14)");
  console.log("  (Scaling for BANKNIFTY: ~2.2x NIFTY, so otm=1000-1500, same % targets)");
  console.log("═".repeat(130));

  const deepOtmVariants: { label: string; params: Record<string, number | string> }[] = [
    // OTM distance variants
    { label: "OTM=800  SL=50 T=40 DTE=7-14",  params: { otmDistance: 800,  minPremium: 20, targetDecayPct: 40, stopLossMultiplier: 2, dangerBufferPts: 200, entryDteMin: 7, entryDteMax: 14 } },
    { label: "OTM=1000 SL=50 T=40 DTE=7-14",  params: { otmDistance: 1000, minPremium: 20, targetDecayPct: 40, stopLossMultiplier: 2, dangerBufferPts: 300, entryDteMin: 7, entryDteMax: 14 } },
    { label: "OTM=1200 SL=50 T=40 DTE=7-14",  params: { otmDistance: 1200, minPremium: 20, targetDecayPct: 40, stopLossMultiplier: 2, dangerBufferPts: 300, entryDteMin: 7, entryDteMax: 14 } },
    { label: "OTM=1500 SL=50 T=40 DTE=7-14",  params: { otmDistance: 1500, minPremium: 10, targetDecayPct: 40, stopLossMultiplier: 2, dangerBufferPts: 400, entryDteMin: 7, entryDteMax: 14 } },
    // Target variants
    { label: "OTM=1000 SL=50 T=30 DTE=7-14",  params: { otmDistance: 1000, minPremium: 20, targetDecayPct: 30, stopLossMultiplier: 2, dangerBufferPts: 300, entryDteMin: 7, entryDteMax: 14 } },
    { label: "OTM=1000 SL=50 T=50 DTE=7-14",  params: { otmDistance: 1000, minPremium: 20, targetDecayPct: 50, stopLossMultiplier: 2, dangerBufferPts: 300, entryDteMin: 7, entryDteMax: 14 } },
    { label: "OTM=1000 SL=50 T=60 DTE=7-14",  params: { otmDistance: 1000, minPremium: 20, targetDecayPct: 60, stopLossMultiplier: 2, dangerBufferPts: 300, entryDteMin: 7, entryDteMax: 14 } },
    // SL variants
    { label: "OTM=1000 SL=80 T=40 DTE=7-14",  params: { otmDistance: 1000, minPremium: 20, targetDecayPct: 40, stopLossMultiplier: 1.8, dangerBufferPts: 300, entryDteMin: 7, entryDteMax: 14 } },
    { label: "OTM=1000 SL=100 T=40 DTE=7-14", params: { otmDistance: 1000, minPremium: 20, targetDecayPct: 40, stopLossMultiplier: 3, dangerBufferPts: 300, entryDteMin: 7, entryDteMax: 14 } },
    // DTE variants
    { label: "OTM=1000 SL=50 T=40 DTE=3-7",   params: { otmDistance: 1000, minPremium: 10, targetDecayPct: 40, stopLossMultiplier: 2, dangerBufferPts: 300, entryDteMin: 3, entryDteMax: 7 } },
    { label: "OTM=1000 SL=50 T=40 DTE=7-20",  params: { otmDistance: 1000, minPremium: 20, targetDecayPct: 40, stopLossMultiplier: 2, dangerBufferPts: 300, entryDteMin: 7, entryDteMax: 20 } },
    // NIFTY-audit best combo scaled for BANKNIFTY
    { label: "★ BEST NIFTY SCALED: OTM=1400 SL=80 T=40 DTE=7-14", params: { otmDistance: 1400, minPremium: 10, targetDecayPct: 40, stopLossMultiplier: 1.8, dangerBufferPts: 400, entryDteMin: 7, entryDteMax: 14 } },
  ];

  console.log("\n" + "-".repeat(130));
  console.log(
    "Variant".padEnd(50) +
    "Trades".padStart(7) +
    "Win%".padStart(8) +
    "Return".padStart(12) +
    "Return%".padStart(10) +
    "Sharpe".padStart(8) +
    "MaxDD".padStart(8) +
    "PF".padStart(7) +
    "Expect".padStart(10) +
    "Tgt".padStart(5) +
    "SL".padStart(5)
  );
  console.log("-".repeat(130));

  let bestVariant = { label: "", returnPct: -Infinity, params: {} as Record<string, number | string> };

  for (const v of deepOtmVariants) {
    try {
      const m = runStrategy("deep_otm_sell", chainHistory, allSpot, v.params);

      if (m.totalReturnPct > bestVariant.returnPct && m.totalTrades >= 50) {
        bestVariant = { label: v.label, returnPct: m.totalReturnPct, params: v.params };
      }

      console.log(
        v.label.padEnd(50) +
        String(m.totalTrades).padStart(7) +
        `${(m.winRate * 100).toFixed(1)}%`.padStart(8) +
        `₹${m.totalReturn.toFixed(0)}`.padStart(12) +
        `${m.totalReturnPct.toFixed(2)}%`.padStart(10) +
        m.sharpeRatio.toFixed(2).padStart(8) +
        `${m.maxDrawdownPct.toFixed(2)}%`.padStart(8) +
        (m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)).padStart(7) +
        `₹${m.expectancy.toFixed(0)}`.padStart(10) +
        String(m.exitBreakdown.target).padStart(5) +
        String(m.exitBreakdown.sl).padStart(5)
      );
    } catch (e) {
      console.log(v.label.padEnd(50) + `  ERROR: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  console.log("-".repeat(130));

  if (bestVariant.label) {
    console.log(`\n  🏆 Best variant (≥50 trades): ${bestVariant.label} → ${bestVariant.returnPct.toFixed(2)}%`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 3: YEAR-BY-YEAR BREAKDOWN FOR TOP STRATEGIES
  // ═══════════════════════════════════════════════════════════════════

  console.log("\n\n" + "═".repeat(130));
  console.log("  SECTION 3: YEAR-BY-YEAR BREAKDOWN — TOP STRATEGIES");
  console.log("  (Checking for regime degradation — key NIFTY learning: deep OTM collapsed post-2020)");
  console.log("═".repeat(130));

  // Run year-by-year for the top strategies
  runYearByYear("short_straddle", chainHistory, allSpot, strategyConfigs.short_straddle);
  runYearByYear("short_strangle", chainHistory, allSpot, strategyConfigs.short_strangle);
  runYearByYear("deep_otm_sell", chainHistory, allSpot, strategyConfigs.deep_otm_sell);
  runYearByYear("iron_condor", chainHistory, allSpot, strategyConfigs.iron_condor);
  runYearByYear("long_straddle", chainHistory, allSpot, strategyConfigs.long_straddle);

  // Also run best deep OTM variant year-by-year
  if (bestVariant.label) {
    console.log(`\n  Best Deep OTM Variant: ${bestVariant.label}`);
    runYearByYear("deep_otm_sell", chainHistory, allSpot, bestVariant.params);
  }

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 4: SHORT STRADDLE PARAM VARIANTS (NIFTY best: DTE 2-5, T=20%, SL=30%)
  // ═══════════════════════════════════════════════════════════════════

  console.log("\n\n" + "═".repeat(130));
  console.log("  SECTION 4: SHORT STRADDLE — PARAMETER VARIANTS (was #1 on NIFTY)");
  console.log("═".repeat(130));

  const straddleVariants: { label: string; params: Record<string, number | string> }[] = [
    { label: "DTE=2-5  T=20 SL=30 (NIFTY best)", params: { ivPercentileMin: 0, entryDteMin: 2, entryDteMax: 5, targetPct: 20, stopLossPct: 30, exitDte: 0 } },
    { label: "DTE=2-5  T=30 SL=40",               params: { ivPercentileMin: 0, entryDteMin: 2, entryDteMax: 5, targetPct: 30, stopLossPct: 40, exitDte: 0 } },
    { label: "DTE=3-7  T=20 SL=30",               params: { ivPercentileMin: 0, entryDteMin: 3, entryDteMax: 7, targetPct: 20, stopLossPct: 30, exitDte: 0 } },
    { label: "DTE=3-7  T=30 SL=40",               params: { ivPercentileMin: 0, entryDteMin: 3, entryDteMax: 7, targetPct: 30, stopLossPct: 40, exitDte: 0 } },
    { label: "DTE=2-5  T=15 SL=25 (tight)",        params: { ivPercentileMin: 0, entryDteMin: 2, entryDteMax: 5, targetPct: 15, stopLossPct: 25, exitDte: 0 } },
    { label: "DTE=2-5  T=25 SL=35",               params: { ivPercentileMin: 0, entryDteMin: 2, entryDteMax: 5, targetPct: 25, stopLossPct: 35, exitDte: 0 } },
  ];

  console.log("\n" + "-".repeat(130));
  console.log(
    "Variant".padEnd(45) +
    "Trades".padStart(7) +
    "Win%".padStart(8) +
    "Return".padStart(12) +
    "Return%".padStart(10) +
    "Sharpe".padStart(8) +
    "MaxDD".padStart(8) +
    "PF".padStart(7) +
    "Expect".padStart(10) +
    "Tgt".padStart(5) +
    "SL".padStart(5) +
    "Time".padStart(5)
  );
  console.log("-".repeat(130));

  for (const v of straddleVariants) {
    try {
      const m = runStrategy("short_straddle", chainHistory, allSpot, v.params);
      console.log(
        v.label.padEnd(45) +
        String(m.totalTrades).padStart(7) +
        `${(m.winRate * 100).toFixed(1)}%`.padStart(8) +
        `₹${m.totalReturn.toFixed(0)}`.padStart(12) +
        `${m.totalReturnPct.toFixed(2)}%`.padStart(10) +
        m.sharpeRatio.toFixed(2).padStart(8) +
        `${m.maxDrawdownPct.toFixed(2)}%`.padStart(8) +
        (m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)).padStart(7) +
        `₹${m.expectancy.toFixed(0)}`.padStart(10) +
        String(m.exitBreakdown.target).padStart(5) +
        String(m.exitBreakdown.sl).padStart(5) +
        String(m.exitBreakdown.time).padStart(5)
      );
    } catch (e) {
      console.log(v.label.padEnd(45) + `  ERROR: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  console.log("-".repeat(130));

  // ═══════════════════════════════════════════════════════════════════

  console.log("\n" + "═".repeat(130));
  console.log("  NOTES & CAVEATS (from AUDIT.md)");
  console.log("═".repeat(130));
  console.log(`
  ⚠️  SYNTHETIC OPTION PRICES: BS model overprices by 4-46%. Absolute P&L not reliable.
  ⚠️  NO BID-ASK SPREAD: Real OTM options have 50%+ spreads on cheap premiums.
  ⚠️  SLIPPAGE: Using 50bps (10x the old default), but real OTM slippage can be higher.
  ⚠️  LOT SIZE: Using 30 (current). Was 25 pre-2023, 20 before that. Not adjusted historically.
  ⚠️  BANKNIFTY POST-NOV-2024: Only monthly expiry (SEBI removed weekly). Fewer trading opportunities.

  ✅  RELATIVE RANKINGS are reliable (strategy A vs B comparison is valid).
  ✅  WIN RATES are directionally correct (BS doesn't change whether a trade wins/loses much).
  ✅  YEAR-BY-YEAR TRENDS show regime degradation honestly.
  ✅  Use these results for strategy SELECTION, not P&L PREDICTION.
  `);

  console.log("═".repeat(130));
  console.log("  Backtest complete.");
  console.log("═".repeat(130));

  // Save results
  const outputPath = path.join(process.cwd(), "data", "banknifty-backtest-results.json");
  fs.writeFileSync(outputPath, JSON.stringify({ timestamp: new Date().toISOString(), underlying: UNDERLYING, period: `${allSpot[0].timestamp.slice(0, 10)} to ${allSpot[allSpot.length - 1].timestamp.slice(0, 10)}`, tradingDays: allSpot.length, results }, null, 2));
  console.log(`\n  Results saved to ${outputPath}`);
}

main().catch(console.error);
