import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import { UPSTOX_API_BASE_URL, HEADERS, ERROR_MESSAGES } from "../constants";
import { STRATEGY_REGISTRY } from "../../backtester/src/engine/strategies";
import { runBacktest } from "../../backtester/src/engine/backtester";
import { calculateMetrics } from "../../backtester/src/engine/metrics";
import type { Candle, StrategyName } from "../../backtester/src/engine/types";

export const compareStrategiesSchema = {
  instrument_key: z.string().min(1, "Instrument key is required"),
  interval: z.enum(["1minute", "30minute", "day", "week", "month"]),
  from_date: z.string().min(1, "From date (YYYY-MM-DD)"),
  to_date: z.string().min(1, "To date (YYYY-MM-DD)"),
  strategies: z.string().describe('JSON array of [{name, params?}] (max 5). Example: [{"name":"sma_crossover"},{"name":"ema_crossover","params":{"fastPeriod":10}}]'),
  initial_capital: z.number().optional(),
  quantity: z.number().optional(),
};

interface CompareStrategiesArgs {
  instrument_key: string;
  interval: string;
  from_date: string;
  to_date: string;
  strategies: string;
  initial_capital?: number;
  quantity?: number;
}

export const compareStrategiesHandler: ToolHandler<CompareStrategiesArgs, Env> = async (
  args: CompareStrategiesArgs,
  env: Env
): Promise<ToolResponse> => {
  try {
    const initialCapital = args.initial_capital ?? 100000;
    const quantity = args.quantity ?? 1;

    const strategyConfigs: Array<{ name: StrategyName; params?: Record<string, number | string> }> =
      JSON.parse(args.strategies);

    if (strategyConfigs.length === 0 || strategyConfigs.length > 5) {
      return {
        content: [{ type: "text", text: "Provide 1-5 strategies for comparison" }],
        isError: true,
      };
    }

    // Fetch candles once
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

    // Run each strategy
    const results = strategyConfigs.map((config) => {
      const strategyDef = STRATEGY_REGISTRY[config.name];
      if (!strategyDef) throw new Error(`Unknown strategy: ${config.name}`);

      const params = { ...strategyDef.defaults, ...(config.params ?? {}) };
      const signals = strategyDef.fn(candles, params);
      const isAccumulation = config.name === "buy_the_dip";
      const { trades, equityCurve } = runBacktest(candles, signals, {
        initialCapital, quantity, allowAccumulation: isAccumulation,
      });
      const metrics = calculateMetrics(trades, equityCurve, initialCapital);
      return { strategy: config.name, params, metrics };
    });

    // Rank by total return
    results.sort((a, b) => b.metrics.totalReturnPct - a.metrics.totalReturnPct);

    const rankings = results.map((r, i) => ({
      rank: i + 1,
      strategy: r.strategy,
      totalReturnPct: r.metrics.totalReturnPct,
      cagr: r.metrics.cagr,
      sharpeRatio: r.metrics.sharpeRatio,
      maxDrawdownPct: r.metrics.maxDrawdownPct,
      winRate: r.metrics.winRate,
      totalTrades: r.metrics.totalTrades,
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ rankings, candles_count: candles.length }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error comparing strategies:", error);
    return {
      content: [{ type: "text", text: `Compare error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};
