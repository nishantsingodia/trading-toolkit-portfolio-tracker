import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import {
  UPSTOX_API_BASE_URL,
  UPSTOX_API_TRADES_ENDPOINT,
  HEADERS,
  ERROR_MESSAGES
} from "../constants";

export const getTradesSchema = {};

interface TradeResponse {
  status: string;
  data: Array<{
    exchange: string;
    product: string;
    trading_symbol: string;
    tradingsymbol: string;
    instrument_token: string;
    order_type: string;
    transaction_type: string;
    quantity: number;
    exchange_order_id: string;
    order_id: string;
    exchange_timestamp: string;
    average_price: number;
    trade_id: string;
    order_ref_id: string;
    order_timestamp: string;
  }>;
}

export const getTradesHandler: ToolHandler<Record<string, never>, Env> = async (args, env: Env): Promise<ToolResponse> => {
  const response = await fetch(`${UPSTOX_API_BASE_URL}${UPSTOX_API_TRADES_ENDPOINT}`, {
    method: "GET",
    headers: {
      "Accept": HEADERS.ACCEPT,
      "Authorization": `Bearer ${env.UPSTOX_ACCESS_TOKEN}`
    }
  });

  if (!response.ok) {
    throw new Error(ERROR_MESSAGES.API_ERROR);
  }

  const data = await response.json() as TradeResponse;

  return {
    content: [{
      type: "text",
      text: JSON.stringify(data, null, 2)
    }]
  };
};
