import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import {
  UPSTOX_API_BASE_URL,
  UPSTOX_API_POSITIONS_ENDPOINT,
  HEADERS,
  ERROR_MESSAGES
} from "../constants";

export const getFnoDecaySchema = {};

interface Position {
  exchange: string;
  multiplier: number;
  value: number;
  pnl: number;
  product: string;
  instrument_token: string;
  average_price: number | null;
  buy_value: number;
  quantity: number;
  last_price: number;
  unrealised: number;
  realised: number;
  sell_value: number;
  trading_symbol: string;
  tradingsymbol: string;
  close_price: number;
  buy_price: number;
  sell_price: number;
}

interface UpstoxPositionsResponse {
  status: string;
  data: Position[];
}

interface Greeks {
  vega: number;
  theta: number;
  gamma: number;
  delta: number;
  iv: number;
}

interface OptionData {
  instrument_key: string;
  market_data: {
    ltp: number;
    volume: number;
    oi: number;
    close_price: number;
    bid_price: number;
    bid_qty: number;
    ask_price: number;
    ask_qty: number;
    prev_oi: number;
  };
  option_greeks: Greeks;
}

interface OptionChainEntry {
  expiry: string;
  strike_price: number;
  underlying_key: string;
  underlying_spot_price: number;
  call_options: OptionData;
  put_options: OptionData;
}

interface UpstoxOptionChainResponse {
  status: string;
  data: OptionChainEntry[];
}

/**
 * Parse an option trading symbol to extract underlying, expiry, strike, and option type.
 * Examples:
 *   NIFTY2540917500CE -> { underlying: "NIFTY", expiry: "250409", strike: 17500, optionType: "CE" }
 *   BANKNIFTY25041545000PE -> { underlying: "BANKNIFTY", expiry: "250415", strike: 45000, optionType: "PE" }
 */
function parseOptionSymbol(tradingSymbol: string): {
  underlying: string;
  expiryRaw: string;
  strike: number;
  optionType: "CE" | "PE";
} | null {
  // Match: UNDERLYING + YYMMDD + STRIKE + CE/PE
  const match = tradingSymbol.match(/^([A-Z]+?)(\d{2}[01]\d[0-3]\d)(\d+)(CE|PE)$/);
  if (!match) return null;
  return {
    underlying: match[1],
    expiryRaw: match[2],
    strike: parseInt(match[3], 10),
    optionType: match[4] as "CE" | "PE",
  };
}

/**
 * Convert YYMMDD to YYYY-MM-DD for the API.
 */
function formatExpiry(expiryRaw: string): string {
  const yy = expiryRaw.substring(0, 2);
  const mm = expiryRaw.substring(2, 4);
  const dd = expiryRaw.substring(4, 6);
  const year = parseInt(yy, 10) + 2000;
  return `${year}-${mm}-${dd}`;
}

/**
 * Map underlying name to Upstox instrument key for option chain lookup.
 */
function getUnderlyingInstrumentKey(underlying: string): string {
  const indexMap: Record<string, string> = {
    "NIFTY": "NSE_INDEX|Nifty 50",
    "BANKNIFTY": "NSE_INDEX|Nifty Bank",
    "FINNIFTY": "NSE_INDEX|Nifty Fin Service",
    "MIDCPNIFTY": "NSE_INDEX|NIFTY MID SELECT",
    "SENSEX": "BSE_INDEX|SENSEX",
    "BANKEX": "BSE_INDEX|BANKEX",
  };
  if (indexMap[underlying]) return indexMap[underlying];
  // For stock options, use NSE_EQ prefix — caller may need to adjust instrument_token
  return `NSE_FO|${underlying}`;
}

interface DecayDetail {
  trading_symbol: string;
  quantity: number;
  net_position: "LONG" | "SHORT";
  option_type: "CE" | "PE";
  strike: number;
  expiry: string;
  underlying: string;
  ltp: number;
  underlying_spot: number;
  theta: number;
  theta_per_lot: number;
  daily_decay: number;
  iv: number;
  delta: number;
  gamma: number;
  vega: number;
  days_to_expiry: number;
}

export const getFnoDecayHandler: ToolHandler<Record<string, never>, Env> = async (_args, env: Env): Promise<ToolResponse> => {
  try {
    // Step 1: Fetch all open positions
    const posResponse = await fetch(`${UPSTOX_API_BASE_URL}${UPSTOX_API_POSITIONS_ENDPOINT}`, {
      method: "GET",
      headers: {
        "Accept": HEADERS.ACCEPT,
        "Authorization": `Bearer ${env.UPSTOX_ACCESS_TOKEN}`
      }
    });

    if (!posResponse.ok) {
      throw new Error("Failed to fetch positions");
    }

    const posData = await posResponse.json() as UpstoxPositionsResponse;
    const positions = posData.data || [];

    // Step 2: Filter for option positions (quantity != 0, symbol ends with CE/PE)
    const optionPositions = positions.filter(p =>
      p.quantity !== 0 && /(?:CE|PE)$/.test(p.trading_symbol || p.tradingsymbol)
    );

    if (optionPositions.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "success",
            message: "No open FnO option positions found.",
            data: { positions: [], summary: null }
          }, null, 2)
        }]
      };
    }

    // Step 3: Group positions by underlying + expiry to batch option chain calls
    const chainKeys = new Map<string, { instrumentKey: string; expiry: string }>();
    const parsedPositions: Array<{ position: Position; parsed: NonNullable<ReturnType<typeof parseOptionSymbol>> }> = [];

    for (const pos of optionPositions) {
      const symbol = pos.trading_symbol || pos.tradingsymbol;
      const parsed = parseOptionSymbol(symbol);
      if (!parsed) continue;

      parsedPositions.push({ position: pos, parsed });
      const expiry = formatExpiry(parsed.expiryRaw);
      const instrumentKey = getUnderlyingInstrumentKey(parsed.underlying);
      const key = `${instrumentKey}|${expiry}`;
      if (!chainKeys.has(key)) {
        chainKeys.set(key, { instrumentKey, expiry });
      }
    }

    // Step 4: Fetch option chains (deduplicated by underlying+expiry)
    const chainDataMap = new Map<string, OptionChainEntry[]>();
    const chainFetches = Array.from(chainKeys.entries()).map(async ([key, { instrumentKey, expiry }]) => {
      const url = `${UPSTOX_API_BASE_URL}/v2/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${encodeURIComponent(expiry)}`;
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "Accept": HEADERS.ACCEPT,
          "Authorization": `Bearer ${env.UPSTOX_ACCESS_TOKEN}`
        }
      });
      if (resp.ok) {
        const data = await resp.json() as UpstoxOptionChainResponse;
        chainDataMap.set(key, data.data || []);
      }
    });
    await Promise.all(chainFetches);

    // Step 5: Match each position to its option chain entry and extract greeks
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const details: DecayDetail[] = [];

    for (const { position, parsed } of parsedPositions) {
      const expiry = formatExpiry(parsed.expiryRaw);
      const instrumentKey = getUnderlyingInstrumentKey(parsed.underlying);
      const chainKey = `${instrumentKey}|${expiry}`;
      const chainEntries = chainDataMap.get(chainKey) || [];

      // Find matching strike in the chain
      const entry = chainEntries.find(e => e.strike_price === parsed.strike);
      if (!entry) continue;

      const optionData = parsed.optionType === "CE" ? entry.call_options : entry.put_options;
      if (!optionData?.option_greeks) continue;

      const greeks = optionData.option_greeks;
      const qty = position.quantity;
      const lotSize = position.multiplier || 1;
      const absQty = Math.abs(qty);

      // Theta is per-share daily decay. Negative for long options, positive for short.
      // If you are short (qty < 0), decay works in your favour (you earn).
      // If you are long (qty > 0), decay works against you (you lose).
      const thetaPerShare = greeks.theta; // typically negative (option loses value)
      const dailyDecay = thetaPerShare * qty * -1; // positive = you earn from decay

      // Days to expiry
      const expiryDate = new Date(expiry);
      expiryDate.setHours(0, 0, 0, 0);
      const dte = Math.max(0, Math.ceil((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)));

      details.push({
        trading_symbol: position.trading_symbol || position.tradingsymbol,
        quantity: qty,
        net_position: qty > 0 ? "LONG" : "SHORT",
        option_type: parsed.optionType,
        strike: parsed.strike,
        expiry,
        underlying: parsed.underlying,
        ltp: optionData.market_data?.ltp ?? position.last_price,
        underlying_spot: entry.underlying_spot_price,
        theta: thetaPerShare,
        theta_per_lot: thetaPerShare * lotSize,
        daily_decay: Math.round(dailyDecay * 100) / 100,
        iv: greeks.iv,
        delta: greeks.delta,
        gamma: greeks.gamma,
        vega: greeks.vega,
        days_to_expiry: dte,
      });
    }

    // Step 6: Build summary
    const totalDailyDecay = details.reduce((sum, d) => sum + d.daily_decay, 0);
    const decayFromShorts = details.filter(d => d.net_position === "SHORT").reduce((sum, d) => sum + d.daily_decay, 0);
    const decayFromLongs = details.filter(d => d.net_position === "LONG").reduce((sum, d) => sum + d.daily_decay, 0);
    const totalTheta = details.reduce((sum, d) => sum + (d.theta * d.quantity * -1), 0);
    const netDelta = details.reduce((sum, d) => sum + (d.delta * d.quantity), 0);
    const netVega = details.reduce((sum, d) => sum + (d.vega * d.quantity), 0);

    // Weekend/holiday decay estimate (options lose value over weekends too)
    const weeklyDecay = totalDailyDecay * 7; // theta applies calendar days
    const monthlyDecay = totalDailyDecay * 30;

    const summary = {
      total_option_positions: details.length,
      total_daily_theta_decay: Math.round(totalDailyDecay * 100) / 100,
      decay_earned_from_shorts: Math.round(decayFromShorts * 100) / 100,
      decay_lost_from_longs: Math.round(decayFromLongs * 100) / 100,
      weekly_decay_estimate: Math.round(weeklyDecay * 100) / 100,
      monthly_decay_estimate: Math.round(monthlyDecay * 100) / 100,
      net_portfolio_delta: Math.round(netDelta * 100) / 100,
      net_portfolio_vega: Math.round(netVega * 100) / 100,
      note: "Positive daily_decay = you earn from time decay (short options). Negative = you lose (long options). Theta accelerates as expiry approaches."
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "success",
          data: {
            positions: details,
            summary
          }
        }, null, 2)
      }]
    };
  } catch (error) {
    console.error("Error calculating FnO decay:", error);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "error",
          message: `Error calculating FnO decay: ${error instanceof Error ? error.message : "Unknown error"}`
        })
      }]
    };
  }
};
