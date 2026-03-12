import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import {
  UPSTOX_API_BASE_URL,
  HEADERS,
  ERROR_MESSAGES
} from "../constants";

export const getMarketStatusSchema = {
  exchange: z.string().describe("Exchange code, e.g. 'NSE', 'BSE', 'MCX'"),
};

interface MarketStatusArgs {
  exchange: string;
}

export const getMarketStatusHandler: ToolHandler<MarketStatusArgs, Env> = async (args: MarketStatusArgs, env: Env): Promise<ToolResponse> => {
  try {
    const url = `${UPSTOX_API_BASE_URL}/v2/market/status/${encodeURIComponent(args.exchange)}`;
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
    console.error("Error fetching market status:", error);
    return {
      content: [{
        type: "text",
        text: ERROR_MESSAGES.API_ERROR
      }]
    };
  }
};
