import { describe, it, expect } from "vitest";
import { SAMPLE_CANDLES, DIP_CANDLES } from "./fixtures/sample-candles.js";
import { STRATEGY_REGISTRY } from "../src/engine/strategies.js";
import { runBacktest } from "../src/engine/backtester.js";
import { calculateMetrics } from "../src/engine/metrics.js";
import { optimizeWithCandles } from "../src/commands/optimize-strategy.js";
import { suggestWithCandles } from "../src/commands/suggest-strategies.js";

describe("run-backtest integration", () => {
  it("runs SMA crossover on sample data end-to-end", () => {
    const strategyDef = STRATEGY_REGISTRY.sma_crossover;
    const params = { ...strategyDef.defaults, fastPeriod: 5, slowPeriod: 20 };
    const signals = strategyDef.fn(SAMPLE_CANDLES, params);
    const { trades, equityCurve } = runBacktest(SAMPLE_CANDLES, signals, {
      initialCapital: 100000,
      quantity: 10,
      allowAccumulation: false,
    });
    const metrics = calculateMetrics(trades, equityCurve, 100000);

    expect(metrics.totalTrades).toBeGreaterThan(0);
    expect(equityCurve).toHaveLength(SAMPLE_CANDLES.length);
    expect(metrics.winRate).toBeGreaterThanOrEqual(0);
    expect(metrics.winRate).toBeLessThanOrEqual(1);
  });

  it("runs buy_the_dip on dip data end-to-end", () => {
    const strategyDef = STRATEGY_REGISTRY.buy_the_dip;
    const signals = strategyDef.fn(DIP_CANDLES, strategyDef.defaults);
    const { trades, equityCurve } = runBacktest(DIP_CANDLES, signals, {
      initialCapital: 100000,
      quantity: 1,
      allowAccumulation: true,
    });
    const metrics = calculateMetrics(trades, equityCurve, 100000);

    expect(metrics.totalTrades).toBeGreaterThan(0);
  });
});

describe("optimize-strategy", () => {
  it("finds best params via grid search", () => {
    const result = optimizeWithCandles(
      SAMPLE_CANDLES,
      "sma_crossover",
      {
        fastPeriod: [5, 10, 15],
        slowPeriod: [20, 30],
      },
      "totalReturnPct",
      100000,
      10
    );

    expect(result.totalCombinations).toBe(6); // 3 * 2
    expect(result.topResults.length).toBeLessThanOrEqual(10);
    expect(result.bestParams).toBeDefined();
    expect(result.optimizeFor).toBe("totalReturnPct");
  });

  it("optimizes buy_the_dip params", () => {
    const result = optimizeWithCandles(
      DIP_CANDLES,
      "buy_the_dip",
      {
        buyDropPct: [-0.5, -1, -2],
        sellTargetPct: [2, 5],
        stopLossPct: [-2, -5],
      },
      "cagr",
      100000,
      1
    );

    expect(result.totalCombinations).toBe(12); // 3 * 2 * 2
    expect(result.bestParams).toBeDefined();
  });
});

describe("suggest-strategies", () => {
  it("ranks all strategies and detects regime", () => {
    const result = suggestWithCandles(SAMPLE_CANDLES);

    expect(result.suggestions).toHaveLength(10);
    expect(result.suggestions[0].rank).toBe(1);
    expect(result.regime).toBeTruthy();
    expect(result.recommendedStrategy).toBeTruthy();
  });

  it("suggestions have valid scores", () => {
    const result = suggestWithCandles(SAMPLE_CANDLES);
    for (const s of result.suggestions) {
      expect(typeof s.score).toBe("number");
      expect(s.metrics.totalTrades).toBeGreaterThanOrEqual(0);
    }
  });
});
