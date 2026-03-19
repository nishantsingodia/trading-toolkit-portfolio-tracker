import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import {
  executeUniverseBacktest,
  type UniverseBacktestResult,
} from "../../backtester/src/commands/run-universe-backtest";
import type { StrategyName } from "../../backtester/src/engine/types";
import type { IndexName } from "../../backtester/src/data/index-constituents";
import type { CandleInterval } from "../../backtester/src/api/historical-candles";

export const runUniverseBacktestSchema = {
  index: z.enum(["nifty_50", "nifty_next_50", "nifty_100", "nifty_midcap_150"])
    .describe("Index whose historical constituents to use. Uses point-in-time snapshot to avoid survivorship bias."),
  interval: z.enum(["1minute", "30minute", "day", "week", "month"])
    .describe("Candle interval"),
  from_date: z.string().min(1, "From date (YYYY-MM-DD) — the constituent snapshot closest to this date is used"),
  to_date: z.string().min(1, "To date (YYYY-MM-DD)"),
  strategy: z.enum([
    "sma_crossover", "ema_crossover", "supertrend", "vwap_crossover",
    "rsi_overbought_oversold", "macd_signal_cross", "bollinger_squeeze",
    "stochastic_crossover", "atr_trailing_stop", "buy_the_dip",
  ]).describe("Strategy to backtest across the universe"),
  strategy_params: z.string().optional()
    .describe("JSON string of strategy params (optional, uses defaults if omitted)"),
  initial_capital: z.number().optional()
    .describe("Starting capital per stock (default: 100000)"),
  quantity: z.number().optional()
    .describe("Trade quantity per signal per stock (default: 1)"),
  concurrency: z.number().optional()
    .describe("Max concurrent API requests (default: 5, to respect Upstox rate limits)"),
};

interface RunUniverseBacktestArgs {
  index: string;
  interval: string;
  from_date: string;
  to_date: string;
  strategy: string;
  strategy_params?: string;
  initial_capital?: number;
  quantity?: number;
  concurrency?: number;
}

export const runUniverseBacktestHandler: ToolHandler<RunUniverseBacktestArgs, Env> = async (
  args: RunUniverseBacktestArgs,
  env: Env
): Promise<ToolResponse> => {
  try {
    const result = await executeUniverseBacktest({
      index: args.index as IndexName,
      interval: args.interval as CandleInterval,
      fromDate: args.from_date,
      toDate: args.to_date,
      strategy: args.strategy as StrategyName,
      strategyParams: args.strategy_params ? JSON.parse(args.strategy_params) : undefined,
      initialCapital: args.initial_capital,
      quantity: args.quantity,
      accessToken: env.UPSTOX_ACCESS_TOKEN,
      concurrency: args.concurrency,
    });

    // Build a concise summary for the response
    const summary = formatUniverseSummary(result);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          summary,
          index: result.index,
          snapshotDate: result.snapshotDate,
          strategy: result.strategy,
          params: result.params,
          dateRange: { from: result.fromDate, to: result.toDate },
          universe: {
            totalStocks: result.totalStocks,
            successfullyTested: result.successCount,
            failed: result.failedCount,
          },
          aggregateMetrics: result.aggregateMetrics,
          topPerformers: result.topPerformers.map(formatStockResult),
          bottomPerformers: result.bottomPerformers.map(formatStockResult),
          failedStocks: result.failedStocks.slice(0, 10),
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error running universe backtest:", error);
    return {
      content: [{
        type: "text",
        text: `Universe backtest error: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
};

function formatStockResult(r: { instrumentKey: string; metrics: any; candleCount: number }) {
  return {
    stock: r.instrumentKey.replace("NSE_EQ|", ""),
    cagr: `${(r.metrics.cagr * 100).toFixed(2)}%`,
    totalReturn: `${r.metrics.totalReturnPct.toFixed(2)}%`,
    sharpe: r.metrics.sharpeRatio.toFixed(2),
    winRate: `${(r.metrics.winRate * 100).toFixed(1)}%`,
    maxDrawdown: `${r.metrics.maxDrawdownPct.toFixed(2)}%`,
    trades: r.metrics.totalTrades,
    candles: r.candleCount,
  };
}

function formatUniverseSummary(result: UniverseBacktestResult): string {
  const m = result.aggregateMetrics;
  return [
    `Survivorship-bias-free backtest of "${result.strategy}" across ${result.index}`,
    `Using constituents as of ${result.snapshotDate} (point-in-time, NOT today's list)`,
    `Period: ${result.fromDate} to ${result.toDate}`,
    `Tested: ${result.successCount}/${result.totalStocks} stocks (${result.failedCount} failed)`,
    ``,
    `AGGREGATE RESULTS (equal-weighted):`,
    `  Avg CAGR:       ${(m.avgCAGR * 100).toFixed(2)}%`,
    `  Median CAGR:    ${(m.medianCAGR * 100).toFixed(2)}%`,
    `  Avg Sharpe:     ${m.avgSharpe.toFixed(2)}`,
    `  Avg Win Rate:   ${(m.avgWinRate * 100).toFixed(1)}%`,
    `  Avg Max DD:     ${m.avgMaxDrawdownPct.toFixed(2)}%`,
    `  Avg Return:     ${m.avgTotalReturnPct.toFixed(2)}%`,
    `  Profitable:     ${m.profitableStocksPct.toFixed(1)}% of stocks`,
  ].join("\n");
}
