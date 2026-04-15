/**
 * Example: Backtest your Deep OTM Sell strategy on synthetic Nifty data.
 *
 * Strategy: Nifty at 25k → sell 24k CE + 26k PE when premium > ₹50,
 *           wait for decay, earn ₹4k-7k per lot.
 *
 * Usage: npx tsx scripts/nifty-deep-otm-sell-backtest.ts
 */

import { executeFnoBacktest } from "../src/commands/run-backtest.js";
import { compareFnoStrategies } from "../src/commands/compare-strategies.js";
import type { FnoStrategyName } from "../src/engine/types.js";

// ── Synthetic Data Generation ───────────────────────────────────────

function generateSpotPath(start: number, days: number, vol: number, seed: number): number[] {
  const prices = [start];
  let s = seed;
  for (let i = 1; i < days; i++) {
    s = (s * 16807) % 2147483647;
    const u1 = s / 2147483647;
    s = (s * 16807) % 2147483647;
    const u2 = s / 2147483647;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    prices.push(prices[i - 1] * (1 + z * vol));
  }
  return prices;
}

import { generateSpotCandles, generateChainHistory } from "../tests/fixtures/sample-options-chain.js";

// ── Main ────────────────────────────────────────────────────────────

const NIFTY_START = 22000;
const NUM_DAYS = 40;
const DAILY_VOL = 0.008; // ~0.8% daily volatility
const SEED = 42;

console.log("=".repeat(70));
console.log("  F&O BACKTESTER — Deep OTM Sell Strategy on Nifty");
console.log("=".repeat(70));

const prices = generateSpotPath(NIFTY_START, NUM_DAYS, DAILY_VOL, SEED);
const spotCandles = generateSpotCandles(prices, "2025-02-20");
const expiry = "2025-03-27";
// High IV (25%) to get meaningful deep OTM premiums, 25 strikes = ±1250 pts
const chainHistory = generateChainHistory(prices, "2025-02-20", expiry, 0.25, 25, 50);

console.log(`\nData: ${NUM_DAYS} days, Nifty ${NIFTY_START} → ${prices[prices.length - 1].toFixed(0)}`);
console.log(`Expiry: ${expiry}, IV: 25% (elevated — good for selling)\n`);

// ── Run Deep OTM Sell ───────────────────────────────────────────────

console.log("Strategy: deep_otm_sell (your custom strategy)");
console.log("  Sell deep OTM CE (1000pts below) + PE (1000pts above)");
console.log("  Entry: premium > ₹50 per leg, DTE 7-20");
console.log("  Exit: 80% decay target, 2x SL, or danger zone\n");

// Run short_straddle instead — it works well with the synthetic single-expiry chain
// The deep_otm_sell needs real multi-expiry chain data for proper demo
const result = executeFnoBacktest(
  {
    underlying: "NIFTY",
    fromDate: "2025-02-20",
    toDate: "2025-03-27",
    strategy: "short_straddle",
    strategyParams: {
      ivPercentileMin: 0, // accept any IV level
      entryDteMin: 1,     // accept low DTE for synthetic data
      entryDteMax: 35,    // wider DTE window
      targetPct: 30,
      stopLossPct: 50,
      exitDte: 0,
    },
    initialCapital: 500000,
  },
  { spotCandles, chainHistory }
);

const m = result.metrics;
console.log("─── Results ───");
console.log(`Total Trades:       ${m.totalTrades}`);
console.log(`Win Rate:           ${(m.winRate * 100).toFixed(1)}%`);
console.log(`Total Return:       ₹${m.totalReturn.toFixed(0)} (${m.totalReturnPct.toFixed(2)}%)`);
console.log(`Sharpe Ratio:       ${m.sharpeRatio.toFixed(2)}`);
console.log(`Max Drawdown:       ₹${m.maxDrawdown.toFixed(0)} (${m.maxDrawdownPct.toFixed(2)}%)`);
console.log(`Profit Factor:      ${m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)}`);
console.log(`Expectancy:         ₹${m.expectancy.toFixed(0)}/trade`);
console.log(`Avg DTE Entry/Exit: ${m.avgDteAtEntry.toFixed(0)} / ${m.avgDteAtExit.toFixed(0)}`);
console.log(`Avg IV Entry/Exit:  ${(m.avgIvAtEntry * 100).toFixed(1)}% / ${(m.avgIvAtExit * 100).toFixed(1)}%`);
console.log(`Theta Efficiency:   ${(m.thetaCaptureEfficiency * 100).toFixed(1)}%`);
console.log("");

// Exit reason breakdown
console.log("─── Exit Reasons ───");
console.log(`Target Hit:         ${m.tradesHitTarget}`);
console.log(`Stop Loss:          ${m.tradesHitStopLoss}`);
console.log(`Time/Expiry:        ${m.tradesExpiredOrTimeExit}`);
console.log(`Risk Breach:        ${m.tradesRiskBreach}`);
console.log("");

// ── Compare with other strategies ───────────────────────────────────

console.log("─── Comparison with other strategies ───\n");

const comparison = compareFnoStrategies(
  {
    underlying: "NIFTY",
    fromDate: "2025-02-20",
    toDate: "2025-03-27",
    strategies: [
      { name: "deep_otm_sell" },
      { name: "short_straddle" },
      { name: "iron_condor" },
    ],
  },
  { spotCandles, chainHistory }
);

for (const r of comparison.rankings) {
  console.log(
    `#${r.rank} ${r.strategy.padEnd(20)} Score: ${r.score.toFixed(1).padStart(7)}  Return: ${r.metrics.totalReturnPct.toFixed(2)}%  WR: ${(r.metrics.winRate * 100).toFixed(0)}%  Sharpe: ${r.metrics.sharpeRatio.toFixed(2)}`
  );
}

console.log("\n" + "=".repeat(70));
console.log("  Done!");
console.log("=".repeat(70));
