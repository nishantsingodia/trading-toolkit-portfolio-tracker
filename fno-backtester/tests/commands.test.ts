import { describe, it, expect } from "vitest";
import { executeFnoBacktest } from "../src/commands/run-backtest.js";
import { compareFnoStrategies } from "../src/commands/compare-strategies.js";
import { optimizeFnoStrategy } from "../src/commands/optimize-strategy.js";
import { suggestFnoStrategies } from "../src/commands/suggest-strategies.js";
import { generateSpotPath, generateSpotCandles, generateChainHistory } from "./fixtures/sample-options-chain.js";

// Generate minimal test data to avoid OOM
const prices = generateSpotPath(22000, 10, 0.01, 42);
const spotCandles = generateSpotCandles(prices, "2025-03-18");
const expiry = "2025-03-27";
const chainHistory = generateChainHistory(prices, "2025-03-18", expiry, 0.15, 5, 50);
const prefetchedData = { spotCandles, chainHistory };

describe("executeFnoBacktest", () => {
  it("runs a backtest with short_straddle strategy", () => {
    const result = executeFnoBacktest(
      {
        underlying: "NIFTY",
        fromDate: "2025-03-15",
        toDate: "2025-03-30",
        strategy: "short_straddle",
      },
      prefetchedData
    );

    expect(result.strategyName).toBe("short_straddle");
    expect(result.underlying).toBe("NIFTY");
    expect(result.metrics).toBeDefined();
    expect(result.equityCurve.length).toBeGreaterThan(0);
  });

  it("runs a backtest with iron_condor strategy", () => {
    const result = executeFnoBacktest(
      {
        underlying: "NIFTY",
        fromDate: "2025-03-15",
        toDate: "2025-03-30",
        strategy: "iron_condor",
      },
      prefetchedData
    );

    expect(result.strategyName).toBe("iron_condor");
    expect(result.metrics).toBeDefined();
  });

  it("runs a backtest with deep_otm_sell strategy", () => {
    const result = executeFnoBacktest(
      {
        underlying: "NIFTY",
        fromDate: "2025-03-15",
        toDate: "2025-03-30",
        strategy: "deep_otm_sell",
      },
      prefetchedData
    );

    expect(result.strategyName).toBe("deep_otm_sell");
    expect(result.metrics).toBeDefined();
  });

  it("accepts custom strategy params", () => {
    const result = executeFnoBacktest(
      {
        underlying: "NIFTY",
        fromDate: "2025-03-15",
        toDate: "2025-03-30",
        strategy: "short_straddle",
        strategyParams: { ivPercentileMin: 30, targetPct: 40 },
        initialCapital: 1000000,
      },
      prefetchedData
    );

    expect(result.metrics).toBeDefined();
  });

  it("throws for unknown strategy", () => {
    expect(() =>
      executeFnoBacktest(
        {
          underlying: "NIFTY",
          fromDate: "2025-03-01",
          toDate: "2025-03-30",
          strategy: "nonexistent" as any,
        },
        prefetchedData
      )
    ).toThrow("Unknown strategy");
  });
});

describe("compareFnoStrategies", () => {
  it("compares multiple strategies and ranks them", () => {
    const result = compareFnoStrategies(
      {
        underlying: "NIFTY",
        fromDate: "2025-03-15",
        toDate: "2025-03-30",
        strategies: [
          { name: "short_straddle" },
          { name: "long_straddle" },
        ],
      },
      prefetchedData
    );

    expect(result.rankings).toHaveLength(2);
    expect(result.rankings[0].rank).toBe(1);
    expect(result.rankings[1].rank).toBe(2);

    // Scores should be in descending order
    for (let i = 1; i < result.rankings.length; i++) {
      expect(result.rankings[i - 1].score).toBeGreaterThanOrEqual(result.rankings[i].score);
    }
  });
});

describe("optimizeFnoStrategy", () => {
  it("finds best params for short_straddle", () => {
    const result = optimizeFnoStrategy(
      {
        underlying: "NIFTY",
        fromDate: "2025-03-15",
        toDate: "2025-03-30",
        strategy: "short_straddle",
        paramRanges: {
          targetPct: [40, 60],
          stopLossPct: [40, 60],
        },
        optimizeFor: "totalReturnPct",
      },
      prefetchedData
    );

    expect(result.totalCombinations).toBe(4); // 2 x 2
    expect(result.bestParams).toBeDefined();
    expect(result.topResults.length).toBeGreaterThan(0);
    expect(result.topResults.length).toBeLessThanOrEqual(10);
  });

  it("throws for too many combinations", () => {
    const bigRanges: Record<string, number[]> = {};
    for (let i = 0; i < 10; i++) {
      bigRanges[`param_${i}`] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    }

    expect(() =>
      optimizeFnoStrategy(
        {
          underlying: "NIFTY",
          fromDate: "2025-03-01",
          toDate: "2025-03-30",
          strategy: "short_straddle",
          paramRanges: bigRanges,
        },
        prefetchedData
      )
    ).toThrow("Too many combinations");
  });
});

describe("suggestFnoStrategies", () => {
  it("suggests strategies with market context", () => {
    const result = suggestFnoStrategies(
      {
        underlying: "NIFTY",
        fromDate: "2025-03-18",
        toDate: "2025-03-28",
      },
      prefetchedData
    );

    expect(result.context).toBeDefined();
    expect(result.context.regime).toBeTruthy();
    expect(result.recommendedStrategy).toBeTruthy();
  });
});
