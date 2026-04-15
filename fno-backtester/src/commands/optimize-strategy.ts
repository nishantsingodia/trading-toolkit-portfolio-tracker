import type {
  FnoStrategyName,
  Underlying,
  OptionsChainSnapshot,
  Candle,
  FnoPerformanceMetrics,
  FnoOptimizationResult,
} from "../engine/types.js";
import { executeFnoBacktest } from "./run-backtest.js";

export interface OptimizeInput {
  underlying: Underlying;
  fromDate: string;
  toDate: string;
  strategy: FnoStrategyName;
  paramRanges: Record<string, (number | string)[]>;
  optimizeFor?: keyof FnoPerformanceMetrics;
  initialCapital?: number;
}

/**
 * Optimize strategy parameters via Cartesian product search.
 * Max 500 combinations (same limit as delivery backtester).
 */
export function optimizeFnoStrategy(
  input: OptimizeInput,
  prefetchedData: {
    spotCandles: Candle[];
    chainHistory: OptionsChainSnapshot[];
  }
): FnoOptimizationResult {
  const optimizeFor = input.optimizeFor ?? "totalReturnPct";

  // Generate Cartesian product of param ranges
  const paramNames = Object.keys(input.paramRanges);
  const paramValues = paramNames.map((k) => input.paramRanges[k]);

  // Check count before generating to avoid OOM
  const totalCount = paramValues.reduce((prod, arr) => prod * arr.length, 1);
  if (totalCount > 500) {
    throw new Error(
      `Too many combinations: ${totalCount} (max 500). Reduce param ranges.`
    );
  }

  const combinations = cartesianProduct(paramValues);

  const results: Array<{
    params: Record<string, number | string>;
    metrics: FnoPerformanceMetrics;
    metricValue: number;
  }> = [];

  for (const combo of combinations) {
    const params: Record<string, number | string> = {};
    for (let i = 0; i < paramNames.length; i++) {
      params[paramNames[i]] = combo[i];
    }

    const result = executeFnoBacktest(
      {
        underlying: input.underlying,
        fromDate: input.fromDate,
        toDate: input.toDate,
        strategy: input.strategy,
        strategyParams: params,
        initialCapital: input.initialCapital,
      },
      prefetchedData
    );

    const metricValue = Number(result.metrics[optimizeFor]) || 0;
    results.push({ params, metrics: result.metrics, metricValue });
  }

  // Sort by target metric (descending)
  results.sort((a, b) => b.metricValue - a.metricValue);

  const topResults = results.slice(0, 10).map((r) => ({
    params: r.params,
    metrics: r.metrics,
  }));

  return {
    bestParams: results[0]?.params ?? {},
    bestMetric: results[0]?.metricValue ?? 0,
    optimizeFor: String(optimizeFor),
    topResults,
    totalCombinations: combinations.length,
  };
}

function cartesianProduct(arrays: (number | string)[][]): (number | string)[][] {
  if (arrays.length === 0) return [[]];
  const [first, ...rest] = arrays;
  const restProduct = cartesianProduct(rest);
  return first.flatMap((val) => restProduct.map((combo) => [val, ...combo]));
}
