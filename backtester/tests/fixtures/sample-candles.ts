import type { Candle } from "../../src/engine/types.js";

/**
 * 100 deterministic daily candles with realistic price action.
 * Starts at 1000, trends up to ~1150, pulls back, then recovers.
 * Volume varies between 50k-200k. OI is zero (equity, not derivatives).
 */
function generateCandles(): Candle[] {
  const candles: Candle[] = [];
  let price = 1000;
  const baseDate = new Date("2024-01-01T00:00:00Z");

  // Seed-based pseudo-random for determinism
  let seed = 42;
  function rand(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 1000) / 1000;
  }

  for (let i = 0; i < 100; i++) {
    const date = new Date(baseDate.getTime() + i * 86_400_000);
    const dayStr = date.toISOString();

    // Trend component: up for first 60, down for next 20, up for last 20
    let drift: number;
    if (i < 60) drift = 0.3;
    else if (i < 80) drift = -0.5;
    else drift = 0.4;

    const change = drift + (rand() - 0.5) * 4;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + rand() * 3;
    const low = Math.min(open, close) - rand() * 3;
    const volume = 50000 + Math.floor(rand() * 150000);

    candles.push({
      timestamp: dayStr,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume,
      oi: 0,
    });

    price = close;
  }

  return candles;
}

export const SAMPLE_CANDLES = generateCandles();

/** Short 20-candle dataset for edge case testing */
export const SHORT_CANDLES = SAMPLE_CANDLES.slice(0, 20);

/** Flat candles (no price movement) for zero-division testing */
export const FLAT_CANDLES: Candle[] = Array.from({ length: 30 }, (_, i) => ({
  timestamp: new Date(
    new Date("2024-01-01").getTime() + i * 86_400_000
  ).toISOString(),
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume: 10000,
  oi: 0,
}));

/** Candles with a big dip for buy_the_dip testing */
export function generateDipCandles(): Candle[] {
  const candles: Candle[] = [];
  const baseDate = new Date("2024-01-01T00:00:00Z");

  // Stable around 1000, then 3 big dips on days 10, 20, 30
  for (let i = 0; i < 50; i++) {
    const date = new Date(baseDate.getTime() + i * 86_400_000);
    let close: number;

    if (i === 10 || i === 20 || i === 30) {
      // -2% dip
      close = candles[i - 1].close * 0.98;
    } else if (i === 0) {
      close = 1000;
    } else {
      // Slight upward drift
      close = candles[i - 1].close * 1.003;
    }

    const open = i > 0 ? candles[i - 1].close : close;
    candles.push({
      timestamp: date.toISOString(),
      open: Math.round(open * 100) / 100,
      high: Math.round(Math.max(open, close) * 1.005 * 100) / 100,
      low: Math.round(Math.min(open, close) * 0.995 * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: 100000,
      oi: 0,
    });
  }

  return candles;
}

export const DIP_CANDLES = generateDipCandles();
