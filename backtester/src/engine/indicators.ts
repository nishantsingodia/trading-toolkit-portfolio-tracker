import type {
  Candle,
  MacdResult,
  BollingerResult,
  SupertrendResult,
  StochasticResult,
  AdxResult,
} from "./types.js";

/**
 * Simple Moving Average — rolling sum with sliding window.
 * Returns NaN for indices < period - 1.
 */
export function sma(closes: number[], period: number): number[] {
  const result = new Array<number>(closes.length).fill(NaN);
  if (period <= 0 || closes.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i];
  }
  result[period - 1] = sum / period;

  for (let i = period; i < closes.length; i++) {
    sum += closes[i] - closes[i - period];
    result[i] = sum / period;
  }
  return result;
}

/**
 * Exponential Moving Average — SMA seed, then recursive EMA.
 * k = 2 / (period + 1)
 */
export function ema(closes: number[], period: number): number[] {
  const result = new Array<number>(closes.length).fill(NaN);
  if (period <= 0 || closes.length < period) return result;

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i];
  }
  result[period - 1] = sum / period;

  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/**
 * Relative Strength Index — Wilder's smoothed average gain/loss.
 * RSI = 100 - 100 / (1 + avgGain / avgLoss)
 * Returns 100 when avgLoss === 0 (all gains), 0 when avgGain === 0.
 */
export function rsi(closes: number[], period: number): number[] {
  const result = new Array<number>(closes.length).fill(NaN);
  if (period <= 0 || closes.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average over first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] =
    avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder's smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    result[i] =
      avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

/**
 * MACD — EMA(fast) - EMA(slow), signal line = EMA of MACD line.
 * Histogram = MACD line - signal line.
 */
export function macd(
  closes: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number
): MacdResult {
  const len = closes.length;
  const macdLine = new Array<number>(len).fill(NaN);
  const signalLine = new Array<number>(len).fill(NaN);
  const histogram = new Array<number>(len).fill(NaN);

  const fastEma = ema(closes, fastPeriod);
  const slowEma = ema(closes, slowPeriod);

  // MACD line starts when both EMAs are available
  const macdStart = slowPeriod - 1;
  for (let i = macdStart; i < len; i++) {
    if (!isNaN(fastEma[i]) && !isNaN(slowEma[i])) {
      macdLine[i] = fastEma[i] - slowEma[i];
    }
  }

  // Signal line = EMA of MACD values (only non-NaN portion)
  const macdValues: number[] = [];
  const macdIndices: number[] = [];
  for (let i = 0; i < len; i++) {
    if (!isNaN(macdLine[i])) {
      macdValues.push(macdLine[i]);
      macdIndices.push(i);
    }
  }

  if (macdValues.length >= signalPeriod) {
    const sigEma = ema(macdValues, signalPeriod);
    for (let j = 0; j < macdValues.length; j++) {
      if (!isNaN(sigEma[j])) {
        const idx = macdIndices[j];
        signalLine[idx] = sigEma[j];
        histogram[idx] = macdLine[idx] - sigEma[j];
      }
    }
  }

  return { macdLine, signalLine, histogram };
}

/**
 * Bollinger Bands — SMA +/- stdDev * rolling standard deviation.
 * Width = (upper - lower) / middle.
 */
export function bollingerBands(
  closes: number[],
  period: number,
  stdDevMultiplier: number
): BollingerResult {
  const len = closes.length;
  const upper = new Array<number>(len).fill(NaN);
  const middle = new Array<number>(len).fill(NaN);
  const lower = new Array<number>(len).fill(NaN);
  const width = new Array<number>(len).fill(NaN);

  const smaValues = sma(closes, period);

  for (let i = period - 1; i < len; i++) {
    const mean = smaValues[i];
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - mean;
      sumSq += diff * diff;
    }
    const std = Math.sqrt(sumSq / period);

    middle[i] = mean;
    upper[i] = mean + stdDevMultiplier * std;
    lower[i] = mean - stdDevMultiplier * std;
    width[i] = mean !== 0 ? (upper[i] - lower[i]) / mean : NaN;
  }

  return { upper, middle, lower, width };
}

/**
 * Average True Range — Wilder's smoothed True Range.
 * TR = max(H-L, |H-prevC|, |L-prevC|)
 */
export function atr(candles: Candle[], period: number): number[] {
  const len = candles.length;
  const result = new Array<number>(len).fill(NaN);
  if (period <= 0 || len < period + 1) return result;

  // True Range series (starts at index 1)
  const tr = new Array<number>(len).fill(0);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < len; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }

  // Initial ATR = simple average of first `period` TRs (starting from index 1)
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += tr[i];
  }
  result[period] = sum / period;

  // Wilder's smoothing
  for (let i = period + 1; i < len; i++) {
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
  }
  return result;
}

/**
 * Supertrend — (H+L)/2 +/- multiplier*ATR with band clamping and direction flip.
 * Direction: 1 = bullish (price above supertrend), -1 = bearish.
 */
export function supertrend(
  candles: Candle[],
  period: number,
  multiplier: number
): SupertrendResult {
  const len = candles.length;
  const st = new Array<number>(len).fill(NaN);
  const direction = new Array<number>(len).fill(0);

  const atrValues = atr(candles, period);

  const upperBand = new Array<number>(len).fill(NaN);
  const lowerBand = new Array<number>(len).fill(NaN);

  // Start from first valid ATR
  const start = period;
  for (let i = start; i < len; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const atrVal = atrValues[i];
    if (isNaN(atrVal)) continue;

    let ub = hl2 + multiplier * atrVal;
    let lb = hl2 - multiplier * atrVal;

    // Band clamping: lower band can only go up, upper band can only go down
    if (i > start && !isNaN(lowerBand[i - 1])) {
      lb =
        candles[i - 1].close > lowerBand[i - 1]
          ? Math.max(lb, lowerBand[i - 1])
          : lb;
    }
    if (i > start && !isNaN(upperBand[i - 1])) {
      ub =
        candles[i - 1].close < upperBand[i - 1]
          ? Math.min(ub, upperBand[i - 1])
          : ub;
    }

    upperBand[i] = ub;
    lowerBand[i] = lb;

    // Direction logic
    if (i === start) {
      direction[i] = candles[i].close > ub ? 1 : -1;
    } else {
      if (direction[i - 1] === 1) {
        direction[i] = candles[i].close < lowerBand[i] ? -1 : 1;
      } else {
        direction[i] = candles[i].close > upperBand[i] ? 1 : -1;
      }
    }

    st[i] = direction[i] === 1 ? lowerBand[i] : upperBand[i];
  }

  return { supertrend: st, direction };
}

/**
 * Volume Weighted Average Price.
 * Cumulative (typical_price * volume) / cumulative volume.
 * For daily candles, no reset is needed. For intraday, resets each day.
 */
export function vwap(candles: Candle[]): number[] {
  const len = candles.length;
  const result = new Array<number>(len).fill(NaN);

  let cumTPV = 0;
  let cumVol = 0;
  let lastDate = "";

  for (let i = 0; i < len; i++) {
    const currentDate = candles[i].timestamp.slice(0, 10);

    // Reset on new day (for intraday data)
    if (currentDate !== lastDate) {
      cumTPV = 0;
      cumVol = 0;
      lastDate = currentDate;
    }

    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumTPV += tp * candles[i].volume;
    cumVol += candles[i].volume;

    result[i] = cumVol !== 0 ? cumTPV / cumVol : NaN;
  }
  return result;
}

/**
 * On Balance Volume — running sum: +volume on up days, -volume on down days.
 */
export function obv(candles: Candle[]): number[] {
  const len = candles.length;
  const result = new Array<number>(len).fill(0);
  if (len === 0) return result;

  result[0] = 0;
  for (let i = 1; i < len; i++) {
    if (candles[i].close > candles[i - 1].close) {
      result[i] = result[i - 1] + candles[i].volume;
    } else if (candles[i].close < candles[i - 1].close) {
      result[i] = result[i - 1] - candles[i].volume;
    } else {
      result[i] = result[i - 1];
    }
  }
  return result;
}

/**
 * Average Directional Index — Wilder-smoothed +DI, -DI, and ADX.
 * Measures trend strength regardless of direction.
 */
export function adx(candles: Candle[], period: number): AdxResult {
  const len = candles.length;
  const adxResult = new Array<number>(len).fill(NaN);
  const plusDi = new Array<number>(len).fill(NaN);
  const minusDi = new Array<number>(len).fill(NaN);

  if (period <= 0 || len < 2 * period + 1) {
    return { adx: adxResult, plusDi, minusDi };
  }

  // +DM, -DM, TR series
  const plusDM = new Array<number>(len).fill(0);
  const minusDM = new Array<number>(len).fill(0);
  const tr = new Array<number>(len).fill(0);

  for (let i = 1; i < len; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;

    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;

    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }

  // Initial sums for Wilder's smoothing
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;
  let smoothTR = 0;
  for (let i = 1; i <= period; i++) {
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
    smoothTR += tr[i];
  }

  const dx = new Array<number>(len).fill(NaN);
  const firstDiIdx = period;

  plusDi[firstDiIdx] =
    smoothTR !== 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
  minusDi[firstDiIdx] =
    smoothTR !== 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
  const diSum = plusDi[firstDiIdx] + minusDi[firstDiIdx];
  dx[firstDiIdx] =
    diSum !== 0
      ? (Math.abs(plusDi[firstDiIdx] - minusDi[firstDiIdx]) / diSum) * 100
      : 0;

  for (let i = period + 1; i < len; i++) {
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
    smoothTR = smoothTR - smoothTR / period + tr[i];

    plusDi[i] = smoothTR !== 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    minusDi[i] = smoothTR !== 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const s = plusDi[i] + minusDi[i];
    dx[i] = s !== 0 ? (Math.abs(plusDi[i] - minusDi[i]) / s) * 100 : 0;
  }

  // ADX = Wilder-smoothed DX, starting at 2*period
  const adxStart = 2 * period;
  if (adxStart < len) {
    let adxSum = 0;
    for (let i = period; i <= adxStart; i++) {
      adxSum += dx[i];
    }
    adxResult[adxStart] = adxSum / (period + 1);

    for (let i = adxStart + 1; i < len; i++) {
      adxResult[i] =
        (adxResult[i - 1] * (period - 1) + dx[i]) / period;
    }
  }

  return { adx: adxResult, plusDi, minusDi };
}

/**
 * Stochastic Oscillator.
 * %K = (close - lowest_low_n) / (highest_high_n - lowest_low_n) * 100
 * %D = SMA(%K, dPeriod)
 */
export function stochastic(
  candles: Candle[],
  kPeriod: number,
  dPeriod: number
): StochasticResult {
  const len = candles.length;
  const k = new Array<number>(len).fill(NaN);
  const d = new Array<number>(len).fill(NaN);

  if (kPeriod <= 0 || len < kPeriod) return { k, d };

  for (let i = kPeriod - 1; i < len; i++) {
    let lowestLow = Infinity;
    let highestHigh = -Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].low < lowestLow) lowestLow = candles[j].low;
      if (candles[j].high > highestHigh) highestHigh = candles[j].high;
    }
    const range = highestHigh - lowestLow;
    k[i] = range !== 0 ? ((candles[i].close - lowestLow) / range) * 100 : 50;
  }

  // %D = SMA of %K
  const kValues = k.filter((v) => !isNaN(v));
  if (kValues.length >= dPeriod) {
    const dSma = sma(kValues, dPeriod);
    let kIdx = 0;
    for (let i = 0; i < len; i++) {
      if (!isNaN(k[i])) {
        if (!isNaN(dSma[kIdx])) {
          d[i] = dSma[kIdx];
        }
        kIdx++;
      }
    }
  }

  return { k, d };
}

// --- Utility functions ---

/** Detect if series `a` crosses above series `b` at index `i` */
export function crossover(a: number[], b: number[], i: number): boolean {
  if (i < 1) return false;
  return (
    !isNaN(a[i]) &&
    !isNaN(b[i]) &&
    !isNaN(a[i - 1]) &&
    !isNaN(b[i - 1]) &&
    a[i - 1] <= b[i - 1] &&
    a[i] > b[i]
  );
}

/** Detect if series `a` crosses below series `b` at index `i` */
export function crossunder(a: number[], b: number[], i: number): boolean {
  if (i < 1) return false;
  return (
    !isNaN(a[i]) &&
    !isNaN(b[i]) &&
    !isNaN(a[i - 1]) &&
    !isNaN(b[i - 1]) &&
    a[i - 1] >= b[i - 1] &&
    a[i] < b[i]
  );
}

/** Calculate daily return percentage for each candle */
export function dailyReturn(candles: Candle[]): number[] {
  const result = new Array<number>(candles.length).fill(NaN);
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    result[i] = prev !== 0 ? ((candles[i].close - prev) / prev) * 100 : NaN;
  }
  return result;
}
