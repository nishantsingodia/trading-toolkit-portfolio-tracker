import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import { UPSTOX_API_BASE_URL, HEADERS, ERROR_MESSAGES } from "../constants";
import { suggestWithCandles } from "../../backtester/src/commands/suggest-strategies";
import type { Candle } from "../../backtester/src/engine/types";

export const suggestStrategiesSchema = {
  instrument_key: z.string().min(1, "Instrument key is required"),
  interval: z.enum(["1minute", "30minute", "day", "week", "month"]).optional().describe("Candle interval (default: day)"),
  lookback_days: z.number().optional().describe("Number of days to look back (default: 90)"),
};

interface SuggestStrategiesArgs {
  instrument_key: string;
  interval?: string;
  lookback_days?: number;
}

export const suggestStrategiesHandler: ToolHandler<SuggestStrategiesArgs, Env> = async (
  args: SuggestStrategiesArgs,
  env: Env
): Promise<ToolResponse> => {
  try {
    const interval = args.interval ?? "day";
    const lookbackDays = args.lookback_days ?? 90;

    const toDate = new Date().toISOString().slice(0, 10);
    const fromDate = new Date(Date.now() - lookbackDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    // Fetch candles
    const encodedKey = encodeURIComponent(args.instrument_key);
    const url = `${UPSTOX_API_BASE_URL}/v2/historical-candle/${encodedKey}/${interval}/${toDate}/${fromDate}`;

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
        content: [{ type: "text", text: "No candle data returned for suggestion period" }],
        isError: true,
      };
    }

    const result = suggestWithCandles(candles);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          regime: result.regime,
          recommendedStrategy: result.recommendedStrategy,
          lookbackDays,
          candlesAnalyzed: candles.length,
          rankings: result.suggestions.map((s) => ({
            rank: s.rank,
            strategy: s.strategy,
            score: Math.round(s.score * 100) / 100,
            totalReturnPct: s.metrics.totalReturnPct,
            cagr: s.metrics.cagr,
            sharpeRatio: s.metrics.sharpeRatio,
            maxDrawdownPct: s.metrics.maxDrawdownPct,
            winRate: s.metrics.winRate,
            totalTrades: s.metrics.totalTrades,
          })),
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error suggesting strategies:", error);
    return {
      content: [{ type: "text", text: `Suggest error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};
