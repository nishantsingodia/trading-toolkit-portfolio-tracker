import { describe, it, expect } from "vitest";
import {
  checkPortfolioGreeksLimits,
  checkPositionStopLoss,
  checkDailyLossLimit,
  checkMaxPositions,
  calculateSimplifiedMargin,
  shouldForceClose,
} from "../src/engine/risk-manager.js";
import type { FnoPosition, FnoBacktestConfig } from "../src/engine/types.js";
import { DEFAULT_FNO_CONFIG } from "../src/engine/types.js";

function makePosition(overrides: Partial<FnoPosition> = {}): FnoPosition {
  return {
    id: "test_pos",
    strategyName: "short_straddle",
    legs: [],
    entryDate: "2025-03-20T09:20:00",
    entrySpot: 22000,
    dte: 7,
    netPremium: 10000,
    marginRequired: 200000,
    currentPnl: 0,
    peakPnl: 5000,
    troughPnl: -3000,
    aggregateGreeks: { delta: 0.1, gamma: 0.01, theta: -50, vega: 20, iv: 0.15 },
    status: "OPEN",
    ...overrides,
  };
}

describe("checkPortfolioGreeksLimits", () => {
  const limits = { maxAbsDelta: 500, maxGamma: 50, maxVega: 500 };

  it("returns null when within limits", () => {
    const pos = makePosition({ aggregateGreeks: { delta: 100, gamma: 10, theta: -50, vega: 200, iv: 0.15 } });
    expect(checkPortfolioGreeksLimits([pos], limits)).toBeNull();
  });

  it("detects delta breach", () => {
    const pos = makePosition({ aggregateGreeks: { delta: 600, gamma: 10, theta: -50, vega: 200, iv: 0.15 } });
    const breach = checkPortfolioGreeksLimits([pos], limits);
    expect(breach).not.toBeNull();
    expect(breach!.type).toBe("delta");
  });

  it("detects gamma breach", () => {
    const pos = makePosition({ aggregateGreeks: { delta: 100, gamma: 60, theta: -50, vega: 200, iv: 0.15 } });
    const breach = checkPortfolioGreeksLimits([pos], limits);
    expect(breach).not.toBeNull();
    expect(breach!.type).toBe("gamma");
  });

  it("detects vega breach", () => {
    const pos = makePosition({ aggregateGreeks: { delta: 100, gamma: 10, theta: -50, vega: 600, iv: 0.15 } });
    const breach = checkPortfolioGreeksLimits([pos], limits);
    expect(breach).not.toBeNull();
    expect(breach!.type).toBe("vega");
  });

  it("ignores closed positions", () => {
    const pos = makePosition({
      status: "CLOSED",
      aggregateGreeks: { delta: 10000, gamma: 10000, theta: -50, vega: 10000, iv: 0.15 },
    });
    expect(checkPortfolioGreeksLimits([pos], limits)).toBeNull();
  });

  it("aggregates across multiple positions", () => {
    const pos1 = makePosition({ aggregateGreeks: { delta: 300, gamma: 10, theta: -50, vega: 200, iv: 0.15 } });
    const pos2 = makePosition({ aggregateGreeks: { delta: 300, gamma: 10, theta: -50, vega: 200, iv: 0.15 } });
    // Total delta = 600 > limit 500
    const breach = checkPortfolioGreeksLimits([pos1, pos2], limits);
    expect(breach).not.toBeNull();
    expect(breach!.type).toBe("delta");
  });
});

describe("checkPositionStopLoss", () => {
  it("returns false when position is profitable", () => {
    const pos = makePosition({ currentPnl: 5000 });
    expect(checkPositionStopLoss(pos, 15000)).toBe(false);
  });

  it("returns false when loss is within limit", () => {
    const pos = makePosition({ currentPnl: -10000 });
    expect(checkPositionStopLoss(pos, 15000)).toBe(false);
  });

  it("returns true when loss exceeds limit", () => {
    const pos = makePosition({ currentPnl: -20000 });
    expect(checkPositionStopLoss(pos, 15000)).toBe(true);
  });
});

describe("checkDailyLossLimit", () => {
  it("returns false when within limit", () => {
    expect(checkDailyLossLimit(-10000, 30000)).toBe(false);
  });

  it("returns true when exceeded", () => {
    expect(checkDailyLossLimit(-35000, 30000)).toBe(true);
  });

  it("returns false when positive", () => {
    expect(checkDailyLossLimit(5000, 30000)).toBe(false);
  });
});

describe("checkMaxPositions", () => {
  it("returns false when under limit", () => {
    expect(checkMaxPositions(2, 3)).toBe(false);
  });

  it("returns true when at limit", () => {
    expect(checkMaxPositions(3, 3)).toBe(true);
  });

  it("returns true when over limit", () => {
    expect(checkMaxPositions(4, 3)).toBe(true);
  });
});

describe("calculateSimplifiedMargin", () => {
  it("calculates naked short margin as ~15% of spot * lots * lotSize", () => {
    const pos = makePosition({
      legs: [
        {
          instrumentKey: "test",
          underlying: "NIFTY",
          strike: 22000,
          optionType: "CE",
          expiry: "2025-03-27",
          side: "SELL",
          lots: 1,
          lotSize: 75,
          entryPrice: 100,
          currentPrice: 100,
          greeks: { delta: 0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.15 },
        },
      ],
    });
    const margin = calculateSimplifiedMargin(pos, 22000);
    // 22000 * 75 * 1 * 0.15 = 247,500
    expect(margin).toBeCloseTo(247500, 0);
  });

  it("calculates spread margin as max loss", () => {
    const pos = makePosition({
      legs: [
        {
          instrumentKey: "test",
          underlying: "NIFTY",
          strike: 22000,
          optionType: "CE",
          expiry: "2025-03-27",
          side: "SELL",
          lots: 1,
          lotSize: 75,
          entryPrice: 100,
          currentPrice: 100,
          greeks: { delta: 0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.15 },
        },
        {
          instrumentKey: "test2",
          underlying: "NIFTY",
          strike: 22200,
          optionType: "CE",
          expiry: "2025-03-27",
          side: "BUY",
          lots: 1,
          lotSize: 75,
          entryPrice: 50,
          currentPrice: 50,
          greeks: { delta: 0.3, gamma: 0.008, theta: -4, vega: 8, iv: 0.16 },
        },
      ],
    });
    const margin = calculateSimplifiedMargin(pos, 22000);
    // Spread width = 200 * 75 = 15,000
    expect(margin).toBe(15000);
  });

  it("calculates long option margin as premium paid", () => {
    const pos = makePosition({
      legs: [
        {
          instrumentKey: "test",
          underlying: "NIFTY",
          strike: 22000,
          optionType: "CE",
          expiry: "2025-03-27",
          side: "BUY",
          lots: 1,
          lotSize: 75,
          entryPrice: 200,
          currentPrice: 200,
          greeks: { delta: 0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.15 },
        },
      ],
    });
    const margin = calculateSimplifiedMargin(pos, 22000);
    // 200 * 75 * 1 = 15,000
    expect(margin).toBe(15000);
  });
});

describe("shouldForceClose", () => {
  it("returns close when stop-loss exceeded", () => {
    const pos = makePosition({ currentPnl: -20000 });
    const result = shouldForceClose(pos, DEFAULT_FNO_CONFIG, 0, 1);
    expect(result.close).toBe(true);
    expect(result.reason).toContain("SL hit");
  });

  it("returns close when daily loss exceeded", () => {
    const pos = makePosition({ currentPnl: -5000 });
    const result = shouldForceClose(pos, DEFAULT_FNO_CONFIG, -35000, 1);
    expect(result.close).toBe(true);
    expect(result.reason).toContain("Daily loss");
  });

  it("returns no close when all limits ok", () => {
    const pos = makePosition({ currentPnl: 5000 });
    const result = shouldForceClose(pos, DEFAULT_FNO_CONFIG, 10000, 1);
    expect(result.close).toBe(false);
  });
});
