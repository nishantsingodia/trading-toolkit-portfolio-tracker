import type {
  FnoBacktestResult,
  FnoStrategyName,
  Underlying,
  CandleInterval,
  OptionsChainSnapshot,
  Candle,
  FnoBacktestConfig,
} from "../engine/types.js";
import { DEFAULT_FNO_CONFIG } from "../engine/types.js";
import { FNO_STRATEGY_REGISTRY } from "../engine/strategies.js";
import { runFnoBacktest } from "../engine/backtester.js";
import { buildBacktestResult } from "../engine/metrics.js";

export interface RunFnoBacktestInput {
  underlying: Underlying;
  fromDate: string;
  toDate: string;
  strategy: FnoStrategyName;
  strategyParams?: Record<string, number | string>;
  initialCapital?: number;
  maxPositions?: number;
  accessToken?: string;
}

export interface ExecuteFnoBacktestResult extends FnoBacktestResult {
  strategyName: FnoStrategyName;
  underlying: Underlying;
  fromDate: string;
  toDate: string;
}

/**
 * Execute a single F&O backtest.
 * Accepts pre-fetched data or can fetch from API (when accessToken provided).
 */
export function executeFnoBacktest(
  input: RunFnoBacktestInput,
  prefetchedData: {
    spotCandles: Candle[];
    chainHistory: OptionsChainSnapshot[];
  }
): ExecuteFnoBacktestResult {
  const strategyDef = FNO_STRATEGY_REGISTRY[input.strategy];
  if (!strategyDef) {
    throw new Error(`Unknown strategy: ${input.strategy}`);
  }

  const params = { ...strategyDef.defaults, ...(input.strategyParams ?? {}) };

  const config: FnoBacktestConfig = {
    ...DEFAULT_FNO_CONFIG,
    initialCapital: input.initialCapital ?? DEFAULT_FNO_CONFIG.initialCapital,
    maxPositions: input.maxPositions ?? DEFAULT_FNO_CONFIG.maxPositions,
  };

  // Generate signals using strategy function
  const signals = strategyDef.fn(
    prefetchedData.chainHistory,
    prefetchedData.spotCandles,
    params
  );

  // Run backtest
  const output = runFnoBacktest(
    prefetchedData.chainHistory,
    prefetchedData.spotCandles,
    signals,
    config,
    input.strategy,
    input.underlying
  );

  // Build result with metrics
  const result = buildBacktestResult(
    output.trades,
    output.equityCurve,
    output.drawdownSeries,
    output.greeksTimeSeries,
    config.initialCapital
  );

  return {
    ...result,
    strategyName: input.strategy,
    underlying: input.underlying,
    fromDate: input.fromDate,
    toDate: input.toDate,
  };
}
