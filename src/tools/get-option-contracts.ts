import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import {
  UPSTOX_API_BASE_URL,
  HEADERS,
  ERROR_MESSAGES
} from "../constants";

export const getOptionContractsSchema = {
  instrument_key: z.string().describe("Instrument key of the underlying, e.g. 'NSE_INDEX|Nifty 50' or 'NSE_INDEX|Nifty Bank'"),
  expiry_date: z.string().optional().describe("Optional expiry date in YYYY-MM-DD format to filter contracts"),
};

interface OptionContractsArgs {
  instrument_key: string;
  expiry_date?: string;
}

export const getOptionContractsHandler: ToolHandler<OptionContractsArgs, Env> = async (args: OptionContractsArgs, env: Env): Promise<ToolResponse> => {
  try {
    let url = `${UPSTOX_API_BASE_URL}/v2/option/contract?instrument_key=${encodeURIComponent(args.instrument_key)}`;
    if (args.expiry_date) {
      url += `&expiry_date=${encodeURIComponent(args.expiry_date)}`;
    }

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
    console.error("Error fetching option contracts:", error);
    return {
      content: [{
        type: "text",
        text: ERROR_MESSAGES.API_ERROR
      }]
    };
  }
};
