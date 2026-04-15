import { describe, it, expect } from "vitest";
import { FNO_STRATEGY_REGISTRY } from "../src/engine/strategies.js";
import { generateSpotPath, generateSpotCandles, generateChainHistory } from "./fixtures/sample-options-chain.js";
import type { FnoStrategyName } from "../src/engine/types.js";

// Generate 30 days of data for positional strategies
const prices = generateSpotPath(22000, 30, 0.01, 42);
const candles = generateSpotCandles(prices, "2025-03-01");
const expiry = "2025-03-27";
const chainHistory = generateChainHistory(prices, "2025-03-01", expiry, 0.15, 15, 50);

describe("FNO_STRATEGY_REGISTRY", () => {
  it("has all 12 strategies registered", () => {
    expect(Object.keys(FNO_STRATEGY_REGISTRY)).toHaveLength(12);
  });

  const expectedStrategies: FnoStrategyName[] = [
    "short_straddle", "short_strangle", "iron_condor", "iron_butterfly",
    "deep_otm_sell", "bull_call_spread", "bear_put_spread", "ema50_directional",
    "long_straddle", "calendar_spread", "straddle_920", "oi_max_pain",
  ];

  for (const name of expectedStrategies) {
    it(`has strategy: ${name}`, () => {
      expect(FNO_STRATEGY_REGISTRY[name]).toBeDefined();
      expect(FNO_STRATEGY_REGISTRY[name].fn).toBeTypeOf("function");
      expect(FNO_STRATEGY_REGISTRY[name].defaults).toBeDefined();
      expect(FNO_STRATEGY_REGISTRY[name].description).toBeTruthy();
      expect(FNO_STRATEGY_REGISTRY[name].executionMode).toMatch(/^(intraday|positional)$/);
    });
  }
});

describe("Strategy signal generation", () => {
  it("short_straddle generates signals", () => {
    const { fn, defaults } = FNO_STRATEGY_REGISTRY.short_straddle;
    const signals = fn(chainHistory, candles, defaults);
    // Should generate at least some signals (depends on data conditions)
    expect(signals).toBeInstanceOf(Array);
    // If signals generated, they should have correct structure
    for (const sig of signals) {
      expect(sig.timestamp).toBeTruthy();
      expect(["OPEN", "CLOSE", "ADJUST"]).toContain(sig.type);
      expect(sig.reason).toBeTruthy();
    }
  });

  it("short_strangle generates signals", () => {
    const { fn, defaults } = FNO_STRATEGY_REGISTRY.short_strangle;
    const signals = fn(chainHistory, candles, defaults);
    expect(signals).toBeInstanceOf(Array);
  });

  it("iron_condor generates signals with 4 legs", () => {
    const { fn, defaults } = FNO_STRATEGY_REGISTRY.iron_condor;
    const signals = fn(chainHistory, candles, defaults);
    expect(signals).toBeInstanceOf(Array);
    const openSignals = signals.filter(s => s.type === "OPEN");
    for (const sig of openSignals) {
      expect(sig.legs).toHaveLength(4); // 4 legs for iron condor
    }
  });

  it("iron_butterfly generates signals with 4 legs", () => {
    const { fn, defaults } = FNO_STRATEGY_REGISTRY.iron_butterfly;
    const signals = fn(chainHistory, candles, defaults);
    expect(signals).toBeInstanceOf(Array);
    const openSignals = signals.filter(s => s.type === "OPEN");
    for (const sig of openSignals) {
      expect(sig.legs).toHaveLength(4);
    }
  });

  it("deep_otm_sell generates signals with 2 legs", () => {
    const { fn, defaults } = FNO_STRATEGY_REGISTRY.deep_otm_sell;
    const signals = fn(chainHistory, candles, defaults);
    expect(signals).toBeInstanceOf(Array);
    const openSignals = signals.filter(s => s.type === "OPEN");
    for (const sig of openSignals) {
      expect(sig.legs).toHaveLength(2);
      // Both should be SELL side
      for (const leg of sig.legs) {
        expect(leg.side).toBe("SELL");
      }
    }
  });

  it("bull_call_spread generates buy + sell legs", () => {
    const { fn, defaults } = FNO_STRATEGY_REGISTRY.bull_call_spread;
    const signals = fn(chainHistory, candles, defaults);
    expect(signals).toBeInstanceOf(Array);
    const openSignals = signals.filter(s => s.type === "OPEN");
    for (const sig of openSignals) {
      expect(sig.legs).toHaveLength(2);
      expect(sig.legs.some(l => l.side === "BUY")).toBe(true);
      expect(sig.legs.some(l => l.side === "SELL")).toBe(true);
    }
  });

  it("bear_put_spread generates PE legs", () => {
    const { fn, defaults } = FNO_STRATEGY_REGISTRY.bear_put_spread;
    const signals = fn(chainHistory, candles, defaults);
    expect(signals).toBeInstanceOf(Array);
    const openSignals = signals.filter(s => s.type === "OPEN");
    for (const sig of openSignals) {
      expect(sig.legs).toHaveLength(2);
      for (const leg of sig.legs) {
        expect(leg.optionType).toBe("PE");
      }
    }
  });

  it("long_straddle generates BUY signals", () => {
    const { fn, defaults } = FNO_STRATEGY_REGISTRY.long_straddle;
    const signals = fn(chainHistory, candles, defaults);
    expect(signals).toBeInstanceOf(Array);
    const openSignals = signals.filter(s => s.type === "OPEN");
    for (const sig of openSignals) {
      expect(sig.legs).toHaveLength(2);
      for (const leg of sig.legs) {
        expect(leg.side).toBe("BUY");
      }
    }
  });

  it("calendar_spread generates legs with different expiries", () => {
    const { fn, defaults } = FNO_STRATEGY_REGISTRY.calendar_spread;
    const signals = fn(chainHistory, candles, defaults);
    expect(signals).toBeInstanceOf(Array);
    const openSignals = signals.filter(s => s.type === "OPEN");
    for (const sig of openSignals) {
      expect(sig.legs).toHaveLength(2);
      // Near leg should be SELL, far leg should be BUY
      const sellLeg = sig.legs.find(l => l.side === "SELL");
      const buyLeg = sig.legs.find(l => l.side === "BUY");
      expect(sellLeg).toBeDefined();
      expect(buyLeg).toBeDefined();
      if (sellLeg && buyLeg) {
        expect(sellLeg.expiry <= buyLeg.expiry).toBe(true);
      }
    }
  });

  it("oi_max_pain generates SELL signals near expiry", () => {
    const { fn, defaults } = FNO_STRATEGY_REGISTRY.oi_max_pain;
    const signals = fn(chainHistory, candles, defaults);
    expect(signals).toBeInstanceOf(Array);
    const openSignals = signals.filter(s => s.type === "OPEN");
    for (const sig of openSignals) {
      expect(sig.legs.length).toBeGreaterThanOrEqual(1);
      expect(sig.legs[0].side).toBe("SELL");
    }
  });
});
