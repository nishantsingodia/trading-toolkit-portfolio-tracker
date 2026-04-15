import { describe, it, expect } from "vitest";
import { runBacktest, applySlippage, calculateOneSideCost, shiftToNextBar } from "../src/engine/backtester.js";
import type { Signal, Candle, BacktestConfig } from "../src/engine/types.js";
import { ZERODHA_EQUITY_DELIVERY } from "../src/engine/types.js";
import { SAMPLE_CANDLES, DIP_CANDLES } from "./fixtures/sample-candles.js";

/** Legacy config: zero costs, same-bar execution (backward compat) */
const LEGACY_CONFIG: BacktestConfig = {
  initialCapital: 100000,
  quantity: 10,
  allowAccumulation: false,
  slippagePct: 0,
  costs: null,
  nextBarExecution: false,
};

const LEGACY_CONFIG_1: BacktestConfig = { ...LEGACY_CONFIG, quantity: 1 };

describe("runBacktest - standard mode (legacy, no costs)", () => {
  it("executes BUY/SELL pairs into trades", () => {
    const signals: Signal[] = [
      {
        index: 5,
        type: "BUY",
        price: SAMPLE_CANDLES[5].close,
        date: SAMPLE_CANDLES[5].timestamp,
        reason: "test buy",
      },
      {
        index: 15,
        type: "SELL",
        price: SAMPLE_CANDLES[15].close,
        date: SAMPLE_CANDLES[15].timestamp,
        reason: "test sell",
      },
    ];

    const result = runBacktest(SAMPLE_CANDLES, signals, LEGACY_CONFIG);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBe(SAMPLE_CANDLES[5].close);
    expect(result.trades[0].exitPrice).toBe(SAMPLE_CANDLES[15].close);
    expect(result.trades[0].quantity).toBe(10);
  });

  it("force-closes open position at end", () => {
    const signals: Signal[] = [
      {
        index: 5,
        type: "BUY",
        price: SAMPLE_CANDLES[5].close,
        date: SAMPLE_CANDLES[5].timestamp,
        reason: "test buy",
      },
    ];

    const result = runBacktest(SAMPLE_CANDLES, signals, LEGACY_CONFIG_1);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("Forced exit at end of data");
  });

  it("ignores duplicate BUY without SELL", () => {
    const signals: Signal[] = [
      {
        index: 5,
        type: "BUY",
        price: SAMPLE_CANDLES[5].close,
        date: SAMPLE_CANDLES[5].timestamp,
        reason: "first buy",
      },
      {
        index: 10,
        type: "BUY",
        price: SAMPLE_CANDLES[10].close,
        date: SAMPLE_CANDLES[10].timestamp,
        reason: "second buy (ignored)",
      },
      {
        index: 15,
        type: "SELL",
        price: SAMPLE_CANDLES[15].close,
        date: SAMPLE_CANDLES[15].timestamp,
        reason: "sell",
      },
    ];

    const result = runBacktest(SAMPLE_CANDLES, signals, LEGACY_CONFIG_1);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBe(SAMPLE_CANDLES[5].close);
  });

  it("builds equity curve for all candles", () => {
    const signals: Signal[] = [];
    const result = runBacktest(SAMPLE_CANDLES, signals, LEGACY_CONFIG_1);

    expect(result.equityCurve).toHaveLength(SAMPLE_CANDLES.length);
    for (const point of result.equityCurve) {
      expect(point.equity).toBe(100000);
    }
  });

  it("returns empty results for empty candles", () => {
    const result = runBacktest([], [], LEGACY_CONFIG_1);
    expect(result.trades).toHaveLength(0);
    expect(result.equityCurve).toHaveLength(0);
    expect(result.totalCosts).toBe(0);
  });
});

describe("runBacktest - accumulation mode (legacy, no costs)", () => {
  const ACCUM_CONFIG: BacktestConfig = {
    ...LEGACY_CONFIG_1,
    allowAccumulation: true,
  };

  it("allows multiple concurrent positions", () => {
    const signals: Signal[] = [
      {
        index: 5,
        type: "BUY",
        price: DIP_CANDLES[5].close,
        date: DIP_CANDLES[5].timestamp,
        reason: "buy 1",
      },
      {
        index: 10,
        type: "BUY",
        price: DIP_CANDLES[10].close,
        date: DIP_CANDLES[10].timestamp,
        reason: "buy 2",
      },
      {
        index: 15,
        type: "SELL",
        price: DIP_CANDLES[15].close,
        date: DIP_CANDLES[15].timestamp,
        reason: "sell 1",
      },
      {
        index: 20,
        type: "SELL",
        price: DIP_CANDLES[20].close,
        date: DIP_CANDLES[20].timestamp,
        reason: "sell 2",
      },
    ];

    const result = runBacktest(DIP_CANDLES, signals, ACCUM_CONFIG);

    expect(result.trades).toHaveLength(2);
    expect(result.trades[0].entryPrice).toBe(DIP_CANDLES[5].close);
    expect(result.trades[0].exitPrice).toBe(DIP_CANDLES[15].close);
  });

  it("force-closes all remaining positions at end", () => {
    const signals: Signal[] = [
      {
        index: 5,
        type: "BUY",
        price: DIP_CANDLES[5].close,
        date: DIP_CANDLES[5].timestamp,
        reason: "buy 1",
      },
      {
        index: 10,
        type: "BUY",
        price: DIP_CANDLES[10].close,
        date: DIP_CANDLES[10].timestamp,
        reason: "buy 2",
      },
    ];

    const result = runBacktest(DIP_CANDLES, signals, ACCUM_CONFIG);

    expect(result.trades).toHaveLength(2);
    for (const trade of result.trades) {
      expect(trade.exitReason).toBe("Forced exit at end of data");
    }
  });
});

// ─── New Feature Tests ───

describe("applySlippage", () => {
  it("increases buy price by slippage %", () => {
    expect(applySlippage(1000, "BUY", 0.05)).toBeCloseTo(1000.5, 2);
  });

  it("decreases sell price by slippage %", () => {
    expect(applySlippage(1000, "SELL", 0.05)).toBeCloseTo(999.5, 2);
  });

  it("zero slippage returns same price", () => {
    expect(applySlippage(1000, "BUY", 0)).toBe(1000);
    expect(applySlippage(1000, "SELL", 0)).toBe(1000);
  });
});

describe("calculateOneSideCost (Zerodha equity delivery)", () => {
  it("calculates buy-side costs correctly", () => {
    // ₹1,00,000 turnover
    const cost = calculateOneSideCost(100000, "BUY", ZERODHA_EQUITY_DELIVERY);

    // STT: 0.1% = ₹100
    // Exchange: 0.00297% = ₹2.97
    // SEBI: 0.0001% = ₹0.10
    // Stamp duty: 0.015% = ₹15 (buy only)
    // DP: ₹0 (buy side)
    // GST: 18% of (2.97 + 0.10) = ₹0.5526
    // Total: ~₹118.62
    expect(cost).toBeGreaterThan(115);
    expect(cost).toBeLessThan(125);
  });

  it("calculates sell-side costs correctly", () => {
    const cost = calculateOneSideCost(100000, "SELL", ZERODHA_EQUITY_DELIVERY);

    // STT: ₹100
    // Exchange: ₹2.97
    // SEBI: ₹0.10
    // Stamp duty: ₹0 (sell side)
    // DP: ₹15.93
    // GST: 18% of (2.97 + 0.10) = ₹0.5526
    // Total: ~₹119.55
    expect(cost).toBeGreaterThan(115);
    expect(cost).toBeLessThan(125);
  });

  it("sell costs include DP charges, buy does not", () => {
    const buyCost = calculateOneSideCost(100000, "BUY", ZERODHA_EQUITY_DELIVERY);
    const sellCost = calculateOneSideCost(100000, "SELL", ZERODHA_EQUITY_DELIVERY);
    // Sell has DP (₹15.93) but no stamp duty; buy has stamp duty (₹15) but no DP
    // They should be roughly similar in magnitude
    expect(Math.abs(buyCost - sellCost)).toBeLessThan(5);
  });
});

describe("shiftToNextBar", () => {
  it("shifts signal to next candle open", () => {
    const signals: Signal[] = [
      {
        index: 5,
        type: "BUY",
        price: SAMPLE_CANDLES[5].close,
        date: SAMPLE_CANDLES[5].timestamp,
        reason: "test",
      },
    ];

    const shifted = shiftToNextBar(signals, SAMPLE_CANDLES);

    expect(shifted).toHaveLength(1);
    expect(shifted[0].index).toBe(6);
    expect(shifted[0].price).toBe(SAMPLE_CANDLES[6].open);
    expect(shifted[0].reason).toContain("next-bar exec");
  });

  it("drops signals on last candle", () => {
    const lastIdx = SAMPLE_CANDLES.length - 1;
    const signals: Signal[] = [
      {
        index: lastIdx,
        type: "BUY",
        price: SAMPLE_CANDLES[lastIdx].close,
        date: SAMPLE_CANDLES[lastIdx].timestamp,
        reason: "test",
      },
    ];

    const shifted = shiftToNextBar(signals, SAMPLE_CANDLES);
    expect(shifted).toHaveLength(0);
  });
});

describe("runBacktest - with realistic costs (Zerodha defaults)", () => {
  const REALISTIC_CONFIG: BacktestConfig = {
    initialCapital: 100000,
    quantity: 10,
    allowAccumulation: false,
    // slippagePct, costs, nextBarExecution all use defaults
  };

  it("next-bar execution uses next candle open", () => {
    const signals: Signal[] = [
      {
        index: 5,
        type: "BUY",
        price: SAMPLE_CANDLES[5].close,
        date: SAMPLE_CANDLES[5].timestamp,
        reason: "buy signal",
      },
      {
        index: 15,
        type: "SELL",
        price: SAMPLE_CANDLES[15].close,
        date: SAMPLE_CANDLES[15].timestamp,
        reason: "sell signal",
      },
    ];

    const result = runBacktest(SAMPLE_CANDLES, signals, REALISTIC_CONFIG);

    expect(result.trades).toHaveLength(1);
    // Entry should be near candle[6].open (with slippage up)
    const expectedEntry = SAMPLE_CANDLES[6].open * (1 + 0.05 / 100);
    expect(result.trades[0].entryPrice).toBeCloseTo(expectedEntry, 1);
    // Exit should be near candle[16].open (with slippage down)
    const expectedExit = SAMPLE_CANDLES[16].open * (1 - 0.05 / 100);
    expect(result.trades[0].exitPrice).toBeCloseTo(expectedExit, 1);
  });

  it("totalCosts is positive when trades occur", () => {
    const signals: Signal[] = [
      {
        index: 5,
        type: "BUY",
        price: SAMPLE_CANDLES[5].close,
        date: SAMPLE_CANDLES[5].timestamp,
        reason: "buy",
      },
      {
        index: 15,
        type: "SELL",
        price: SAMPLE_CANDLES[15].close,
        date: SAMPLE_CANDLES[15].timestamp,
        reason: "sell",
      },
    ];

    const result = runBacktest(SAMPLE_CANDLES, signals, REALISTIC_CONFIG);
    expect(result.totalCosts).toBeGreaterThan(0);
  });

  it("realistic returns are lower than legacy (no cost) returns", () => {
    const signals: Signal[] = [
      {
        index: 5,
        type: "BUY",
        price: SAMPLE_CANDLES[5].close,
        date: SAMPLE_CANDLES[5].timestamp,
        reason: "buy",
      },
      {
        index: 50,
        type: "SELL",
        price: SAMPLE_CANDLES[50].close,
        date: SAMPLE_CANDLES[50].timestamp,
        reason: "sell",
      },
    ];

    const realistic = runBacktest(SAMPLE_CANDLES, signals, REALISTIC_CONFIG);
    const legacy = runBacktest(SAMPLE_CANDLES, signals, LEGACY_CONFIG);

    // Realistic equity should be lower due to costs + slippage
    const realisticFinal = realistic.equityCurve[realistic.equityCurve.length - 1].equity;
    const legacyFinal = legacy.equityCurve[legacy.equityCurve.length - 1].equity;
    expect(realisticFinal).toBeLessThan(legacyFinal);
  });
});

describe("runBacktest - stop loss", () => {
  it("exits position when stop loss is hit", () => {
    // DIP_CANDLES: entry at day 9, close=1027.33. Day 10 low=1001.75 (-2.5% from entry).
    // A -2% stop loss = 1027.33 * 0.98 = 1006.78. Day 10 low (1001.75) breaches this.
    const signals: Signal[] = [
      {
        index: 9,
        type: "BUY",
        price: DIP_CANDLES[9].close,
        date: DIP_CANDLES[9].timestamp,
        reason: "buy",
      },
    ];

    const result = runBacktest(DIP_CANDLES, signals, {
      initialCapital: 100000,
      quantity: 1,
      allowAccumulation: false,
      slippagePct: 0,
      costs: null,
      nextBarExecution: false,
      stopLossPct: -2,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toContain("Stop loss");
    // Should exit on day 10
    expect(result.trades[0].exitDate).toBe(DIP_CANDLES[10].timestamp);
  });

  it("does not trigger stop loss when price stays above threshold", () => {
    // Entry at day 3, close=1009.03. Stop at -5% = 958.58.
    // DIP_CANDLES never go that low, so no SL trigger.
    const signals: Signal[] = [
      {
        index: 3,
        type: "BUY",
        price: DIP_CANDLES[3].close,
        date: DIP_CANDLES[3].timestamp,
        reason: "buy",
      },
    ];

    const result = runBacktest(DIP_CANDLES, signals, {
      initialCapital: 100000,
      quantity: 1,
      allowAccumulation: false,
      slippagePct: 0,
      costs: null,
      nextBarExecution: false,
      stopLossPct: -5,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("Forced exit at end of data");
  });
});
