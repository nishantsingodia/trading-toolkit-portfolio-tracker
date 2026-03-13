import type {
  StrategyName,
  MarketRegime,
  PerformanceMetrics,
  SuggestResult,
  StrategySuggestion,
  Candle,
} from "../engine/types.js";
import { fetchHistoricalCandles } from "../api/historical-candles.js";
import { STRATEGY_REGISTRY } from "../engine/strategies.js";
import { runBacktest } from "../engine/backtester.js";
import { calculateMetrics } from "../engine/metrics.js";
import { sma, rsi, bollingerBands } from "../engine/indicators.js";

export interface SuggestInput {
  instrumentKey: string;
  interval?: "1minute" | "30minute" | "day" | "week" | "month";
  lookbackDays?: number;
  accessToken: string;
}

/**
 * Detect market regime from recent price action.
 * Uses price vs 200 SMA, RSI range, and Bollinger width.
 */
function detectRegime(candles: Candle[]): MarketRegime {
  const closes = candles.map((c) => c.close);

  // Price vs 200 SMA (or use all data if < 200)
  const smaPeriod = Math.min(200, Math.floor(closes.length * 0.8));
  const smaValues = sma(closes, smaPeriod);
  const lastSma = smaValues[smaValues.length - 1];
  const lastClose = closes[closes.length - 1];

  // RSI
  const rsiValues = rsi(closes, 14);
  const recentRsi: number[] = [];
  for (let i = Math.max(0, rsiValues.length - 20); i < rsiValues.length; i++) {
    if (!isNaN(rsiValues[i])) recentRsi.push(rsiValues[i]);
  }
  const avgRsi =
    recentRsi.length > 0
      ? recentRsi.reduce((a, b) => a + b, 0) / recentRsi.length
      : 50;

  // Bollinger width for volatility
  const bb = bollingerBands(closes, 20, 2);
  const recentWidth: number[] = [];
  for (let i = Math.max(0, bb.width.length - 20); i < bb.width.length; i++) {
    if (!isNaN(bb.width[i])) recentWidth.push(bb.width[i]);
  }
  const avgWidth =
    recentWidth.length > 0
      ? recentWidth.reduce((a, b) => a + b, 0) / recentWidth.length
      : 0;

  // High volatility check (width > 10% of price)
  if (avgWidth > 0.10) return "high_volatility";

  // Trend detection
  if (!isNaN(lastSma)) {
    const pctAboveSma = ((lastClose - lastSma) / lastSma) * 100;
    if (pctAboveSma > 3 && avgRsi > 55) return "trending_up";
    if (pctAboveSma < -3 && avgRsi < 45) return "trending_down";
  }

  return "range_bound";
}

/**
 * Calculate composite score for ranking.
 * 40% return, 20% Sharpe, 20% win rate, 20% inverse drawdown.
 */
function compositeScore(metrics: PerformanceMetrics): number {
  const returnScore = metrics.totalReturnPct;
  const sharpeScore = metrics.sharpeRatio * 10; // Scale up Sharpe
  const winRateScore = metrics.winRate * 100;
  const ddScore = Math.max(0, 100 - metrics.maxDrawdownPct); // Lower DD = higher score

  return (
    0.4 * returnScore +
    0.2 * sharpeScore +
    0.2 * winRateScore +
    0.2 * ddScore
  );
}

export async function suggestStrategies(
  input: SuggestInput
): Promise<SuggestResult> {
  const interval = input.interval ?? "day";
  const lookbackDays = input.lookbackDays ?? 90;

  const toDate = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const candles = await fetchHistoricalCandles({
    instrumentKey: input.instrumentKey,
    interval,
    fromDate,
    toDate,
    accessToken: input.accessToken,
  });

  if (candles.length === 0) {
    throw new Error("No candle data returned for suggestion period");
  }

  return suggestWithCandles(candles);
}

/**
 * Run suggestion logic with pre-fetched candles. Exported for testing.
 */
export function suggestWithCandles(candles: Candle[]): SuggestResult {
  const regime = detectRegime(candles);
  const initialCapital = 100_000;
  const quantity = 1;

  const strategyNames = Object.keys(STRATEGY_REGISTRY) as StrategyName[];
  const suggestions: StrategySuggestion[] = [];

  for (const name of strategyNames) {
    const strategyDef = STRATEGY_REGISTRY[name];
    const signals = strategyDef.fn(candles, strategyDef.defaults);
    const isAccumulation = name === "buy_the_dip";
    const { trades, equityCurve } = runBacktest(candles, signals, {
      initialCapital,
      quantity,
      allowAccumulation: isAccumulation,
    });
    const metrics = calculateMetrics(trades, equityCurve, initialCapital);
    const score = compositeScore(metrics);

    suggestions.push({ strategy: name, score, metrics, rank: 0 });
  }

  // Sort by score descending
  suggestions.sort((a, b) => b.score - a.score);
  suggestions.forEach((s, i) => {
    s.rank = i + 1;
  });

  // Recommend the best strategy that matches the detected regime
  const regimeMatch = suggestions.find((s) =>
    STRATEGY_REGISTRY[s.strategy].regimes.includes(regime)
  );
  const recommendedStrategy = regimeMatch
    ? regimeMatch.strategy
    : suggestions[0].strategy;

  return {
    regime,
    suggestions,
    recommendedStrategy,
  };
}
