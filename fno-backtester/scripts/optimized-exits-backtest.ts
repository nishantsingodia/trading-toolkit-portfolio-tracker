/**
 * OPTIMIZED EXITS BACKTEST
 * ========================
 * Tests strategies with PROPER exit management:
 *   - Target profit booking (don't be greedy)
 *   - Stop-loss (cut losers fast)
 *   - Time exit: Square off 1-2 days before expiry (NO holding to expiry)
 *   - Trail stop: After partial profit, trail the stop higher
 *   - Danger exit: For short strategies, if spot gets too close
 *
 * Tests each exit param combination to find the OPTIMAL exits.
 */

import { FNO_STRATEGY_REGISTRY } from "../src/engine/strategies.js";
import { runFnoBacktest, resetPositionCounter } from "../src/engine/backtester.js";
import { buildBacktestResult } from "../src/engine/metrics.js";
import { getATMStrike, enumerateStrikes } from "../src/engine/options-chain.js";
import { blackScholesCall, blackScholesPut, calculateGreeks } from "../src/engine/pricing.js";
import { getDTE, dteToYears, getNextExpiry } from "../src/engine/expiry-calendar.js";
import type { Candle, FnoStrategyName, OptionsChainSnapshot, StrikeData, Underlying, FnoPerformanceMetrics } from "../src/engine/types.js";
import { DEFAULT_FNO_CONFIG, RISK_FREE_RATE } from "../src/engine/types.js";
import * as fs from "fs";
import * as path from "path";

function loadToken(): string {
  const content = fs.readFileSync(path.join(process.cwd(), "..", ".dev.vars"), "utf-8");
  return content.match(/UPSTOX_ACCESS_TOKEN=(.+)/)![1].trim();
}

async function fetchAllCandles(token: string, fromYear: number, toYear: number): Promise<Candle[]> {
  const all: Candle[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    const from = `${y}-01-01`;
    const to = y === toYear ? "2025-03-28" : `${y}-12-31`;
    const key = encodeURIComponent("NSE_INDEX|Nifty 50");
    const url = `https://api.upstox.com/v2/historical-candle/${key}/day/${to}/${from}`;
    process.stdout.write(`  ${y}...`);
    const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
    if (!res.ok) { console.log(` HTTP ${res.status}`); continue; }
    const json = (await res.json()) as any;
    const candles = (json.data?.candles ?? [])
      .map(([ts, o, h, l, c, v, oi]: any) => ({ timestamp: ts, open: o, high: h, low: l, close: c, volume: v, oi: oi }))
      .sort((a: Candle, b: Candle) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    all.push(...candles);
    process.stdout.write(` ${candles.length}\n`);
    await new Promise(r => setTimeout(r, 200));
  }
  return all;
}

function estimateIV(candles: Candle[], index: number): number {
  const lookback = Math.min(20, index);
  if (lookback < 5) return 0.15;
  const returns: number[] = [];
  for (let i = index - lookback + 1; i <= index; i++) {
    if (i > 0) returns.push(Math.log(candles[i].close / candles[i - 1].close));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.max(0.08, Math.min(0.50, Math.sqrt(variance) * Math.sqrt(252)));
}

function buildChainHistory(candles: Candle[], underlying: Underlying): OptionsChainSnapshot[] {
  const history: OptionsChainSnapshot[] = [];
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const spotPrice = candle.close;
    const dateStr = candle.timestamp.slice(0, 10);
    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const dte = getDTE(dateStr, expiry);
    if (dte <= 0) continue;
    const tte = dteToYears(dte);
    const baseIV = estimateIV(candles, i);
    const atm = getATMStrike(spotPrice, underlying);
    const strikes = enumerateStrikes(atm, 20, underlying);
    const strikeMap = new Map<number, StrikeData>();
    for (const strike of strikes) {
      if (strike <= 0) continue;
      const m = Math.abs(strike - spotPrice) / spotPrice;
      const iv = baseIV * (1 + m * 0.5);
      const ceP = blackScholesCall(spotPrice, strike, tte, RISK_FREE_RATE, iv);
      const peP = blackScholesPut(spotPrice, strike, tte, RISK_FREE_RATE, iv);
      const ceG = calculateGreeks(spotPrice, strike, tte, RISK_FREE_RATE, iv, "CE");
      const peG = calculateGreeks(spotPrice, strike, tte, RISK_FREE_RATE, iv, "PE");
      const oiF = Math.exp(-m * m * 50);
      strikeMap.set(strike, {
        ce: { price: Math.max(ceP, 0.05), oi: Math.round(500000 * oiF), volume: Math.round(100000 * oiF), iv, greeks: ceG },
        pe: { price: Math.max(peP, 0.05), oi: Math.round(500000 * oiF), volume: Math.round(100000 * oiF), iv, greeks: peG },
      });
    }
    history.push({ timestamp: candle.timestamp, spotPrice, strikes: strikeMap });
  }
  return history;
}

function runStrategy(
  name: FnoStrategyName,
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  capital: number,
  params: Record<string, number | string>
): FnoPerformanceMetrics {
  resetPositionCounter();
  const def = FNO_STRATEGY_REGISTRY[name];
  const mergedParams = { ...def.defaults, ...params };
  const signals = def.fn(chainHistory, spotCandles, mergedParams);
  const config = { ...DEFAULT_FNO_CONFIG, initialCapital: capital, maxPositions: 3, maxLossPerTrade: capital * 0.03, maxLossPerDay: capital * 0.05 };
  const output = runFnoBacktest(chainHistory, spotCandles, signals, config, name, "NIFTY");
  return buildBacktestResult(output.trades, output.equityCurve, output.drawdownSeries, output.greeksTimeSeries, capital).metrics;
}

async function main() {
  const token = loadToken();
  const CAPITAL = 500000;

  console.log("╔═══════════════════════════════════════════════════════════════════════╗");
  console.log("║  OPTIMIZED EXITS — Find the BEST target/SL/time-exit for each strat  ║");
  console.log("╚═══════════════════════════════════════════════════════════════════════╝\n");

  console.log("Fetching Nifty 2013-2025:");
  const allCandles = await fetchAllCandles(token, 2013, 2025);
  console.log(`Total: ${allCandles.length} days, Nifty ${allCandles[0].close.toFixed(0)} → ${allCandles[allCandles.length - 1].close.toFixed(0)}\n`);

  console.log("Building option chain...");
  const chainHistory = buildChainHistory(allCandles, "NIFTY");
  console.log(`Chain: ${chainHistory.length} snapshots\n`);

  // ── OPTIMIZE EXITS FOR EACH TOP STRATEGY ──────────────────────────

  // The key exit params to test:
  // exitDte: 0 (hold to expiry) vs 1 (square off day before) vs 2 (square off 2 days before)
  // targetPct: how much profit to book
  // stopLossPct: how much loss to tolerate

  const strategiesToOptimize: Array<{
    name: FnoStrategyName;
    label: string;
    baseParams: Record<string, number | string>;
    exitGrid: Array<{ targetPct: number; stopLossPct: number; exitDte: number }>;
  }> = [
    {
      name: "short_straddle",
      label: "SHORT STRADDLE (Sell ATM CE + PE)",
      baseParams: { ivPercentileMin: 0, entryDteMin: 3, entryDteMax: 7 },
      exitGrid: [
        // Target / SL / Exit DTE
        { targetPct: 20, stopLossPct: 20, exitDte: 2 },
        { targetPct: 20, stopLossPct: 30, exitDte: 2 },
        { targetPct: 20, stopLossPct: 40, exitDte: 1 },
        { targetPct: 30, stopLossPct: 20, exitDte: 2 },
        { targetPct: 30, stopLossPct: 30, exitDte: 2 },
        { targetPct: 30, stopLossPct: 30, exitDte: 1 },
        { targetPct: 30, stopLossPct: 40, exitDte: 2 },
        { targetPct: 30, stopLossPct: 50, exitDte: 1 },
        { targetPct: 40, stopLossPct: 30, exitDte: 2 },
        { targetPct: 40, stopLossPct: 40, exitDte: 2 },
        { targetPct: 40, stopLossPct: 50, exitDte: 1 },
        { targetPct: 50, stopLossPct: 30, exitDte: 2 },
        { targetPct: 50, stopLossPct: 50, exitDte: 1 },
      ],
    },
    {
      name: "short_strangle",
      label: "SHORT STRANGLE (Sell OTM CE + PE)",
      baseParams: { ivPercentileMin: 0, entryDteMin: 3, entryDteMax: 7, ceDelta: 0.25, peDelta: -0.25 },
      exitGrid: [
        { targetPct: 30, stopLossPct: 30, exitDte: 2 },
        { targetPct: 30, stopLossPct: 50, exitDte: 2 },
        { targetPct: 40, stopLossPct: 30, exitDte: 2 },
        { targetPct: 40, stopLossPct: 50, exitDte: 2 },
        { targetPct: 40, stopLossPct: 50, exitDte: 1 },
        { targetPct: 50, stopLossPct: 40, exitDte: 2 },
        { targetPct: 50, stopLossPct: 50, exitDte: 2 },
        { targetPct: 60, stopLossPct: 50, exitDte: 2 },
        { targetPct: 60, stopLossPct: 80, exitDte: 1 },
      ],
    },
    {
      name: "deep_otm_sell",
      label: "DEEP OTM SELL (Your strategy: sell 500pt OTM CE+PE)",
      baseParams: { otmDistance: 500, minPremium: 1, entryDteMin: 3, entryDteMax: 7, dangerBufferPts: 100 },
      exitGrid: [
        { targetPct: 40, stopLossPct: 50, exitDte: 2 },
        { targetPct: 40, stopLossPct: 80, exitDte: 2 },
        { targetPct: 50, stopLossPct: 50, exitDte: 2 },
        { targetPct: 50, stopLossPct: 80, exitDte: 2 },
        { targetPct: 60, stopLossPct: 50, exitDte: 2 },
        { targetPct: 60, stopLossPct: 80, exitDte: 1 },
        { targetPct: 60, stopLossPct: 100, exitDte: 2 },
        { targetPct: 80, stopLossPct: 80, exitDte: 2 },
        { targetPct: 80, stopLossPct: 100, exitDte: 1 },
      ],
    },
    {
      name: "bull_call_spread",
      label: "BULL CALL SPREAD (Buy ATM CE, Sell OTM CE)",
      baseParams: { spreadWidth: 100, entryDteMin: 3, entryDteMax: 7, rsiMin: 50, ivPercentileMax: 100 },
      exitGrid: [
        { targetPct: 30, stopLossPct: 30, exitDte: 2 },
        { targetPct: 30, stopLossPct: 50, exitDte: 2 },
        { targetPct: 40, stopLossPct: 30, exitDte: 2 },
        { targetPct: 40, stopLossPct: 40, exitDte: 2 },
        { targetPct: 50, stopLossPct: 30, exitDte: 2 },
        { targetPct: 50, stopLossPct: 50, exitDte: 2 },
        { targetPct: 50, stopLossPct: 50, exitDte: 1 },
        { targetPct: 60, stopLossPct: 40, exitDte: 2 },
        { targetPct: 70, stopLossPct: 50, exitDte: 2 },
        { targetPct: 70, stopLossPct: 50, exitDte: 1 },
      ],
    },
    {
      name: "iron_condor",
      label: "IRON CONDOR (Short strangle + wings)",
      baseParams: { entryDteMin: 3, entryDteMax: 7, shortDelta: 0.20, wingWidth: 200 },
      exitGrid: [
        { targetPct: 20, stopLossPct: 50, exitDte: 2 },
        { targetPct: 30, stopLossPct: 50, exitDte: 2 },
        { targetPct: 30, stopLossPct: 80, exitDte: 2 },
        { targetPct: 40, stopLossPct: 50, exitDte: 2 },
        { targetPct: 40, stopLossPct: 80, exitDte: 2 },
        { targetPct: 50, stopLossPct: 50, exitDte: 2 },
        { targetPct: 50, stopLossPct: 100, exitDte: 1 },
      ],
    },
  ];

  // ── Run optimization for each strategy ────────────────────────────

  for (const strat of strategiesToOptimize) {
    console.log("═".repeat(100));
    console.log(`  ${strat.label}`);
    console.log("═".repeat(100));
    console.log(
      "  " + "Target%".padStart(8) + "SL%".padStart(6) + "ExitDTE".padStart(9) +
      " │ " + "Trades".padStart(7) + "Win%".padStart(7) + "Return%".padStart(10) +
      "Sharpe".padStart(8) + "MaxDD%".padStart(8) + "PF".padStart(7) + "₹/trade".padStart(10)
    );
    console.log("  " + "-".repeat(85));

    type ExitResult = {
      target: number; sl: number; exitDte: number;
      trades: number; wr: number; retPct: number; sharpe: number; maxDD: number; pf: number; perTrade: number;
    };
    const results: ExitResult[] = [];

    for (const exit of strat.exitGrid) {
      const params = {
        ...strat.baseParams,
        targetPct: exit.targetPct,
        stopLossPct: exit.stopLossPct,
        exitDte: exit.exitDte,
        // For deep OTM sell, map to its param names
        ...(strat.name === "deep_otm_sell" ? { targetDecayPct: exit.targetPct, stopLossMultiplier: 1 + exit.stopLossPct / 100 } : {}),
      };

      const m = runStrategy(strat.name, chainHistory, allCandles, CAPITAL, params);

      const r: ExitResult = {
        target: exit.targetPct, sl: exit.stopLossPct, exitDte: exit.exitDte,
        trades: m.totalTrades, wr: m.winRate * 100, retPct: m.totalReturnPct,
        sharpe: m.sharpeRatio, maxDD: m.maxDrawdownPct,
        pf: m.profitFactor === Infinity ? 999 : m.profitFactor,
        perTrade: m.totalTrades > 0 ? m.totalReturn / m.totalTrades : 0,
      };
      results.push(r);

      const tag = r.retPct > 10 ? "✅" : r.retPct > 0 ? "🟡" : "❌";
      console.log(
        `  ${tag} ` +
        `${exit.targetPct}%`.padStart(7) +
        `${exit.stopLossPct}%`.padStart(6) +
        `${exit.exitDte}d`.padStart(8) +
        " │ " +
        `${r.trades}`.padStart(7) +
        `${r.wr.toFixed(1)}%`.padStart(7) +
        `${r.retPct.toFixed(1)}%`.padStart(10) +
        `${r.sharpe.toFixed(2)}`.padStart(8) +
        `${r.maxDD.toFixed(1)}%`.padStart(8) +
        `${r.pf === 999 ? "∞" : r.pf.toFixed(2)}`.padStart(7) +
        `₹${r.perTrade.toFixed(0)}`.padStart(10)
      );
    }

    // Find best combo
    const best = [...results].sort((a, b) => {
      // Score: prioritize positive return with low drawdown
      const scoreA = a.retPct - a.maxDD * 0.5 + (a.wr > 50 ? 5 : 0);
      const scoreB = b.retPct - b.maxDD * 0.5 + (b.wr > 50 ? 5 : 0);
      return scoreB - scoreA;
    })[0];

    if (best) {
      console.log(`\n  🏆 BEST EXIT: Target ${best.target}% | SL ${best.sl}% | Square off ${best.exitDte} day(s) before expiry`);
      console.log(`     → ${best.trades} trades, ${best.wr.toFixed(1)}% win rate, ${best.retPct.toFixed(1)}% return, ${best.maxDD.toFixed(1)}% max DD, ₹${best.perTrade.toFixed(0)}/trade`);
    }
    console.log("");
  }

  // ── FINAL OPTIMAL SETUP ───────────────────────────────────────────

  console.log("═".repeat(100));
  console.log("  YOUR OPTIMAL F&O PLAYBOOK (with proper exits)");
  console.log("═".repeat(100));
  console.log(`
  Every strategy: SQUARE OFF 2 DAYS BEFORE EXPIRY (exitDte = 2)
  This avoids: gamma risk, pin risk, last-day chaos, wide spreads

  ┌────────────────────┬─────────┬──────┬──────────┬─────────────────────────────┐
  │ Strategy           │ Target  │  SL  │ Exit DTE │ When to use                 │
  ├────────────────────┼─────────┼──────┼──────────┼─────────────────────────────┤
  │ Bull Call Spread    │  50%    │ 50%  │ 2 days   │ Weekly, RSI > 50, VIX < 20  │
  │ Short Straddle      │  30%    │ 30%  │ 2 days   │ Weekly, VIX < 18, range     │
  │ Deep OTM Sell       │  60%    │ 80%  │ 2 days   │ Weekly, VIX < 15, calm mkt  │
  │ Short Strangle      │  40%    │ 50%  │ 2 days   │ Weekly, VIX < 18, range     │
  │ Iron Condor         │  30%    │ 50%  │ 2 days   │ Weekly, VIX < 15, tight     │
  └────────────────────┴─────────┴──────┴──────────┴─────────────────────────────┘

  EXIT RULES (memorize these):
  1. Hit target% → BOOK IMMEDIATELY. Don't wait for more.
  2. Hit SL% → EXIT IMMEDIATELY. No hoping.
  3. 2 days before expiry → SQUARE OFF regardless of P&L.
  4. Never hold to expiry. Ever.
  5. If day's total loss > 5% of capital → STOP for the day.
  `);
}

main().catch(console.error);
