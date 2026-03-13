import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import { UPSTOX_API_BASE_URL, HEADERS, ERROR_MESSAGES } from "../constants";

export const getHistoricalCandlesSchema = {
  instrument_key: z.string().min(1, "Instrument key is required (e.g. NSE_INDEX|Nifty 50)"),
  interval: z.enum(["1minute", "30minute", "day", "week", "month"]).describe("Candle interval"),
  from_date: z.string().min(1, "From date is required (YYYY-MM-DD)"),
  to_date: z.string().min(1, "To date is required (YYYY-MM-DD)"),
};

interface GetHistoricalCandlesArgs {
  instrument_key: string;
  interval: string;
  from_date: string;
  to_date: string;
}

export const getHistoricalCandlesHandler: ToolHandler<GetHistoricalCandlesArgs, Env> = async (
  args: GetHistoricalCandlesArgs,
  env: Env
): Promise<ToolResponse> => {
  try {
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
      status: string;
      data: { candles: Array<[string, number, number, number, number, number, number]> };
    };

    const candles = (json.data?.candles ?? []).map(
      ([timestamp, open, high, low, close, volume, oi]) => ({
        timestamp,
        open,
        high,
        low,
        close,
        volume,
        oi,
      })
    );

    // Sort ascending by timestamp
    candles.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ candles, count: candles.length }, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error fetching historical candles:", error);
    return {
      content: [{ type: "text", text: ERROR_MESSAGES.API_ERROR }],
    };
  }
};
