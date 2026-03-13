import type {
  BacktestResult,
  StrategyName,
  PerformanceMetrics,
} from "../engine/types.js";
import { fetchHistoricalCandles, type CandleInterval } from "../api/historical-candles.js";
import { executeBacktest } from "./run-backtest.js";

export interface StrategyConfig {
  name: StrategyName;
  params?: Record<string, number | string>;
}

export interface CompareInput {
  instrumentKey: string;
  interval: CandleInterval;
  fromDate: string;
  toDate: string;
  strategies: StrategyConfig[];
  initialCapital?: number;
  quantity?: number;
  accessToken: string;
}

export interface CompareResult {
  rankings: Array<{
    rank: number;
    strategy: StrategyName;
    metrics: PerformanceMetrics;
  }>;
  results: Array<{
    strategy: StrategyName;
    result: BacktestResult;
  }>;
}

export async function compareStrategies(
  input: CompareInput
): Promise<CompareResult> {
  if (input.strategies.length === 0) {
    throw new Error("At least one strategy is required");
  }
  if (input.strategies.length > 5) {
    throw new Error("Maximum 5 strategies for comparison");
  }

  // Fetch candles once
  const candles = await fetchHistoricalCandles({
    instrumentKey: input.instrumentKey,
    interval: input.interval,
    fromDate: input.fromDate,
    toDate: input.toDate,
    accessToken: input.accessToken,
  });

  if (candles.length === 0) {
    throw new Error("No candle data returned");
  }

  // Run each strategy with pre-fetched candles
  const results: Array<{ strategy: StrategyName; result: BacktestResult }> = [];

  for (const strat of input.strategies) {
    const result = await executeBacktest(
      {
        instrumentKey: input.instrumentKey,
        interval: input.interval,
        fromDate: input.fromDate,
        toDate: input.toDate,
        strategy: strat.name,
        strategyParams: strat.params,
        initialCapital: input.initialCapital,
        quantity: input.quantity,
        accessToken: input.accessToken,
      },
      candles
    );
    results.push({ strategy: strat.name, result });
  }

  // Rank by total return (descending)
  const sorted = [...results].sort(
    (a, b) => b.result.metrics.totalReturnPct - a.result.metrics.totalReturnPct
  );

  const rankings = sorted.map((r, i) => ({
    rank: i + 1,
    strategy: r.strategy,
    metrics: r.result.metrics,
  }));

  return { rankings, results };
}
