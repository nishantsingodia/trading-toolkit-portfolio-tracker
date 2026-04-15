/**
 * COMPREHENSIVE F&O STRATEGY BACKTEST
 * ====================================
 * Fetches REAL Nifty spot data from Upstox, builds BS-modeled option chains,
 * and backtests all 12 strategies with full metrics comparison.
 *
 * Usage: npx tsx scripts/full-strategy-comparison.ts
 */

import { FNO_STRATEGY_REGISTRY } from "../src/engine/strategies.js";
import { runFnoBacktest, resetPositionCounter } from "../src/engine/backtester.js";
import { buildBacktestResult } from "../src/engine/metrics.js";
import { getATMStrike, enumerateStrikes } from "../src/engine/options-chain.js";
import { blackScholesCall, blackScholesPut, calculateGreeks } from "../src/engine/pricing.js";
import { getDTE, dteToYears, getNextExpiry, getWeeklyExpiries } from "../src/engine/expiry-calendar.js";
import type { Candle, FnoStrategyName, OptionsChainSnapshot, StrikeData, Underlying, FnoPerformanceMetrics } from "../src/engine/types.js";
import { DEFAULT_FNO_CONFIG, RISK_FREE_RATE } from "../src/engine/types.js";
import * as fs from "fs";
import * as path from "path";

// ── Load Upstox Token ───────────────────────────────────────────────

function loadToken(): string {
  const devVarsPath = path.join(process.cwd(), "..", ".dev.vars");
  const content = fs.readFileSync(devVarsPath, "utf-8");
  const match = content.match(/UPSTOX_ACCESS_TOKEN=(.+)/);
  if (!match) throw new Error("No UPSTOX_ACCESS_TOKEN in .dev.vars");
  return match[1].trim();
}

// ── Fetch Real Spot Data ────────────────────────────────────────────

async function fetchSpotCandles(
  underlying: string,
  fromDate: string,
  toDate: string,
  token: string,
  interval: string = "day"
): Promise<Candle[]> {
  const indexKey = underlying === "NIFTY" ? "NSE_INDEX|Nifty 50" : "NSE_INDEX|Nifty Bank";
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(indexKey)}/${interval}/${toDate}/${fromDate}`;

  console.log(`  Fetching ${underlying} ${interval} candles: ${fromDate} → ${toDate}...`);
  const response = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upstox API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const json = (await response.json()) as {
    data: { candles: Array<[string, number, number, number, number, number, number]> };
  };

  const candles = (json.data?.candles ?? [])
    .map(([timestamp, open, high, low, close, volume, oi]) => ({ timestamp, open, high, low, close, volume, oi }))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  console.log(`  Got ${candles.length} candles. Range: ${candles[0]?.close?.toFixed(0)} → ${candles[candles.length - 1]?.close?.toFixed(0)}`);
  return candles;
}

// ── Build Synthetic Chain from Real Spot ─────────────────────────────

function buildChainHistory(
  spotCandles: Candle[],
  underlying: Underlying,
  baseIV: number = 0.15,
  numStrikes: number = 25
): OptionsChainSnapshot[] {
  const history: OptionsChainSnapshot[] = [];
  const strikeInterval = underlying === "NIFTY" ? 50 : 100;

  for (const candle of spotCandles) {
    const spotPrice = candle.close;
    const dateStr = candle.timestamp.slice(0, 10);

    // Find next weekly expiry
    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const dte = getDTE(dateStr, expiry);
    if (dte <= 0) continue;
    const tte = dteToYears(dte);

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

// ── Run Single Strategy ─────────────────────────────────────────────

function runStrategy(
  name: FnoStrategyName,
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  underlying: Underlying,
  capital: number,
  customParams?: Record<string, number | string>
): FnoPerformanceMetrics & { trades_detail: string[] } {
  resetPositionCounter();

  const def = FNO_STRATEGY_REGISTRY[name];
  const params = { ...def.defaults, ...(customParams ?? {}) };
  const signals = def.fn(chainHistory, spotCandles, params);

  const config = {
    ...DEFAULT_FNO_CONFIG,
    initialCapital: capital,
    maxPositions: 3,
    maxLossPerTrade: capital * 0.03, // 3% of capital
    maxLossPerDay: capital * 0.05,   // 5% of capital
  };

  const output = runFnoBacktest(chainHistory, spotCandles, signals, config, name, underlying);
  const result = buildBacktestResult(output.trades, output.equityCurve, output.drawdownSeries, output.greeksTimeSeries, capital);

  const trades_detail = output.trades.slice(0, 5).map(t =>
    `${t.entryDate.slice(0, 10)} → ${t.exitDate.slice(0, 10)} | PnL: ₹${t.exitPnl.toFixed(0)} | ${t.exitReason}`
  );

  return { ...result.metrics, trades_detail };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const token = loadToken();
  const CAPITAL = 500000; // ₹5 Lakh

  // Parse --underlying CLI arg (default: NIFTY)
  const underlyingArg = process.argv.find((_, i) => process.argv[i - 1] === "--underlying");
  const UNDERLYING: Underlying = underlyingArg === "BANKNIFTY" ? "BANKNIFTY" : "NIFTY";

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log(`║   F&O STRATEGY BACKTEST — ALL 12 STRATEGIES ON REAL ${UNDERLYING.padEnd(10)} DATA  ║`);
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  // ── Fetch real data for multiple periods ───────────────────────────
  // Period 1: Last ~6 months (daily)
  const spotCandles = await fetchSpotCandles(UNDERLYING, "2024-09-01", "2025-03-28", token, "day");

  if (spotCandles.length === 0) {
    console.error("No data fetched. Check your Upstox token.");
    return;
  }

  const startPrice = spotCandles[0].close;
  const endPrice = spotCandles[spotCandles.length - 1].close;
  const indexReturn = ((endPrice - startPrice) / startPrice * 100).toFixed(2);

  console.log(`\n📊 ${UNDERLYING} Performance: ${startPrice.toFixed(0)} → ${endPrice.toFixed(0)} (${indexReturn}%)`);
  console.log(`📅 Period: ${spotCandles[0].timestamp.slice(0, 10)} → ${spotCandles[spotCandles.length - 1].timestamp.slice(0, 10)} (${spotCandles.length} days)`);
  console.log(`💰 Capital: ₹${(CAPITAL / 100000).toFixed(0)} Lakh\n`);

  // Build chain with realistic IV levels
  // BANKNIFTY typically has higher IV (~18%) vs NIFTY (~14%)
  const baseIV = UNDERLYING === "BANKNIFTY" ? 0.18 : 0.14;
  console.log(`  Building synthetic option chain (BS model, IV ~${(baseIV * 100).toFixed(0)}%)...`);
  const chainHistory = buildChainHistory(spotCandles, UNDERLYING, baseIV, 25);
  console.log(`  Chain built: ${chainHistory.length} snapshots, ${chainHistory[0]?.strikes.size} strikes each\n`);

  // ── Run all strategies with relaxed params for daily data ─────────
  // The key insight: with daily data, we need to relax DTE and IV filters
  // because we can only enter once per day (not intraday)

  // BANKNIFTY has wider moves → adjust OTM distances & wing widths
  const isBank = UNDERLYING === "BANKNIFTY";
  const wingWidth = isBank ? 400 : 200;
  const otmDist = isBank ? 1000 : 500;
  const spreadW = isBank ? 200 : 100;

  const strategyConfigs: Record<string, Record<string, number | string>> = {
    short_straddle: { __underlying: UNDERLYING, ivPercentileMin: 0, entryDteMin: 2, entryDteMax: 7, targetPct: 30, stopLossPct: 40, exitDte: 0 },
    short_strangle: { __underlying: UNDERLYING, ivPercentileMin: 0, entryDteMin: 2, entryDteMax: 7, targetPct: 40, stopLossPct: 80, exitDte: 0, ceDelta: 0.25, peDelta: -0.25 },
    iron_condor: { __underlying: UNDERLYING, entryDteMin: 3, entryDteMax: 7, exitDte: 0, shortDelta: 0.20, wingWidth, targetPct: 40, stopLossMultiplier: 2 },
    iron_butterfly: { __underlying: UNDERLYING, entryDteMin: 3, entryDteMax: 7, exitDte: 0, wingWidth, targetPct: 30, stopLossMultiplier: 1.5 },
    deep_otm_sell: { __underlying: UNDERLYING, otmDistance: otmDist, minPremium: 1, targetDecayPct: 60, stopLossMultiplier: 2, dangerBufferPts: isBank ? 200 : 100, entryDteMin: 3, entryDteMax: 7 },
    bull_call_spread: { __underlying: UNDERLYING, spreadWidth: spreadW, entryDteMin: 3, entryDteMax: 7, exitDte: 0, rsiMin: 50, ivPercentileMax: 100 },
    bear_put_spread: { __underlying: UNDERLYING, spreadWidth: spreadW, entryDteMin: 3, entryDteMax: 7, exitDte: 0, rsiMax: 50, ivPercentileMax: 100 },
    ema50_directional: { __underlying: UNDERLYING }, // Intraday — needs 1min data, will skip
    long_straddle: { __underlying: UNDERLYING, ivPercentileMax: 100, entryDteMin: 3, entryDteMax: 7, targetPct: 20, stopLossPct: 20, exitDte: 0 },
    calendar_spread: { __underlying: UNDERLYING, nearDteMin: 2, nearDteMax: 6, spotMoveExitPct: 2 },
    straddle_920: { __underlying: UNDERLYING }, // Intraday — needs 1min data, will skip
    oi_max_pain: { __underlying: UNDERLYING, maxPainDeviationMin: isBank ? 100 : 50, convergenceTarget: isBank ? 50 : 25, stopLossDeviation: isBank ? 200 : 100, entryDte: 3 },
  };

  // ── Run each strategy ─────────────────────────────────────────────

  type ResultRow = {
    strategy: string;
    mode: string;
    totalTrades: number;
    winRate: string;
    totalReturn: string;
    totalReturnPct: string;
    sharpe: string;
    maxDD: string;
    profitFactor: string;
    expectancy: string;
    avgDteEntry: string;
    targetHit: number;
    slHit: number;
    timeExit: number;
    verdict: string;
    trades_detail: string[];
  };

  const results: ResultRow[] = [];

  const positionalStrategies: FnoStrategyName[] = [
    "short_straddle", "short_strangle", "iron_condor", "iron_butterfly",
    "deep_otm_sell", "bull_call_spread", "bear_put_spread",
    "long_straddle", "calendar_spread", "oi_max_pain",
  ];

  for (const name of positionalStrategies) {
    console.log(`  Running ${name}...`);
    try {
      const m = runStrategy(name, chainHistory, spotCandles, UNDERLYING, CAPITAL, strategyConfigs[name]);

      let verdict = "❌ AVOID";
      if (m.totalTrades === 0) {
        verdict = "⚪ NO TRADES";
      } else if (m.totalReturnPct > 5 && m.winRate > 0.5 && m.sharpeRatio > 0.5) {
        verdict = "✅ STRONG — Follow This";
      } else if (m.totalReturnPct > 0 && m.winRate > 0.4 && m.profitFactor > 1) {
        verdict = "🟡 DECENT — Use With Caution";
      } else if (m.totalReturnPct > 0) {
        verdict = "🟠 MARGINAL";
      }

      results.push({
        strategy: name,
        mode: FNO_STRATEGY_REGISTRY[name].executionMode,
        totalTrades: m.totalTrades,
        winRate: `${(m.winRate * 100).toFixed(1)}%`,
        totalReturn: `₹${m.totalReturn.toFixed(0)}`,
        totalReturnPct: `${m.totalReturnPct.toFixed(2)}%`,
        sharpe: m.sharpeRatio.toFixed(2),
        maxDD: `${m.maxDrawdownPct.toFixed(2)}%`,
        profitFactor: m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2),
        expectancy: `₹${m.expectancy.toFixed(0)}`,
        avgDteEntry: m.avgDteAtEntry.toFixed(1),
        targetHit: m.tradesHitTarget,
        slHit: m.tradesHitStopLoss,
        timeExit: m.tradesExpiredOrTimeExit,
        verdict,
        trades_detail: m.trades_detail,
      });
    } catch (e) {
      console.log(`    Error: ${(e as Error).message}`);
      results.push({
        strategy: name, mode: "positional", totalTrades: 0, winRate: "-", totalReturn: "-",
        totalReturnPct: "-", sharpe: "-", maxDD: "-", profitFactor: "-", expectancy: "-",
        avgDteEntry: "-", targetHit: 0, slHit: 0, timeExit: 0, verdict: "⚠️ ERROR", trades_detail: [],
      });
    }
  }

  // Add note for intraday strategies
  results.push({
    strategy: "ema50_directional", mode: "intraday", totalTrades: 0, winRate: "-", totalReturn: "-",
    totalReturnPct: "-", sharpe: "-", maxDD: "-", profitFactor: "-", expectancy: "-",
    avgDteEntry: "-", targetHit: 0, slHit: 0, timeExit: 0, verdict: "⏳ NEEDS 1-MIN DATA", trades_detail: [],
  });
  results.push({
    strategy: "straddle_920", mode: "intraday", totalTrades: 0, winRate: "-", totalReturn: "-",
    totalReturnPct: "-", sharpe: "-", maxDD: "-", profitFactor: "-", expectancy: "-",
    avgDteEntry: "-", targetHit: 0, slHit: 0, timeExit: 0, verdict: "⏳ NEEDS 1-MIN DATA", trades_detail: [],
  });

  // ── Print Results ─────────────────────────────────────────────────

  console.log("\n" + "═".repeat(120));
  console.log(`  RESULTS SUMMARY — All F&O Strategies on ${UNDERLYING} (6-Month Backtest)`);
  console.log("═".repeat(120));

  // Sort by verdict quality then return
  const verdictOrder: Record<string, number> = {
    "✅ STRONG — Follow This": 0,
    "🟡 DECENT — Use With Caution": 1,
    "🟠 MARGINAL": 2,
    "⚪ NO TRADES": 3,
    "⏳ NEEDS 1-MIN DATA": 4,
    "❌ AVOID": 5,
    "⚠️ ERROR": 6,
  };
  results.sort((a, b) => (verdictOrder[a.verdict] ?? 9) - (verdictOrder[b.verdict] ?? 9));

  console.log("\n" + "-".repeat(120));
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
    "  Verdict"
  );
  console.log("-".repeat(120));

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
      "  " + r.verdict
    );
  }
  console.log("-".repeat(120));

  // ── Detailed Analysis for Top Strategies ──────────────────────────

  const actionable = results.filter(r => r.verdict.includes("STRONG") || r.verdict.includes("DECENT"));

  if (actionable.length > 0) {
    console.log("\n" + "═".repeat(80));
    console.log("  ACTIONABLE STRATEGIES — Follow These Religiously");
    console.log("═".repeat(80));

    for (const r of actionable) {
      const def = FNO_STRATEGY_REGISTRY[r.strategy as FnoStrategyName];
      console.log(`\n🎯 ${r.strategy.toUpperCase()}`);
      console.log(`   ${def.description}`);
      console.log(`   Mode: ${r.mode} | Refresh: ${def.refreshInterval}`);
      console.log(`   Win Rate: ${r.winRate} | Return: ${r.totalReturnPct} | Sharpe: ${r.sharpe}`);
      console.log(`   Target Hits: ${r.targetHit} | SL Hits: ${r.slHit} | Time Exits: ${r.timeExit}`);
      console.log(`   Avg DTE at Entry: ${r.avgDteEntry} days`);

      if (r.trades_detail.length > 0) {
        console.log("   Recent trades:");
        for (const t of r.trades_detail) console.log(`     ${t}`);
      }

      // Strategy-specific rules
      console.log("\n   📋 RULES TO FOLLOW:");
      if (r.strategy === "short_straddle") {
        console.log("   1. Enter when DTE = 3-7 (weekly expiry)");
        console.log("   2. Sell ATM CE + ATM PE");
        console.log("   3. Target: 30% premium decay → book profit");
        console.log("   4. SL: If combined premium rises 40% → EXIT immediately");
        console.log("   5. Time exit: Close at DTE = 0 regardless");
        console.log("   6. NEVER hold past expiry — intraday settle or exit before");
        console.log("   7. Skip if VIX > 20 (gap risk too high)");
      } else if (r.strategy === "short_strangle") {
        console.log("   1. Enter when DTE = 3-7, sell 0.25 delta CE + PE");
        console.log("   2. Target: 40% premium decay → book");
        console.log("   3. SL: Combined premium rises 80% → EXIT");
        console.log("   4. If one leg goes ITM → close BOTH legs immediately");
      } else if (r.strategy === "iron_condor") {
        console.log("   1. Enter when DTE = 3-7, sell 0.20 delta CE+PE, buy wings 200pts further");
        console.log("   2. Max loss is DEFINED = wing width - credit");
        console.log("   3. Target: 40% of max profit → book");
        console.log("   4. SAFEST option seller strategy — losses are capped");
      } else if (r.strategy === "iron_butterfly") {
        console.log("   1. Enter when DTE = 3-7, sell ATM CE+PE, buy wings 200pts OTM");
        console.log("   2. Higher premium than iron condor but tighter range");
        console.log("   3. Target: 30% of max profit");
        console.log("   4. Best when you expect market to stay FLAT");
      } else if (r.strategy === "deep_otm_sell") {
        console.log("   1. YOUR STRATEGY: Sell 500pt OTM CE + PE");
        console.log("   2. Wait for premium to decay 60%+ → book profit");
        console.log("   3. DANGER EXIT: If spot comes within 100pts of strike");
        console.log("   4. SL: Premium doubles from entry → EXIT");
        console.log("   5. Need ~₹4.2L margin for naked legs");
        console.log("   6. Consider adding wings (→ wide iron condor) to cap losses");
      } else if (r.strategy === "bull_call_spread") {
        console.log("   1. Enter when RSI > 50 (bullish bias)");
        console.log("   2. Buy ATM CE + Sell 100pt higher CE");
        console.log("   3. Max loss = net debit paid (DEFINED)");
        console.log("   4. Best in mild uptrends");
      } else if (r.strategy === "bear_put_spread") {
        console.log("   1. Enter when RSI < 50 (bearish bias)");
        console.log("   2. Buy ATM PE + Sell 100pt lower PE");
        console.log("   3. Max loss = net debit paid (DEFINED)");
      } else if (r.strategy === "long_straddle") {
        console.log("   1. BUY ATM CE + PE when you expect big move");
        console.log("   2. Target: 20% premium rise → book");
        console.log("   3. SL: 20% premium drop → EXIT (theta eats you)");
        console.log("   4. Best BEFORE events (RBI, Budget, earnings)");
      }
    }
  }

  // ── Final Recommendations ─────────────────────────────────────────

  console.log("\n" + "═".repeat(80));
  console.log("  FINAL RECOMMENDATIONS");
  console.log("═".repeat(80));
  console.log(`
  MONEY MANAGEMENT RULES (follow these NO MATTER what):
  1. Never risk more than 2% of capital on a single trade
  2. Max 3 positions open simultaneously
  3. Daily loss limit: 5% of capital → stop trading for the day
  4. Always use stop-losses — no "hoping it comes back"
  5. Book profits at target — don't get greedy

  STRATEGY SELECTION by VIX:
  • VIX < 12: Iron Condor, Short Strangle (premiums small but reliable)
  • VIX 12-18: Short Straddle, Deep OTM Sell, Iron Condor
  • VIX 18-25: Bull/Bear Spreads, Long Straddle (if event coming)
  • VIX > 25: STOP SELLING. Only defined-risk or stay cash.

  THE 93% RULE: 93% of F&O traders lose money. The 7% who win:
  • Have BACKTESTED strategies (you're doing this now ✅)
  • Follow strict position sizing (1-2% risk per trade)
  • Never revenge-trade after a loss
  • Exit at stop-loss WITHOUT THINKING
  `);

  console.log("═".repeat(80));
  console.log("  Backtest complete.");
  console.log("═".repeat(80));
}

main().catch(console.error);
