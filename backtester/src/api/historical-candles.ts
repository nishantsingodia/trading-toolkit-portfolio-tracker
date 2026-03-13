import type { Candle } from "../engine/types.js";

const UPSTOX_BASE_URL = "https://api.upstox.com/v2";

export type CandleInterval = "1minute" | "30minute" | "day" | "week" | "month";

export interface FetchCandlesOptions {
  instrumentKey: string;
  interval: CandleInterval;
  fromDate: string; // YYYY-MM-DD
  toDate: string; // YYYY-MM-DD
  accessToken: string;
}

/**
 * Fetch historical candle data from Upstox API.
 * API: GET /v2/historical-candle/{instrument_key}/{interval}/{to_date}/{from_date}
 * Returns: { data: { candles: [[ts, o, h, l, c, v, oi], ...] } }
 */
export async function fetchHistoricalCandles(
  options: FetchCandlesOptions
): Promise<Candle[]> {
  const { instrumentKey, interval, fromDate, toDate, accessToken } = options;

  const encodedKey = encodeURIComponent(instrumentKey);
  const url = `${UPSTOX_BASE_URL}/historical-candle/${encodedKey}/${interval}/${toDate}/${fromDate}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Upstox API error ${response.status}: ${body}`
    );
  }

  const json = (await response.json()) as {
    status: string;
    data: { candles: Array<[string, number, number, number, number, number, number]> };
  };

  if (!json.data?.candles) {
    return [];
  }

  // Upstox returns candles in reverse chronological order — sort ascending
  const rawCandles = json.data.candles;
  const candles: Candle[] = rawCandles.map(
    ([timestamp, open, high, low, close, volume, oi]) => ({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
      oi,
    })
  );

  candles.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return candles;
}
