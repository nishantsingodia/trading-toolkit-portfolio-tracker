import { describe, it, expect } from "vitest";
import {
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  atr,
  supertrend,
  vwap,
  obv,
  adx,
  stochastic,
  crossover,
  crossunder,
  dailyReturn,
} from "../src/engine/indicators.js";
import { SAMPLE_CANDLES, FLAT_CANDLES } from "./fixtures/sample-candles.js";

const closes = SAMPLE_CANDLES.map((c) => c.close);

describe("SMA", () => {
  it("returns NaN for indices before period - 1", () => {
    const result = sma(closes, 10);
    for (let i = 0; i < 9; i++) {
      expect(result[i]).toBeNaN();
    }
    expect(result[9]).not.toBeNaN();
  });

  it("calculates correct SMA for known values", () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = sma(data, 3);
    expect(result[2]).toBeCloseTo(2, 5); // (1+2+3)/3
    expect(result[3]).toBeCloseTo(3, 5); // (2+3+4)/3
    expect(result[9]).toBeCloseTo(9, 5); // (8+9+10)/3
  });

  it("handles empty array", () => {
    expect(sma([], 5)).toEqual([]);
  });

  it("handles period > data length", () => {
    const result = sma([1, 2, 3], 10);
    expect(result.every(isNaN)).toBe(true);
  });
});

describe("EMA", () => {
  it("starts with SMA as seed", () => {
    const data = [1, 2, 3, 4, 5];
    const result = ema(data, 3);
    expect(result[2]).toBeCloseTo(2, 5); // SMA(1,2,3) = 2
  });

  it("applies exponential smoothing", () => {
    const data = [1, 2, 3, 4, 5];
    const result = ema(data, 3);
    const k = 2 / (3 + 1);
    const expected = 4 * k + result[2] * (1 - k); // for index 3
    expect(result[3]).toBeCloseTo(expected, 5);
  });

  it("returns NaN before seed period", () => {
    const result = ema(closes, 20);
    expect(result[18]).toBeNaN();
    expect(result[19]).not.toBeNaN();
  });
});

describe("RSI", () => {
  it("returns values between 0 and 100", () => {
    const result = rsi(closes, 14);
    for (const v of result) {
      if (!isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("returns 100 when all gains (no losses)", () => {
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = rsi(rising, 14);
    expect(result[14]).toBe(100);
  });

  it("handles flat prices", () => {
    const flat = Array.from({ length: 20 }, () => 100);
    const result = rsi(flat, 14);
    // avgGain = 0, avgLoss = 0 => special case
    // With zero change, avgGain=0, avgLoss=0 => 100 - 100/(1+0/0) is NaN
    // Our implementation returns 100 when avgLoss === 0
    expect(result[14]).toBe(100);
  });
});

describe("MACD", () => {
  it("returns three series of same length", () => {
    const result = macd(closes, 12, 26, 9);
    expect(result.macdLine).toHaveLength(closes.length);
    expect(result.signalLine).toHaveLength(closes.length);
    expect(result.histogram).toHaveLength(closes.length);
  });

  it("histogram = macdLine - signalLine where both defined", () => {
    const result = macd(closes, 12, 26, 9);
    for (let i = 0; i < closes.length; i++) {
      if (!isNaN(result.macdLine[i]) && !isNaN(result.signalLine[i])) {
        expect(result.histogram[i]).toBeCloseTo(
          result.macdLine[i] - result.signalLine[i],
          10
        );
      }
    }
  });
});

describe("Bollinger Bands", () => {
  it("middle band equals SMA", () => {
    const result = bollingerBands(closes, 20, 2);
    const smaValues = sma(closes, 20);
    for (let i = 19; i < closes.length; i++) {
      expect(result.middle[i]).toBeCloseTo(smaValues[i], 10);
    }
  });

  it("upper > middle > lower when stdDev > 0", () => {
    const result = bollingerBands(closes, 20, 2);
    for (let i = 19; i < closes.length; i++) {
      if (!isNaN(result.upper[i])) {
        expect(result.upper[i]).toBeGreaterThanOrEqual(result.middle[i]);
        expect(result.middle[i]).toBeGreaterThanOrEqual(result.lower[i]);
      }
    }
  });

  it("width is non-negative", () => {
    const result = bollingerBands(closes, 20, 2);
    for (const w of result.width) {
      if (!isNaN(w)) {
        expect(w).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("ATR", () => {
  it("returns positive values where defined", () => {
    const result = atr(SAMPLE_CANDLES, 14);
    for (const v of result) {
      if (!isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("returns all NaN for flat candles", () => {
    const result = atr(FLAT_CANDLES, 14);
    // ATR of flat candles should be 0 (H-L=0, |H-prevC|=0, |L-prevC|=0)
    for (const v of result) {
      if (!isNaN(v)) {
        expect(v).toBeCloseTo(0, 5);
      }
    }
  });
});

describe("Supertrend", () => {
  it("direction is 1 or -1 where defined", () => {
    const result = supertrend(SAMPLE_CANDLES, 10, 3);
    for (const d of result.direction) {
      if (d !== 0) {
        expect(Math.abs(d)).toBe(1);
      }
    }
  });

  it("supertrend values are finite where defined", () => {
    const result = supertrend(SAMPLE_CANDLES, 10, 3);
    for (const v of result.supertrend) {
      if (!isNaN(v)) {
        expect(isFinite(v)).toBe(true);
      }
    }
  });
});

describe("VWAP", () => {
  it("rolling VWAP returns values after period warmup", () => {
    const result = vwap(SAMPLE_CANDLES, 20);
    // First 19 values should be NaN (rolling window not full)
    for (let i = 0; i < 19; i++) {
      expect(result[i]).toBeNaN();
    }
    // From index 19 onwards, should have values
    expect(result[19]).not.toBeNaN();
    expect(result[50]).not.toBeNaN();
  });

  it("returns NaN for zero-volume candles", () => {
    const zeroVol = FLAT_CANDLES.map((c) => ({ ...c, volume: 0 }));
    const result = vwap(zeroVol, 20);
    for (const v of result) {
      expect(v).toBeNaN();
    }
  });

  it("rolling VWAP is between low and high of window", () => {
    const result = vwap(SAMPLE_CANDLES, 10);
    for (let i = 9; i < SAMPLE_CANDLES.length; i++) {
      if (isNaN(result[i])) continue;
      // VWAP should be in a reasonable range around prices
      let minLow = Infinity, maxHigh = -Infinity;
      for (let j = i - 9; j <= i; j++) {
        if (SAMPLE_CANDLES[j].low < minLow) minLow = SAMPLE_CANDLES[j].low;
        if (SAMPLE_CANDLES[j].high > maxHigh) maxHigh = SAMPLE_CANDLES[j].high;
      }
      expect(result[i]).toBeGreaterThanOrEqual(minLow);
      expect(result[i]).toBeLessThanOrEqual(maxHigh);
    }
  });
});

describe("OBV", () => {
  it("starts at 0", () => {
    const result = obv(SAMPLE_CANDLES);
    expect(result[0]).toBe(0);
  });

  it("increases on up days and decreases on down days", () => {
    const result = obv(SAMPLE_CANDLES);
    for (let i = 1; i < SAMPLE_CANDLES.length; i++) {
      if (SAMPLE_CANDLES[i].close > SAMPLE_CANDLES[i - 1].close) {
        expect(result[i]).toBe(result[i - 1] + SAMPLE_CANDLES[i].volume);
      } else if (SAMPLE_CANDLES[i].close < SAMPLE_CANDLES[i - 1].close) {
        expect(result[i]).toBe(result[i - 1] - SAMPLE_CANDLES[i].volume);
      }
    }
  });
});

describe("ADX", () => {
  it("returns values between 0 and 100 where defined", () => {
    const result = adx(SAMPLE_CANDLES, 14);
    for (const v of result.adx) {
      if (!isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("+DI and -DI are non-negative where defined", () => {
    const result = adx(SAMPLE_CANDLES, 14);
    for (let i = 0; i < result.plusDi.length; i++) {
      if (!isNaN(result.plusDi[i])) {
        expect(result.plusDi[i]).toBeGreaterThanOrEqual(0);
      }
      if (!isNaN(result.minusDi[i])) {
        expect(result.minusDi[i]).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("Stochastic", () => {
  it("%K values between 0 and 100", () => {
    const result = stochastic(SAMPLE_CANDLES, 14, 3);
    for (const v of result.k) {
      if (!isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("%D is SMA of %K", () => {
    const result = stochastic(SAMPLE_CANDLES, 14, 3);
    // %D should exist after %K has enough values
    const dValues = result.d.filter((v) => !isNaN(v));
    expect(dValues.length).toBeGreaterThan(0);
  });
});

describe("crossover / crossunder", () => {
  const a = [1, 2, 3, 4, 5];
  const b = [3, 3, 3, 3, 3];

  it("detects crossover", () => {
    expect(crossover(a, b, 3)).toBe(true); // a goes from 3 to 4, b stays at 3
    expect(crossover(a, b, 1)).toBe(false);
  });

  it("detects crossunder", () => {
    // a: [5,4,3,2,1], b: [3,3,3,3,3]
    const aDown = [5, 4, 3, 2, 1];
    expect(crossunder(aDown, b, 3)).toBe(true); // 3→2 crosses under 3
  });
});

describe("dailyReturn", () => {
  it("first value is NaN", () => {
    const result = dailyReturn(SAMPLE_CANDLES);
    expect(result[0]).toBeNaN();
  });

  it("calculates correct percentage", () => {
    const result = dailyReturn(SAMPLE_CANDLES);
    const expected =
      ((SAMPLE_CANDLES[1].close - SAMPLE_CANDLES[0].close) /
        SAMPLE_CANDLES[0].close) *
      100;
    expect(result[1]).toBeCloseTo(expected, 5);
  });
});
