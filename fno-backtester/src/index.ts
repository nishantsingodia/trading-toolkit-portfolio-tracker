// ── Types ────────────────────────────────────────────────────────────
export type {
  Candle,
  OptionType,
  PositionSide,
  Greeks,
  OptionQuote,
  StrikeData,
  OptionsChainSnapshot,
  OptionLeg,
  FnoPosition,
  FnoTrade,
  FnoSignal,
  FnoSignalType,
  LegSignal,
  FnoStrategyName,
  FnoStrategyFn,
  FnoStrategyDefinition,
  ExecutionMode,
  MarketRegime,
  MarketContext,
  FnoBacktestConfig,
  FnoBacktestResult,
  FnoPerformanceMetrics,
  FnoOptimizationResult,
  FnoStrategySuggestion,
  FnoSuggestResult,
  EquityPoint,
  DrawdownPoint,
  GreeksSnapshot,
  CandleInterval,
  Underlying,
  SlippageModel,
} from "./engine/types.js";

export {
  DEFAULT_FNO_CONFIG,
  LOT_SIZES,
  STRIKE_INTERVALS,
  RISK_FREE_RATE,
} from "./engine/types.js";

// ── Pricing Engine ──────────────────────────────────────────────────
export {
  normalCDF,
  normalPDF,
  blackScholesCall,
  blackScholesPut,
  blackScholesPrice,
  calculateGreeks,
  impliedVolatility,
  aggregateGreeks,
} from "./engine/pricing.js";

// ── Expiry Calendar ─────────────────────────────────────────────────
export {
  isTradingDay,
  getWeeklyExpiries,
  getMonthlyExpiries,
  getNextExpiry,
  getDTE,
  isExpiryDay,
  getLotSize,
  getStrikeInterval,
  dteToYears,
} from "./engine/expiry-calendar.js";

// ── Options Chain ───────────────────────────────────────────────────
export {
  getATMStrike,
  enumerateStrikes,
  buildInstrumentKey,
  calculateIVPercentile,
  calculateIVRank,
  calculateMaxPain,
  calculatePCR,
  getOISupportResistance,
  findStrikeByDelta,
  getQuote,
  emptyGreeks,
} from "./engine/options-chain.js";

// ── Indicators ──────────────────────────────────────────────────────
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

// ── Backtester Engine ───────────────────────────────────────────────
export { runFnoBacktest, resetPositionCounter } from "./engine/backtester.js";

// ── Risk Manager ────────────────────────────────────────────────────
export {
  checkPortfolioGreeksLimits,
  checkPositionStopLoss,
  checkDailyLossLimit,
  checkMaxPositions,
  calculateSimplifiedMargin,
  shouldForceClose,
} from "./engine/risk-manager.js";

// ── Strategies ──────────────────────────────────────────────────────
export { FNO_STRATEGY_REGISTRY } from "./engine/strategies.js";

// ── Metrics ─────────────────────────────────────────────────────────
export { calculateFnoMetrics, buildBacktestResult } from "./engine/metrics.js";

// ── Commands ────────────────────────────────────────────────────────
export { executeFnoBacktest } from "./commands/run-backtest.js";
export { compareFnoStrategies } from "./commands/compare-strategies.js";
export { optimizeFnoStrategy } from "./commands/optimize-strategy.js";
export { suggestFnoStrategies } from "./commands/suggest-strategies.js";

// ── API ─────────────────────────────────────────────────────────────
export {
  fetchHistoricalCandles,
  fetchOptionsChain,
} from "./api/historical-candles.js";
