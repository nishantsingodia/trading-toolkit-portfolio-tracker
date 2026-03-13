import type {
  BacktestResult,
  StrategyName,
  Candle,
} from "../engine/types.js";
import { STRATEGY_REGISTRY } from "../engine/strategies.js";
import { runBacktest } from "../engine/backtester.js";
import { calculateMetrics } from "../engine/metrics.js";
import {
  fetchHistoricalCandles,
  type CandleInterval,
} from "../api/historical-candles.js";

export interface RunBacktestInput {
  instrumentKey: string;
  interval: CandleInterval;
  fromDate: string;
  toDate: string;
  strategy: StrategyName;
  strategyParams?: Record<string, number | string>;
  initialCapital?: number;
  quantity?: number;
  accessToken: string;
}

/**
 * Run a single strategy backtest.
 * Optionally accepts pre-fetched candles to avoid redundant API calls
 * (used by compare/optimize commands).
 */
export async function executeBacktest(
  input: RunBacktestInput,
  prefetchedCandles?: Candle[]
): Promise<BacktestResult> {
  const initialCapital = input.initialCapital ?? 100_000;
  const quantity = input.quantity ?? 1;

  const strategyDef = STRATEGY_REGISTRY[input.strategy];
  if (!strategyDef) {
    throw new Error(`Unknown strategy: ${input.strategy}`);
  }

  // Use provided candles or fetch from API
  const candles =
    prefetchedCandles ??
    (await fetchHistoricalCandles({
      instrumentKey: input.instrumentKey,
      interval: input.interval,
      fromDate: input.fromDate,
      toDate: input.toDate,
      accessToken: input.accessToken,
    }));

  if (candles.length === 0) {
    throw new Error("No candle data returned for the specified parameters");
  }

  // Merge defaults with user params
  const params = { ...strategyDef.defaults, ...(input.strategyParams ?? {}) };

  // Generate signals
  const signals = strategyDef.fn(candles, params);

  // Run backtest
  const isAccumulation = input.strategy === "buy_the_dip";
  const { trades, equityCurve, drawdownSeries } = runBacktest(
    candles,
    signals,
    {
      initialCapital,
      quantity,
      allowAccumulation: isAccumulation,
    }
  );

  // Calculate metrics
  const metrics = calculateMetrics(trades, equityCurve, initialCapital);

  return {
    trades,
    metrics,
    equityCurve,
    drawdownSeries,
  };
}
