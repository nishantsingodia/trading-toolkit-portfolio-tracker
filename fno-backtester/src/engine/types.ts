// ── OHLCV Candle (shared with delivery backtester) ──────────────────

export interface Candle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number;
}

// ── Option primitives ───────────────────────────────────────────────

export type OptionType = "CE" | "PE";
export type PositionSide = "BUY" | "SELL";

export interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

// ── Options chain data ──────────────────────────────────────────────

export interface OptionQuote {
  price: number;
  oi: number;
  volume: number;
  iv: number;
  greeks: Greeks;
}

export interface StrikeData {
  ce: OptionQuote;
  pe: OptionQuote;
}

export interface OptionsChainSnapshot {
  timestamp: string;
  spotPrice: number;
  strikes: Map<number, StrikeData>;
}

// ── Position & leg tracking ─────────────────────────────────────────

export interface OptionLeg {
  instrumentKey: string;
  underlying: string;
  strike: number;
  optionType: OptionType;
  expiry: string;
  side: PositionSide;
  lots: number;
  lotSize: number;
  entryPrice: number;
  currentPrice: number;
  greeks: Greeks;
}

export type PositionStatus = "OPEN" | "CLOSED" | "EXPIRED";

export interface FnoPosition {
  id: string;
  strategyName: FnoStrategyName;
  legs: OptionLeg[];
  entryDate: string;
  entrySpot: number;
  dte: number;
  netPremium: number; // positive = credit, negative = debit
  marginRequired: number;
  currentPnl: number;
  peakPnl: number;
  troughPnl: number;
  aggregateGreeks: Greeks;
  status: PositionStatus;
}

// ── Completed trade ─────────────────────────────────────────────────

export interface FnoTrade {
  positionId: string;
  strategyName: FnoStrategyName;
  legs: OptionLeg[];
  entryDate: string;
  exitDate: string;
  entrySpot: number;
  exitSpot: number;
  dteAtEntry: number;
  dteAtExit: number;
  ivAtEntry: number;
  ivAtExit: number;
  netPremiumCollected: number;
  exitPnl: number;
  exitPnlPct: number;
  thetaCaptured: number;
  maxDrawdownDuringTrade: number;
  exitReason: string;
}

// ── Signals ─────────────────────────────────────────────────────────

export type FnoSignalType = "OPEN" | "CLOSE" | "ADJUST";

export interface LegSignal {
  strike: number;
  optionType: OptionType;
  side: PositionSide;
  expiry: string;
  lots: number;
}

export interface FnoSignal {
  timestamp: string;
  type: FnoSignalType;
  positionId?: string; // for CLOSE / ADJUST
  legs: LegSignal[];
  reason: string;
}

// ── Strategy definitions ────────────────────────────────────────────

export type FnoStrategyName =
  | "short_straddle"
  | "short_strangle"
  | "iron_condor"
  | "iron_butterfly"
  | "deep_otm_sell"
  | "bull_call_spread"
  | "bear_put_spread"
  | "ema50_directional"
  | "long_straddle"
  | "calendar_spread"
  | "straddle_920"
  | "oi_max_pain";

export type ExecutionMode = "intraday" | "positional";

export type FnoStrategyFn = (
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  params: Record<string, number | string>
) => FnoSignal[];

export interface FnoStrategyDefinition {
  name: FnoStrategyName;
  fn: FnoStrategyFn;
  defaults: Record<string, number | string>;
  description: string;
  executionMode: ExecutionMode;
  refreshInterval: string; // "1m" | "15m" | "30m" | "1h" | "daily"
  regimes: MarketRegime[];
  vixRange: { min: number; max: number };
}

// ── Market context ──────────────────────────────────────────────────

export type MarketRegime =
  | "trending_up"
  | "trending_down"
  | "range_bound"
  | "high_volatility";

export interface MarketContext {
  regime: MarketRegime;
  vixLevel: number;
  ivPercentile: number;
  ivRank: number;
  dte: number;
  timeOfDay: string; // HH:mm
  pcr: number;
  maxPainStrike: number;
}

// ── Backtest configuration ──────────────────────────────────────────

export type SlippageModel = "none" | "fixed" | "oi_based";

/**
 * India F&O transaction cost components.
 * All rates are as of FY 2024-25 (Budget 2024 STT increase included).
 */
export interface TransactionCosts {
  /** Brokerage per order in ₹ (discount broker: ₹20/order) */
  brokeragePerOrder: number;
  /** STT rate on sell-side premium (0.0125% pre-Oct-2024, 0.02% post-Oct-2024) */
  sttSellRate: number;
  /** Exchange transaction charges rate on premium (NSE: ~0.0495%) */
  exchangeTxnRate: number;
  /** SEBI turnover fee rate (~0.0001%) */
  sebiTurnoverRate: number;
  /** Stamp duty rate on buy-side premium (0.003%) */
  stampDutyBuyRate: number;
  /** GST rate on (brokerage + exchange charges) — 18% */
  gstRate: number;
}

export interface FnoBacktestConfig {
  initialCapital: number;
  maxPositions: number;
  maxLossPerTrade: number;
  maxLossPerDay: number;
  portfolioGreeksLimits: {
    maxAbsDelta: number;
    maxGamma: number;
    maxVega: number;
  };
  slippageModel: SlippageModel;
  slippageBps: number;
  /** Transaction costs — set to null to skip (legacy behavior) */
  txnCosts: TransactionCosts | null;
}

/** India F&O costs as of FY 2024-25 (Zerodha-style discount broker) */
export const INDIA_FNO_TXN_COSTS: TransactionCosts = {
  brokeragePerOrder: 20,          // ₹20 flat per order
  sttSellRate: 0.000125,          // 0.0125% on option sell premium (pre-Oct-2024)
  exchangeTxnRate: 0.000495,      // 0.0495% on premium (NSE)
  sebiTurnoverRate: 0.000001,     // 0.0001% on premium
  stampDutyBuyRate: 0.00003,      // 0.003% on buy-side premium
  gstRate: 0.18,                  // 18% GST on brokerage + exchange charges
};

export const DEFAULT_FNO_CONFIG: FnoBacktestConfig = {
  initialCapital: 500_000,
  maxPositions: 3,
  maxLossPerTrade: 15_000,
  maxLossPerDay: 30_000,
  portfolioGreeksLimits: {
    maxAbsDelta: 500,
    maxGamma: 50,
    maxVega: 500,
  },
  slippageModel: "fixed",
  slippageBps: 5,
  txnCosts: null,  // legacy: no costs (backward compatible)
};

// ── Backtest results ────────────────────────────────────────────────

export interface EquityPoint {
  date: string;
  equity: number;
}

export interface DrawdownPoint {
  date: string;
  drawdown: number;
  drawdownPct: number;
}

export interface GreeksSnapshot {
  date: string;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface FnoBacktestResult {
  trades: FnoTrade[];
  metrics: FnoPerformanceMetrics;
  equityCurve: EquityPoint[];
  drawdownSeries: DrawdownPoint[];
  greeksTimeSeries: GreeksSnapshot[];
}

// ── Performance metrics ─────────────────────────────────────────────

export interface FnoPerformanceMetrics {
  // Base metrics (same as delivery backtester)
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalReturn: number;
  totalReturnPct: number;
  cagr: number;
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  expectancy: number;

  // F&O specific
  avgDteAtEntry: number;
  avgDteAtExit: number;
  avgIvAtEntry: number;
  avgIvAtExit: number;
  thetaCaptureEfficiency: number;
  marginUtilizationAvg: number;
  marginUtilizationMax: number;
  avgPremiumDecay: number;
  breakevenProbability: number;

  // Exit reason breakdown
  tradesHitTarget: number;
  tradesHitStopLoss: number;
  tradesExpiredOrTimeExit: number;
  tradesRiskBreach: number;
}

// ── Indicator types (reused from delivery backtester) ───────────────

export interface MacdResult {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  width: number[];
}

export interface SupertrendResult {
  supertrend: number[];
  direction: number[];
}

export interface StochasticResult {
  k: number[];
  d: number[];
}

export interface AdxResult {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
}

// ── Optimization & suggestion results ───────────────────────────────

export interface FnoOptimizationResult {
  bestParams: Record<string, number | string>;
  bestMetric: number;
  optimizeFor: string;
  topResults: Array<{
    params: Record<string, number | string>;
    metrics: FnoPerformanceMetrics;
  }>;
  totalCombinations: number;
}

export interface FnoStrategySuggestion {
  strategy: FnoStrategyName;
  score: number;
  metrics: FnoPerformanceMetrics;
  rank: number;
}

export interface FnoSuggestResult {
  context: MarketContext;
  suggestions: FnoStrategySuggestion[];
  recommendedStrategy: FnoStrategyName;
}

// ── API types ───────────────────────────────────────────────────────

export type CandleInterval =
  | "1minute"
  | "30minute"
  | "day"
  | "week"
  | "month";

export type Underlying = "NIFTY" | "BANKNIFTY";

export const LOT_SIZES: Record<Underlying, number> = {
  NIFTY: 75,
  BANKNIFTY: 30,
};

export const STRIKE_INTERVALS: Record<Underlying, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
};

export const RISK_FREE_RATE = 0.065; // 6.5% RBI repo rate
