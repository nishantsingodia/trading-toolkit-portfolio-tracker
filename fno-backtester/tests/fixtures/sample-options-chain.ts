import type { OptionsChainSnapshot, StrikeData, Candle } from "../../src/engine/types.js";
import { blackScholesCall, blackScholesPut, calculateGreeks } from "../../src/engine/pricing.js";
import { RISK_FREE_RATE } from "../../src/engine/types.js";

/**
 * Generate a deterministic spot price path using seeded random walk.
 */
export function generateSpotPath(
  startPrice: number,
  numDays: number,
  dailyVol: number = 0.01,
  seed: number = 42
): number[] {
  const prices: number[] = [startPrice];
  let s = seed;

  for (let i = 1; i < numDays; i++) {
    // Simple seeded PRNG (Lehmer)
    s = (s * 16807) % 2147483647;
    const u1 = s / 2147483647;
    s = (s * 16807) % 2147483647;
    const u2 = s / 2147483647;

    // Box-Muller for normal distribution
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const dailyReturn = z * dailyVol;
    prices.push(prices[i - 1] * (1 + dailyReturn));
  }

  return prices;
}

/**
 * Generate synthetic spot candles from a price path.
 */
export function generateSpotCandles(
  prices: number[],
  startDate: string,
  interval: "day" | "1minute" = "day"
): Candle[] {
  const candles: Candle[] = [];
  const start = new Date(startDate + "T09:15:00Z");

  for (let i = 0; i < prices.length; i++) {
    const price = prices[i];
    const noise = price * 0.005; // 0.5% intraday noise

    let timestamp: string;
    if (interval === "day") {
      const d = new Date(start.getTime());
      d.setUTCDate(d.getUTCDate() + i);
      timestamp = d.toISOString().slice(0, 10) + "T15:30:00";
    } else {
      const d = new Date(start.getTime());
      d.setUTCMinutes(d.getUTCMinutes() + i);
      timestamp = d.toISOString().slice(0, 19);
    }

    candles.push({
      timestamp,
      open: price - noise * 0.3,
      high: price + noise,
      low: price - noise,
      close: price,
      volume: 1000000 + Math.floor(Math.abs(prices[i] - (prices[i - 1] ?? prices[i])) * 10000),
      oi: 0,
    });
  }

  return candles;
}

/**
 * Generate a synthetic options chain snapshot using Black-Scholes pricing.
 * Creates realistic option prices at each strike.
 */
export function generateChainSnapshot(
  spotPrice: number,
  timestamp: string,
  expiry: string,
  iv: number = 0.15,
  numStrikes: number = 10,
  strikeInterval: number = 50
): OptionsChainSnapshot {
  const atm = Math.round(spotPrice / strikeInterval) * strikeInterval;
  const strikes = new Map<number, StrikeData>();

  const dateStr = timestamp.slice(0, 10);
  const expiryDate = new Date(expiry + "T00:00:00Z");
  const currentDate = new Date(dateStr + "T00:00:00Z");
  const dte = Math.max(1, Math.round((expiryDate.getTime() - currentDate.getTime()) / (1000 * 60 * 60 * 24)));
  const tte = dte / 365;

  for (let i = -numStrikes; i <= numStrikes; i++) {
    const strike = atm + i * strikeInterval;
    if (strike <= 0) continue;

    // Add IV skew: OTM options have slightly higher IV (volatility smile)
    const moneyness = Math.abs(strike - spotPrice) / spotPrice;
    const skewedIV = iv * (1 + moneyness * 0.5);

    const cePrice = blackScholesCall(spotPrice, strike, tte, RISK_FREE_RATE, skewedIV);
    const pePrice = blackScholesPut(spotPrice, strike, tte, RISK_FREE_RATE, skewedIV);
    const ceGreeks = calculateGreeks(spotPrice, strike, tte, RISK_FREE_RATE, skewedIV, "CE");
    const peGreeks = calculateGreeks(spotPrice, strike, tte, RISK_FREE_RATE, skewedIV, "PE");

    // OI distribution: highest near ATM, decaying toward wings
    const oiFactor = Math.exp(-moneyness * moneyness * 50);
    const baseOI = 500000;

    strikes.set(strike, {
      ce: {
        price: Math.max(cePrice, 0.05), // minimum tick
        oi: Math.round(baseOI * oiFactor),
        volume: Math.round(100000 * oiFactor),
        iv: skewedIV,
        greeks: ceGreeks,
      },
      pe: {
        price: Math.max(pePrice, 0.05),
        oi: Math.round(baseOI * oiFactor),
        volume: Math.round(100000 * oiFactor),
        iv: skewedIV,
        greeks: peGreeks,
      },
    });
  }

  return { timestamp, spotPrice, strikes };
}

/**
 * Generate a full chain history from a spot price path.
 */
export function generateChainHistory(
  prices: number[],
  startDate: string,
  expiry: string,
  iv: number = 0.15,
  numStrikes: number = 10,
  strikeInterval: number = 50
): OptionsChainSnapshot[] {
  const history: OptionsChainSnapshot[] = [];
  const start = new Date(startDate + "T09:15:00Z");

  for (let i = 0; i < prices.length; i++) {
    const d = new Date(start.getTime());
    d.setUTCDate(d.getUTCDate() + i);
    const timestamp = d.toISOString().slice(0, 10) + "T15:30:00";

    history.push(
      generateChainSnapshot(
        prices[i],
        timestamp,
        expiry,
        iv,
        numStrikes,
        strikeInterval
      )
    );
  }

  return history;
}
