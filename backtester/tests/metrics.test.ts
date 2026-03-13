import { describe, it, expect } from "vitest";
import { calculateMetrics } from "../src/engine/metrics.js";
import type { Trade, EquityPoint } from "../src/engine/types.js";

describe("calculateMetrics", () => {
  it("returns zeroed metrics for empty trades", () => {
    const metrics = calculateMetrics([], [], 100000);
    expect(metrics.totalTrades).toBe(0);
    expect(metrics.winRate).toBe(0);
    expect(metrics.cagr).toBe(0);
    expect(metrics.sharpeRatio).toBe(0);
  });

  it("calculates win rate correctly", () => {
    const trades: Trade[] = [
      {
        entryDate: "2024-01-01",
        entryPrice: 100,
        exitDate: "2024-01-10",
        exitPrice: 110,
        quantity: 1,
        pnl: 10,
        pnlPct: 10,
        holdingDays: 9,
        exitReason: "target",
      },
      {
        entryDate: "2024-01-15",
        entryPrice: 110,
        exitDate: "2024-01-20",
        exitPrice: 105,
        quantity: 1,
        pnl: -5,
        pnlPct: -4.55,
        holdingDays: 5,
        exitReason: "stop",
      },
      {
        entryDate: "2024-02-01",
        entryPrice: 105,
        exitDate: "2024-02-10",
        exitPrice: 115,
        quantity: 1,
        pnl: 10,
        pnlPct: 9.52,
        holdingDays: 9,
        exitReason: "target",
      },
    ];

    const equity: EquityPoint[] = [
      { date: "2024-01-01", equity: 100000 },
      { date: "2024-01-10", equity: 100010 },
      { date: "2024-01-20", equity: 100005 },
      { date: "2024-02-10", equity: 100015 },
    ];

    const metrics = calculateMetrics(trades, equity, 100000);
    expect(metrics.totalTrades).toBe(3);
    expect(metrics.winningTrades).toBe(2);
    expect(metrics.losingTrades).toBe(1);
    expect(metrics.winRate).toBeCloseTo(2 / 3, 5);
  });

  it("calculates profit factor correctly", () => {
    const trades: Trade[] = [
      {
        entryDate: "2024-01-01",
        entryPrice: 100,
        exitDate: "2024-01-10",
        exitPrice: 120,
        quantity: 1,
        pnl: 20,
        pnlPct: 20,
        holdingDays: 9,
        exitReason: "target",
      },
      {
        entryDate: "2024-01-15",
        entryPrice: 120,
        exitDate: "2024-01-20",
        exitPrice: 110,
        quantity: 1,
        pnl: -10,
        pnlPct: -8.33,
        holdingDays: 5,
        exitReason: "stop",
      },
    ];

    const equity: EquityPoint[] = [
      { date: "2024-01-01", equity: 100000 },
      { date: "2024-01-20", equity: 100010 },
    ];

    const metrics = calculateMetrics(trades, equity, 100000);
    // Profit factor = gross wins / gross losses = 20 / 10 = 2
    expect(metrics.profitFactor).toBeCloseTo(2, 5);
  });

  it("handles all-winning trades (infinite profit factor)", () => {
    const trades: Trade[] = [
      {
        entryDate: "2024-01-01",
        entryPrice: 100,
        exitDate: "2024-01-10",
        exitPrice: 110,
        quantity: 1,
        pnl: 10,
        pnlPct: 10,
        holdingDays: 9,
        exitReason: "target",
      },
    ];

    const equity: EquityPoint[] = [
      { date: "2024-01-01", equity: 100000 },
      { date: "2024-01-10", equity: 100010 },
    ];

    const metrics = calculateMetrics(trades, equity, 100000);
    expect(metrics.profitFactor).toBe(Infinity);
  });

  it("calculates total return", () => {
    const trades: Trade[] = [
      {
        entryDate: "2024-01-01",
        entryPrice: 100,
        exitDate: "2024-06-01",
        exitPrice: 150,
        quantity: 10,
        pnl: 500,
        pnlPct: 50,
        holdingDays: 152,
        exitReason: "target",
      },
    ];

    const equity: EquityPoint[] = [
      { date: "2024-01-01", equity: 100000 },
      { date: "2024-06-01", equity: 100500 },
    ];

    const metrics = calculateMetrics(trades, equity, 100000);
    expect(metrics.totalReturn).toBe(500);
    expect(metrics.totalReturnPct).toBeCloseTo(0.5, 2);
  });

  it("calculates max drawdown", () => {
    const equity: EquityPoint[] = [
      { date: "2024-01-01", equity: 100000 },
      { date: "2024-02-01", equity: 110000 }, // peak
      { date: "2024-03-01", equity: 95000 }, // drawdown of 15000
      { date: "2024-04-01", equity: 105000 },
    ];

    const metrics = calculateMetrics([], equity, 100000);
    expect(metrics.maxDrawdown).toBe(15000);
    expect(metrics.maxDrawdownPct).toBeCloseTo(
      (15000 / 110000) * 100,
      2
    );
  });
});
