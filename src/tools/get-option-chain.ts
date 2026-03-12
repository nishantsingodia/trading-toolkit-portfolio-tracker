import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import {
  UPSTOX_API_BASE_URL,
  HEADERS,
  ERROR_MESSAGES
} from "../constants";

export const getOptionChainSchema = {
  instrument_key: z.string().describe("Instrument key of the underlying, e.g. 'NSE_INDEX|Nifty 50' or 'NSE_INDEX|Nifty Bank'"),
  expiry_date: z.string().describe("Expiry date in YYYY-MM-DD format, e.g. '2024-03-28'"),
};

interface OptionChainArgs {
  instrument_key: string;
  expiry_date: string;
}

export const getOptionChainHandler: ToolHandler<OptionChainArgs, Env> = async (args: OptionChainArgs, env: Env): Promise<ToolResponse> => {
  try {
    const url = `${UPSTOX_API_BASE_URL}/v2/option/chain?instrument_key=${encodeURIComponent(args.instrument_key)}&expiry_date=${encodeURIComponent(args.expiry_date)}`;
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
    console.error("Error fetching option chain:", error);
    return {
      content: [{
        type: "text",
        text: ERROR_MESSAGES.API_ERROR
      }]
    };
  }
};
