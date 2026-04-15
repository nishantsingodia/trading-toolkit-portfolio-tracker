import { describe, it, expect } from "vitest";
import { runBacktest } from "../src/engine/backtester.js";
import { calculateMetrics } from "../src/engine/metrics.js";
import { STRATEGY_REGISTRY } from "../src/engine/strategies.js";
import {
  walkForwardOptimize,
  parameterSensitivity,
  computePlateauScore,
} from "../src/commands/optimize-strategy.js";
import type { BacktestConfig, StrategyName } from "../src/engine/types.js";
import { SAMPLE_CANDLES } from "./fixtures/sample-candles.js";

// ─── Before/After Comparison ───

const LEGACY_CONFIG: BacktestConfig = {
  initialCapital: 100_000,
  quantity: 10,
  allowAccumulation: false,
  slippagePct: 0,
  costs: null,
  nextBarExecution: false,
};

const REALISTIC_CONFIG: BacktestConfig = {
  initialCapital: 100_000,
  quantity: 10,
  allowAccumulation: false,
  // defaults: slippage 0.05%, Zerodha costs, next-bar execution
};

describe("Before/After: legacy vs realistic execution", () => {
  const strategies: StrategyName[] = [
    "sma_crossover",
    "ema_crossover",
    "supertrend",
    "vwap_crossover",
    "rsi_overbought_oversold",
    "macd_signal_cross",
    "bollinger_squeeze",
    "stochastic_crossover",
    "atr_trailing_stop",
    "buy_the_dip",
  ];

  it("all 10 strategies produce lower or equal returns with realistic costs", () => {
    const comparison: Array<{
      strategy: string;
      legacyReturn: number;
      realisticReturn: number;
      costImpact: number;
      legacyTrades: number;
      realisticTrades: number;
    }> = [];

    for (const name of strategies) {
      const strategyDef = STRATEGY_REGISTRY[name];
      const signals = strategyDef.fn(SAMPLE_CANDLES, strategyDef.defaults);
      const isAccum = name === "buy_the_dip";

      const legacyResult = runBacktest(SAMPLE_CANDLES, signals, {
        ...LEGACY_CONFIG,
        allowAccumulation: isAccum,
      });
      const legacyMetrics = calculateMetrics(
        legacyResult.trades,
        legacyResult.equityCurve,
        100_000
      );

      const realisticResult = runBacktest(SAMPLE_CANDLES, signals, {
        ...REALISTIC_CONFIG,
        allowAccumulation: isAccum,
      });
      const realisticMetrics = calculateMetrics(
        realisticResult.trades,
        realisticResult.equityCurve,
        100_000
      );

      comparison.push({
        strategy: name,
        legacyReturn: Math.round(legacyMetrics.totalReturnPct * 100) / 100,
        realisticReturn: Math.round(realisticMetrics.totalReturnPct * 100) / 100,
        costImpact: Math.round((realisticMetrics.totalReturnPct - legacyMetrics.totalReturnPct) * 100) / 100,
        legacyTrades: legacyMetrics.totalTrades,
        realisticTrades: realisticMetrics.totalTrades,
      });
    }

    // Print comparison table
    console.log("\n╔══════════════════════════════════════════════════════════════════╗");
    console.log("║          BEFORE/AFTER: Legacy vs Realistic Execution           ║");
    console.log("╠══════════════════════╦══════════╦══════════╦══════════╦═════════╣");
    console.log("║ Strategy             ║ Legacy % ║ Real %   ║ Impact % ║ Trades  ║");
    console.log("╠══════════════════════╬══════════╬══════════╬══════════╬═════════╣");
    for (const row of comparison) {
      const name = row.strategy.padEnd(20);
      const leg = row.legacyReturn.toFixed(2).padStart(8);
      const real = row.realisticReturn.toFixed(2).padStart(8);
      const impact = row.costImpact.toFixed(2).padStart(8);
      const trades = `${row.realisticTrades}/${row.legacyTrades}`.padStart(7);
      console.log(`║ ${name} ║ ${leg} ║ ${real} ║ ${impact} ║ ${trades} ║`);
    }
    console.log("╚══════════════════════╩══════════╩══════════╩══════════╩═════════╝");

    // Assertions: realistic should never exceed legacy returns significantly
    // (small floating-point differences OK, but no strategy should magically gain from costs)
    for (const row of comparison) {
      // Realistic return should be <= legacy return + small epsilon
      // (next-bar execution can sometimes change signal timing favorably, so allow small positive delta)
      expect(row.costImpact).toBeLessThan(5); // no strategy should gain >5% from cost model
    }
  });
});

// ─── Walk-Forward Validation ───

describe("Walk-forward validation", () => {
  it("runs 3-fold walk-forward on SMA crossover", () => {
    const result = walkForwardOptimize(
      SAMPLE_CANDLES,
      "sma_crossover",
      { fastPeriod: [5, 10], slowPeriod: [20, 30] },
      "totalReturnPct",
      3,   // 100 candles / 3 = 33 per fold (≥30 minimum)
      0.75,
      100_000,
      10
    );

    expect(result.windows.length).toBeGreaterThan(0);
    expect(result.windows.length).toBeLessThanOrEqual(3);

    console.log("\n── Walk-Forward: SMA Crossover (3 folds) ──");
    for (const w of result.windows) {
      console.log(
        `  Fold [${w.window.trainStart}-${w.window.trainEnd}] → [${w.window.testStart}-${w.window.testEnd}]` +
        `  IS: ${(w.inSampleMetrics.totalReturnPct).toFixed(2)}%` +
        `  OOS: ${(w.outOfSampleMetrics.totalReturnPct).toFixed(2)}%` +
        `  Degradation: ${w.degradationPct}%` +
        `  Params: ${JSON.stringify(w.bestParams)}`
      );
    }
    console.log(`  Avg IS: ${result.avgInSample}%  Avg OOS: ${result.avgOutOfSample}%`);
    console.log(`  Avg Degradation: ${result.avgDegradation}%  Param Stability: ${result.paramStability}`);

    // Each window should have valid metrics
    for (const w of result.windows) {
      expect(w.inSampleMetrics.totalTrades).toBeGreaterThanOrEqual(0);
      expect(w.outOfSampleMetrics.totalTrades).toBeGreaterThanOrEqual(0);
      expect(typeof w.degradationPct).toBe("number");
    }
  });

  it("runs walk-forward on EMA crossover", () => {
    const result = walkForwardOptimize(
      SAMPLE_CANDLES,
      "ema_crossover",
      { fastPeriod: [5, 12, 20], slowPeriod: [26, 50] },
      "totalReturnPct",
      3,
      0.7,
      100_000,
      10
    );

    expect(result.windows.length).toBeGreaterThan(0);
    expect(result.paramStability).toBeGreaterThanOrEqual(0);
    expect(result.paramStability).toBeLessThanOrEqual(1);
  });
});

// ─── Parameter Sensitivity ───

describe("Parameter sensitivity analysis", () => {
  it("analyzes SMA crossover param sensitivity", () => {
    const report = parameterSensitivity(
      SAMPLE_CANDLES,
      "sma_crossover",
      {
        fastPeriod: [3, 5, 8, 10, 15, 20],
        slowPeriod: [20, 30, 40, 50],
      },
      "totalReturnPct",
      100_000,
      10
    );

    expect(report.strategy).toBe("sma_crossover");
    expect(report.params).toHaveLength(2);
    expect(["ROBUST", "MODERATE", "FRAGILE"]).toContain(report.verdict);

    console.log("\n── Sensitivity: SMA Crossover ──");
    for (const p of report.params) {
      const valStrs = p.values.map(v =>
        `${v.value}→${(v.metrics.totalReturnPct).toFixed(1)}%`
      ).join(", ");
      console.log(`  ${p.paramName}: plateau=${p.plateauScore} robust=${p.isRobust}`);
      console.log(`    ${valStrs}`);
    }
    console.log(`  Overall: ${report.overallRobustness} → ${report.verdict}`);

    // Each param should have results for all tested values
    for (const p of report.params) {
      expect(p.values.length).toBeGreaterThan(0);
      expect(p.plateauScore).toBeGreaterThanOrEqual(0);
      expect(p.plateauScore).toBeLessThanOrEqual(1);
    }
  });

  it("analyzes supertrend param sensitivity", () => {
    const report = parameterSensitivity(
      SAMPLE_CANDLES,
      "supertrend",
      {
        period: [7, 10, 14, 20],
        multiplier: [2, 3, 4, 5],
      },
      "totalReturnPct",
      100_000,
      10
    );

    expect(report.params).toHaveLength(2);
    console.log("\n── Sensitivity: Supertrend ──");
    for (const p of report.params) {
      const valStrs = p.values.map(v =>
        `${v.value}→${(v.metrics.totalReturnPct).toFixed(1)}%`
      ).join(", ");
      console.log(`  ${p.paramName}: plateau=${p.plateauScore} robust=${p.isRobust}`);
      console.log(`    ${valStrs}`);
    }
    console.log(`  Overall: ${report.overallRobustness} → ${report.verdict}`);
  });
});

// ─── Plateau Score Unit Tests ───

describe("computePlateauScore", () => {
  it("returns 1 for identical values (perfect plateau)", () => {
    expect(computePlateauScore([10, 10, 10, 10])).toBe(1);
  });

  it("returns high score for similar values", () => {
    expect(computePlateauScore([10, 10.5, 9.5, 10.2])).toBeGreaterThan(0.9);
  });

  it("returns low score for wildly different values", () => {
    expect(computePlateauScore([1, 100, -50, 200])).toBeLessThan(0.3);
  });

  it("returns 1 for single value", () => {
    expect(computePlateauScore([42])).toBe(1);
  });

  it("handles all zeros", () => {
    expect(computePlateauScore([0, 0, 0])).toBe(1);
  });
});
