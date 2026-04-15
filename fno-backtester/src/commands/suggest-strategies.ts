import type {
  FnoStrategyName,
  Underlying,
  OptionsChainSnapshot,
  Candle,
  MarketContext,
  FnoSuggestResult,
  FnoStrategySuggestion,
} from "../engine/types.js";
import { FNO_STRATEGY_REGISTRY } from "../engine/strategies.js";
import { executeFnoBacktest } from "./run-backtest.js";
import { sma, rsi as calcRsi, bollingerBands } from "../engine/indicators.js";
import { getATMStrike, calculateMaxPain, calculatePCR, calculateIVPercentile } from "../engine/options-chain.js";
import { getDTE, getNextExpiry } from "../engine/expiry-calendar.js";

export interface SuggestInput {
  underlying: Underlying;
  fromDate: string;
  toDate: string;
  initialCapital?: number;
}

/**
 * Detect market context from recent data.
 */
function detectMarketContext(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[]
): MarketContext {
  const closes = spotCandles.map((c) => c.close);
  const lastChain = chainHistory[chainHistory.length - 1];
  const lastCandle = spotCandles[spotCandles.length - 1];
  const dateStr = lastCandle.timestamp.slice(0, 10);

  // Trend detection using SMA200
  const sma200 = sma(closes, Math.min(200, closes.length));
  const lastSma = sma200[sma200.length - 1];
  const rsiValues = calcRsi(closes, 14);
  const lastRsi = rsiValues[rsiValues.length - 1];
  const spotPrice = lastCandle.close;

  let regime: MarketContext["regime"] = "range_bound";
  if (!isNaN(lastSma) && !isNaN(lastRsi)) {
    if (spotPrice > lastSma * 1.03 && lastRsi > 55) regime = "trending_up";
    else if (spotPrice < lastSma * 0.97 && lastRsi < 45) regime = "trending_down";
  }

  // IV from last chain
  const atm = getATMStrike(spotPrice, "NIFTY");
  const atmData = lastChain?.strikes.get(atm);
  const currentIV = atmData ? (atmData.ce.iv + atmData.pe.iv) / 2 : 0.15;

  // VIX approximation from IV (annualized ATM IV ≈ VIX)
  const vixLevel = currentIV * 100; // e.g., 0.15 → 15

  // Bollinger Bands for volatility detection
  const bb = bollingerBands(closes, 20, 2);
  const lastWidth = bb.width[bb.width.length - 1];
  if (!isNaN(lastWidth) && lastWidth > 0.10) regime = "high_volatility";

  const ivHistory = chainHistory.map((ch) => {
    const a = getATMStrike(ch.spotPrice, "NIFTY");
    const d = ch.strikes.get(a);
    return d ? (d.ce.iv + d.pe.iv) / 2 : 0.15;
  });
  const ivPercentile = calculateIVPercentile(ivHistory.slice(0, -1), currentIV);
  const ivRank = ivHistory.length > 1
    ? ((currentIV - Math.min(...ivHistory)) / (Math.max(...ivHistory) - Math.min(...ivHistory))) * 100
    : 50;

  const expiry = getNextExpiry("NIFTY", dateStr, "weekly");
  const dte = getDTE(dateStr, expiry);

  const pcr = lastChain ? calculatePCR(lastChain) : 1.0;
  const maxPainStrike = lastChain ? calculateMaxPain(lastChain) : spotPrice;

  const time = lastCandle.timestamp.slice(11, 16) || "12:00";

  return {
    regime,
    vixLevel,
    ivPercentile,
    ivRank,
    dte,
    timeOfDay: time,
    pcr,
    maxPainStrike,
  };
}

/**
 * Suggest best F&O strategies based on current market context.
 * Runs each compatible strategy and ranks by composite score.
 */
export function suggestFnoStrategies(
  input: SuggestInput,
  prefetchedData: {
    spotCandles: Candle[];
    chainHistory: OptionsChainSnapshot[];
  }
): FnoSuggestResult {
  const context = detectMarketContext(
    prefetchedData.chainHistory,
    prefetchedData.spotCandles
  );

  // Filter strategies compatible with current regime and VIX
  const compatibleStrategies = Object.values(FNO_STRATEGY_REGISTRY).filter(
    (strat) =>
      strat.regimes.includes(context.regime) &&
      context.vixLevel >= strat.vixRange.min &&
      context.vixLevel <= strat.vixRange.max
  );

  const suggestions: FnoStrategySuggestion[] = [];

  for (const strat of compatibleStrategies) {
    try {
      const result = executeFnoBacktest(
        {
          underlying: input.underlying,
          fromDate: input.fromDate,
          toDate: input.toDate,
          strategy: strat.name,
          initialCapital: input.initialCapital,
        },
        prefetchedData
      );

      // Composite score: 40% return + 20% Sharpe + 20% win rate + 20% inverse DD
      const returnScore = result.metrics.totalReturnPct;
      const sharpeScore = Math.min(result.metrics.sharpeRatio * 20, 100);
      const winRateScore = result.metrics.winRate * 100;
      const ddScore = Math.max(0, 100 - result.metrics.maxDrawdownPct);
      const score = returnScore * 0.4 + sharpeScore * 0.2 + winRateScore * 0.2 + ddScore * 0.2;

      suggestions.push({
        strategy: strat.name,
        score,
        metrics: result.metrics,
        rank: 0,
      });
    } catch {
      // Skip strategies that error out
    }
  }

  suggestions.sort((a, b) => b.score - a.score);
  suggestions.forEach((s, i) => (s.rank = i + 1));

  return {
    context,
    suggestions,
    recommendedStrategy: suggestions[0]?.strategy ?? "iron_condor",
  };
}
