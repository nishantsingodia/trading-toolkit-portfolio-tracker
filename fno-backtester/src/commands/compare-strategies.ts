import type {
  FnoStrategyName,
  Underlying,
  OptionsChainSnapshot,
  Candle,
  FnoPerformanceMetrics,
} from "../engine/types.js";
import { executeFnoBacktest } from "./run-backtest.js";

export interface CompareInput {
  underlying: Underlying;
  fromDate: string;
  toDate: string;
  strategies: Array<{
    name: FnoStrategyName;
    params?: Record<string, number | string>;
  }>;
  initialCapital?: number;
}

export interface CompareResult {
  rankings: Array<{
    rank: number;
    strategy: FnoStrategyName;
    score: number;
    metrics: FnoPerformanceMetrics;
  }>;
}

/**
 * Compare multiple F&O strategies on the same data.
 * Ranks by composite score: 40% return + 20% Sharpe + 20% win rate + 20% inverse drawdown.
 */
export function compareFnoStrategies(
  input: CompareInput,
  prefetchedData: {
    spotCandles: Candle[];
    chainHistory: OptionsChainSnapshot[];
  }
): CompareResult {
  if (input.strategies.length > 5) {
    throw new Error("Maximum 5 strategies for comparison");
  }

  const results: Array<{
    strategy: FnoStrategyName;
    metrics: FnoPerformanceMetrics;
  }> = [];

  for (const stratConfig of input.strategies) {
    const result = executeFnoBacktest(
      {
        underlying: input.underlying,
        fromDate: input.fromDate,
        toDate: input.toDate,
        strategy: stratConfig.name,
        strategyParams: stratConfig.params,
        initialCapital: input.initialCapital,
      },
      prefetchedData
    );

    results.push({
      strategy: stratConfig.name,
      metrics: result.metrics,
    });
  }

  // Score: 40% return + 20% sharpe + 20% win rate + 20% inverse drawdown
  const scored = results.map((r) => {
    const returnScore = r.metrics.totalReturnPct;
    const sharpeScore = Math.min(r.metrics.sharpeRatio * 20, 100); // cap at 100
    const winRateScore = r.metrics.winRate * 100;
    const ddScore = Math.max(0, 100 - r.metrics.maxDrawdownPct);

    const compositeScore =
      returnScore * 0.4 +
      sharpeScore * 0.2 +
      winRateScore * 0.2 +
      ddScore * 0.2;

    return { strategy: r.strategy, score: compositeScore, metrics: r.metrics };
  });

  scored.sort((a, b) => b.score - a.score);

  return {
    rankings: scored.map((s, i) => ({
      rank: i + 1,
      ...s,
    })),
  };
}
