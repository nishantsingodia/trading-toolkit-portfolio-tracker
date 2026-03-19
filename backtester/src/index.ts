// Core engine exports
export type {
  Candle,
  Signal,
  Trade,
  BacktestResult,
  PerformanceMetrics,
  StrategyName,
  MarketRegime,
  OptimizationResult,
  SuggestResult,
} from "./engine/types.js";

export {
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  atr,
  supertrend,
  vwap,
  obv,
  adx,
  stochastic,
  crossover,
  crossunder,
  dailyReturn,
} from "./engine/indicators.js";

export { STRATEGY_REGISTRY } from "./engine/strategies.js";
export { runBacktest } from "./engine/backtester.js";
export { calculateMetrics } from "./engine/metrics.js";

// API
export { fetchHistoricalCandles } from "./api/historical-candles.js";
export type { CandleInterval } from "./api/historical-candles.js";

// Commands
export { executeBacktest } from "./commands/run-backtest.js";
export { compareStrategies } from "./commands/compare-strategies.js";
export { optimizeStrategy, optimizeWithCandles } from "./commands/optimize-strategy.js";
export { suggestStrategies, suggestWithCandles } from "./commands/suggest-strategies.js";
export { executeUniverseBacktest } from "./commands/run-universe-backtest.js";
export type { UniverseBacktestInput, UniverseBacktestResult, StockBacktestResult } from "./commands/run-universe-backtest.js";

// Index constituent data
export { getConstituentsAsOf, getAvailableSnapshots, getAvailableIndices } from "./data/index-constituents.js";
export type { IndexName, IndexSnapshot } from "./data/index-constituents.js";
