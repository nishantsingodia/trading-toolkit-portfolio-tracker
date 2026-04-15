import { describe, it, expect } from "vitest";
import { calculateFnoMetrics, buildBacktestResult } from "../src/engine/metrics.js";
import type { FnoTrade, EquityPoint, DrawdownPoint, GreeksSnapshot } from "../src/engine/types.js";

function makeTrade(overrides: Partial<FnoTrade> = {}): FnoTrade {
  return {
    positionId: "test",
    strategyName: "short_straddle",
    legs: [],
    entryDate: "2025-03-15T09:20:00",
    exitDate: "2025-03-20T15:15:00",
    entrySpot: 22000,
    exitSpot: 22100,
    dteAtEntry: 12,
    dteAtExit: 7,
    ivAtEntry: 0.15,
    ivAtExit: 0.13,
    netPremiumCollected: 10000,
    exitPnl: 5000,
    exitPnlPct: 50,
    thetaCaptured: 4000,
    maxDrawdownDuringTrade: -2000,
    exitReason: "target_hit",
    ...overrides,
  };
}

describe("calculateFnoMetrics", () => {
  it("returns empty metrics for no trades", () => {
    const m = calculateFnoMetrics([], [], [], [], 500000);
    expect(m.totalTrades).toBe(0);
    expect(m.winRate).toBe(0);
  });

  it("calculates basic metrics correctly", () => {
    const trades = [
      makeTrade({ exitPnl: 5000, exitReason: "target_hit" }),
      makeTrade({ exitPnl: -3000, exitReason: "stop_loss" }),
      makeTrade({ exitPnl: 8000, exitReason: "target_hit" }),
    ];

    const equity: EquityPoint[] = [
      { date: "2025-03-15", equity: 500000 },
      { date: "2025-03-17", equity: 505000 },
      { date: "2025-03-19", equity: 502000 },
      { date: "2025-03-21", equity: 510000 },
    ];

    const dd: DrawdownPoint[] = [
      { date: "2025-03-15", drawdown: 0, drawdownPct: 0 },
      { date: "2025-03-17", drawdown: 0, drawdownPct: 0 },
      { date: "2025-03-19", drawdown: 3000, drawdownPct: 0.59 },
      { date: "2025-03-21", drawdown: 0, drawdownPct: 0 },
    ];

    const m = calculateFnoMetrics(trades, equity, dd, [], 500000);

    expect(m.totalTrades).toBe(3);
    expect(m.winningTrades).toBe(2);
    expect(m.losingTrades).toBe(1);
    expect(m.winRate).toBeCloseTo(2 / 3, 3);
    expect(m.totalReturn).toBe(10000); // 5k - 3k + 8k
    expect(m.totalReturnPct).toBe(2); // 10k / 500k * 100
    expect(m.profitFactor).toBeCloseTo(13000 / 3000, 2);
    expect(m.maxDrawdownPct).toBe(0.59);
  });

  it("calculates F&O specific metrics", () => {
    const trades = [
      makeTrade({ dteAtEntry: 12, dteAtExit: 7, ivAtEntry: 0.15, ivAtExit: 0.13, exitReason: "target_hit" }),
      makeTrade({ dteAtEntry: 8, dteAtExit: 3, ivAtEntry: 0.18, ivAtExit: 0.14, exitReason: "stop_loss" }),
    ];

    const m = calculateFnoMetrics(trades, [], [], [], 500000);

    expect(m.avgDteAtEntry).toBe(10); // (12 + 8) / 2
    expect(m.avgDteAtExit).toBe(5); // (7 + 3) / 2
    expect(m.avgIvAtEntry).toBeCloseTo(0.165, 3);
    expect(m.avgIvAtExit).toBeCloseTo(0.135, 3);
  });

  it("tracks exit reason breakdown", () => {
    const trades = [
      makeTrade({ exitReason: "target_hit" }),
      makeTrade({ exitReason: "target_hit" }),
      makeTrade({ exitReason: "stop_loss" }),
      makeTrade({ exitReason: "time_exit" }),
      makeTrade({ exitReason: "risk_breach: delta" }),
    ];

    const m = calculateFnoMetrics(trades, [], [], [], 500000);

    expect(m.tradesHitTarget).toBe(2);
    expect(m.tradesHitStopLoss).toBe(1);
    expect(m.tradesExpiredOrTimeExit).toBe(1);
    expect(m.tradesRiskBreach).toBe(1);
  });

  it("buildBacktestResult creates complete result", () => {
    const trades = [makeTrade()];
    const equity: EquityPoint[] = [{ date: "2025-03-15", equity: 500000 }];
    const dd: DrawdownPoint[] = [{ date: "2025-03-15", drawdown: 0, drawdownPct: 0 }];
    const greeks: GreeksSnapshot[] = [{ date: "2025-03-15", delta: 0, gamma: 0, theta: 0, vega: 0 }];

    const result = buildBacktestResult(trades, equity, dd, greeks, 500000);
    expect(result.trades).toHaveLength(1);
    expect(result.metrics).toBeDefined();
    expect(result.equityCurve).toHaveLength(1);
    expect(result.drawdownSeries).toHaveLength(1);
    expect(result.greeksTimeSeries).toHaveLength(1);
  });
});
