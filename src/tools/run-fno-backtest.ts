import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import { UPSTOX_API_BASE_URL, HEADERS, ERROR_MESSAGES } from "../constants";

// Import from F&O backtester
import { FNO_STRATEGY_REGISTRY } from "../../fno-backtester/src/engine/strategies";
import { runFnoBacktest } from "../../fno-backtester/src/engine/backtester";
import { buildBacktestResult } from "../../fno-backtester/src/engine/metrics";
import { getATMStrike, enumerateStrikes } from "../../fno-backtester/src/engine/options-chain";
import { blackScholesCall, blackScholesPut, calculateGreeks, impliedVolatility } from "../../fno-backtester/src/engine/pricing";
import { getDTE, dteToYears, getNextExpiry } from "../../fno-backtester/src/engine/expiry-calendar";
import type { Candle, FnoStrategyName, OptionsChainSnapshot, StrikeData, Underlying } from "../../fno-backtester/src/engine/types";
import { DEFAULT_FNO_CONFIG, RISK_FREE_RATE } from "../../fno-backtester/src/engine/types";

export const runFnoBacktestSchema = {
  underlying: z.enum(["NIFTY", "BANKNIFTY"]).describe("Index underlying — NIFTY or BANKNIFTY"),
  from_date: z.string().min(1, "From date (YYYY-MM-DD)"),
  to_date: z.string().min(1, "To date (YYYY-MM-DD)"),
  strategy: z.enum([
    "short_straddle", "short_strangle", "iron_condor", "iron_butterfly",
    "deep_otm_sell", "bull_call_spread", "bear_put_spread", "ema50_directional",
    "long_straddle", "calendar_spread", "straddle_920", "oi_max_pain",
  ]).describe("F&O strategy to backtest"),
  strategy_params: z.string().optional().describe("JSON string of strategy params (optional, uses defaults)"),
  initial_capital: z.number().optional().describe("Starting capital (default: 500000)"),
  num_strikes: z.number().optional().describe("Number of strikes each side of ATM to fetch (default: 10)"),
};

interface RunFnoBacktestArgs {
  underlying: string;
  from_date: string;
  to_date: string;
  strategy: string;
  strategy_params?: string;
  initial_capital?: number;
  num_strikes?: number;
}

/** Fetch spot candles for the underlying index */
async function fetchSpotCandles(
  underlying: string,
  fromDate: string,
  toDate: string,
  token: string
): Promise<Candle[]> {
  const indexKey = underlying === "NIFTY"
    ? "NSE_INDEX|Nifty 50"
    : "NSE_INDEX|Nifty Bank";
  const encodedKey = encodeURIComponent(indexKey);
  const url = `${UPSTOX_API_BASE_URL}/v2/historical-candle/${encodedKey}/day/${toDate}/${fromDate}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: HEADERS.ACCEPT,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch spot candles: ${response.status}`);
  }

  const json = (await response.json()) as {
    data: { candles: Array<[string, number, number, number, number, number, number]> };
  };

  return (json.data?.candles ?? [])
    .map(([timestamp, open, high, low, close, volume, oi]) => ({
      timestamp, open, high, low, close, volume, oi,
    }))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

/** Fetch option chain using Upstox /v2/option/chain endpoint */
async function fetchOptionChainSnapshot(
  underlying: string,
  expiryDate: string,
  token: string
): Promise<any> {
  const indexKey = underlying === "NIFTY"
    ? "NSE_INDEX|Nifty 50"
    : "NSE_INDEX|Nifty Bank";

  const url = `${UPSTOX_API_BASE_URL}/v2/option/chain?instrument_key=${encodeURIComponent(indexKey)}&expiry_date=${encodeURIComponent(expiryDate)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: HEADERS.ACCEPT,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) return null;
  return response.json();
}

/**
 * Build chain history from spot candles + option chain data.
 * Uses BS model to compute theoretical prices when real chain isn't available at each timestamp.
 */
function buildChainFromSpot(
  spotCandles: Candle[],
  optionChainData: any,
  underlying: Underlying,
  expiry: string,
  numStrikes: number
): OptionsChainSnapshot[] {
  const history: OptionsChainSnapshot[] = [];

  // Extract IV from the live chain data if available
  let baseIV = 0.15;
  if (optionChainData?.data) {
    const ivs: number[] = [];
    for (const row of optionChainData.data) {
      if (row.call_options?.market_data?.iv) ivs.push(row.call_options.market_data.iv / 100);
      if (row.put_options?.market_data?.iv) ivs.push(row.put_options.market_data.iv / 100);
    }
    if (ivs.length > 0) baseIV = ivs.reduce((a: number, b: number) => a + b, 0) / ivs.length;
  }

  for (const candle of spotCandles) {
    const spotPrice = candle.close;
    const dateStr = candle.timestamp.slice(0, 10);
    const dte = getDTE(dateStr, expiry);
    const tte = dteToYears(dte);
    if (dte <= 0) continue;

    const atm = getATMStrike(spotPrice, underlying);
    const strikes = enumerateStrikes(atm, numStrikes, underlying);
    const strikeMap = new Map<number, StrikeData>();

    for (const strike of strikes) {
      if (strike <= 0) continue;
      const moneyness = Math.abs(strike - spotPrice) / spotPrice;
      const skewedIV = baseIV * (1 + moneyness * 0.5);

      const cePrice = blackScholesCall(spotPrice, strike, tte, RISK_FREE_RATE, skewedIV);
      const pePrice = blackScholesPut(spotPrice, strike, tte, RISK_FREE_RATE, skewedIV);
      const ceGreeks = calculateGreeks(spotPrice, strike, tte, RISK_FREE_RATE, skewedIV, "CE");
      const peGreeks = calculateGreeks(spotPrice, strike, tte, RISK_FREE_RATE, skewedIV, "PE");

      const oiFactor = Math.exp(-moneyness * moneyness * 50);
      const baseOI = 500000;

      strikeMap.set(strike, {
        ce: { price: Math.max(cePrice, 0.05), oi: Math.round(baseOI * oiFactor), volume: Math.round(100000 * oiFactor), iv: skewedIV, greeks: ceGreeks },
        pe: { price: Math.max(pePrice, 0.05), oi: Math.round(baseOI * oiFactor), volume: Math.round(100000 * oiFactor), iv: skewedIV, greeks: peGreeks },
      });
    }

    history.push({ timestamp: candle.timestamp, spotPrice, strikes: strikeMap });
  }

  return history;
}

export const runFnoBacktestHandler: ToolHandler<RunFnoBacktestArgs, Env> = async (
  args: RunFnoBacktestArgs,
  env: Env
): Promise<ToolResponse> => {
  try {
    const underlying = args.underlying as Underlying;
    const strategy = args.strategy as FnoStrategyName;
    const initialCapital = args.initial_capital ?? 500000;
    const numStrikes = args.num_strikes ?? 10;

    const strategyDef = FNO_STRATEGY_REGISTRY[strategy];
    if (!strategyDef) {
      return { content: [{ type: "text", text: `Unknown F&O strategy: ${args.strategy}` }], isError: true };
    }

    // 1. Fetch spot candles
    const spotCandles = await fetchSpotCandles(underlying, args.from_date, args.to_date, env.UPSTOX_ACCESS_TOKEN);
    if (spotCandles.length === 0) {
      return { content: [{ type: "text", text: "No spot candle data returned" }], isError: true };
    }

    // 2. Get current option chain for IV calibration
    const expiry = getNextExpiry(underlying, args.to_date, "weekly");
    let optionChainData = null;
    try {
      optionChainData = await fetchOptionChainSnapshot(underlying, expiry, env.UPSTOX_ACCESS_TOKEN);
    } catch { /* proceed with default IV */ }

    // 3. Build synthetic chain history from spot + BS model
    const chainHistory = buildChainFromSpot(spotCandles, optionChainData, underlying, expiry, numStrikes);
    if (chainHistory.length === 0) {
      return { content: [{ type: "text", text: "Could not build option chain history" }], isError: true };
    }

    // 4. Run strategy
    const params = { ...strategyDef.defaults, ...(args.strategy_params ? JSON.parse(args.strategy_params) : {}) };
    const signals = strategyDef.fn(chainHistory, spotCandles, params);

    // 5. Run backtest
    const config = { ...DEFAULT_FNO_CONFIG, initialCapital };
    const output = runFnoBacktest(chainHistory, spotCandles, signals, config, strategy, underlying);

    // 6. Build result with metrics
    const result = buildBacktestResult(output.trades, output.equityCurve, output.drawdownSeries, output.greeksTimeSeries, initialCapital);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          strategy: args.strategy,
          underlying: args.underlying,
          from_date: args.from_date,
          to_date: args.to_date,
          expiry,
          params,
          candles_count: spotCandles.length,
          chain_snapshots: chainHistory.length,
          metrics: result.metrics,
          trades: result.trades.slice(0, 30),
          total_trades: result.trades.length,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error running F&O backtest:", error);
    return {
      content: [{ type: "text", text: `F&O Backtest error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};
