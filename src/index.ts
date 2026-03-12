import { Env, GetHoldingsArgs } from "./types";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getProfileSchema, getProfileHandler,
  getFundsMarginSchema, getFundsMarginHandler,
  getHoldingsSchema, getHoldingsHandler,
  getPositionsSchema, getPositionsHandler,
  getMtfPositionsSchema, getMtfPositionsHandler,
  getOrderBookSchema, getOrderBookHandler,
  getOrderDetailsSchema, getOrderDetailsHandler,
  getTradesSchema, getTradesHandler,
  getOrderTradesSchema, getOrderTradesHandler,
  getOrderHistorySchema, getOrderHistoryHandler,
  getMarketQuotesSchema, getMarketQuotesHandler,
  getLtpQuotesSchema, getLtpQuotesHandler,
  getOhlcQuotesSchema, getOhlcQuotesHandler,
  getOptionChainSchema, getOptionChainHandler,
  getOptionContractsSchema, getOptionContractsHandler,
  getMarketStatusSchema, getMarketStatusHandler
} from "./tools";

export class MyMCP extends McpAgent {
	env: Env;
	server = new McpServer({
		name: "Upstox MCP",
		version: "1.0.0",
	});
	constructor(ctx: any, env: any) {
		super(ctx, env);
		this.env = env;
	}
	async init() {
		this.server.tool("get-profile", getProfileSchema, async (args) => {
			return getProfileHandler(args as Record<string, never>, this.env);
		});
		this.server.tool("get-funds-margin", getFundsMarginSchema, async (args) => {
			return getFundsMarginHandler(args as { segment?: string }, this.env);
		});
		this.server.tool("get-holdings", getHoldingsSchema, async (args) => {
			return getHoldingsHandler(args as GetHoldingsArgs, this.env);
		});
		this.server.tool("get-positions", getPositionsSchema, async (args) => {
			return getPositionsHandler(args as Record<string, never>, this.env);
		});
		this.server.tool("get-mtf-positions", getMtfPositionsSchema, async (args) => {
			return getMtfPositionsHandler(args as Record<string, never>, this.env);
		});
		this.server.tool("get-order-book", getOrderBookSchema, async (args) => {
			return getOrderBookHandler(args as Record<string, never>, this.env);
		});
		this.server.tool("get-order-details", getOrderDetailsSchema, async (args) => {
			return getOrderDetailsHandler(args as { orderId: string }, this.env);
		});
		this.server.tool("get-trades", getTradesSchema, async (args) => {
			return getTradesHandler(args as Record<string, never>, this.env);
		});
		this.server.tool("get-order-trades", getOrderTradesSchema, async (args) => {
			return getOrderTradesHandler(args as { orderId: string }, this.env);
		});
		this.server.tool("get-order-history", getOrderHistorySchema, async (args) => {
			return getOrderHistoryHandler(args as { orderId?: string; tag?: string }, this.env);
		});

		// Market Data Tools
		this.server.tool("get-market-quotes", getMarketQuotesSchema, async (args) => {
			return getMarketQuotesHandler(args as { instrument_keys: string }, this.env);
		});
		this.server.tool("get-ltp-quotes", getLtpQuotesSchema, async (args) => {
			return getLtpQuotesHandler(args as { instrument_keys: string }, this.env);
		});
		this.server.tool("get-ohlc-quotes", getOhlcQuotesSchema, async (args) => {
			return getOhlcQuotesHandler(args as { instrument_keys: string; interval: string }, this.env);
		});
		this.server.tool("get-option-chain", getOptionChainSchema, async (args) => {
			return getOptionChainHandler(args as { instrument_key: string; expiry_date: string }, this.env);
		});
		this.server.tool("get-option-contracts", getOptionContractsSchema, async (args) => {
			return getOptionContractsHandler(args as { instrument_key: string; expiry_date?: string }, this.env);
		});
		this.server.tool("get-market-status", getMarketStatusSchema, async (args) => {
			return getMarketStatusHandler(args as { exchange: string }, this.env);
		});
	}
}

// Export the MCP server directly
export default MyMCP.mount("/sse");
