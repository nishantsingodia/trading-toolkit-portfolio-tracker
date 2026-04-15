import type { Greeks, OptionType } from "./types.js";
import { RISK_FREE_RATE } from "./types.js";

/**
 * Standard normal CDF — Abramowitz & Stegun approximation (7+ decimal accuracy).
 */
export function normalCDF(x: number): number {
  // Hart approximation — accurate to ~7.5 x 10^-8
  if (x < -8) return 0;
  if (x > 8) return 1;

  const a1 = 0.319381530;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  const k = 1.0 / (1.0 + 0.2316419 * Math.abs(x));
  const cnd =
    (1.0 / Math.sqrt(2 * Math.PI)) *
    Math.exp(-0.5 * x * x) *
    (a1 * k + a2 * k * k + a3 * k ** 3 + a4 * k ** 4 + a5 * k ** 5);

  return x >= 0 ? 1 - cnd : cnd;
}

/**
 * Standard normal PDF.
 */
export function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * d1 and d2 terms used by Black-Scholes.
 */
function d1d2(
  spot: number,
  strike: number,
  tte: number,
  rf: number,
  iv: number
): { d1: number; d2: number } {
  const sqrtT = Math.sqrt(tte);
  const d1 =
    (Math.log(spot / strike) + (rf + (iv * iv) / 2) * tte) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  return { d1, d2 };
}

/**
 * Black-Scholes European call price.
 */
export function blackScholesCall(
  spot: number,
  strike: number,
  tte: number,
  rf: number,
  iv: number
): number {
  if (tte <= 0) return Math.max(spot - strike, 0); // intrinsic
  if (iv <= 0) return Math.max(spot - strike * Math.exp(-rf * tte), 0);

  const { d1, d2 } = d1d2(spot, strike, tte, rf, iv);
  return spot * normalCDF(d1) - strike * Math.exp(-rf * tte) * normalCDF(d2);
}

/**
 * Black-Scholes European put price.
 */
export function blackScholesPut(
  spot: number,
  strike: number,
  tte: number,
  rf: number,
  iv: number
): number {
  if (tte <= 0) return Math.max(strike - spot, 0); // intrinsic
  if (iv <= 0) return Math.max(strike * Math.exp(-rf * tte) - spot, 0);

  const { d1, d2 } = d1d2(spot, strike, tte, rf, iv);
  return strike * Math.exp(-rf * tte) * normalCDF(-d2) - spot * normalCDF(-d1);
}

/**
 * Compute option price based on type.
 */
export function blackScholesPrice(
  spot: number,
  strike: number,
  tte: number,
  rf: number,
  iv: number,
  optionType: OptionType
): number {
  return optionType === "CE"
    ? blackScholesCall(spot, strike, tte, rf, iv)
    : blackScholesPut(spot, strike, tte, rf, iv);
}

/**
 * Calculate all Greeks for an option.
 */
export function calculateGreeks(
  spot: number,
  strike: number,
  tte: number,
  rf: number,
  iv: number,
  optionType: OptionType
): Greeks {
  if (tte <= 0 || iv <= 0) {
    // At expiry or zero vol — intrinsic value greeks
    const itm =
      optionType === "CE" ? spot > strike : spot < strike;
    return {
      delta: itm ? (optionType === "CE" ? 1 : -1) : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      iv,
    };
  }

  const sqrtT = Math.sqrt(tte);
  const { d1, d2 } = d1d2(spot, strike, tte, rf, iv);
  const nd1 = normalPDF(d1);
  const discountFactor = Math.exp(-rf * tte);

  // Delta
  let delta: number;
  if (optionType === "CE") {
    delta = normalCDF(d1);
  } else {
    delta = normalCDF(d1) - 1;
  }

  // Gamma (same for call and put)
  const gamma = nd1 / (spot * iv * sqrtT);

  // Theta (per calendar day, not per trading day)
  let theta: number;
  const commonTheta = -(spot * nd1 * iv) / (2 * sqrtT);
  if (optionType === "CE") {
    theta =
      commonTheta - rf * strike * discountFactor * normalCDF(d2);
  } else {
    theta =
      commonTheta + rf * strike * discountFactor * normalCDF(-d2);
  }
  theta = theta / 365; // per calendar day

  // Vega (for 1% IV change)
  const vega = (spot * sqrtT * nd1) / 100;

  return { delta, gamma, theta, vega, iv };
}

/**
 * Implied Volatility solver using Newton-Raphson.
 * Returns IV as a decimal (e.g., 0.15 for 15%).
 */
export function impliedVolatility(
  marketPrice: number,
  spot: number,
  strike: number,
  tte: number,
  rf: number,
  optionType: OptionType,
  maxIterations: number = 100,
  tolerance: number = 1e-6
): number {
  if (tte <= 0) return 0;
  if (marketPrice <= 0) return 0;

  // Initial guess based on ATM approximation
  let iv = Math.sqrt((2 * Math.PI) / tte) * (marketPrice / spot);
  iv = Math.max(0.01, Math.min(5.0, iv));

  for (let i = 0; i < maxIterations; i++) {
    const price = blackScholesPrice(spot, strike, tte, rf, iv, optionType);
    const diff = price - marketPrice;

    if (Math.abs(diff) < tolerance) return iv;

    // Vega as derivative (not scaled by /100)
    const sqrtT = Math.sqrt(tte);
    const { d1 } = d1d2(spot, strike, tte, rf, iv);
    const vega = spot * sqrtT * normalPDF(d1);

    if (vega < 1e-10) break; // avoid division by zero

    iv = iv - diff / vega;
    iv = Math.max(0.01, Math.min(5.0, iv)); // clamp
  }

  return iv;
}

/**
 * Aggregate Greeks across multiple legs.
 * BUY legs add to portfolio Greeks, SELL legs subtract.
 */
export function aggregateGreeks(
  legs: Array<{
    greeks: Greeks;
    side: "BUY" | "SELL";
    lots: number;
    lotSize: number;
  }>
): Greeks {
  let delta = 0;
  let gamma = 0;
  let theta = 0;
  let vega = 0;
  let totalIv = 0;
  let count = 0;

  for (const leg of legs) {
    const multiplier =
      (leg.side === "BUY" ? 1 : -1) * leg.lots * leg.lotSize;
    delta += leg.greeks.delta * multiplier;
    gamma += leg.greeks.gamma * multiplier;
    theta += leg.greeks.theta * multiplier;
    vega += leg.greeks.vega * multiplier;
    totalIv += leg.greeks.iv;
    count++;
  }

  return {
    delta,
    gamma,
    theta,
    vega,
    iv: count > 0 ? totalIv / count : 0, // average IV across legs
  };
}
