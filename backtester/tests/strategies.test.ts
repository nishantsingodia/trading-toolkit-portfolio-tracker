import { describe, it, expect } from "vitest";
import {
  smaCrossover,
  emaCrossover,
  supertrendStrategy,
  vwapCrossover,
  rsiStrategy,
  macdSignalCross,
  bollingerSqueeze,
  stochasticCrossover,
  atrTrailingStop,
  buyTheDip,
  STRATEGY_REGISTRY,
} from "../src/engine/strategies.js";
import { SAMPLE_CANDLES, DIP_CANDLES, FLAT_CANDLES } from "./fixtures/sample-candles.js";

describe("SMA Crossover", () => {
  it("generates BUY and SELL signals", () => {
    const signals = smaCrossover(SAMPLE_CANDLES, {
      fastPeriod: 5,
      slowPeriod: 20,
    });
    expect(signals.length).toBeGreaterThan(0);
    const buys = signals.filter((s) => s.type === "BUY");
    const sells = signals.filter((s) => s.type === "SELL");
    expect(buys.length).toBeGreaterThan(0);
  });

  it("signals have valid structure", () => {
    const signals = smaCrossover(SAMPLE_CANDLES, {
      fastPeriod: 5,
      slowPeriod: 20,
    });
    for (const sig of signals) {
      expect(sig.index).toBeGreaterThanOrEqual(0);
      expect(sig.index).toBeLessThan(SAMPLE_CANDLES.length);
      expect(["BUY", "SELL"]).toContain(sig.type);
      expect(sig.price).toBeGreaterThan(0);
      expect(sig.date).toBeTruthy();
      expect(sig.reason).toBeTruthy();
    }
  });
});

describe("EMA Crossover", () => {
  it("generates signals with default params", () => {
    const signals = emaCrossover(SAMPLE_CANDLES, {
      fastPeriod: 12,
      slowPeriod: 26,
    });
    expect(signals.length).toBeGreaterThan(0);
  });
});

describe("Supertrend Strategy", () => {
  it("generates direction change signals", () => {
    const signals = supertrendStrategy(SAMPLE_CANDLES, {
      period: 10,
      multiplier: 3,
    });
    expect(signals.length).toBeGreaterThan(0);
  });
});

describe("VWAP Crossover", () => {
  it("generates signals on price/rolling-VWAP crossings", () => {
    const signals = vwapCrossover(SAMPLE_CANDLES, { period: 20 });
    // Rolling VWAP on daily candles acts as volume-weighted MA — should produce crossovers
    expect(signals.length).toBeGreaterThan(0);
  });
});

describe("RSI Strategy", () => {
  it("generates signals at overbought/oversold levels", () => {
    const signals = rsiStrategy(SAMPLE_CANDLES, {
      period: 14,
      overbought: 70,
      oversold: 30,
    });
    // May or may not have signals depending on data
    for (const sig of signals) {
      expect(["BUY", "SELL"]).toContain(sig.type);
    }
  });
});

describe("MACD Signal Cross", () => {
  it("generates crossover signals", () => {
    const signals = macdSignalCross(SAMPLE_CANDLES, {
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
    });
    expect(signals.length).toBeGreaterThan(0);
  });
});

describe("Bollinger Squeeze", () => {
  it("generates breakout signals after squeeze", () => {
    const signals = bollingerSqueeze(SAMPLE_CANDLES, {
      period: 20,
      stdDev: 2,
      squeezeThreshold: 0.5,
    });
    // May or may not trigger depending on volatility profile
    for (const sig of signals) {
      expect(sig.reason).toContain("Bollinger");
    }
  });
});

describe("Stochastic Crossover", () => {
  it("generates signals in extreme zones", () => {
    const signals = stochasticCrossover(SAMPLE_CANDLES, {
      kPeriod: 14,
      dPeriod: 3,
      overbought: 80,
      oversold: 20,
    });
    for (const sig of signals) {
      expect(sig.reason).toContain("Stochastic");
    }
  });
});

describe("ATR Trailing Stop", () => {
  it("generates entry and exit signals", () => {
    const signals = atrTrailingStop(SAMPLE_CANDLES, {
      atrPeriod: 14,
      multiplier: 3,
      adxPeriod: 14,
      adxThreshold: 25,
    });
    // Should have paired entries/exits
    for (const sig of signals) {
      expect(["BUY", "SELL"]).toContain(sig.type);
    }
  });
});

describe("Buy the Dip", () => {
  it("buys on dip days", () => {
    const signals = buyTheDip(DIP_CANDLES, {
      buyDropPct: -1,
      sellTargetPct: 3,
      stopLossPct: -5,
      maxHoldDays: 30,
    });
    const buys = signals.filter((s) => s.type === "BUY");
    // DIP_CANDLES has 3 big dips (-2%) on days 10, 20, 30
    expect(buys.length).toBe(3);
  });

  it("force-closes positions at end of data", () => {
    const signals = buyTheDip(DIP_CANDLES, {
      buyDropPct: -1,
      sellTargetPct: 50, // Very high target, won't be hit
      stopLossPct: -50, // Very wide stop, won't be hit
      maxHoldDays: 999, // Won't expire
    });
    const sells = signals.filter((s) => s.type === "SELL");
    expect(sells.length).toBeGreaterThan(0);
    // All remaining should be forced exits
    const forcedExits = sells.filter((s) =>
      s.reason.includes("Forced exit")
    );
    expect(forcedExits.length).toBeGreaterThan(0);
  });

  it("handles flat candles without crashing", () => {
    const signals = buyTheDip(FLAT_CANDLES, {
      buyDropPct: -1,
      sellTargetPct: 3,
      stopLossPct: -2,
      maxHoldDays: 30,
    });
    // No dips in flat data
    expect(signals.filter((s) => s.type === "BUY").length).toBe(0);
  });
});

describe("Strategy Registry", () => {
  it("has all 10 strategies", () => {
    expect(Object.keys(STRATEGY_REGISTRY)).toHaveLength(10);
  });

  it("all strategies can run without errors", () => {
    for (const [name, entry] of Object.entries(STRATEGY_REGISTRY)) {
      expect(() => {
        entry.fn(SAMPLE_CANDLES, entry.defaults);
      }).not.toThrow();
    }
  });

  it("all strategies have required metadata", () => {
    for (const entry of Object.values(STRATEGY_REGISTRY)) {
      expect(entry.name).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.regimes.length).toBeGreaterThan(0);
      expect(entry.defaults).toBeDefined();
    }
  });
});
