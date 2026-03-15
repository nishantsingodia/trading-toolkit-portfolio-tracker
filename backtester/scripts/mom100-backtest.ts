/**
 * Backtest: "Buy MOM100 ETF every 1% dip, invest ₹10k each time"
 * Then optimize sell parameters to maximize CAGR.
 *
 * Since we don't have a live Upstox token, we simulate realistic MOM100
 * price action based on actual Nifty Midcap 150 Momentum 50 performance:
 * - Jan 2023: ~15.5 NAV → Mar 2026: ~24 NAV (~55% total, ~17% CAGR)
 * - Intermittent corrections of 5-12%
 */
import { buyTheDip } from "../src/engine/strategies.js";
import { runBacktest } from "../src/engine/backtester.js";
import { calculateMetrics } from "../src/engine/metrics.js";
import { optimizeWithCandles } from "../src/commands/optimize-strategy.js";
import type { Candle } from "../src/engine/types.js";

// --- Generate realistic MOM100-like daily candles (Jan 2023 - Mar 2026) ---
function generateMom100Candles(): Candle[] {
  const candles: Candle[] = [];
  let price = 15.5; // NAV in Jan 2023
  const startDate = new Date("2023-01-02T00:00:00Z");

  // ~800 trading days from Jan 2023 to Mar 2026
  let seed = 12345;
  function rand(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 10000) / 10000;
  }

  // Regime: bull with periodic corrections
  // Target: 15.5 → ~24 over 800 days (~0.055% daily drift)
  const dailyDrift = 0.00055;

  for (let i = 0; i < 800; i++) {
    const date = new Date(startDate.getTime() + i * 86_400_000);
    const dow = date.getDay();
    if (dow === 0 || dow === 6) continue; // Skip weekends

    // Corrections: simulate 5 drawdown periods
    let regimeDrift = dailyDrift;
    let volatility = 0.012; // ~1.2% daily vol

    // Correction periods (simulate real midcap corrections)
    if (i >= 60 && i <= 80) { regimeDrift = -0.004; volatility = 0.018; }   // Feb-Mar 2023 correction
    if (i >= 180 && i <= 200) { regimeDrift = -0.003; volatility = 0.015; }  // Jun 2023 pullback
    if (i >= 350 && i <= 380) { regimeDrift = -0.005; volatility = 0.020; }  // Jan 2024 correction
    if (i >= 500 && i <= 540) { regimeDrift = -0.006; volatility = 0.022; }  // Jul-Aug 2024 correction
    if (i >= 650 && i <= 690) { regimeDrift = -0.004; volatility = 0.018; }  // Jan 2025 pullback
    // Strong rally periods
    if (i >= 100 && i <= 170) { regimeDrift = 0.003; }  // Apr-Jun 2023 rally
    if (i >= 220 && i <= 340) { regimeDrift = 0.002; }  // Jul-Dec 2023 rally
    if (i >= 400 && i <= 490) { regimeDrift = 0.0025; } // Mar-Jun 2024 rally

    const change = regimeDrift + (rand() - 0.5) * 2 * volatility;
    const newPrice = price * (1 + change);

    const open = price;
    const close = newPrice;
    const high = Math.max(open, close) * (1 + rand() * 0.005);
    const low = Math.min(open, close) * (1 - rand() * 0.005);

    candles.push({
      timestamp: date.toISOString(),
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: 500000 + Math.floor(rand() * 1000000),
      oi: 0,
    });

    price = newPrice;
  }

  return candles;
}

const candles = generateMom100Candles();
console.log(`\n📊 MOM100 Simulation: ${candles.length} trading days`);
console.log(`   Start: ${candles[0].timestamp.slice(0, 10)} @ ₹${candles[0].close}`);
console.log(`   End:   ${candles[candles.length - 1].timestamp.slice(0, 10)} @ ₹${candles[candles.length - 1].close}`);
const buyHoldReturn = ((candles[candles.length - 1].close - candles[0].close) / candles[0].close * 100);
console.log(`   Buy & Hold Return: ${buyHoldReturn.toFixed(1)}%\n`);

// --- Step 1: Backtest with default params ---
console.log("═══════════════════════════════════════════════════════════════");
console.log("STEP 1: Backtest 'Buy every 1% dip, ₹10k each time'");
console.log("═══════════════════════════════════════════════════════════════\n");

// ₹10k per dip buy at ~₹20 avg price = ~500 units per buy
// We'll use quantity=500 to approximate ₹10k per buy
const avgPrice = candles.reduce((s, c) => s + c.close, 0) / candles.length;
const qtyPer10k = Math.round(10000 / avgPrice);

const defaultParams = {
  buyDropPct: -1,
  sellTargetPct: 5,
  stopLossPct: -3,
  maxHoldDays: 60,
};

const signals = buyTheDip(candles, defaultParams);
const result = runBacktest(candles, signals, {
  initialCapital: 500000, // ₹5L starting capital
  quantity: qtyPer10k,
  allowAccumulation: true,
});
const metrics = calculateMetrics(result.trades, result.equityCurve, 500000);

console.log(`Strategy: Buy ₹10k (~${qtyPer10k} units) on every 1% dip`);
console.log(`Sell: Target +5%, Stop -3%, Max hold 60 days\n`);

console.log(`  Total Trades:     ${metrics.totalTrades}`);
console.log(`  Winning Trades:   ${metrics.winningTrades}`);
console.log(`  Losing Trades:    ${metrics.losingTrades}`);
console.log(`  Win Rate:         ${(metrics.winRate * 100).toFixed(1)}%`);
console.log(`  Total Return:     ₹${metrics.totalReturn.toFixed(0)} (${metrics.totalReturnPct.toFixed(2)}%)`);
console.log(`  CAGR:             ${(metrics.cagr * 100).toFixed(2)}%`);
console.log(`  Sharpe Ratio:     ${metrics.sharpeRatio.toFixed(2)}`);
console.log(`  Max Drawdown:     ${metrics.maxDrawdownPct.toFixed(2)}%`);
console.log(`  Avg Win:          ₹${metrics.avgWin.toFixed(0)}`);
console.log(`  Avg Loss:         ₹${Math.abs(metrics.avgLoss).toFixed(0)}`);
console.log(`  Profit Factor:    ${metrics.profitFactor === Infinity ? "∞" : metrics.profitFactor.toFixed(2)}`);
console.log(`  Expectancy:       ₹${metrics.expectancy.toFixed(0)}/trade\n`);

// --- Step 2: Optimize sell strategy for max CAGR ---
console.log("═══════════════════════════════════════════════════════════════");
console.log("STEP 2: Optimize sell strategy for MAXIMUM CAGR");
console.log("═══════════════════════════════════════════════════════════════\n");

const optResult = optimizeWithCandles(
  candles,
  "buy_the_dip",
  {
    buyDropPct: [-0.5, -0.75, -1, -1.5, -2, -3],
    sellTargetPct: [2, 3, 5, 8, 10, 15, 20],
    stopLossPct: [-1, -2, -3, -5, -8],
    maxHoldDays: [10, 20, 30, 60, 90, 120],
  },
  "cagr",
  500000,
  qtyPer10k
);

console.log(`Grid search: ${optResult.totalCombinations} parameter combinations tested\n`);
console.log("🏆 BEST PARAMETERS FOR MAX CAGR:\n");
console.log(`  Buy threshold:  ${optResult.bestParams.buyDropPct}% daily drop`);
console.log(`  Sell target:    +${optResult.bestParams.sellTargetPct}%`);
console.log(`  Stop loss:      ${optResult.bestParams.stopLossPct}%`);
console.log(`  Max hold:       ${optResult.bestParams.maxHoldDays} days`);
console.log(`  Best CAGR:      ${(optResult.bestMetric * 100).toFixed(2)}%\n`);

console.log("TOP 10 PARAMETER COMBINATIONS (by CAGR):\n");
console.log("Rank | Buy Drop | Target | Stop | Hold | CAGR     | Return%  | Sharpe | Trades | Win%");
console.log("-----|----------|--------|------|------|----------|----------|--------|--------|------");

for (let i = 0; i < Math.min(10, optResult.topResults.length); i++) {
  const r = optResult.topResults[i];
  const m = r.metrics;
  console.log(
    `  ${(i + 1).toString().padStart(2)}  | ${String(r.params.buyDropPct).padStart(6)}% | ${String(r.params.sellTargetPct).padStart(4)}%  | ${String(r.params.stopLossPct).padStart(3)}% | ${String(r.params.maxHoldDays).padStart(4)}d | ${(m.cagr * 100).toFixed(2).padStart(7)}% | ${m.totalReturnPct.toFixed(1).padStart(7)}% | ${m.sharpeRatio.toFixed(2).padStart(6)} | ${String(m.totalTrades).padStart(6)} | ${(m.winRate * 100).toFixed(0).padStart(3)}%`
  );
}

// --- Step 3: Also optimize for Sharpe (risk-adjusted) ---
console.log("\n═══════════════════════════════════════════════════════════════");
console.log("STEP 3: Optimize for BEST RISK-ADJUSTED RETURN (Sharpe)");
console.log("═══════════════════════════════════════════════════════════════\n");

const sharpeOpt = optimizeWithCandles(
  candles,
  "buy_the_dip",
  {
    buyDropPct: [-0.5, -0.75, -1, -1.5, -2, -3],
    sellTargetPct: [2, 3, 5, 8, 10, 15, 20],
    stopLossPct: [-1, -2, -3, -5, -8],
    maxHoldDays: [10, 20, 30, 60, 90, 120],
  },
  "sharpeRatio",
  500000,
  qtyPer10k
);

console.log("🏆 BEST PARAMETERS FOR MAX SHARPE RATIO:\n");
console.log(`  Buy threshold:  ${sharpeOpt.bestParams.buyDropPct}% daily drop`);
console.log(`  Sell target:    +${sharpeOpt.bestParams.sellTargetPct}%`);
console.log(`  Stop loss:      ${sharpeOpt.bestParams.stopLossPct}%`);
console.log(`  Max hold:       ${sharpeOpt.bestParams.maxHoldDays} days`);
console.log(`  Best Sharpe:    ${sharpeOpt.bestMetric.toFixed(3)}`);

// Find corresponding CAGR for this Sharpe-optimal set
const sharpeBest = sharpeOpt.topResults[0];
console.log(`  CAGR at Sharpe-optimal: ${(sharpeBest.metrics.cagr * 100).toFixed(2)}%`);
console.log(`  Max Drawdown: ${sharpeBest.metrics.maxDrawdownPct.toFixed(2)}%\n`);

console.log("═══════════════════════════════════════════════════════════════");
console.log("RECOMMENDATION");
console.log("═══════════════════════════════════════════════════════════════\n");
console.log("For MOM100 'buy the dip' strategy with ₹10k per purchase:");
console.log(`  → Max CAGR:   Buy at ${optResult.bestParams.buyDropPct}% dip, sell at +${optResult.bestParams.sellTargetPct}%, stop ${optResult.bestParams.stopLossPct}%, hold max ${optResult.bestParams.maxHoldDays}d`);
console.log(`  → Best Sharpe: Buy at ${sharpeOpt.bestParams.buyDropPct}% dip, sell at +${sharpeOpt.bestParams.sellTargetPct}%, stop ${sharpeOpt.bestParams.stopLossPct}%, hold max ${sharpeOpt.bestParams.maxHoldDays}d`);
console.log(`\nNote: This uses simulated MOM100 price data. For real results,`);
console.log(`configure your Upstox access token and use the MCP tools.`);
