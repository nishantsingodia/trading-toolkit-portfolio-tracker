import { describe, it, expect } from "vitest";
import {
  normalCDF,
  normalPDF,
  blackScholesCall,
  blackScholesPut,
  blackScholesPrice,
  calculateGreeks,
  impliedVolatility,
  aggregateGreeks,
} from "../src/engine/pricing.js";

describe("normalCDF", () => {
  it("returns 0.5 for x = 0", () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 6);
  });

  it("returns ~0.8413 for x = 1", () => {
    expect(normalCDF(1)).toBeCloseTo(0.8413, 3);
  });

  it("returns ~0.1587 for x = -1", () => {
    expect(normalCDF(-1)).toBeCloseTo(0.1587, 3);
  });

  it("returns near 1 for large positive x", () => {
    expect(normalCDF(5)).toBeGreaterThan(0.999);
  });

  it("returns near 0 for large negative x", () => {
    expect(normalCDF(-5)).toBeLessThan(0.001);
  });
});

describe("normalPDF", () => {
  it("returns ~0.3989 for x = 0", () => {
    expect(normalPDF(0)).toBeCloseTo(0.3989, 3);
  });

  it("is symmetric", () => {
    expect(normalPDF(1)).toBeCloseTo(normalPDF(-1), 10);
  });
});

describe("blackScholesCall", () => {
  // Reference: Nifty at 22000, strike 22000, 30 DTE, IV 15%, rf 6.5%
  it("prices an ATM call correctly", () => {
    const price = blackScholesCall(22000, 22000, 30 / 365, 0.065, 0.15);
    // ATM call with these params
    expect(price).toBeGreaterThan(150);
    expect(price).toBeLessThan(600);
  });

  it("returns intrinsic value at expiry", () => {
    expect(blackScholesCall(22100, 22000, 0, 0.065, 0.15)).toBeCloseTo(100, 1);
    expect(blackScholesCall(21900, 22000, 0, 0.065, 0.15)).toBeCloseTo(0, 1);
  });

  it("increases with higher IV", () => {
    const low = blackScholesCall(22000, 22000, 30 / 365, 0.065, 0.10);
    const high = blackScholesCall(22000, 22000, 30 / 365, 0.065, 0.25);
    expect(high).toBeGreaterThan(low);
  });

  it("increases with more time", () => {
    const short = blackScholesCall(22000, 22000, 7 / 365, 0.065, 0.15);
    const long = blackScholesCall(22000, 22000, 30 / 365, 0.065, 0.15);
    expect(long).toBeGreaterThan(short);
  });

  it("ITM call is more expensive than OTM call", () => {
    const itm = blackScholesCall(22000, 21500, 30 / 365, 0.065, 0.15);
    const otm = blackScholesCall(22000, 22500, 30 / 365, 0.065, 0.15);
    expect(itm).toBeGreaterThan(otm);
  });
});

describe("blackScholesPut", () => {
  it("prices an ATM put correctly", () => {
    const price = blackScholesPut(22000, 22000, 30 / 365, 0.065, 0.15);
    expect(price).toBeGreaterThan(100);
    expect(price).toBeLessThan(500);
  });

  it("returns intrinsic value at expiry", () => {
    expect(blackScholesPut(21900, 22000, 0, 0.065, 0.15)).toBeCloseTo(100, 1);
    expect(blackScholesPut(22100, 22000, 0, 0.065, 0.15)).toBeCloseTo(0, 1);
  });

  it("put-call parity holds", () => {
    const spot = 22000;
    const strike = 22000;
    const tte = 30 / 365;
    const rf = 0.065;
    const iv = 0.15;
    const call = blackScholesCall(spot, strike, tte, rf, iv);
    const put = blackScholesPut(spot, strike, tte, rf, iv);
    // C - P = S - K * exp(-rT)
    const parity = call - put;
    const expected = spot - strike * Math.exp(-rf * tte);
    expect(parity).toBeCloseTo(expected, 1);
  });
});

describe("blackScholesPrice", () => {
  it("routes to call for CE", () => {
    const direct = blackScholesCall(22000, 22000, 30 / 365, 0.065, 0.15);
    const routed = blackScholesPrice(22000, 22000, 30 / 365, 0.065, 0.15, "CE");
    expect(routed).toBeCloseTo(direct, 10);
  });

  it("routes to put for PE", () => {
    const direct = blackScholesPut(22000, 22000, 30 / 365, 0.065, 0.15);
    const routed = blackScholesPrice(22000, 22000, 30 / 365, 0.065, 0.15, "PE");
    expect(routed).toBeCloseTo(direct, 10);
  });
});

describe("calculateGreeks", () => {
  const spot = 22000;
  const strike = 22000;
  const tte = 30 / 365;
  const rf = 0.065;
  const iv = 0.15;

  it("ATM call delta is ~0.5", () => {
    const g = calculateGreeks(spot, strike, tte, rf, iv, "CE");
    expect(g.delta).toBeGreaterThan(0.45);
    expect(g.delta).toBeLessThan(0.60);
  });

  it("ATM put delta is ~-0.5", () => {
    const g = calculateGreeks(spot, strike, tte, rf, iv, "PE");
    expect(g.delta).toBeGreaterThan(-0.60);
    expect(g.delta).toBeLessThan(-0.40);
  });

  it("gamma is positive for both calls and puts", () => {
    const gc = calculateGreeks(spot, strike, tte, rf, iv, "CE");
    const gp = calculateGreeks(spot, strike, tte, rf, iv, "PE");
    expect(gc.gamma).toBeGreaterThan(0);
    expect(gp.gamma).toBeGreaterThan(0);
  });

  it("gamma is same for call and put at same strike", () => {
    const gc = calculateGreeks(spot, strike, tte, rf, iv, "CE");
    const gp = calculateGreeks(spot, strike, tte, rf, iv, "PE");
    expect(gc.gamma).toBeCloseTo(gp.gamma, 8);
  });

  it("theta is negative (time decay)", () => {
    const gc = calculateGreeks(spot, strike, tte, rf, iv, "CE");
    const gp = calculateGreeks(spot, strike, tte, rf, iv, "PE");
    expect(gc.theta).toBeLessThan(0);
    expect(gp.theta).toBeLessThan(0);
  });

  it("vega is positive for both calls and puts", () => {
    const gc = calculateGreeks(spot, strike, tte, rf, iv, "CE");
    const gp = calculateGreeks(spot, strike, tte, rf, iv, "PE");
    expect(gc.vega).toBeGreaterThan(0);
    expect(gp.vega).toBeGreaterThan(0);
  });

  it("deep ITM call has delta near 1", () => {
    const g = calculateGreeks(25000, 20000, tte, rf, iv, "CE");
    expect(g.delta).toBeGreaterThan(0.95);
  });

  it("deep OTM call has delta near 0", () => {
    const g = calculateGreeks(20000, 25000, tte, rf, iv, "CE");
    expect(g.delta).toBeLessThan(0.05);
  });

  it("returns intrinsic greeks at expiry", () => {
    const g = calculateGreeks(22100, 22000, 0, rf, iv, "CE");
    expect(g.delta).toBe(1);
    expect(g.gamma).toBe(0);
    expect(g.theta).toBe(0);
  });
});

describe("impliedVolatility", () => {
  it("round-trips: price -> IV -> price", () => {
    const spot = 22000;
    const strike = 22000;
    const tte = 30 / 365;
    const rf = 0.065;
    const origIV = 0.15;

    const price = blackScholesCall(spot, strike, tte, rf, origIV);
    const recoveredIV = impliedVolatility(price, spot, strike, tte, rf, "CE");
    expect(recoveredIV).toBeCloseTo(origIV, 3);
  });

  it("round-trips for put", () => {
    const spot = 22000;
    const strike = 22500;
    const tte = 15 / 365;
    const rf = 0.065;
    const origIV = 0.20;

    const price = blackScholesPut(spot, strike, tte, rf, origIV);
    const recoveredIV = impliedVolatility(price, spot, strike, tte, rf, "PE");
    expect(recoveredIV).toBeCloseTo(origIV, 3);
  });

  it("round-trips for OTM option", () => {
    const spot = 22000;
    const strike = 22500;
    const tte = 30 / 365;
    const rf = 0.065;
    const origIV = 0.18;

    const price = blackScholesCall(spot, strike, tte, rf, origIV);
    const recoveredIV = impliedVolatility(price, spot, strike, tte, rf, "CE");
    expect(recoveredIV).toBeCloseTo(origIV, 2);
  });

  it("returns 0 for expired option", () => {
    expect(impliedVolatility(100, 22000, 22000, 0, 0.065, "CE")).toBe(0);
  });

  it("returns 0 for zero price", () => {
    expect(impliedVolatility(0, 22000, 22000, 30 / 365, 0.065, "CE")).toBe(0);
  });
});

describe("aggregateGreeks", () => {
  it("sums greeks for bought legs and subtracts for sold", () => {
    const legs = [
      {
        greeks: { delta: 0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.15 },
        side: "BUY" as const,
        lots: 1,
        lotSize: 75,
      },
      {
        greeks: { delta: 0.3, gamma: 0.008, theta: -4, vega: 8, iv: 0.16 },
        side: "SELL" as const,
        lots: 1,
        lotSize: 75,
      },
    ];

    const agg = aggregateGreeks(legs);
    expect(agg.delta).toBeCloseTo(0.5 * 75 - 0.3 * 75, 5);
    expect(agg.gamma).toBeCloseTo(0.01 * 75 - 0.008 * 75, 5);
    expect(agg.theta).toBeCloseTo(-5 * 75 - (-4 * 75), 5); // buy adds, sell subtracts
    expect(agg.vega).toBeCloseTo(10 * 75 - 8 * 75, 5);
    expect(agg.iv).toBeCloseTo((0.15 + 0.16) / 2, 5); // average IV
  });

  it("handles empty legs", () => {
    const agg = aggregateGreeks([]);
    expect(agg.delta).toBe(0);
    expect(agg.iv).toBe(0);
  });

  it("short straddle has near-zero delta", () => {
    const legs = [
      {
        greeks: { delta: 0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.15 },
        side: "SELL" as const,
        lots: 1,
        lotSize: 75,
      },
      {
        greeks: { delta: -0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.15 },
        side: "SELL" as const,
        lots: 1,
        lotSize: 75,
      },
    ];

    const agg = aggregateGreeks(legs);
    // -0.5*75 + 0.5*75 = 0
    expect(agg.delta).toBeCloseTo(0, 5);
    // Both sold: theta is positive for the position
    expect(agg.theta).toBeGreaterThan(0);
  });
});
