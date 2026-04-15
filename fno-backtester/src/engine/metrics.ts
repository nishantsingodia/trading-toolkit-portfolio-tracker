import type {
  FnoTrade,
  EquityPoint,
  DrawdownPoint,
  GreeksSnapshot,
  FnoPerformanceMetrics,
  FnoBacktestResult,
} from "./types.js";

const RISK_FREE_RATE = 0.065;
const TRADING_DAYS_PER_YEAR = 252;

/**
 * Calculate comprehensive F&O performance metrics from backtest output.
 */
export function calculateFnoMetrics(
  trades: FnoTrade[],
  equityCurve: EquityPoint[],
  drawdownSeries: DrawdownPoint[],
  greeksTimeSeries: GreeksSnapshot[],
  initialCapital: number
): FnoPerformanceMetrics {
  const totalTrades = trades.length;

  if (totalTrades === 0) {
    return emptyMetrics();
  }

  // Base metrics
  const winningTrades = trades.filter((t) => t.exitPnl > 0).length;
  const losingTrades = trades.filter((t) => t.exitPnl <= 0).length;
  const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

  const totalReturn = trades.reduce((sum, t) => sum + t.exitPnl, 0);
  const totalReturnPct = (totalReturn / initialCapital) * 100;

  // CAGR
  const firstDate = equityCurve[0]?.date ?? "";
  const lastDate = equityCurve[equityCurve.length - 1]?.date ?? "";
  const years = dateDiffYears(firstDate, lastDate);
  const finalEquity = equityCurve[equityCurve.length - 1]?.equity ?? initialCapital;
  const cagr = years > 0 ? Math.pow(finalEquity / initialCapital, 1 / years) - 1 : 0;

  // Sharpe Ratio
  const dailyReturns = computeDailyReturns(equityCurve);
  const sharpeRatio = computeSharpe(dailyReturns);

  // Max Drawdown
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  for (const dd of drawdownSeries) {
    if (dd.drawdown > maxDrawdown) maxDrawdown = dd.drawdown;
    if (dd.drawdownPct > maxDrawdownPct) maxDrawdownPct = dd.drawdownPct;
  }

  // Avg Win / Avg Loss
  const wins = trades.filter((t) => t.exitPnl > 0);
  const losses = trades.filter((t) => t.exitPnl <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.exitPnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.exitPnl), 0) / losses.length : 0;

  // Profit Factor
  const grossProfit = wins.reduce((s, t) => s + t.exitPnl, 0);
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.exitPnl), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Expectancy
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

  // F&O Specific Metrics
  const avgDteAtEntry = trades.reduce((s, t) => s + t.dteAtEntry, 0) / totalTrades;
  const avgDteAtExit = trades.reduce((s, t) => s + t.dteAtExit, 0) / totalTrades;
  const avgIvAtEntry = trades.reduce((s, t) => s + t.ivAtEntry, 0) / totalTrades;
  const avgIvAtExit = trades.reduce((s, t) => s + t.ivAtExit, 0) / totalTrades;

  // Theta Capture Efficiency
  const totalThetaCaptured = trades.reduce((s, t) => s + t.thetaCaptured, 0);
  const totalPremiumCollected = trades
    .filter((t) => t.netPremiumCollected > 0)
    .reduce((s, t) => s + t.netPremiumCollected, 0);
  const thetaCaptureEfficiency = totalPremiumCollected > 0 ? totalThetaCaptured / totalPremiumCollected : 0;

  // Margin Utilization (simplified — would need position-level margin tracking for accuracy)
  const marginUtilizationAvg = 0; // placeholder
  const marginUtilizationMax = 0; // placeholder

  // Premium Decay
  const avgPremiumDecay = totalTrades > 0
    ? trades.reduce((s, t) => s + (t.netPremiumCollected > 0 ? t.exitPnlPct : 0), 0) / totalTrades
    : 0;

  // Break-even Probability (trades that were profitable or zero)
  const breakevenProbability = totalTrades > 0
    ? trades.filter((t) => t.exitPnl >= 0).length / totalTrades
    : 0;

  // Exit Reason Breakdown
  const tradesHitTarget = trades.filter((t) => t.exitReason === "target_hit").length;
  const tradesHitStopLoss = trades.filter((t) => t.exitReason === "stop_loss").length;
  const tradesExpiredOrTimeExit = trades.filter((t) =>
    t.exitReason === "expiry_settlement" ||
    t.exitReason === "time_exit" ||
    t.exitReason === "near_expiry" ||
    t.exitReason === "backtest_end"
  ).length;
  const tradesRiskBreach = trades.filter((t) => t.exitReason.includes("risk_breach")).length;

  return {
    totalTrades,
    winningTrades,
    losingTrades,
    winRate,
    totalReturn,
    totalReturnPct,
    cagr,
    sharpeRatio,
    maxDrawdown,
    maxDrawdownPct,
    avgWin,
    avgLoss,
    profitFactor,
    expectancy,
    avgDteAtEntry,
    avgDteAtExit,
    avgIvAtEntry,
    avgIvAtExit,
    thetaCaptureEfficiency,
    marginUtilizationAvg,
    marginUtilizationMax,
    avgPremiumDecay,
    breakevenProbability,
    tradesHitTarget,
    tradesHitStopLoss,
    tradesExpiredOrTimeExit,
    tradesRiskBreach,
  };
}

/**
 * Build full FnoBacktestResult from backtest output + metrics.
 */
export function buildBacktestResult(
  trades: FnoTrade[],
  equityCurve: EquityPoint[],
  drawdownSeries: DrawdownPoint[],
  greeksTimeSeries: GreeksSnapshot[],
  initialCapital: number
): FnoBacktestResult {
  return {
    trades,
    metrics: calculateFnoMetrics(trades, equityCurve, drawdownSeries, greeksTimeSeries, initialCapital),
    equityCurve,
    drawdownSeries,
    greeksTimeSeries,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function emptyMetrics(): FnoPerformanceMetrics {
  return {
    totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
    totalReturn: 0, totalReturnPct: 0, cagr: 0, sharpeRatio: 0,
    maxDrawdown: 0, maxDrawdownPct: 0, avgWin: 0, avgLoss: 0,
    profitFactor: 0, expectancy: 0,
    avgDteAtEntry: 0, avgDteAtExit: 0, avgIvAtEntry: 0, avgIvAtExit: 0,
    thetaCaptureEfficiency: 0, marginUtilizationAvg: 0, marginUtilizationMax: 0,
    avgPremiumDecay: 0, breakevenProbability: 0,
    tradesHitTarget: 0, tradesHitStopLoss: 0, tradesExpiredOrTimeExit: 0, tradesRiskBreach: 0,
  };
}

function dateDiffYears(from: string, to: string): number {
  const a = new Date(from);
  const b = new Date(to);
  const diffMs = b.getTime() - a.getTime();
  return diffMs / (365.25 * 24 * 60 * 60 * 1000);
}

function computeDailyReturns(equityCurve: EquityPoint[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) {
      returns.push((equityCurve[i].equity - prev) / prev);
    }
  }
  return returns;
}

function computeSharpe(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  const dailyRiskFree = RISK_FREE_RATE / TRADING_DAYS_PER_YEAR;
  return ((mean - dailyRiskFree) / stdDev) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}
