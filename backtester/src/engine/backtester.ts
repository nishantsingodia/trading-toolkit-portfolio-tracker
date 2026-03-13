import type {
  Candle,
  Signal,
  Trade,
  EquityPoint,
  DrawdownPoint,
  BacktestConfig,
} from "./types.js";

interface OpenPosition {
  entryDate: string;
  entryPrice: number;
  entryIndex: number;
  quantity: number;
}

export interface BacktestOutput {
  trades: Trade[];
  equityCurve: EquityPoint[];
  drawdownSeries: DrawdownPoint[];
}

const MS_PER_DAY = 86_400_000;

function daysBetween(a: string, b: string): number {
  const d1 = new Date(a).getTime();
  const d2 = new Date(b).getTime();
  return Math.max(1, Math.round(Math.abs(d2 - d1) / MS_PER_DAY));
}

/**
 * Standard backtest — processes BUY/SELL signals sequentially.
 * Maintains a single position (long or flat).
 */
function runStandardBacktest(
  candles: Candle[],
  signals: Signal[],
  config: BacktestConfig
): BacktestOutput {
  const trades: Trade[] = [];
  let position: OpenPosition | null = null;
  let cash = config.initialCapital;
  let equity = config.initialCapital;

  const equityCurve: EquityPoint[] = [];
  const drawdownSeries: DrawdownPoint[] = [];
  let peakEquity = config.initialCapital;

  // Index signals by candle index for O(1) lookup
  const signalMap = new Map<number, Signal>();
  for (const sig of signals) {
    // If multiple signals at same index, last one wins
    signalMap.set(sig.index, sig);
  }

  for (let i = 0; i < candles.length; i++) {
    const sig = signalMap.get(i);

    if (sig) {
      if (sig.type === "BUY" && position === null) {
        position = {
          entryDate: sig.date,
          entryPrice: sig.price,
          entryIndex: i,
          quantity: config.quantity,
        };
        cash -= sig.price * config.quantity;
      } else if (sig.type === "SELL" && position !== null) {
        const pnl = (sig.price - position.entryPrice) * position.quantity;
        const pnlPct =
          ((sig.price - position.entryPrice) / position.entryPrice) * 100;
        trades.push({
          entryDate: position.entryDate,
          entryPrice: position.entryPrice,
          exitDate: sig.date,
          exitPrice: sig.price,
          quantity: position.quantity,
          pnl,
          pnlPct,
          holdingDays: daysBetween(position.entryDate, sig.date),
          exitReason: sig.reason,
        });
        cash += sig.price * position.quantity;
        position = null;
      }
    }

    // Mark-to-market equity
    if (position !== null) {
      equity = cash + candles[i].close * position.quantity;
    } else {
      equity = cash;
    }

    equityCurve.push({ date: candles[i].timestamp, equity });

    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity - equity;
    const ddPct = peakEquity !== 0 ? (dd / peakEquity) * 100 : 0;
    drawdownSeries.push({
      date: candles[i].timestamp,
      drawdown: dd,
      drawdownPct: ddPct,
    });
  }

  // Force-close open position at end
  if (position !== null) {
    const lastCandle = candles[candles.length - 1];
    const pnl =
      (lastCandle.close - position.entryPrice) * position.quantity;
    const pnlPct =
      ((lastCandle.close - position.entryPrice) / position.entryPrice) * 100;
    trades.push({
      entryDate: position.entryDate,
      entryPrice: position.entryPrice,
      exitDate: lastCandle.timestamp,
      exitPrice: lastCandle.close,
      quantity: position.quantity,
      pnl,
      pnlPct,
      holdingDays: daysBetween(position.entryDate, lastCandle.timestamp),
      exitReason: "Forced exit at end of data",
    });
  }

  return { trades, equityCurve, drawdownSeries };
}

/**
 * Accumulation backtest — allows multiple concurrent positions.
 * Used by buy_the_dip: each BUY opens a new position, each SELL closes
 * the oldest open position (FIFO).
 */
function runAccumulationBacktest(
  candles: Candle[],
  signals: Signal[],
  config: BacktestConfig
): BacktestOutput {
  const trades: Trade[] = [];
  const openPositions: OpenPosition[] = [];
  let cash = config.initialCapital;

  const equityCurve: EquityPoint[] = [];
  const drawdownSeries: DrawdownPoint[] = [];
  let peakEquity = config.initialCapital;

  // Group signals by index
  const signalsByIndex = new Map<number, Signal[]>();
  for (const sig of signals) {
    const existing = signalsByIndex.get(sig.index);
    if (existing) {
      existing.push(sig);
    } else {
      signalsByIndex.set(sig.index, [sig]);
    }
  }

  for (let i = 0; i < candles.length; i++) {
    const sigs = signalsByIndex.get(i);

    if (sigs) {
      for (const sig of sigs) {
        if (sig.type === "BUY") {
          openPositions.push({
            entryDate: sig.date,
            entryPrice: sig.price,
            entryIndex: i,
            quantity: config.quantity,
          });
          cash -= sig.price * config.quantity;
        } else if (sig.type === "SELL" && openPositions.length > 0) {
          // FIFO: close oldest position
          const pos = openPositions.shift()!;
          const pnl = (sig.price - pos.entryPrice) * pos.quantity;
          const pnlPct =
            ((sig.price - pos.entryPrice) / pos.entryPrice) * 100;
          trades.push({
            entryDate: pos.entryDate,
            entryPrice: pos.entryPrice,
            exitDate: sig.date,
            exitPrice: sig.price,
            quantity: pos.quantity,
            pnl,
            pnlPct,
            holdingDays: daysBetween(pos.entryDate, sig.date),
            exitReason: sig.reason,
          });
          cash += sig.price * pos.quantity;
        }
      }
    }

    // Mark-to-market
    let positionValue = 0;
    for (const pos of openPositions) {
      positionValue += candles[i].close * pos.quantity;
    }
    const equity = cash + positionValue;

    equityCurve.push({ date: candles[i].timestamp, equity });

    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity - equity;
    const ddPct = peakEquity !== 0 ? (dd / peakEquity) * 100 : 0;
    drawdownSeries.push({
      date: candles[i].timestamp,
      drawdown: dd,
      drawdownPct: ddPct,
    });
  }

  // Force-close remaining positions
  if (openPositions.length > 0) {
    const lastCandle = candles[candles.length - 1];
    for (const pos of openPositions) {
      const pnl = (lastCandle.close - pos.entryPrice) * pos.quantity;
      const pnlPct =
        ((lastCandle.close - pos.entryPrice) / pos.entryPrice) * 100;
      trades.push({
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        exitDate: lastCandle.timestamp,
        exitPrice: lastCandle.close,
        quantity: pos.quantity,
        pnl,
        pnlPct,
        holdingDays: daysBetween(pos.entryDate, lastCandle.timestamp),
        exitReason: "Forced exit at end of data",
      });
    }
  }

  return { trades, equityCurve, drawdownSeries };
}

/** Run backtest with the appropriate mode */
export function runBacktest(
  candles: Candle[],
  signals: Signal[],
  config: BacktestConfig
): BacktestOutput {
  if (candles.length === 0) {
    return {
      trades: [],
      equityCurve: [],
      drawdownSeries: [],
    };
  }

  if (config.allowAccumulation) {
    return runAccumulationBacktest(candles, signals, config);
  }
  return runStandardBacktest(candles, signals, config);
}
