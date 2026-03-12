import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import {
  UPSTOX_API_BASE_URL,
  UPSTOX_API_PROFILE_ENDPOINT,
  HEADERS,
  ERROR_MESSAGES
} from "../constants";

export const getProfileSchema = {};

interface UpstoxProfileResponse {
  status: string;
  data: {
    email: string;
    exchanges: string[];
    products: string[];
    broker: string;
    user_id: string;
    user_name: string;
    order_types: string[];
    user_type: string;
    poa: boolean;
    ddpi: boolean;
    is_active: boolean;
  };
}

export const getProfileHandler: ToolHandler<Record<string, never>, Env> = async (args, env: Env): Promise<ToolResponse> => {
  const response = await fetch(`${UPSTOX_API_BASE_URL}${UPSTOX_API_PROFILE_ENDPOINT}`, {
    method: "GET",
    headers: {
      "Accept": HEADERS.ACCEPT,
      "Authorization": `Bearer ${env.UPSTOX_ACCESS_TOKEN}`
    }
  });

  if (!response.ok) {
    throw new Error(ERROR_MESSAGES.API_ERROR);
  }

  const data = await response.json() as UpstoxProfileResponse;

  return {
    content: [{
      type: "text",
      text: JSON.stringify(data, null, 2)
    }]
  };
};
