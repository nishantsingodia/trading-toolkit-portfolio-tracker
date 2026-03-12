import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import {
  UPSTOX_API_BASE_URL,
  HEADERS,
  ERROR_MESSAGES
} from "../constants";

export const getOhlcQuotesSchema = {
  instrument_keys: z.string().describe("Comma-separated instrument keys, e.g. 'NSE_EQ|INE848E01016,NSE_INDEX|Nifty 50'. Max 500 instruments."),
  interval: z.string().describe("OHLC interval: '1d' for daily or 'I1' for 1 minute, 'I30' for 30 minutes"),
};

interface OhlcQuotesArgs {
  instrument_keys: string;
  interval: string;
}

export const getOhlcQuotesHandler: ToolHandler<OhlcQuotesArgs, Env> = async (args: OhlcQuotesArgs, env: Env): Promise<ToolResponse> => {
  try {
    const url = `${UPSTOX_API_BASE_URL}/v2/market-quote/ohlc?instrument_key=${encodeURIComponent(args.instrument_keys)}&interval=${encodeURIComponent(args.interval)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": HEADERS.ACCEPT,
        "Authorization": `Bearer ${env.UPSTOX_ACCESS_TOKEN}`
      }
    });

    if (!response.ok) {
      throw new Error(ERROR_MESSAGES.API_ERROR);
    }

    const data = await response.json();

    return {
      content: [{
        type: "text",
        text: JSON.stringify(data, null, 2)
      }]
    };
  } catch (error) {
    console.error("Error fetching OHLC quotes:", error);
    return {
      content: [{
        type: "text",
        text: ERROR_MESSAGES.API_ERROR
      }]
    };
  }
};
