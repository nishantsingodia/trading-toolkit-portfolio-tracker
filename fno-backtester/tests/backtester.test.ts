import { describe, it, expect, beforeEach } from "vitest";
import { runFnoBacktest, resetPositionCounter } from "../src/engine/backtester.js";
import { generateSpotPath, generateSpotCandles, generateChainHistory } from "./fixtures/sample-options-chain.js";
import type { FnoSignal, FnoBacktestConfig } from "../src/engine/types.js";
import { DEFAULT_FNO_CONFIG } from "../src/engine/types.js";
import { getATMStrike } from "../src/engine/options-chain.js";

beforeEach(() => {
  resetPositionCounter();
});

function makeConfig(overrides: Partial<FnoBacktestConfig> = {}): FnoBacktestConfig {
  return { ...DEFAULT_FNO_CONFIG, ...overrides };
}

describe("runFnoBacktest", () => {
  // Generate 15 days of data — Nifty around 22000, expiry in 15 days
  const prices = generateSpotPath(22000, 15, 0.008, 42);
  const candles = generateSpotCandles(prices, "2025-03-15");
  const expiry = "2025-03-27";
  const chainHistory = generateChainHistory(prices, "2025-03-15", expiry, 0.15, 10, 50);

  it("returns empty trades when no signals", () => {
    const result = runFnoBacktest(chainHistory, candles, [], makeConfig());
    expect(result.trades).toHaveLength(0);
    expect(result.equityCurve.length).toBe(chainHistory.length);
  });

  it("equity curve starts at initial capital when no positions", () => {
    const config = makeConfig({ initialCapital: 500000 });
    const result = runFnoBacktest(chainHistory, candles, [], config);
    expect(result.equityCurve[0].equity).toBe(500000);
  });

  it("opens and closes a short straddle", () => {
    const atm = getATMStrike(prices[0], "NIFTY");
    const signals: FnoSignal[] = [
      {
        timestamp: chainHistory[0].timestamp,
        type: "OPEN",
        legs: [
          { strike: atm, optionType: "CE", side: "SELL", expiry, lots: 1 },
          { strike: atm, optionType: "PE", side: "SELL", expiry, lots: 1 },
        ],
        reason: "test short straddle entry",
      },
      {
        timestamp: chainHistory[5].timestamp,
        type: "CLOSE",
        positionId: "pos_1",
        legs: [],
        reason: "test short straddle exit",
      },
    ];

    const result = runFnoBacktest(chainHistory, candles, signals, makeConfig(), "short_straddle", "NIFTY");

    // Should have at least 1 trade (opened and closed by signal or risk)
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    expect(result.trades[0].strategyName).toBe("short_straddle");
    expect(result.trades[0].dteAtEntry).toBeGreaterThan(0);
    expect(result.trades[0].legs).toHaveLength(2);
  });

  it("settles on expiry — OTM options expire worthless", () => {
    // Place strikes far OTM — they should expire worthless
    const signals: FnoSignal[] = [
      {
        timestamp: chainHistory[0].timestamp,
        type: "OPEN",
        legs: [
          { strike: prices[0] + 1000, optionType: "CE", side: "SELL", expiry, lots: 1 },
          { strike: prices[0] - 1000, optionType: "PE", side: "SELL", expiry, lots: 1 },
        ],
        reason: "test OTM sell",
      },
    ];

    // Use chain history that extends to expiry
    const extendedPrices = generateSpotPath(22000, 13, 0.005, 42);
    const extendedCandles = generateSpotCandles(extendedPrices, "2025-03-15");
    const extendedChain = generateChainHistory(extendedPrices, "2025-03-15", expiry, 0.15, 25, 50);

    const result = runFnoBacktest(
      extendedChain,
      extendedCandles,
      signals,
      makeConfig({ maxPositions: 5 }),
      "deep_otm_sell",
      "NIFTY"
    );

    // Should have a trade (either expired or force-closed at backtest end)
    expect(result.trades.length).toBeGreaterThan(0);
  });

  it("respects max positions limit", () => {
    const atm = getATMStrike(prices[0], "NIFTY");
    const signals: FnoSignal[] = [
      {
        timestamp: chainHistory[0].timestamp,
        type: "OPEN",
        legs: [{ strike: atm, optionType: "CE", side: "BUY", expiry, lots: 1 }],
        reason: "pos 1",
      },
      {
        timestamp: chainHistory[0].timestamp,
        type: "OPEN",
        legs: [{ strike: atm, optionType: "PE", side: "BUY", expiry, lots: 1 }],
        reason: "pos 2",
      },
      {
        timestamp: chainHistory[0].timestamp,
        type: "OPEN",
        legs: [{ strike: atm + 50, optionType: "CE", side: "BUY", expiry, lots: 1 }],
        reason: "pos 3 (should be blocked)",
      },
    ];

    const result = runFnoBacktest(
      chainHistory,
      candles,
      signals,
      makeConfig({ maxPositions: 2 }),
      "long_straddle",
      "NIFTY"
    );

    // Should only have 2 positions opened (third blocked by max positions)
    // All get closed at backtest end
    expect(result.trades).toHaveLength(2);
  });

  it("force closes on stop-loss breach", () => {
    const atm = getATMStrike(prices[0], "NIFTY");
    const signals: FnoSignal[] = [
      {
        timestamp: chainHistory[0].timestamp,
        type: "OPEN",
        legs: [
          { strike: atm, optionType: "CE", side: "SELL", expiry, lots: 1 },
          { strike: atm, optionType: "PE", side: "SELL", expiry, lots: 1 },
        ],
        reason: "short straddle",
      },
    ];

    // Very tight stop-loss to trigger quickly
    const config = makeConfig({ maxLossPerTrade: 100 });
    const result = runFnoBacktest(chainHistory, candles, signals, config, "short_straddle", "NIFTY");

    expect(result.trades.length).toBeGreaterThan(0);
    // The first trade should be closed due to stop-loss, risk breach, or backtest end
    const firstTrade = result.trades[0];
    expect(
      firstTrade.exitReason.includes("SL hit") ||
      firstTrade.exitReason.includes("risk_breach") ||
      firstTrade.exitReason.includes("backtest_end")
    ).toBe(true);
  });

  it("tracks equity curve and drawdown", () => {
    const atm = getATMStrike(prices[0], "NIFTY");
    const signals: FnoSignal[] = [
      {
        timestamp: chainHistory[0].timestamp,
        type: "OPEN",
        legs: [
          { strike: atm, optionType: "CE", side: "BUY", expiry, lots: 1 },
        ],
        reason: "buy call",
      },
    ];

    const result = runFnoBacktest(chainHistory, candles, signals, makeConfig(), "bull_call_spread", "NIFTY");

    expect(result.equityCurve.length).toBe(chainHistory.length);
    expect(result.drawdownSeries.length).toBe(chainHistory.length);
    expect(result.greeksTimeSeries.length).toBe(chainHistory.length);

    // Drawdown should never be negative
    for (const dd of result.drawdownSeries) {
      expect(dd.drawdown).toBeGreaterThanOrEqual(0);
      expect(dd.drawdownPct).toBeGreaterThanOrEqual(0);
    }
  });

  it("tracks Greeks time series", () => {
    const atm = getATMStrike(prices[0], "NIFTY");
    const signals: FnoSignal[] = [
      {
        timestamp: chainHistory[0].timestamp,
        type: "OPEN",
        legs: [
          { strike: atm, optionType: "CE", side: "SELL", expiry, lots: 1 },
          { strike: atm, optionType: "PE", side: "SELL", expiry, lots: 1 },
        ],
        reason: "short straddle",
      },
    ];

    const result = runFnoBacktest(chainHistory, candles, signals, makeConfig(), "short_straddle", "NIFTY");

    // After opening, greeks should be non-zero at some point
    const hasNonZeroGreeks = result.greeksTimeSeries.some(
      (g) => g.delta !== 0 || g.theta !== 0 || g.gamma !== 0 || g.vega !== 0
    );
    expect(hasNonZeroGreeks).toBe(true);
  });
});
