import type {
  Candle,
  Signal,
  SmaCrossoverParams,
  EmaCrossoverParams,
  SupertrendParams,
  VwapCrossoverParams,
  RsiParams,
  MacdParams,
  BollingerSqueezeParams,
  StochasticCrossoverParams,
  AtrTrailingStopParams,
  BuyTheDipParams,
  StrategyName,
} from "./types.js";

import {
  sma,
  ema,
  rsi as calcRsi,
  macd as calcMacd,
  bollingerBands,
  supertrend as calcSupertrend,
  vwap as calcVwap,
  stochastic as calcStochastic,
  atr as calcAtr,
  adx as calcAdx,
  crossover,
  crossunder,
  dailyReturn,
} from "./indicators.js";

/** SMA Crossover — golden/death cross */
export function smaCrossover(
  candles: Candle[],
  params: SmaCrossoverParams
): Signal[] {
  const closes = candles.map((c) => c.close);
  const fast = sma(closes, params.fastPeriod);
  const slow = sma(closes, params.slowPeriod);
  const signals: Signal[] = [];

  for (let i = 1; i < candles.length; i++) {
    if (crossover(fast, slow, i)) {
      signals.push({
        index: i,
        type: "BUY",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: `SMA ${params.fastPeriod} crossed above SMA ${params.slowPeriod}`,
      });
    } else if (crossunder(fast, slow, i)) {
      signals.push({
        index: i,
        type: "SELL",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: `SMA ${params.fastPeriod} crossed below SMA ${params.slowPeriod}`,
      });
    }
  }
  return signals;
}

/** EMA Crossover — faster trend following */
export function emaCrossover(
  candles: Candle[],
  params: EmaCrossoverParams
): Signal[] {
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, params.fastPeriod);
  const slow = ema(closes, params.slowPeriod);
  const signals: Signal[] = [];

  for (let i = 1; i < candles.length; i++) {
    if (crossover(fast, slow, i)) {
      signals.push({
        index: i,
        type: "BUY",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: `EMA ${params.fastPeriod} crossed above EMA ${params.slowPeriod}`,
      });
    } else if (crossunder(fast, slow, i)) {
      signals.push({
        index: i,
        type: "SELL",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: `EMA ${params.fastPeriod} crossed below EMA ${params.slowPeriod}`,
      });
    }
  }
  return signals;
}

/** Supertrend — direction change signals */
export function supertrendStrategy(
  candles: Candle[],
  params: SupertrendParams
): Signal[] {
  const { supertrend: _st, direction } = calcSupertrend(
    candles,
    params.period,
    params.multiplier
  );
  const signals: Signal[] = [];

  for (let i = 1; i < candles.length; i++) {
    if (direction[i] === 1 && direction[i - 1] === -1) {
      signals.push({
        index: i,
        type: "BUY",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: "Supertrend turned bullish",
      });
    } else if (direction[i] === -1 && direction[i - 1] === 1) {
      signals.push({
        index: i,
        type: "SELL",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: "Supertrend turned bearish",
      });
    }
  }
  return signals;
}

/** VWAP Crossover — long above VWAP, short below */
export function vwapCrossover(
  candles: Candle[],
  _params: VwapCrossoverParams
): Signal[] {
  const vwapValues = calcVwap(candles);
  const closes = candles.map((c) => c.close);
  const signals: Signal[] = [];

  for (let i = 1; i < candles.length; i++) {
    if (crossover(closes, vwapValues, i)) {
      signals.push({
        index: i,
        type: "BUY",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: "Price crossed above VWAP",
      });
    } else if (crossunder(closes, vwapValues, i)) {
      signals.push({
        index: i,
        type: "SELL",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: "Price crossed below VWAP",
      });
    }
  }
  return signals;
}

/** RSI Overbought/Oversold */
export function rsiStrategy(
  candles: Candle[],
  params: RsiParams
): Signal[] {
  const closes = candles.map((c) => c.close);
  const rsiValues = calcRsi(closes, params.period);
  const signals: Signal[] = [];

  for (let i = 1; i < candles.length; i++) {
    if (isNaN(rsiValues[i]) || isNaN(rsiValues[i - 1])) continue;

    // Buy when RSI crosses above oversold from below
    if (rsiValues[i - 1] <= params.oversold && rsiValues[i] > params.oversold) {
      signals.push({
        index: i,
        type: "BUY",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: `RSI crossed above ${params.oversold} (was ${rsiValues[i - 1].toFixed(1)}, now ${rsiValues[i].toFixed(1)})`,
      });
    }
    // Sell when RSI crosses below overbought from above
    else if (
      rsiValues[i - 1] >= params.overbought &&
      rsiValues[i] < params.overbought
    ) {
      signals.push({
        index: i,
        type: "SELL",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: `RSI crossed below ${params.overbought} (was ${rsiValues[i - 1].toFixed(1)}, now ${rsiValues[i].toFixed(1)})`,
      });
    }
  }
  return signals;
}

/** MACD Signal Cross */
export function macdSignalCross(
  candles: Candle[],
  params: MacdParams
): Signal[] {
  const closes = candles.map((c) => c.close);
  const { macdLine, signalLine } = calcMacd(
    closes,
    params.fastPeriod,
    params.slowPeriod,
    params.signalPeriod
  );
  const signals: Signal[] = [];

  for (let i = 1; i < candles.length; i++) {
    if (crossover(macdLine, signalLine, i)) {
      signals.push({
        index: i,
        type: "BUY",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: "MACD crossed above signal line",
      });
    } else if (crossunder(macdLine, signalLine, i)) {
      signals.push({
        index: i,
        type: "SELL",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: "MACD crossed below signal line",
      });
    }
  }
  return signals;
}

/** Bollinger Squeeze — breakout after low bandwidth */
export function bollingerSqueeze(
  candles: Candle[],
  params: BollingerSqueezeParams
): Signal[] {
  const closes = candles.map((c) => c.close);
  const { upper, lower, width } = bollingerBands(
    closes,
    params.period,
    params.stdDev
  );
  const signals: Signal[] = [];

  // Find average width for squeeze detection
  let widthSum = 0;
  let widthCount = 0;
  for (let i = 0; i < width.length; i++) {
    if (!isNaN(width[i])) {
      widthSum += width[i];
      widthCount++;
    }
  }
  const avgWidth = widthCount > 0 ? widthSum / widthCount : 0;
  const squeezeLevel = avgWidth * params.squeezeThreshold;

  let inSqueeze = false;

  for (let i = 1; i < candles.length; i++) {
    if (isNaN(width[i]) || isNaN(upper[i]) || isNaN(lower[i])) continue;

    if (width[i] < squeezeLevel) {
      inSqueeze = true;
    } else if (inSqueeze) {
      // Squeeze released — breakout direction
      inSqueeze = false;
      if (candles[i].close > upper[i]) {
        signals.push({
          index: i,
          type: "BUY",
          price: candles[i].close,
          date: candles[i].timestamp,
          reason: "Bollinger squeeze breakout upward",
        });
      } else if (candles[i].close < lower[i]) {
        signals.push({
          index: i,
          type: "SELL",
          price: candles[i].close,
          date: candles[i].timestamp,
          reason: "Bollinger squeeze breakout downward",
        });
      }
    }
  }
  return signals;
}

/** Stochastic Crossover — %K/%D crossover in extreme zones */
export function stochasticCrossover(
  candles: Candle[],
  params: StochasticCrossoverParams
): Signal[] {
  const { k, d } = calcStochastic(candles, params.kPeriod, params.dPeriod);
  const signals: Signal[] = [];

  for (let i = 1; i < candles.length; i++) {
    if (isNaN(k[i]) || isNaN(d[i]) || isNaN(k[i - 1]) || isNaN(d[i - 1]))
      continue;

    // Buy: %K crosses above %D in oversold zone
    if (
      k[i - 1] <= params.oversold &&
      crossover(k, d, i)
    ) {
      signals.push({
        index: i,
        type: "BUY",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: `Stochastic %K crossed above %D in oversold zone (K=${k[i].toFixed(1)})`,
      });
    }
    // Sell: %K crosses below %D in overbought zone
    else if (
      k[i - 1] >= params.overbought &&
      crossunder(k, d, i)
    ) {
      signals.push({
        index: i,
        type: "SELL",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: `Stochastic %K crossed below %D in overbought zone (K=${k[i].toFixed(1)})`,
      });
    }
  }
  return signals;
}

/** ATR Trailing Stop — trend entry via ADX, volatility-adaptive stop */
export function atrTrailingStop(
  candles: Candle[],
  params: AtrTrailingStopParams
): Signal[] {
  const atrValues = calcAtr(candles, params.atrPeriod);
  const { adx: adxValues } = calcAdx(candles, params.adxPeriod);
  const signals: Signal[] = [];

  let inPosition = false;
  let trailingStop = 0;
  let highSinceEntry = 0;

  for (let i = 1; i < candles.length; i++) {
    if (isNaN(atrValues[i]) || isNaN(adxValues[i])) continue;

    if (!inPosition) {
      // Enter when ADX confirms a trend
      if (
        adxValues[i] > params.adxThreshold &&
        candles[i].close > candles[i - 1].close
      ) {
        inPosition = true;
        highSinceEntry = candles[i].high;
        trailingStop = candles[i].close - params.multiplier * atrValues[i];
        signals.push({
          index: i,
          type: "BUY",
          price: candles[i].close,
          date: candles[i].timestamp,
          reason: `ADX ${adxValues[i].toFixed(1)} > ${params.adxThreshold}, trend entry`,
        });
      }
    } else {
      // Update trailing stop
      if (candles[i].high > highSinceEntry) {
        highSinceEntry = candles[i].high;
      }
      const newStop = highSinceEntry - params.multiplier * atrValues[i];
      if (newStop > trailingStop) {
        trailingStop = newStop;
      }

      // Exit if price hits trailing stop
      if (candles[i].low <= trailingStop) {
        inPosition = false;
        signals.push({
          index: i,
          type: "SELL",
          price: Math.max(candles[i].open, trailingStop), // slippage-aware
          date: candles[i].timestamp,
          reason: `ATR trailing stop hit at ${trailingStop.toFixed(2)}`,
        });
      }
    }
  }
  return signals;
}

/**
 * Buy the Dip — buys when daily return drops by buyDropPct or more.
 * Exits on first of: target hit, stop loss hit, max hold period.
 * Signals are paired BUY/SELL — the backtester handles accumulation mode.
 */
export function buyTheDip(
  candles: Candle[],
  params: BuyTheDipParams
): Signal[] {
  const returns = dailyReturn(candles);
  const signals: Signal[] = [];

  interface OpenPosition {
    entryIndex: number;
    entryPrice: number;
  }

  const openPositions: OpenPosition[] = [];

  for (let i = 1; i < candles.length; i++) {
    // Check exits for open positions (iterate backwards for safe removal)
    for (let j = openPositions.length - 1; j >= 0; j--) {
      const pos = openPositions[j];
      const pnlPct =
        ((candles[i].close - pos.entryPrice) / pos.entryPrice) * 100;
      const holdDays = i - pos.entryIndex;

      let exitReason = "";
      if (pnlPct >= params.sellTargetPct) {
        exitReason = `Target hit: ${pnlPct.toFixed(2)}% >= ${params.sellTargetPct}%`;
      } else if (pnlPct <= params.stopLossPct) {
        exitReason = `Stop loss hit: ${pnlPct.toFixed(2)}% <= ${params.stopLossPct}%`;
      } else if (holdDays >= params.maxHoldDays) {
        exitReason = `Max hold ${params.maxHoldDays} days reached`;
      }

      if (exitReason) {
        signals.push({
          index: i,
          type: "SELL",
          price: candles[i].close,
          date: candles[i].timestamp,
          reason: exitReason,
        });
        openPositions.splice(j, 1);
      }
    }

    // Check for new dip entry
    if (!isNaN(returns[i]) && returns[i] <= params.buyDropPct) {
      signals.push({
        index: i,
        type: "BUY",
        price: candles[i].close,
        date: candles[i].timestamp,
        reason: `Daily return ${returns[i].toFixed(2)}% <= ${params.buyDropPct}%`,
      });
      openPositions.push({ entryIndex: i, entryPrice: candles[i].close });
    }
  }

  // Force-close remaining positions at the end
  if (openPositions.length > 0) {
    const lastCandle = candles[candles.length - 1];
    for (const pos of openPositions) {
      signals.push({
        index: candles.length - 1,
        type: "SELL",
        price: lastCandle.close,
        date: lastCandle.timestamp,
        reason: `Forced exit at end of data (held from index ${pos.entryIndex})`,
      });
    }
  }

  return signals;
}

// --- Strategy Registry ---

export interface StrategyEntry {
  name: StrategyName;
  fn: (candles: Candle[], params: Record<string, number | string>) => Signal[];
  defaults: Record<string, number | string>;
  description: string;
  regimes: string[];
}

export const STRATEGY_REGISTRY: Record<StrategyName, StrategyEntry> = {
  sma_crossover: {
    name: "sma_crossover",
    fn: (c, p) =>
      smaCrossover(c, {
        fastPeriod: Number(p.fastPeriod),
        slowPeriod: Number(p.slowPeriod),
      }),
    defaults: { fastPeriod: 50, slowPeriod: 200 },
    description: "SMA golden/death cross",
    regimes: ["trending_up", "trending_down"],
  },
  ema_crossover: {
    name: "ema_crossover",
    fn: (c, p) =>
      emaCrossover(c, {
        fastPeriod: Number(p.fastPeriod),
        slowPeriod: Number(p.slowPeriod),
      }),
    defaults: { fastPeriod: 12, slowPeriod: 26 },
    description: "EMA fast trend following",
    regimes: ["trending_up", "trending_down"],
  },
  supertrend: {
    name: "supertrend",
    fn: (c, p) =>
      supertrendStrategy(c, {
        period: Number(p.period),
        multiplier: Number(p.multiplier),
      }),
    defaults: { period: 10, multiplier: 3 },
    description: "Supertrend direction change",
    regimes: ["trending_up", "trending_down"],
  },
  vwap_crossover: {
    name: "vwap_crossover",
    fn: (c, p) => vwapCrossover(c, { anchor: String(p.anchor) }),
    defaults: { anchor: "day" },
    description: "VWAP crossover for intraday/swing",
    regimes: ["range_bound"],
  },
  rsi_overbought_oversold: {
    name: "rsi_overbought_oversold",
    fn: (c, p) =>
      rsiStrategy(c, {
        period: Number(p.period),
        overbought: Number(p.overbought),
        oversold: Number(p.oversold),
      }),
    defaults: { period: 14, overbought: 70, oversold: 30 },
    description: "RSI overbought/oversold reversal",
    regimes: ["range_bound"],
  },
  macd_signal_cross: {
    name: "macd_signal_cross",
    fn: (c, p) =>
      macdSignalCross(c, {
        fastPeriod: Number(p.fastPeriod),
        slowPeriod: Number(p.slowPeriod),
        signalPeriod: Number(p.signalPeriod),
      }),
    defaults: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    description: "MACD/signal line crossover",
    regimes: ["trending_up", "trending_down"],
  },
  bollinger_squeeze: {
    name: "bollinger_squeeze",
    fn: (c, p) =>
      bollingerSqueeze(c, {
        period: Number(p.period),
        stdDev: Number(p.stdDev),
        squeezeThreshold: Number(p.squeezeThreshold),
      }),
    defaults: { period: 20, stdDev: 2, squeezeThreshold: 0.5 },
    description: "Bollinger band squeeze breakout",
    regimes: ["high_volatility"],
  },
  stochastic_crossover: {
    name: "stochastic_crossover",
    fn: (c, p) =>
      stochasticCrossover(c, {
        kPeriod: Number(p.kPeriod),
        dPeriod: Number(p.dPeriod),
        overbought: Number(p.overbought),
        oversold: Number(p.oversold),
      }),
    defaults: { kPeriod: 14, dPeriod: 3, overbought: 80, oversold: 20 },
    description: "Stochastic %K/%D crossover in extremes",
    regimes: ["range_bound"],
  },
  atr_trailing_stop: {
    name: "atr_trailing_stop",
    fn: (c, p) =>
      atrTrailingStop(c, {
        atrPeriod: Number(p.atrPeriod),
        multiplier: Number(p.multiplier),
        adxPeriod: Number(p.adxPeriod),
        adxThreshold: Number(p.adxThreshold),
      }),
    defaults: { atrPeriod: 14, multiplier: 3, adxPeriod: 14, adxThreshold: 25 },
    description: "ATR trailing stop with ADX trend filter",
    regimes: ["trending_up"],
  },
  buy_the_dip: {
    name: "buy_the_dip",
    fn: (c, p) =>
      buyTheDip(c, {
        buyDropPct: Number(p.buyDropPct),
        sellTargetPct: Number(p.sellTargetPct),
        stopLossPct: Number(p.stopLossPct),
        maxHoldDays: Number(p.maxHoldDays),
      }),
    defaults: {
      buyDropPct: -1,
      sellTargetPct: 3,
      stopLossPct: -2,
      maxHoldDays: 30,
    },
    description: "Buy on dips, sell on target/stop/time",
    regimes: ["trending_up", "range_bound"],
  },
};
