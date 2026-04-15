import type {
  Candle,
  Signal,
  Trade,
  EquityPoint,
  DrawdownPoint,
  BacktestConfig,
  ZerodhaCosts,
} from "./types.js";
import { ZERODHA_EQUITY_DELIVERY } from "./types.js";

interface OpenPosition {
  entryDate: string;
  entryPrice: number;  // actual fill price (after slippage)
  entryIndex: number;
  quantity: number;
}

export interface BacktestOutput {
  trades: Trade[];
  equityCurve: EquityPoint[];
  drawdownSeries: DrawdownPoint[];
  totalCosts: number;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(a: string, b: string): number {
  const d1 = new Date(a).getTime();
  const d2 = new Date(b).getTime();
  return Math.max(1, Math.round(Math.abs(d2 - d1) / MS_PER_DAY));
}

// ─── Cost & Slippage Helpers ───

function getSlippagePct(config: BacktestConfig): number {
  return config.slippagePct ?? 0.05; // 0.05% per side default (large-cap)
}

function getCosts(config: BacktestConfig): ZerodhaCosts | null {
  if (config.costs === null) return null; // explicitly disabled
  return config.costs ?? ZERODHA_EQUITY_DELIVERY;
}

/** Apply slippage: BUY fills higher, SELL fills lower */
function applySlippage(price: number, side: "BUY" | "SELL", slippagePct: number): number {
  if (side === "BUY") return price * (1 + slippagePct / 100);
  return price * (1 - slippagePct / 100);
}

/**
 * Calculate Zerodha equity delivery costs for one side of a trade.
 * Returns total cost in ₹ for the given turnover.
 */
function calculateOneSideCost(
  turnover: number,
  side: "BUY" | "SELL",
  costs: ZerodhaCosts
): number {
  const stt = turnover * (costs.sttPct / 100);
  const exchangeTxn = turnover * (costs.exchangeTxnPct / 100);
  const sebi = turnover * (costs.sebiPct / 100);
  const stampDuty = side === "BUY" ? turnover * (costs.stampDutyPct / 100) : 0;
  const dp = side === "SELL" ? costs.dpCharges : 0;
  const gst = (exchangeTxn + sebi) * (costs.gstPct / 100); // GST on exchange + SEBI (brokerage is ₹0)
  return stt + exchangeTxn + sebi + stampDuty + dp + gst;
}

// ─── Signal Pre-processing ───

/**
 * Apply next-bar execution: shift signal execution to next candle's open.
 * Signal fires at candle[i].close → executed at candle[i+1].open.
 * Signals on the last candle are dropped (can't execute next bar).
 */
function shiftToNextBar(signals: Signal[], candles: Candle[]): Signal[] {
  const shifted: Signal[] = [];
  for (const sig of signals) {
    const nextIdx = sig.index + 1;
    if (nextIdx < candles.length) {
      shifted.push({
        ...sig,
        index: nextIdx,
        price: candles[nextIdx].open,
        date: candles[nextIdx].timestamp,
        reason: sig.reason + " (next-bar exec)",
      });
    }
  }
  return shifted;
}

/**
 * Inject stop-loss SELL signals for open positions.
 * Checks each bar: if close drops below entry * (1 + stopLossPct/100), emit SELL.
 */
function injectStopLossSignals(
  signals: Signal[],
  candles: Candle[],
  stopLossPct: number,
  config: BacktestConfig
): Signal[] {
  const augmented = [...signals];
  const slippage = getSlippagePct(config);

  // Simulate forward to know when positions are open
  let position: { entryPrice: number; entryIndex: number } | null = null;

  // Index existing signals by candle index
  const signalMap = new Map<number, Signal>();
  for (const sig of augmented) {
    signalMap.set(sig.index, sig);
  }

  for (let i = 0; i < candles.length; i++) {
    const sig = signalMap.get(i);

    if (sig && sig.type === "BUY" && position === null) {
      const fillPrice = applySlippage(sig.price, "BUY", slippage);
      position = { entryPrice: fillPrice, entryIndex: i };
    } else if (sig && sig.type === "SELL" && position !== null) {
      position = null;
    } else if (position !== null) {
      const stopPrice = position.entryPrice * (1 + stopLossPct / 100);
      if (candles[i].low <= stopPrice) {
        // Stop loss hit — use the worse of open or stop price
        const exitPrice = Math.min(candles[i].open, stopPrice);
        const slSig: Signal = {
          index: i,
          type: "SELL",
          price: exitPrice,
          date: candles[i].timestamp,
          reason: `Stop loss ${stopLossPct}% hit`,
        };
        augmented.push(slSig);
        signalMap.set(i, slSig); // override any existing signal at this index
        position = null;
      }
    }
  }

  // Sort by index for proper processing
  augmented.sort((a, b) => a.index - b.index);
  return augmented;
}

/**
 * Inject max-hold SELL signals for positions held too long.
 */
function injectMaxHoldSignals(
  signals: Signal[],
  candles: Candle[],
  maxHoldDays: number
): Signal[] {
  const augmented = [...signals];
  let position: { entryIndex: number } | null = null;

  const signalMap = new Map<number, Signal>();
  for (const sig of augmented) {
    signalMap.set(sig.index, sig);
  }

  for (let i = 0; i < candles.length; i++) {
    const sig = signalMap.get(i);

    if (sig && sig.type === "BUY" && position === null) {
      position = { entryIndex: i };
    } else if (sig && sig.type === "SELL" && position !== null) {
      position = null;
    } else if (position !== null) {
      const held = daysBetween(candles[position.entryIndex].timestamp, candles[i].timestamp);
      if (held >= maxHoldDays) {
        const mhSig: Signal = {
          index: i,
          type: "SELL",
          price: candles[i].close,
          date: candles[i].timestamp,
          reason: `Max hold ${maxHoldDays} days reached`,
        };
        augmented.push(mhSig);
        signalMap.set(i, mhSig);
        position = null;
      }
    }
  }

  augmented.sort((a, b) => a.index - b.index);
  return augmented;
}

// ─── Standard Backtest ───

function runStandardBacktest(
  candles: Candle[],
  signals: Signal[],
  config: BacktestConfig
): BacktestOutput {
  const trades: Trade[] = [];
  let position: OpenPosition | null = null;
  let cash = config.initialCapital;
  let equity = config.initialCapital;
  let totalCosts = 0;

  const equityCurve: EquityPoint[] = [];
  const drawdownSeries: DrawdownPoint[] = [];
  let peakEquity = config.initialCapital;

  const slippage = getSlippagePct(config);
  const costs = getCosts(config);

  // Index signals by candle index for O(1) lookup
  const signalMap = new Map<number, Signal>();
  for (const sig of signals) {
    signalMap.set(sig.index, sig);
  }

  for (let i = 0; i < candles.length; i++) {
    const sig = signalMap.get(i);

    if (sig) {
      if (sig.type === "BUY" && position === null) {
        const fillPrice = applySlippage(sig.price, "BUY", slippage);
        const turnover = fillPrice * config.quantity;
        const buyCost = costs ? calculateOneSideCost(turnover, "BUY", costs) : 0;
        totalCosts += buyCost;

        position = {
          entryDate: sig.date,
          entryPrice: fillPrice,
          entryIndex: i,
          quantity: config.quantity,
        };
        cash -= turnover + buyCost;
      } else if (sig.type === "SELL" && position !== null) {
        const fillPrice = applySlippage(sig.price, "SELL", slippage);
        const turnover = fillPrice * position.quantity;
        const sellCost = costs ? calculateOneSideCost(turnover, "SELL", costs) : 0;
        totalCosts += sellCost;

        const pnl = (fillPrice - position.entryPrice) * position.quantity - (costs ? sellCost + calculateOneSideCost(position.entryPrice * position.quantity, "BUY", costs) : 0);
        const pnlPct =
          ((fillPrice - position.entryPrice) / position.entryPrice) * 100;
        trades.push({
          entryDate: position.entryDate,
          entryPrice: position.entryPrice,
          exitDate: sig.date,
          exitPrice: fillPrice,
          quantity: position.quantity,
          pnl: (fillPrice - position.entryPrice) * position.quantity,
          pnlPct,
          holdingDays: daysBetween(position.entryDate, sig.date),
          exitReason: sig.reason,
        });
        cash += turnover - sellCost;
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
    const fillPrice = applySlippage(lastCandle.close, "SELL", slippage);
    const turnover = fillPrice * position.quantity;
    const sellCost = costs ? calculateOneSideCost(turnover, "SELL", costs) : 0;
    totalCosts += sellCost;

    const pnlPct =
      ((fillPrice - position.entryPrice) / position.entryPrice) * 100;
    trades.push({
      entryDate: position.entryDate,
      entryPrice: position.entryPrice,
      exitDate: lastCandle.timestamp,
      exitPrice: fillPrice,
      quantity: position.quantity,
      pnl: (fillPrice - position.entryPrice) * position.quantity,
      pnlPct,
      holdingDays: daysBetween(position.entryDate, lastCandle.timestamp),
      exitReason: "Forced exit at end of data",
    });
    cash += turnover - sellCost;
  }

  return { trades, equityCurve, drawdownSeries, totalCosts };
}

// ─── Accumulation Backtest ───

function runAccumulationBacktest(
  candles: Candle[],
  signals: Signal[],
  config: BacktestConfig
): BacktestOutput {
  const trades: Trade[] = [];
  const openPositions: OpenPosition[] = [];
  let cash = config.initialCapital;
  let totalCosts = 0;

  const equityCurve: EquityPoint[] = [];
  const drawdownSeries: DrawdownPoint[] = [];
  let peakEquity = config.initialCapital;

  const slippage = getSlippagePct(config);
  const costs = getCosts(config);

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
          const fillPrice = applySlippage(sig.price, "BUY", slippage);
          const turnover = fillPrice * config.quantity;
          const buyCost = costs ? calculateOneSideCost(turnover, "BUY", costs) : 0;
          totalCosts += buyCost;

          openPositions.push({
            entryDate: sig.date,
            entryPrice: fillPrice,
            entryIndex: i,
            quantity: config.quantity,
          });
          cash -= turnover + buyCost;
        } else if (sig.type === "SELL" && openPositions.length > 0) {
          const pos = openPositions.shift()!;
          const fillPrice = applySlippage(sig.price, "SELL", slippage);
          const turnover = fillPrice * pos.quantity;
          const sellCost = costs ? calculateOneSideCost(turnover, "SELL", costs) : 0;
          totalCosts += sellCost;

          const pnlPct =
            ((fillPrice - pos.entryPrice) / pos.entryPrice) * 100;
          trades.push({
            entryDate: pos.entryDate,
            entryPrice: pos.entryPrice,
            exitDate: sig.date,
            exitPrice: fillPrice,
            quantity: pos.quantity,
            pnl: (fillPrice - pos.entryPrice) * pos.quantity,
            pnlPct,
            holdingDays: daysBetween(pos.entryDate, sig.date),
            exitReason: sig.reason,
          });
          cash += turnover - sellCost;
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
      const fillPrice = applySlippage(lastCandle.close, "SELL", slippage);
      const turnover = fillPrice * pos.quantity;
      const sellCost = costs ? calculateOneSideCost(turnover, "SELL", costs) : 0;
      totalCosts += sellCost;

      const pnlPct =
        ((fillPrice - pos.entryPrice) / pos.entryPrice) * 100;
      trades.push({
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        exitDate: lastCandle.timestamp,
        exitPrice: fillPrice,
        quantity: pos.quantity,
        pnl: (fillPrice - pos.entryPrice) * pos.quantity,
        pnlPct,
        holdingDays: daysBetween(pos.entryDate, lastCandle.timestamp),
        exitReason: "Forced exit at end of data",
      });
      cash += turnover - sellCost;
    }
  }

  return { trades, equityCurve, drawdownSeries, totalCosts };
}

// ─── Main Entry Point ───

/** Run backtest with the appropriate mode, applying realistic execution model */
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
      totalCosts: 0,
    };
  }

  let processedSignals = signals;

  // 1. Next-bar execution (default: on)
  const useNextBar = config.nextBarExecution !== false;
  if (useNextBar) {
    processedSignals = shiftToNextBar(processedSignals, candles);
  }

  // 2. Inject stop-loss signals (only for standard mode — accumulation has its own)
  if (config.stopLossPct != null && !config.allowAccumulation) {
    processedSignals = injectStopLossSignals(processedSignals, candles, config.stopLossPct, config);
  }

  // 3. Inject max-hold signals (only for standard mode)
  if (config.maxHoldDays != null && !config.allowAccumulation) {
    processedSignals = injectMaxHoldSignals(processedSignals, candles, config.maxHoldDays);
  }

  if (config.allowAccumulation) {
    return runAccumulationBacktest(candles, processedSignals, config);
  }
  return runStandardBacktest(candles, processedSignals, config);
}

// ─── Exported for testing ───
export { applySlippage, calculateOneSideCost, shiftToNextBar, daysBetween };
