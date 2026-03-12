import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import {
  UPSTOX_API_BASE_URL,
  HEADERS,
  ERROR_MESSAGES
} from "../constants";

export const getMarketQuotesSchema = {
  instrument_keys: z.string().describe("Comma-separated instrument keys, e.g. 'NSE_EQ|INE848E01016,NSE_INDEX|Nifty 50'. Max 500 instruments."),
};

interface MarketQuotesArgs {
  instrument_keys: string;
}

export const getMarketQuotesHandler: ToolHandler<MarketQuotesArgs, Env> = async (args: MarketQuotesArgs, env: Env): Promise<ToolResponse> => {
  try {
    const url = `${UPSTOX_API_BASE_URL}/v2/market-quote/quotes?instrument_key=${encodeURIComponent(args.instrument_keys)}`;
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
    console.error("Error fetching market quotes:", error);
    return {
      content: [{
        type: "text",
        text: ERROR_MESSAGES.API_ERROR
      }]
    };
  }
};
