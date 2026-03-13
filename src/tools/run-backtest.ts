import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import { UPSTOX_API_BASE_URL, HEADERS, ERROR_MESSAGES } from "../constants";

export const runBacktestSchema = {
  instrument_key: z.string().min(1, "Instrument key is required"),
  interval: z.enum(["1minute", "30minute", "day", "week", "month"]).describe("Candle interval"),
  from_date: z.string().min(1, "From date (YYYY-MM-DD)"),
  to_date: z.string().min(1, "To date (YYYY-MM-DD)"),
  strategy: z.enum([
    "sma_crossover", "ema_crossover", "supertrend", "vwap_crossover",
    "rsi_overbought_oversold", "macd_signal_cross", "bollinger_squeeze",
    "stochastic_crossover", "atr_trailing_stop", "buy_the_dip",
  ]).describe("Strategy to backtest"),
  strategy_params: z.string().optional().describe("JSON string of strategy params (optional, uses defaults if omitted)"),
  initial_capital: z.number().optional().describe("Starting capital (default: 100000)"),
  quantity: z.number().optional().describe("Trade quantity per signal (default: 1)"),
};

interface RunBacktestArgs {
  instrument_key: string;
  interval: string;
  from_date: string;
  to_date: string;
  strategy: string;
  strategy_params?: string;
  initial_capital?: number;
  quantity?: number;
}

// Inline the backtest logic to avoid cross-project imports in Cloudflare Workers
import {
  STRATEGY_REGISTRY,
} from "../../backtester/src/engine/strategies";
import { runBacktest } from "../../backtester/src/engine/backtester";
import { calculateMetrics } from "../../backtester/src/engine/metrics";
import type { Candle, StrategyName } from "../../backtester/src/engine/types";

export const runBacktestHandler: ToolHandler<RunBacktestArgs, Env> = async (
  args: RunBacktestArgs,
  env: Env
): Promise<ToolResponse> => {
  try {
    const initialCapital = args.initial_capital ?? 100000;
    const quantity = args.quantity ?? 1;
    const strategy = args.strategy as StrategyName;

    const strategyDef = STRATEGY_REGISTRY[strategy];
    if (!strategyDef) {
      return {
        content: [{ type: "text", text: `Unknown strategy: ${args.strategy}` }],
        isError: true,
      };
    }

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

    if (!response.ok) {
      throw new Error(ERROR_MESSAGES.API_ERROR);
    }

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
        content: [{ type: "text", text: "No candle data returned for the specified parameters" }],
        isError: true,
      };
    }

    // Run strategy
    const params = {
      ...strategyDef.defaults,
      ...(args.strategy_params ? JSON.parse(args.strategy_params) : {}),
    };
    const signals = strategyDef.fn(candles, params);

    const isAccumulation = strategy === "buy_the_dip";
    const { trades, equityCurve } = runBacktest(candles, signals, {
      initialCapital,
      quantity,
      allowAccumulation: isAccumulation,
    });

    const metrics = calculateMetrics(trades, equityCurve, initialCapital);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          strategy: args.strategy,
          params,
          candles_count: candles.length,
          metrics,
          trades: trades.slice(0, 50), // Cap at 50 trades to avoid huge responses
          total_trades: trades.length,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error running backtest:", error);
    return {
      content: [{ type: "text", text: `Backtest error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};
