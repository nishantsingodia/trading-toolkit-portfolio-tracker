import type { Candle, CandleInterval, Underlying, OptionsChainSnapshot, StrikeData } from "../engine/types.js";
import { RISK_FREE_RATE } from "../engine/types.js";
import { getATMStrike, enumerateStrikes, buildInstrumentKey } from "../engine/options-chain.js";
import { blackScholesCall, blackScholesPut, calculateGreeks, impliedVolatility } from "../engine/pricing.js";
import { getDTE, dteToYears } from "../engine/expiry-calendar.js";

const UPSTOX_BASE_URL = "https://api.upstox.com/v2";

export interface FetchCandlesOptions {
  instrumentKey: string;
  interval: CandleInterval;
  fromDate: string;
  toDate: string;
  accessToken: string;
}

/**
 * Fetch historical candles from Upstox API.
 */
export async function fetchHistoricalCandles(
  options: FetchCandlesOptions
): Promise<Candle[]> {
  const url = `${UPSTOX_BASE_URL}/historical-candle/${encodeURIComponent(options.instrumentKey)}/${options.interval}/${options.toDate}/${options.fromDate}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Upstox API error: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as {
    status: string;
    data: { candles: Array<[string, number, number, number, number, number, number]> };
  };

  if (!json.data?.candles) return [];

  return json.data.candles
    .map(([timestamp, open, high, low, close, volume, oi]) => ({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
      oi,
    }))
    .reverse(); // API returns newest first, we want oldest first
}

export interface FetchOptionsChainOptions {
  underlying: Underlying;
  expiry: string;
  spotPrice: number;
  numStrikes: number;
  interval: CandleInterval;
  fromDate: string;
  toDate: string;
  accessToken: string;
}

/**
 * Fetch a complete options chain by fetching individual option contract candles.
 * Note: This makes many API calls (2 per strike * numStrikes * 2 sides).
 * Rate limiting and caching recommended for production use.
 */
export async function fetchOptionsChain(
  options: FetchOptionsChainOptions
): Promise<OptionsChainSnapshot[]> {
  const atm = getATMStrike(options.spotPrice, options.underlying);
  const strikes = enumerateStrikes(atm, options.numStrikes, options.underlying);

  // Fetch spot candles first
  const spotKey =
    options.underlying === "NIFTY"
      ? "NSE_INDEX|Nifty 50"
      : "NSE_INDEX|Nifty Bank";

  const spotCandles = await fetchHistoricalCandles({
    instrumentKey: spotKey,
    interval: options.interval,
    fromDate: options.fromDate,
    toDate: options.toDate,
    accessToken: options.accessToken,
  });

  // Fetch option contract candles for each strike
  const optionData = new Map<
    number,
    { ce: Candle[]; pe: Candle[] }
  >();

  for (const strike of strikes) {
    const ceKey = buildInstrumentKey(options.underlying, options.expiry, strike, "CE");
    const peKey = buildInstrumentKey(options.underlying, options.expiry, strike, "PE");

    try {
      const [ceCandles, peCandles] = await Promise.all([
        fetchHistoricalCandles({
          instrumentKey: ceKey,
          interval: options.interval,
          fromDate: options.fromDate,
          toDate: options.toDate,
          accessToken: options.accessToken,
        }),
        fetchHistoricalCandles({
          instrumentKey: peKey,
          interval: options.interval,
          fromDate: options.fromDate,
          toDate: options.toDate,
          accessToken: options.accessToken,
        }),
      ]);

      optionData.set(strike, { ce: ceCandles, pe: peCandles });
    } catch {
      // Skip strikes with no data
    }

    // Simple rate limiting — 100ms between pairs
    await new Promise((r) => setTimeout(r, 100));
  }

  // Combine into chain snapshots per timestamp
  const chainHistory: OptionsChainSnapshot[] = [];

  for (const spotCandle of spotCandles) {
    const chainStrikes = new Map<number, StrikeData>();
    const dateStr = spotCandle.timestamp.slice(0, 10);
    const dte = getDTE(dateStr, options.expiry);
    const tte = dteToYears(dte);

    for (const [strike, data] of optionData) {
      // Find matching candle by timestamp
      const ceCandle = data.ce.find((c) => c.timestamp === spotCandle.timestamp);
      const peCandle = data.pe.find((c) => c.timestamp === spotCandle.timestamp);

      if (ceCandle && peCandle) {
        // Calculate IV from market prices
        const ceIV = impliedVolatility(ceCandle.close, spotCandle.close, strike, tte, RISK_FREE_RATE, "CE");
        const peIV = impliedVolatility(peCandle.close, spotCandle.close, strike, tte, RISK_FREE_RATE, "PE");

        const ceGreeks = calculateGreeks(spotCandle.close, strike, tte, RISK_FREE_RATE, ceIV, "CE");
        const peGreeks = calculateGreeks(spotCandle.close, strike, tte, RISK_FREE_RATE, peIV, "PE");

        chainStrikes.set(strike, {
          ce: {
            price: ceCandle.close,
            oi: ceCandle.oi,
            volume: ceCandle.volume,
            iv: ceIV,
            greeks: ceGreeks,
          },
          pe: {
            price: peCandle.close,
            oi: peCandle.oi,
            volume: peCandle.volume,
            iv: peIV,
            greeks: peGreeks,
          },
        });
      }
    }

    if (chainStrikes.size > 0) {
      chainHistory.push({
        timestamp: spotCandle.timestamp,
        spotPrice: spotCandle.close,
        strikes: chainStrikes,
      });
    }
  }

  return chainHistory;
}
