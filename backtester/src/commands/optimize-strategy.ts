import type {
  StrategyName,
  PerformanceMetrics,
  OptimizationResult,
  Candle,
} from "../engine/types.js";
import { fetchHistoricalCandles, type CandleInterval } from "../api/historical-candles.js";
import { STRATEGY_REGISTRY } from "../engine/strategies.js";
import { runBacktest } from "../engine/backtester.js";
import { calculateMetrics } from "../engine/metrics.js";

export interface OptimizeInput {
  instrumentKey: string;
  interval: CandleInterval;
  fromDate: string;
  toDate: string;
  strategy: StrategyName;
  paramRanges: Record<string, (number | string)[]>;
  optimizeFor?: keyof PerformanceMetrics;
  initialCapital?: number;
  quantity?: number;
  accessToken: string;
}

const MAX_COMBINATIONS = 500;

/**
 * Generate all combinations from parameter ranges (cartesian product).
 */
function generateCombinations(
  paramRanges: Record<string, (number | string)[]>
): Record<string, number | string>[] {
  const keys = Object.keys(paramRanges);
  if (keys.length === 0) return [{}];

  const combinations: Record<string, number | string>[] = [];

  function recurse(
    index: number,
    current: Record<string, number | string>
  ): void {
    if (index === keys.length) {
      combinations.push({ ...current });
      return;
    }
    const key = keys[index];
    for (const value of paramRanges[key]) {
      current[key] = value;
      recurse(index + 1, current);
      // Early exit if we've hit the cap
      if (combinations.length >= MAX_COMBINATIONS) return;
    }
  }

  recurse(0, {});
  return combinations;
}

export async function optimizeStrategy(
  input: OptimizeInput
): Promise<OptimizationResult> {
  const initialCapital = input.initialCapital ?? 100_000;
  const quantity = input.quantity ?? 1;
  const optimizeFor = input.optimizeFor ?? "cagr";

  const strategyDef = STRATEGY_REGISTRY[input.strategy];
  if (!strategyDef) {
    throw new Error(`Unknown strategy: ${input.strategy}`);
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

  return optimizeWithCandles(
    candles,
    input.strategy,
    input.paramRanges,
    optimizeFor,
    initialCapital,
    quantity
  );
}

/**
 * Run optimization with pre-fetched candles. Exported for testing.
 */
export function optimizeWithCandles(
  candles: Candle[],
  strategy: StrategyName,
  paramRanges: Record<string, (number | string)[]>,
  optimizeFor: keyof PerformanceMetrics,
  initialCapital: number,
  quantity: number
): OptimizationResult {
  const strategyDef = STRATEGY_REGISTRY[strategy];
  if (!strategyDef) {
    throw new Error(`Unknown strategy: ${strategy}`);
  }

  const combinations = generateCombinations(paramRanges);
  const isAccumulation = strategy === "buy_the_dip";

  const allResults: Array<{
    params: Record<string, number | string>;
    metrics: PerformanceMetrics;
  }> = [];

  for (const combo of combinations) {
    const params = { ...strategyDef.defaults, ...combo };
    const signals = strategyDef.fn(candles, params);
    const { trades, equityCurve } = runBacktest(candles, signals, {
      initialCapital,
      quantity,
      allowAccumulation: isAccumulation,
    });
    const metrics = calculateMetrics(trades, equityCurve, initialCapital);
    allResults.push({ params: combo, metrics });
  }

  // Sort by target metric (descending for most metrics)
  const isLowerBetter =
    optimizeFor === "maxDrawdown" || optimizeFor === "maxDrawdownPct";
  allResults.sort((a, b) => {
    const aVal = a.metrics[optimizeFor] as number;
    const bVal = b.metrics[optimizeFor] as number;
    return isLowerBetter ? aVal - bVal : bVal - aVal;
  });

  const best = allResults[0];

  return {
    bestParams: best.params,
    bestMetric: best.metrics[optimizeFor] as number,
    optimizeFor,
    topResults: allResults.slice(0, 10),
    totalCombinations: combinations.length,
  };
}
