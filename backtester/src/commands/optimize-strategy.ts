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
      if (combinations.length >= MAX_COMBINATIONS) return;
    }
  }

  recurse(0, {});
  return combinations;
}

/** Run a single strategy+params on candles, return metrics */
function runSingle(
  candles: Candle[],
  strategy: StrategyName,
  params: Record<string, number | string>,
  initialCapital: number,
  quantity: number
): PerformanceMetrics {
  const strategyDef = STRATEGY_REGISTRY[strategy];
  const signals = strategyDef.fn(candles, params);
  const isAccumulation = strategy === "buy_the_dip";
  const { trades, equityCurve } = runBacktest(candles, signals, {
    initialCapital,
    quantity,
    allowAccumulation: isAccumulation,
  });
  return calculateMetrics(trades, equityCurve, initialCapital);
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

// ─── Walk-Forward Validation (SKILL.md §5) ───

export interface WalkForwardWindow {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

export interface WalkForwardResult {
  windows: Array<{
    window: WalkForwardWindow;
    bestParams: Record<string, number | string>;
    inSampleMetrics: PerformanceMetrics;
    outOfSampleMetrics: PerformanceMetrics;
    degradationPct: number; // (OOS - IS) / IS * 100. Negative = worse OOS.
  }>;
  avgInSample: number;
  avgOutOfSample: number;
  avgDegradation: number;
  paramStability: number; // 0-1 score, 1 = same params every window
}

/**
 * Walk-forward optimization: optimize on train window, validate on test window,
 * roll forward and repeat. Returns per-window metrics + degradation analysis.
 *
 * @param candles Full dataset
 * @param strategy Strategy name
 * @param paramRanges Parameter grid to search
 * @param optimizeFor Metric to optimize
 * @param numFolds Number of walk-forward windows (default 4)
 * @param trainRatio Fraction of each fold used for training (default 0.75)
 */
export function walkForwardOptimize(
  candles: Candle[],
  strategy: StrategyName,
  paramRanges: Record<string, (number | string)[]>,
  optimizeFor: keyof PerformanceMetrics = "cagr",
  numFolds: number = 4,
  trainRatio: number = 0.75,
  initialCapital: number = 100_000,
  quantity: number = 1
): WalkForwardResult {
  const strategyDef = STRATEGY_REGISTRY[strategy];
  if (!strategyDef) throw new Error(`Unknown strategy: ${strategy}`);

  const n = candles.length;
  const foldSize = Math.floor(n / numFolds);
  if (foldSize < 30) throw new Error(`Not enough data for ${numFolds} folds (need ≥${numFolds * 30} candles)`);

  const trainSize = Math.floor(foldSize * trainRatio);
  const testSize = foldSize - trainSize;

  const windows: WalkForwardResult["windows"] = [];
  const allBestParams: Record<string, number | string>[] = [];

  for (let fold = 0; fold < numFolds; fold++) {
    const foldStart = fold * foldSize;
    const trainStart = foldStart;
    const trainEnd = foldStart + trainSize;
    const testStart = trainEnd;
    const testEnd = Math.min(foldStart + foldSize, n);

    if (testEnd <= testStart || trainEnd <= trainStart) continue;

    const trainCandles = candles.slice(trainStart, trainEnd);
    const testCandles = candles.slice(testStart, testEnd);

    if (trainCandles.length < 20 || testCandles.length < 5) continue;

    // Optimize on train
    const optResult = optimizeWithCandles(
      trainCandles, strategy, paramRanges, optimizeFor, initialCapital, quantity
    );
    const bestParams = { ...strategyDef.defaults, ...optResult.bestParams };

    // Run best params on train (in-sample)
    const isMetrics = runSingle(trainCandles, strategy, bestParams, initialCapital, quantity);

    // Run best params on test (out-of-sample)
    const oosMetrics = runSingle(testCandles, strategy, bestParams, initialCapital, quantity);

    const isVal = isMetrics[optimizeFor] as number;
    const oosVal = oosMetrics[optimizeFor] as number;
    const degradation = isVal !== 0 ? ((oosVal - isVal) / Math.abs(isVal)) * 100 : 0;

    windows.push({
      window: { trainStart, trainEnd, testStart, testEnd },
      bestParams: optResult.bestParams,
      inSampleMetrics: isMetrics,
      outOfSampleMetrics: oosMetrics,
      degradationPct: Math.round(degradation * 100) / 100,
    });
    allBestParams.push(optResult.bestParams);
  }

  // Compute averages
  const avgIS = windows.length > 0
    ? windows.reduce((s, w) => s + (w.inSampleMetrics[optimizeFor] as number), 0) / windows.length
    : 0;
  const avgOOS = windows.length > 0
    ? windows.reduce((s, w) => s + (w.outOfSampleMetrics[optimizeFor] as number), 0) / windows.length
    : 0;
  const avgDeg = windows.length > 0
    ? windows.reduce((s, w) => s + w.degradationPct, 0) / windows.length
    : 0;

  // Parameter stability: how often do the same params win across folds?
  const paramStability = computeParamStability(allBestParams);

  return {
    windows,
    avgInSample: Math.round(avgIS * 100) / 100,
    avgOutOfSample: Math.round(avgOOS * 100) / 100,
    avgDegradation: Math.round(avgDeg * 100) / 100,
    paramStability: Math.round(paramStability * 100) / 100,
  };
}

function computeParamStability(paramSets: Record<string, number | string>[]): number {
  if (paramSets.length <= 1) return 1;

  const keys = Object.keys(paramSets[0]);
  if (keys.length === 0) return 1;

  let totalStable = 0;
  for (const key of keys) {
    const values = paramSets.map(p => String(p[key]));
    const mode = values.sort((a, b) =>
      values.filter(v => v === a).length - values.filter(v => v === b).length
    ).pop()!;
    const modeCount = values.filter(v => v === mode).length;
    totalStable += modeCount / values.length;
  }

  return totalStable / keys.length;
}

// ─── Parameter Sensitivity Analysis (SKILL.md §4) ───

export interface SensitivityResult {
  paramName: string;
  values: Array<{
    value: number | string;
    metrics: PerformanceMetrics;
  }>;
  plateauScore: number;    // 0-1, higher = more stable across param values
  bestValue: number | string;
  isRobust: boolean;       // true if plateau score > 0.6
}

export interface SensitivityReport {
  strategy: StrategyName;
  params: SensitivityResult[];
  overallRobustness: number; // average plateau score across all params
  verdict: "ROBUST" | "FRAGILE" | "MODERATE";
}

/**
 * Sweep each parameter independently while holding others at defaults.
 * Measures how stable the target metric is across parameter values.
 * A "plateau" (stable region) indicates genuine edge; a spike indicates overfitting.
 */
export function parameterSensitivity(
  candles: Candle[],
  strategy: StrategyName,
  paramRanges: Record<string, (number | string)[]>,
  optimizeFor: keyof PerformanceMetrics = "totalReturnPct",
  initialCapital: number = 100_000,
  quantity: number = 1
): SensitivityReport {
  const strategyDef = STRATEGY_REGISTRY[strategy];
  if (!strategyDef) throw new Error(`Unknown strategy: ${strategy}`);

  const results: SensitivityResult[] = [];

  for (const [paramName, values] of Object.entries(paramRanges)) {
    const sweepResults: SensitivityResult["values"] = [];

    for (const val of values) {
      const params = { ...strategyDef.defaults, [paramName]: val };
      const metrics = runSingle(candles, strategy, params, initialCapital, quantity);
      sweepResults.push({ value: val, metrics });
    }

    // Calculate plateau score: how stable is the metric across values?
    const metricValues = sweepResults.map(r => r.metrics[optimizeFor] as number);
    const plateauScore = computePlateauScore(metricValues);

    // Find best value
    const isLowerBetter = optimizeFor === "maxDrawdown" || optimizeFor === "maxDrawdownPct";
    const sorted = [...sweepResults].sort((a, b) => {
      const aVal = a.metrics[optimizeFor] as number;
      const bVal = b.metrics[optimizeFor] as number;
      return isLowerBetter ? aVal - bVal : bVal - aVal;
    });

    results.push({
      paramName,
      values: sweepResults,
      plateauScore: Math.round(plateauScore * 100) / 100,
      bestValue: sorted[0].value,
      isRobust: plateauScore > 0.6,
    });
  }

  const overallRobustness = results.length > 0
    ? results.reduce((s, r) => s + r.plateauScore, 0) / results.length
    : 0;

  let verdict: SensitivityReport["verdict"];
  if (overallRobustness >= 0.7) verdict = "ROBUST";
  else if (overallRobustness >= 0.4) verdict = "MODERATE";
  else verdict = "FRAGILE";

  return {
    strategy,
    params: results,
    overallRobustness: Math.round(overallRobustness * 100) / 100,
    verdict,
  };
}

/**
 * Compute plateau score: 1 = all values produce same result (perfect plateau),
 * 0 = wildly different results (spike/overfitting).
 *
 * Uses coefficient of variation: CV = stddev / |mean|.
 * Plateau score = max(0, 1 - CV).
 * Low CV = stable = high plateau score.
 */
function computePlateauScore(values: number[]): number {
  if (values.length <= 1) return 1;

  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean === 0) {
    // If mean is 0, check if all values are 0
    return values.every(v => v === 0) ? 1 : 0;
  }

  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  const cv = stddev / Math.abs(mean);

  return Math.max(0, Math.min(1, 1 - cv));
}

// Exported for testing
export { generateCombinations, runSingle, computePlateauScore };
