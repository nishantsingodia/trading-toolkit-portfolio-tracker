/**
 * Universe-aware backtest: runs a strategy across all stocks in a
 * point-in-time index snapshot, eliminating survivorship bias.
 *
 * Instead of testing on "current Nifty 100 stocks" (which includes future
 * winners and excludes past losers), this uses the actual index constituents
 * as of the backtest start date.
 */
import type {
  StrategyName,
  PerformanceMetrics,
  Candle,
} from "../engine/types.js";
import { STRATEGY_REGISTRY } from "../engine/strategies.js";
import { runBacktest } from "../engine/backtester.js";
import { calculateMetrics } from "../engine/metrics.js";
import { fetchHistoricalCandles, type CandleInterval } from "../api/historical-candles.js";
import {
  getConstituentsAsOf,
  getAvailableSnapshots,
  type IndexName,
} from "../data/index-constituents.js";

export interface UniverseBacktestInput {
  index: IndexName;
  interval: CandleInterval;
  fromDate: string;
  toDate: string;
  strategy: StrategyName;
  strategyParams?: Record<string, number | string>;
  initialCapital?: number;
  quantity?: number;
  accessToken: string;
  /** Max concurrent API requests (default: 5, to respect rate limits) */
  concurrency?: number;
}

export interface StockBacktestResult {
  instrumentKey: string;
  metrics: PerformanceMetrics;
  candleCount: number;
  error?: string;
}

export interface UniverseBacktestResult {
  /** Index used */
  index: IndexName;
  /** Snapshot date used (the most recent one on or before fromDate) */
  snapshotDate: string;
  /** Strategy tested */
  strategy: StrategyName;
  /** Strategy params used */
  params: Record<string, number | string>;
  /** Date range */
  fromDate: string;
  toDate: string;
  /** Total stocks in the universe */
  totalStocks: number;
  /** Stocks successfully backtested */
  successCount: number;
  /** Stocks that failed (no data, API error, etc.) */
  failedCount: number;
  /** Aggregate metrics across all stocks (equal-weighted) */
  aggregateMetrics: {
    avgCAGR: number;
    medianCAGR: number;
    avgSharpe: number;
    avgWinRate: number;
    avgMaxDrawdownPct: number;
    avgTotalReturnPct: number;
    /** % of stocks where the strategy was profitable */
    profitableStocksPct: number;
  };
  /** Per-stock results sorted by CAGR descending */
  stockResults: StockBacktestResult[];
  /** Top 10 performers */
  topPerformers: StockBacktestResult[];
  /** Bottom 10 performers */
  bottomPerformers: StockBacktestResult[];
  /** Stocks that failed to fetch data */
  failedStocks: Array<{ instrumentKey: string; error: string }>;
}

/**
 * Run a strategy across all stocks in a historical index snapshot.
 */
export async function executeUniverseBacktest(
  input: UniverseBacktestInput
): Promise<UniverseBacktestResult> {
  const initialCapital = input.initialCapital ?? 100_000;
  const quantity = input.quantity ?? 1;
  const concurrency = input.concurrency ?? 5;

  // Validate strategy
  const strategyDef = STRATEGY_REGISTRY[input.strategy];
  if (!strategyDef) {
    throw new Error(`Unknown strategy: ${input.strategy}`);
  }

  // Get point-in-time constituents
  const snapshot = getConstituentsAsOf(input.index, input.fromDate);
  if (!snapshot) {
    const available = getAvailableSnapshots(input.index);
    throw new Error(
      `No index snapshot found for ${input.index} on or before ${input.fromDate}. ` +
      `Available snapshots: ${available.join(", ") || "none"}`
    );
  }

  const params = { ...strategyDef.defaults, ...(input.strategyParams ?? {}) };
  const constituents = snapshot.constituents;

  // Run backtests with controlled concurrency
  const results: StockBacktestResult[] = [];
  const failedStocks: Array<{ instrumentKey: string; error: string }> = [];

  // Process in batches to respect API rate limits
  for (let i = 0; i < constituents.length; i += concurrency) {
    const batch = constituents.slice(i, i + concurrency);
    const batchPromises = batch.map(async (instrumentKey) => {
      try {
        const candles = await fetchHistoricalCandles({
          instrumentKey,
          interval: input.interval,
          fromDate: input.fromDate,
          toDate: input.toDate,
          accessToken: input.accessToken,
        });

        if (candles.length === 0) {
          failedStocks.push({ instrumentKey, error: "No candle data returned" });
          return;
        }

        const signals = strategyDef.fn(candles, params);
        const isAccumulation = input.strategy === "buy_the_dip";
        const { trades, equityCurve } = runBacktest(candles, signals, {
          initialCapital,
          quantity,
          allowAccumulation: isAccumulation,
        });

        const metrics = calculateMetrics(trades, equityCurve, initialCapital);
        results.push({ instrumentKey, metrics, candleCount: candles.length });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        failedStocks.push({ instrumentKey, error: errorMsg });
      }
    });

    await Promise.all(batchPromises);
  }

  // Sort by CAGR descending
  results.sort((a, b) => b.metrics.cagr - a.metrics.cagr);

  // Compute aggregate metrics
  const aggregateMetrics = computeAggregateMetrics(results);

  return {
    index: input.index,
    snapshotDate: snapshot.effectiveDate,
    strategy: input.strategy,
    params,
    fromDate: input.fromDate,
    toDate: input.toDate,
    totalStocks: constituents.length,
    successCount: results.length,
    failedCount: failedStocks.length,
    aggregateMetrics,
    stockResults: results,
    topPerformers: results.slice(0, 10),
    bottomPerformers: results.slice(-10).reverse(),
    failedStocks,
  };
}

function computeAggregateMetrics(
  results: StockBacktestResult[]
): UniverseBacktestResult["aggregateMetrics"] {
  if (results.length === 0) {
    return {
      avgCAGR: 0,
      medianCAGR: 0,
      avgSharpe: 0,
      avgWinRate: 0,
      avgMaxDrawdownPct: 0,
      avgTotalReturnPct: 0,
      profitableStocksPct: 0,
    };
  }

  const n = results.length;
  const cagrs = results.map((r) => r.metrics.cagr);
  const sharpes = results.map((r) => r.metrics.sharpeRatio);
  const winRates = results.map((r) => r.metrics.winRate);
  const drawdowns = results.map((r) => r.metrics.maxDrawdownPct);
  const returns = results.map((r) => r.metrics.totalReturnPct);
  const profitable = results.filter((r) => r.metrics.totalReturn > 0).length;

  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const median = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  return {
    avgCAGR: sum(cagrs) / n,
    medianCAGR: median(cagrs),
    avgSharpe: sum(sharpes) / n,
    avgWinRate: sum(winRates) / n,
    avgMaxDrawdownPct: sum(drawdowns) / n,
    avgTotalReturnPct: sum(returns) / n,
    profitableStocksPct: (profitable / n) * 100,
  };
}
