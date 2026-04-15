import { describe, it, expect } from "vitest";
import {
  getATMStrike,
  enumerateStrikes,
  buildInstrumentKey,
  calculateIVPercentile,
  calculateIVRank,
  calculateMaxPain,
  calculatePCR,
  getOISupportResistance,
  findStrikeByDelta,
  getQuote,
} from "../src/engine/options-chain.js";
import type { OptionsChainSnapshot, StrikeData } from "../src/engine/types.js";

function makeChain(
  spotPrice: number,
  strikesData: Array<{
    strike: number;
    cePrice: number;
    pePrice: number;
    ceOI: number;
    peOI: number;
    ceDelta: number;
    peDelta: number;
  }>
): OptionsChainSnapshot {
  const strikes = new Map<number, StrikeData>();
  for (const s of strikesData) {
    strikes.set(s.strike, {
      ce: {
        price: s.cePrice,
        oi: s.ceOI,
        volume: 1000,
        iv: 0.15,
        greeks: { delta: s.ceDelta, gamma: 0.001, theta: -5, vega: 10, iv: 0.15 },
      },
      pe: {
        price: s.pePrice,
        oi: s.peOI,
        volume: 1000,
        iv: 0.15,
        greeks: { delta: s.peDelta, gamma: 0.001, theta: -5, vega: 10, iv: 0.15 },
      },
    });
  }
  return { timestamp: "2025-03-27T10:00:00", spotPrice, strikes };
}

describe("getATMStrike", () => {
  it("rounds to nearest 50 for NIFTY", () => {
    expect(getATMStrike(22123, "NIFTY")).toBe(22100);
    expect(getATMStrike(22150, "NIFTY")).toBe(22150);
    expect(getATMStrike(22175, "NIFTY")).toBe(22200);
  });

  it("rounds to nearest 100 for BANKNIFTY", () => {
    expect(getATMStrike(48050, "BANKNIFTY")).toBe(48100);
    expect(getATMStrike(47950, "BANKNIFTY")).toBe(48000);
    expect(getATMStrike(48000, "BANKNIFTY")).toBe(48000);
  });
});

describe("enumerateStrikes", () => {
  it("generates correct strikes for NIFTY", () => {
    const strikes = enumerateStrikes(22000, 3, "NIFTY");
    expect(strikes).toEqual([21850, 21900, 21950, 22000, 22050, 22100, 22150]);
  });

  it("generates correct strikes for BANKNIFTY", () => {
    const strikes = enumerateStrikes(48000, 2, "BANKNIFTY");
    expect(strikes).toEqual([47800, 47900, 48000, 48100, 48200]);
  });
});

describe("buildInstrumentKey", () => {
  it("builds correct key for NIFTY CE", () => {
    expect(buildInstrumentKey("NIFTY", "2025-03-27", 22000, "CE")).toBe(
      "NSE_FO|NIFTY25MAR22000CE"
    );
  });

  it("builds correct key for BANKNIFTY PE", () => {
    expect(buildInstrumentKey("BANKNIFTY", "2025-12-25", 48000, "PE")).toBe(
      "NSE_FO|BANKNIFTY25DEC48000PE"
    );
  });

  it("handles January correctly", () => {
    expect(buildInstrumentKey("NIFTY", "2026-01-29", 25000, "CE")).toBe(
      "NSE_FO|NIFTY26JAN25000CE"
    );
  });
});

describe("calculateIVPercentile", () => {
  it("returns 50 for empty history", () => {
    expect(calculateIVPercentile([], 0.15)).toBe(50);
  });

  it("returns 0 when current is lowest", () => {
    expect(calculateIVPercentile([0.20, 0.25, 0.30], 0.10)).toBe(0);
  });

  it("returns 100 when current is highest", () => {
    expect(calculateIVPercentile([0.10, 0.15, 0.20], 0.30)).toBe(100);
  });

  it("returns ~50 for median value", () => {
    const history = [0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.22, 0.24, 0.26, 0.28];
    const pct = calculateIVPercentile(history, 0.19);
    expect(pct).toBeGreaterThan(40);
    expect(pct).toBeLessThan(60);
  });
});

describe("calculateIVRank", () => {
  it("returns 50 for empty history", () => {
    expect(calculateIVRank([], 0.15)).toBe(50);
  });

  it("returns 0 when current equals min", () => {
    expect(calculateIVRank([0.10, 0.20, 0.30], 0.10)).toBe(0);
  });

  it("returns 100 when current equals max", () => {
    expect(calculateIVRank([0.10, 0.20, 0.30], 0.30)).toBe(100);
  });

  it("returns 50 for midpoint", () => {
    expect(calculateIVRank([0.10, 0.30], 0.20)).toBeCloseTo(50, 5);
  });
});

describe("calculateMaxPain", () => {
  it("finds the strike that minimizes total pain", () => {
    const chain = makeChain(22000, [
      { strike: 21800, cePrice: 250, pePrice: 10, ceOI: 50000, peOI: 200000, ceDelta: 0.8, peDelta: -0.05 },
      { strike: 21900, cePrice: 170, pePrice: 20, ceOI: 80000, peOI: 150000, ceDelta: 0.7, peDelta: -0.1 },
      { strike: 22000, cePrice: 100, pePrice: 80, ceOI: 300000, peOI: 300000, ceDelta: 0.5, peDelta: -0.5 },
      { strike: 22100, cePrice: 50, pePrice: 160, ceOI: 200000, peOI: 80000, ceDelta: 0.2, peDelta: -0.7 },
      { strike: 22200, cePrice: 15, pePrice: 250, ceOI: 150000, peOI: 50000, ceDelta: 0.05, peDelta: -0.8 },
    ]);

    const maxPain = calculateMaxPain(chain);
    // Max pain should be near ATM where writers lose least
    expect(maxPain).toBeGreaterThanOrEqual(21800);
    expect(maxPain).toBeLessThanOrEqual(22200);
  });
});

describe("calculatePCR", () => {
  it("returns > 1 when more puts than calls", () => {
    const chain = makeChain(22000, [
      { strike: 22000, cePrice: 100, pePrice: 100, ceOI: 100000, peOI: 200000, ceDelta: 0.5, peDelta: -0.5 },
    ]);
    expect(calculatePCR(chain)).toBe(2);
  });

  it("returns < 1 when more calls than puts", () => {
    const chain = makeChain(22000, [
      { strike: 22000, cePrice: 100, pePrice: 100, ceOI: 200000, peOI: 100000, ceDelta: 0.5, peDelta: -0.5 },
    ]);
    expect(calculatePCR(chain)).toBe(0.5);
  });

  it("returns 0 when no call OI", () => {
    const chain = makeChain(22000, [
      { strike: 22000, cePrice: 100, pePrice: 100, ceOI: 0, peOI: 100000, ceDelta: 0.5, peDelta: -0.5 },
    ]);
    expect(calculatePCR(chain)).toBe(0);
  });
});

describe("getOISupportResistance", () => {
  it("finds correct support and resistance levels", () => {
    const chain = makeChain(22000, [
      { strike: 21800, cePrice: 250, pePrice: 10, ceOI: 50000, peOI: 500000, ceDelta: 0.8, peDelta: -0.05 },
      { strike: 22000, cePrice: 100, pePrice: 80, ceOI: 100000, peOI: 100000, ceDelta: 0.5, peDelta: -0.5 },
      { strike: 22200, cePrice: 15, pePrice: 250, ceOI: 400000, peOI: 50000, ceDelta: 0.05, peDelta: -0.8 },
    ]);

    const { support, resistance } = getOISupportResistance(chain);
    expect(support).toBe(21800); // highest put OI
    expect(resistance).toBe(22200); // highest call OI
  });
});

describe("findStrikeByDelta", () => {
  it("finds the strike closest to target delta for CE", () => {
    const chain = makeChain(22000, [
      { strike: 21800, cePrice: 250, pePrice: 10, ceOI: 50000, peOI: 50000, ceDelta: 0.8, peDelta: -0.2 },
      { strike: 22000, cePrice: 100, pePrice: 80, ceOI: 100000, peOI: 100000, ceDelta: 0.5, peDelta: -0.5 },
      { strike: 22200, cePrice: 15, pePrice: 250, ceOI: 50000, peOI: 50000, ceDelta: 0.2, peDelta: -0.8 },
    ]);

    expect(findStrikeByDelta(chain, 0.2, "CE")).toBe(22200);
    expect(findStrikeByDelta(chain, 0.5, "CE")).toBe(22000);
  });

  it("finds the strike closest to target delta for PE", () => {
    const chain = makeChain(22000, [
      { strike: 21800, cePrice: 250, pePrice: 10, ceOI: 50000, peOI: 50000, ceDelta: 0.8, peDelta: -0.2 },
      { strike: 22000, cePrice: 100, pePrice: 80, ceOI: 100000, peOI: 100000, ceDelta: 0.5, peDelta: -0.5 },
      { strike: 22200, cePrice: 15, pePrice: 250, ceOI: 50000, peOI: 50000, ceDelta: 0.2, peDelta: -0.8 },
    ]);

    expect(findStrikeByDelta(chain, -0.2, "PE")).toBe(21800);
    expect(findStrikeByDelta(chain, -0.5, "PE")).toBe(22000);
  });
});

describe("getQuote", () => {
  it("returns CE quote for existing strike", () => {
    const chain = makeChain(22000, [
      { strike: 22000, cePrice: 100, pePrice: 80, ceOI: 100000, peOI: 100000, ceDelta: 0.5, peDelta: -0.5 },
    ]);

    const quote = getQuote(chain, 22000, "CE");
    expect(quote).toBeDefined();
    expect(quote!.price).toBe(100);
  });

  it("returns undefined for non-existing strike", () => {
    const chain = makeChain(22000, [
      { strike: 22000, cePrice: 100, pePrice: 80, ceOI: 100000, peOI: 100000, ceDelta: 0.5, peDelta: -0.5 },
    ]);

    expect(getQuote(chain, 21000, "CE")).toBeUndefined();
  });
});
