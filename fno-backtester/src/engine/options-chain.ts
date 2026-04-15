import type {
  Underlying,
  OptionsChainSnapshot,
  StrikeData,
  OptionQuote,
  Greeks,
} from "./types.js";
import { STRIKE_INTERVALS } from "./types.js";

/**
 * Get ATM strike — round spot price to nearest strike interval.
 */
export function getATMStrike(spotPrice: number, underlying: Underlying): number {
  const interval = STRIKE_INTERVALS[underlying];
  return Math.round(spotPrice / interval) * interval;
}

/**
 * Enumerate strikes around ATM — returns sorted array of strikes.
 */
export function enumerateStrikes(
  atm: number,
  numStrikes: number,
  underlying: Underlying
): number[] {
  const interval = STRIKE_INTERVALS[underlying];
  const strikes: number[] = [];
  for (let i = -numStrikes; i <= numStrikes; i++) {
    strikes.push(atm + i * interval);
  }
  return strikes;
}

/**
 * Build Upstox instrument key for an option contract.
 * Format: NSE_FO|NIFTY25MAR22000CE
 */
export function buildInstrumentKey(
  underlying: Underlying,
  expiry: string,
  strike: number,
  optionType: "CE" | "PE"
): string {
  const d = new Date(expiry + "T00:00:00");
  const yy = String(d.getUTCFullYear()).slice(-2);
  const months = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
  ];
  const mon = months[d.getUTCMonth()];
  return `NSE_FO|${underlying}${yy}${mon}${strike}${optionType}`;
}

/**
 * Calculate IV Percentile — what percentage of historical IVs are below the current IV.
 * Range: 0-100.
 */
export function calculateIVPercentile(
  ivHistory: number[],
  currentIV: number
): number {
  if (ivHistory.length === 0) return 50; // default to midpoint
  const below = ivHistory.filter((iv) => iv < currentIV).length;
  return (below / ivHistory.length) * 100;
}

/**
 * Calculate IV Rank — where current IV sits in the historical min-max range.
 * Formula: (currentIV - minIV) / (maxIV - minIV) * 100
 * Range: 0-100.
 */
export function calculateIVRank(
  ivHistory: number[],
  currentIV: number
): number {
  if (ivHistory.length === 0) return 50;
  const minIV = Math.min(...ivHistory);
  const maxIV = Math.max(...ivHistory);
  if (maxIV === minIV) return 50;
  return ((currentIV - minIV) / (maxIV - minIV)) * 100;
}

/**
 * Calculate Max Pain strike — the strike where total options value is minimized.
 * At max pain, option writers (sellers) lose the least.
 */
export function calculateMaxPain(chain: OptionsChainSnapshot): number {
  const strikes = Array.from(chain.strikes.keys()).sort((a, b) => a - b);
  if (strikes.length === 0) return chain.spotPrice;

  let minPain = Infinity;
  let maxPainStrike = strikes[0];

  for (const targetStrike of strikes) {
    let totalPain = 0;

    for (const [strike, data] of chain.strikes) {
      // Call pain: calls are ITM when spot > strike
      if (targetStrike > strike) {
        totalPain += (targetStrike - strike) * data.ce.oi;
      }
      // Put pain: puts are ITM when spot < strike
      if (targetStrike < strike) {
        totalPain += (strike - targetStrike) * data.pe.oi;
      }
    }

    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = targetStrike;
    }
  }

  return maxPainStrike;
}

/**
 * Calculate Put-Call Ratio from OI data.
 * PCR > 1.0 = more puts than calls (bullish contrarian signal).
 * PCR < 0.6 = more calls than puts (bearish contrarian signal).
 */
export function calculatePCR(chain: OptionsChainSnapshot): number {
  let totalPutOI = 0;
  let totalCallOI = 0;

  for (const [, data] of chain.strikes) {
    totalPutOI += data.pe.oi;
    totalCallOI += data.ce.oi;
  }

  if (totalCallOI === 0) return 0;
  return totalPutOI / totalCallOI;
}

/**
 * Get OI-based support and resistance levels.
 * Support = strike with highest put OI (put writers confident).
 * Resistance = strike with highest call OI (call writers confident).
 */
export function getOISupportResistance(chain: OptionsChainSnapshot): {
  support: number;
  resistance: number;
} {
  let maxPutOI = 0;
  let maxCallOI = 0;
  let support = chain.spotPrice;
  let resistance = chain.spotPrice;

  for (const [strike, data] of chain.strikes) {
    if (data.pe.oi > maxPutOI) {
      maxPutOI = data.pe.oi;
      support = strike;
    }
    if (data.ce.oi > maxCallOI) {
      maxCallOI = data.ce.oi;
      resistance = strike;
    }
  }

  return { support, resistance };
}

/**
 * Find the strike closest to a target delta value.
 */
export function findStrikeByDelta(
  chain: OptionsChainSnapshot,
  targetDelta: number,
  optionType: "CE" | "PE"
): number {
  let bestStrike = 0;
  let bestDiff = Infinity;

  for (const [strike, data] of chain.strikes) {
    const quote = optionType === "CE" ? data.ce : data.pe;
    const diff = Math.abs(quote.greeks.delta - targetDelta);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestStrike = strike;
    }
  }

  return bestStrike;
}

/**
 * Get the option quote for a specific strike and type.
 */
export function getQuote(
  chain: OptionsChainSnapshot,
  strike: number,
  optionType: "CE" | "PE"
): OptionQuote | undefined {
  const strikeData = chain.strikes.get(strike);
  if (!strikeData) return undefined;
  return optionType === "CE" ? strikeData.ce : strikeData.pe;
}

/**
 * Create empty Greeks (useful for initialization).
 */
export function emptyGreeks(): Greeks {
  return { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 };
}
