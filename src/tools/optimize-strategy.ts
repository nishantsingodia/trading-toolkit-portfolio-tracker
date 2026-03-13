import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import { UPSTOX_API_BASE_URL, HEADERS, ERROR_MESSAGES } from "../constants";
import { optimizeWithCandles } from "../../backtester/src/commands/optimize-strategy";
import type { Candle, StrategyName, PerformanceMetrics } from "../../backtester/src/engine/types";

export const optimizeStrategySchema = {
  instrument_key: z.string().min(1, "Instrument key is required"),
  interval: z.enum(["1minute", "30minute", "day", "week", "month"]),
  from_date: z.string().min(1, "From date (YYYY-MM-DD)"),
  to_date: z.string().min(1, "To date (YYYY-MM-DD)"),
  strategy: z.enum([
    "sma_crossover", "ema_crossover", "supertrend", "vwap_crossover",
    "rsi_overbought_oversold", "macd_signal_cross", "bollinger_squeeze",
    "stochastic_crossover", "atr_trailing_stop", "buy_the_dip",
  ]),
  param_ranges: z.string().describe('JSON object mapping param names to arrays of values. Example: {"buyDropPct":[-0.5,-1,-2],"sellTargetPct":[2,3,5]}'),
  optimize_for: z.string().optional().describe("Metric to optimize for (default: cagr). Options: cagr, totalReturnPct, sharpeRatio, winRate, maxDrawdownPct"),
  initial_capital: z.number().optional(),
  quantity: z.number().optional(),
};

interface OptimizeStrategyArgs {
  instrument_key: string;
  interval: string;
  from_date: string;
  to_date: string;
  strategy: string;
  param_ranges: string;
  optimize_for?: string;
  initial_capital?: number;
  quantity?: number;
}

export const optimizeStrategyHandler: ToolHandler<OptimizeStrategyArgs, Env> = async (
  args: OptimizeStrategyArgs,
  env: Env
): Promise<ToolResponse> => {
  try {
    const initialCapital = args.initial_capital ?? 100000;
    const quantity = args.quantity ?? 1;
    const optimizeFor = (args.optimize_for ?? "cagr") as keyof PerformanceMetrics;

    // Fetch candles
    const encodedKey = encodeURIComponent(args.instrument_key);
    const url = `${UPSTOX_API_BASE_URL}/v2/historical-candle/${encodedKey}/${args.interval}/${args.to_date}/${args.from_date}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: HEADERS.ACCEPT,
        Authorization: `Bearer ${env.UPSTOX_ACCESS_TOKEN}`,
      },
    });

    if (!response.ok) throw new Error(ERROR_MESSAGES.API_ERROR);

    const json = (await response.json()) as {
      data: { candles: Array<[string, number, number, number, number, number, number]> };
    };

    const candles: Candle[] = (json.data?.candles ?? [])
      .map(([timestamp, open, high, low, close, volume, oi]) => ({
        timestamp, open, high, low, close, volume, oi,
      }))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (candles.length === 0) {
      return {
        content: [{ type: "text", text: "No candle data returned" }],
        isError: true,
      };
    }

    const paramRanges: Record<string, (number | string)[]> = JSON.parse(args.param_ranges);

    const result = optimizeWithCandles(
      candles,
      args.strategy as StrategyName,
      paramRanges,
      optimizeFor,
      initialCapital,
      quantity
    );

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          strategy: args.strategy,
          optimizeFor,
          bestParams: result.bestParams,
          bestMetric: result.bestMetric,
          totalCombinations: result.totalCombinations,
          topResults: result.topResults.map((r) => ({
            params: r.params,
            [optimizeFor]: r.metrics[optimizeFor],
            totalReturnPct: r.metrics.totalReturnPct,
            cagr: r.metrics.cagr,
            sharpeRatio: r.metrics.sharpeRatio,
            maxDrawdownPct: r.metrics.maxDrawdownPct,
            winRate: r.metrics.winRate,
            totalTrades: r.metrics.totalTrades,
          })),
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error optimizing strategy:", error);
    return {
      content: [{ type: "text", text: `Optimize error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};
