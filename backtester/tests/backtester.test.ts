import { describe, it, expect } from "vitest";
import { runBacktest } from "../src/engine/backtester.js";
import type { Signal, Candle } from "../src/engine/types.js";
import { SAMPLE_CANDLES, DIP_CANDLES } from "./fixtures/sample-candles.js";

describe("runBacktest - standard mode", () => {
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

    const result = runBacktest(SAMPLE_CANDLES, signals, {
      initialCapital: 100000,
      quantity: 10,
      allowAccumulation: false,
    });

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
      // No SELL signal
    ];

    const result = runBacktest(SAMPLE_CANDLES, signals, {
      initialCapital: 100000,
      quantity: 1,
      allowAccumulation: false,
    });

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

    const result = runBacktest(SAMPLE_CANDLES, signals, {
      initialCapital: 100000,
      quantity: 1,
      allowAccumulation: false,
    });

    // Only one trade (second BUY ignored since already in position)
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBe(SAMPLE_CANDLES[5].close);
  });

  it("builds equity curve for all candles", () => {
    const signals: Signal[] = [];
    const result = runBacktest(SAMPLE_CANDLES, signals, {
      initialCapital: 100000,
      quantity: 1,
      allowAccumulation: false,
    });

    expect(result.equityCurve).toHaveLength(SAMPLE_CANDLES.length);
    // No trades, equity stays at initial capital
    for (const point of result.equityCurve) {
      expect(point.equity).toBe(100000);
    }
  });

  it("returns empty results for empty candles", () => {
    const result = runBacktest([], [], {
      initialCapital: 100000,
      quantity: 1,
      allowAccumulation: false,
    });
    expect(result.trades).toHaveLength(0);
    expect(result.equityCurve).toHaveLength(0);
  });
});

describe("runBacktest - accumulation mode", () => {
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

    const result = runBacktest(DIP_CANDLES, signals, {
      initialCapital: 100000,
      quantity: 1,
      allowAccumulation: true,
    });

    expect(result.trades).toHaveLength(2);
    // FIFO: first sell closes first buy
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

    const result = runBacktest(DIP_CANDLES, signals, {
      initialCapital: 100000,
      quantity: 1,
      allowAccumulation: true,
    });

    expect(result.trades).toHaveLength(2);
    for (const trade of result.trades) {
      expect(trade.exitReason).toBe("Forced exit at end of data");
    }
  });
});
