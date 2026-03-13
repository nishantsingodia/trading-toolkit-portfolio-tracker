import type { Trade, EquityPoint, PerformanceMetrics } from "./types.js";

/** India risk-free rate (approximate RBI repo rate) */
const RISK_FREE_RATE = 0.065;

/** Trading days per year (NSE) */
const TRADING_DAYS_PER_YEAR = 252;

/**
 * Calculate all performance metrics from trade log and equity curve.
 */
export function calculateMetrics(
  trades: Trade[],
  equityCurve: EquityPoint[],
  initialCapital: number
): PerformanceMetrics {
  const totalTrades = trades.length;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);

  const winningTrades = wins.length;
  const losingTrades = losses.length;
  const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const totalReturn = totalPnl;
  const totalReturnPct =
    initialCapital !== 0 ? (totalPnl / initialCapital) * 100 : 0;

  // CAGR
  const cagr = calculateCagr(equityCurve, initialCapital);

  // Sharpe ratio (annualized, from daily equity returns)
  const sharpeRatio = calculateSharpe(equityCurve);

  // Max drawdown
  const { maxDrawdown, maxDrawdownPct } = calculateMaxDrawdown(equityCurve);

  // Average win/loss
  const totalWinPnl = wins.reduce((sum, t) => sum + t.pnl, 0);
  const totalLossPnl = losses.reduce((sum, t) => sum + Math.abs(t.pnl), 0);
  const avgWin = winningTrades > 0 ? totalWinPnl / winningTrades : 0;
  const avgLoss = losingTrades > 0 ? totalLossPnl / losingTrades : 0;

  // Profit factor = gross profits / gross losses
  const profitFactor = totalLossPnl !== 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? Infinity : 0;

  // Expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss)
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

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
  };
}

function calculateCagr(
  equityCurve: EquityPoint[],
  initialCapital: number
): number {
  if (equityCurve.length < 2 || initialCapital <= 0) return 0;

  const finalEquity = equityCurve[equityCurve.length - 1].equity;
  const startDate = new Date(equityCurve[0].date).getTime();
  const endDate = new Date(equityCurve[equityCurve.length - 1].date).getTime();
  const years = (endDate - startDate) / (365.25 * 86_400_000);

  if (years <= 0 || finalEquity <= 0) return 0;

  return Math.pow(finalEquity / initialCapital, 1 / years) - 1;
}

function calculateSharpe(equityCurve: EquityPoint[]): number {
  if (equityCurve.length < 2) return 0;

  // Daily returns
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev !== 0) {
      dailyReturns.push((equityCurve[i].equity - prev) / prev);
    }
  }

  if (dailyReturns.length < 2) return 0;

  const mean =
    dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
    (dailyReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  const dailyRiskFree = RISK_FREE_RATE / TRADING_DAYS_PER_YEAR;
  const excessReturn = mean - dailyRiskFree;

  // Annualize
  return (excessReturn / stdDev) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

function calculateMaxDrawdown(equityCurve: EquityPoint[]): {
  maxDrawdown: number;
  maxDrawdownPct: number;
} {
  let peak = 0;
  let maxDd = 0;
  let maxDdPct = 0;

  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = peak - point.equity;
    const ddPct = peak !== 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
  }

  return { maxDrawdown: maxDd, maxDrawdownPct: maxDdPct };
}
