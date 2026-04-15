import type {
  FnoSignal,
  FnoBacktestConfig,
  FnoPosition,
  FnoTrade,
  OptionsChainSnapshot,
  Candle,
  OptionLeg,
  EquityPoint,
  DrawdownPoint,
  GreeksSnapshot,
  FnoStrategyName,
  Greeks,
  TransactionCosts,
} from "./types.js";
import { DEFAULT_FNO_CONFIG, RISK_FREE_RATE } from "./types.js";
import { blackScholesPrice, calculateGreeks, aggregateGreeks } from "./pricing.js";
import { getDTE, getLotSize, isExpiryDay } from "./expiry-calendar.js";
import { dteToYears } from "./expiry-calendar.js";
import { getQuote } from "./options-chain.js";
import {
  checkPortfolioGreeksLimits,
  shouldForceClose,
  calculateSimplifiedMargin,
} from "./risk-manager.js";

export interface FnoBacktestOutput {
  trades: FnoTrade[];
  openPositions: FnoPosition[];
  equityCurve: EquityPoint[];
  drawdownSeries: DrawdownPoint[];
  greeksTimeSeries: GreeksSnapshot[];
}

let positionCounter = 0;
function nextPositionId(): string {
  return `pos_${++positionCounter}`;
}

/**
 * Reset the position counter (for testing).
 */
export function resetPositionCounter(): void {
  positionCounter = 0;
}

/**
 * Apply slippage to a price.
 * For BUY: price goes up (worse fill).
 * For SELL: price goes down (worse fill).
 */
function applySlippage(
  price: number,
  side: "BUY" | "SELL",
  config: FnoBacktestConfig
): number {
  if (config.slippageModel === "none") return price;

  const slippageFactor = config.slippageBps / 10000;
  if (side === "BUY") {
    return price * (1 + slippageFactor);
  } else {
    return price * (1 - slippageFactor);
  }
}

/**
 * Calculate India F&O transaction costs for a round-trip trade.
 *
 * Components (per leg, per side):
 *   Brokerage:   ₹20/order (flat)
 *   STT:         0.0125% on SELL-side premium × quantity
 *   Exchange:    0.0495% on premium × quantity (both sides)
 *   SEBI:        0.0001% on premium × quantity (both sides)
 *   Stamp duty:  0.003% on BUY-side premium × quantity
 *   GST:         18% on (brokerage + exchange charges)
 *
 * Returns total cost in ₹ to be DEDUCTED from P&L.
 */
function calculateTxnCosts(
  legs: OptionLeg[],
  entryPrices: number[],
  exitPrices: number[],
  costs: TransactionCosts
): number {
  let totalCost = 0;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const qty = leg.lotSize * leg.lots;
    const entryP = entryPrices[i];
    const exitP = exitPrices[i];

    // Entry side
    const entryTurnover = entryP * qty;
    const entryBrokerage = costs.brokeragePerOrder;
    const entryExchange = entryTurnover * costs.exchangeTxnRate;
    const entrySebi = entryTurnover * costs.sebiTurnoverRate;
    // STT only on sell side
    const entryStt = leg.side === "SELL" ? entryTurnover * costs.sttSellRate : 0;
    // Stamp duty only on buy side
    const entryStamp = leg.side === "BUY" ? entryTurnover * costs.stampDutyBuyRate : 0;
    const entryGst = (entryBrokerage + entryExchange) * costs.gstRate;

    // Exit side (opposite of entry)
    const exitTurnover = exitP * qty;
    const exitBrokerage = costs.brokeragePerOrder;
    const exitExchange = exitTurnover * costs.exchangeTxnRate;
    const exitSebi = exitTurnover * costs.sebiTurnoverRate;
    // At exit, the side flips: if entry was SELL, exit is BUY (no STT) and vice versa
    const exitStt = leg.side === "BUY" ? exitTurnover * costs.sttSellRate : 0;
    const exitStamp = leg.side === "SELL" ? exitTurnover * costs.stampDutyBuyRate : 0;
    const exitGst = (exitBrokerage + exitExchange) * costs.gstRate;

    totalCost += entryBrokerage + entryExchange + entrySebi + entryStt + entryStamp + entryGst
               + exitBrokerage + exitExchange + exitSebi + exitStt + exitStamp + exitGst;
  }

  return totalCost;
}

/**
 * Mark-to-market a single leg using Black-Scholes theoretical price.
 */
function markLegToMarket(
  leg: OptionLeg,
  spotPrice: number,
  currentDate: string
): { price: number; greeks: Greeks } {
  const dte = getDTE(currentDate, leg.expiry);
  const tte = dteToYears(dte);

  const price = blackScholesPrice(
    spotPrice,
    leg.strike,
    tte,
    RISK_FREE_RATE,
    leg.greeks.iv, // use last known IV
    leg.optionType
  );

  const greeks = calculateGreeks(
    spotPrice,
    leg.strike,
    tte,
    RISK_FREE_RATE,
    leg.greeks.iv,
    leg.optionType
  );

  return { price, greeks };
}

/**
 * Open a new position from a signal.
 */
function openPosition(
  signal: FnoSignal,
  chain: OptionsChainSnapshot,
  strategyName: FnoStrategyName,
  config: FnoBacktestConfig,
  underlying: string
): FnoPosition | null {
  const legs: OptionLeg[] = [];
  const lotSize = getLotSize(underlying as "NIFTY" | "BANKNIFTY");

  for (const legSignal of signal.legs) {
    const quote = getQuote(chain, legSignal.strike, legSignal.optionType);
    if (!quote) return null; // strike not available in chain

    const entryPrice = applySlippage(quote.price, legSignal.side, config);

    legs.push({
      instrumentKey: `${underlying}_${legSignal.strike}_${legSignal.optionType}_${legSignal.expiry}`,
      underlying,
      strike: legSignal.strike,
      optionType: legSignal.optionType,
      expiry: legSignal.expiry,
      side: legSignal.side,
      lots: legSignal.lots,
      lotSize,
      entryPrice,
      currentPrice: entryPrice,
      greeks: { ...quote.greeks },
    });
  }

  // Calculate net premium: SELL legs = credit (+), BUY legs = debit (-)
  let netPremium = 0;
  for (const leg of legs) {
    const premium = leg.entryPrice * leg.lotSize * leg.lots;
    netPremium += leg.side === "SELL" ? premium : -premium;
  }

  const position: FnoPosition = {
    id: signal.positionId ?? nextPositionId(),
    strategyName,
    legs,
    entryDate: signal.timestamp,
    entrySpot: chain.spotPrice,
    dte: getDTE(signal.timestamp.slice(0, 10), legs[0].expiry),
    netPremium,
    marginRequired: 0,
    currentPnl: 0,
    peakPnl: 0,
    troughPnl: 0,
    aggregateGreeks: aggregateGreeks(legs),
    status: "OPEN",
  };

  position.marginRequired = calculateSimplifiedMargin(position, chain.spotPrice);

  return position;
}

/**
 * Close a position and create a trade record.
 */
function closePosition(
  position: FnoPosition,
  chain: OptionsChainSnapshot,
  currentDate: string,
  exitReason: string,
  config: FnoBacktestConfig
): FnoTrade {
  let exitPnl = 0;
  let thetaCaptured = 0;
  const entryPrices: number[] = [];
  const exitPrices: number[] = [];

  for (const leg of position.legs) {
    const quote = getQuote(chain, leg.strike, leg.optionType);
    const exitPrice = quote
      ? applySlippage(quote.price, leg.side === "BUY" ? "SELL" : "BUY", config)
      : leg.currentPrice;

    entryPrices.push(leg.entryPrice);
    exitPrices.push(exitPrice);

    const pnlPerUnit =
      leg.side === "BUY"
        ? exitPrice - leg.entryPrice
        : leg.entryPrice - exitPrice;

    exitPnl += pnlPerUnit * leg.lotSize * leg.lots;

    if (leg.side === "SELL") {
      thetaCaptured += (leg.entryPrice - exitPrice) * leg.lotSize * leg.lots;
    }
  }

  // Deduct transaction costs (brokerage, STT, exchange, GST, stamp duty)
  if (config.txnCosts) {
    const txnCost = calculateTxnCosts(position.legs, entryPrices, exitPrices, config.txnCosts);
    exitPnl -= txnCost;
  }

  const entryDate = position.entryDate.slice(0, 10);
  const exitDateStr = currentDate.slice(0, 10);

  const avgEntryIV =
    position.legs.reduce((sum, l) => sum + l.greeks.iv, 0) / position.legs.length;

  // Get current IV from chain
  let avgExitIV = avgEntryIV;
  const exitIvs: number[] = [];
  for (const leg of position.legs) {
    const quote = getQuote(chain, leg.strike, leg.optionType);
    if (quote) exitIvs.push(quote.greeks.iv);
  }
  if (exitIvs.length > 0) {
    avgExitIV = exitIvs.reduce((a, b) => a + b, 0) / exitIvs.length;
  }

  position.status = "CLOSED";

  return {
    positionId: position.id,
    strategyName: position.strategyName,
    legs: position.legs.map((l) => ({ ...l })),
    entryDate: position.entryDate,
    exitDate: currentDate,
    entrySpot: position.entrySpot,
    exitSpot: chain.spotPrice,
    dteAtEntry: position.dte,
    dteAtExit: getDTE(exitDateStr, position.legs[0].expiry),
    ivAtEntry: avgEntryIV,
    ivAtExit: avgExitIV,
    netPremiumCollected: position.netPremium,
    exitPnl,
    exitPnlPct:
      Math.abs(position.netPremium) > 0
        ? (exitPnl / Math.abs(position.netPremium)) * 100
        : 0,
    thetaCaptured,
    maxDrawdownDuringTrade: position.troughPnl,
    exitReason,
  };
}

/**
 * Handle expiry — settle ITM legs at intrinsic value, expire OTM legs worthless.
 */
function settleOnExpiry(
  position: FnoPosition,
  spotPrice: number,
  currentDate: string,
  config: FnoBacktestConfig
): FnoTrade {
  let exitPnl = 0;
  let thetaCaptured = 0;
  const entryPrices: number[] = [];
  const exitPrices: number[] = [];

  for (const leg of position.legs) {
    let intrinsic: number;
    if (leg.optionType === "CE") {
      intrinsic = Math.max(spotPrice - leg.strike, 0);
    } else {
      intrinsic = Math.max(leg.strike - spotPrice, 0);
    }

    entryPrices.push(leg.entryPrice);
    exitPrices.push(intrinsic);

    const pnlPerUnit =
      leg.side === "BUY"
        ? intrinsic - leg.entryPrice
        : leg.entryPrice - intrinsic;

    exitPnl += pnlPerUnit * leg.lotSize * leg.lots;

    if (leg.side === "SELL") {
      thetaCaptured += (leg.entryPrice - intrinsic) * leg.lotSize * leg.lots;
    }
  }

  // Deduct transaction costs
  if (config.txnCosts) {
    const txnCost = calculateTxnCosts(position.legs, entryPrices, exitPrices, config.txnCosts);
    exitPnl -= txnCost;
  }

  const avgEntryIV =
    position.legs.reduce((sum, l) => sum + l.greeks.iv, 0) / position.legs.length;

  position.status = "EXPIRED";

  return {
    positionId: position.id,
    strategyName: position.strategyName,
    legs: position.legs.map((l) => ({ ...l })),
    entryDate: position.entryDate,
    exitDate: currentDate,
    entrySpot: position.entrySpot,
    exitSpot: spotPrice,
    dteAtEntry: position.dte,
    dteAtExit: 0,
    ivAtEntry: avgEntryIV,
    ivAtExit: 0,
    netPremiumCollected: position.netPremium,
    exitPnl,
    exitPnlPct:
      Math.abs(position.netPremium) > 0
        ? (exitPnl / Math.abs(position.netPremium)) * 100
        : 0,
    thetaCaptured,
    maxDrawdownDuringTrade: position.troughPnl,
    exitReason: "expiry_settlement",
  };
}

/**
 * Core F&O backtesting engine.
 *
 * Iterates through chain snapshots, processes signals, manages positions,
 * handles expiry, risk limits, and builds equity curve.
 */
export function runFnoBacktest(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  signals: FnoSignal[],
  config: FnoBacktestConfig = DEFAULT_FNO_CONFIG,
  strategyName: FnoStrategyName = "short_straddle",
  underlying: string = "NIFTY"
): FnoBacktestOutput {
  resetPositionCounter();

  const trades: FnoTrade[] = [];
  const openPositions: FnoPosition[] = [];
  const equityCurve: EquityPoint[] = [];
  const drawdownSeries: DrawdownPoint[] = [];
  const greeksTimeSeries: GreeksSnapshot[] = [];

  let cash = config.initialCapital;
  let peakEquity = config.initialCapital;
  let dailyPnl = 0;
  let lastDate = "";

  // Index signals by timestamp for O(1) lookup
  const signalsByTimestamp = new Map<string, FnoSignal[]>();
  for (const signal of signals) {
    const existing = signalsByTimestamp.get(signal.timestamp) ?? [];
    existing.push(signal);
    signalsByTimestamp.set(signal.timestamp, existing);
  }

  for (let i = 0; i < chainHistory.length; i++) {
    const chain = chainHistory[i];
    const currentDate = chain.timestamp.slice(0, 10);
    const spotPrice = chain.spotPrice;

    // Reset daily P&L on new day
    if (currentDate !== lastDate) {
      dailyPnl = 0;
      lastDate = currentDate;
    }

    // 1. Mark-to-market all open positions
    for (const pos of openPositions) {
      if (pos.status !== "OPEN") continue;

      let positionPnl = 0;
      for (const leg of pos.legs) {
        const { price, greeks } = markLegToMarket(leg, spotPrice, currentDate);
        leg.currentPrice = price;
        leg.greeks = greeks;

        const pnlPerUnit =
          leg.side === "BUY"
            ? price - leg.entryPrice
            : leg.entryPrice - price;
        positionPnl += pnlPerUnit * leg.lotSize * leg.lots;
      }

      pos.currentPnl = positionPnl;
      pos.peakPnl = Math.max(pos.peakPnl, positionPnl);
      pos.troughPnl = Math.min(pos.troughPnl, positionPnl);
      pos.aggregateGreeks = aggregateGreeks(pos.legs);
    }

    // 2. Handle expiry — settle positions whose legs expire today
    for (let j = openPositions.length - 1; j >= 0; j--) {
      const pos = openPositions[j];
      if (pos.status !== "OPEN") continue;

      const expiryDate = pos.legs[0].expiry;
      if (currentDate >= expiryDate) {
        const trade = settleOnExpiry(pos, spotPrice, chain.timestamp, config);
        trades.push(trade);
        cash += trade.exitPnl;
        dailyPnl += trade.exitPnl;
      }
    }

    // 3. Check risk limits — force close breaching positions
    const activePositions = openPositions.filter((p) => p.status === "OPEN");

    // Check portfolio-level Greeks limits
    const greeksBreach = checkPortfolioGreeksLimits(
      activePositions,
      config.portfolioGreeksLimits
    );
    if (greeksBreach) {
      // Force close the position contributing most to the breach
      for (const pos of activePositions) {
        if (pos.status !== "OPEN") continue;
        const trade = closePosition(pos, chain, chain.timestamp, `risk_breach: ${greeksBreach.message}`, config);
        trades.push(trade);
        cash += trade.exitPnl;
        dailyPnl += trade.exitPnl;
        break; // close one at a time
      }
    }

    // Check per-position risk
    for (const pos of openPositions) {
      if (pos.status !== "OPEN") continue;
      const { close, reason } = shouldForceClose(
        pos,
        config,
        dailyPnl,
        activePositions.length
      );
      if (close) {
        const trade = closePosition(pos, chain, chain.timestamp, reason, config);
        trades.push(trade);
        cash += trade.exitPnl;
        dailyPnl += trade.exitPnl;
      }
    }

    // 4. Process signals for this timestamp
    const currentSignals = signalsByTimestamp.get(chain.timestamp) ?? [];
    for (const signal of currentSignals) {
      if (signal.type === "OPEN") {
        // Check if we can open more positions
        const currentOpen = openPositions.filter((p) => p.status === "OPEN").length;
        if (currentOpen >= config.maxPositions) continue;

        const position = openPosition(signal, chain, strategyName, config, underlying);
        if (position) {
          openPositions.push(position);
        }
      } else if (signal.type === "CLOSE" && signal.positionId) {
        const pos = openPositions.find(
          (p) => p.id === signal.positionId && p.status === "OPEN"
        );
        if (pos) {
          const trade = closePosition(pos, chain, chain.timestamp, signal.reason, config);
          trades.push(trade);
          cash += trade.exitPnl;
          dailyPnl += trade.exitPnl;
        }
      }
    }

    // 5. Calculate equity (cash + unrealized P&L of open positions)
    let unrealizedPnl = 0;
    for (const pos of openPositions) {
      if (pos.status === "OPEN") {
        unrealizedPnl += pos.currentPnl;
      }
    }
    const equity = cash + unrealizedPnl;

    equityCurve.push({ date: chain.timestamp, equity });

    // Drawdown
    peakEquity = Math.max(peakEquity, equity);
    const drawdown = peakEquity - equity;
    const drawdownPct = peakEquity > 0 ? (drawdown / peakEquity) * 100 : 0;
    drawdownSeries.push({ date: chain.timestamp, drawdown, drawdownPct });

    // Greeks snapshot
    let totalDelta = 0;
    let totalGamma = 0;
    let totalTheta = 0;
    let totalVega = 0;
    for (const pos of openPositions) {
      if (pos.status === "OPEN") {
        totalDelta += pos.aggregateGreeks.delta;
        totalGamma += pos.aggregateGreeks.gamma;
        totalTheta += pos.aggregateGreeks.theta;
        totalVega += pos.aggregateGreeks.vega;
      }
    }
    greeksTimeSeries.push({
      date: chain.timestamp,
      delta: totalDelta,
      gamma: totalGamma,
      theta: totalTheta,
      vega: totalVega,
    });
  }

  // Force close any remaining open positions at last chain snapshot
  if (chainHistory.length > 0) {
    const lastChain = chainHistory[chainHistory.length - 1];
    for (const pos of openPositions) {
      if (pos.status === "OPEN") {
        const trade = closePosition(
          pos,
          lastChain,
          lastChain.timestamp,
          "backtest_end",
          config
        );
        trades.push(trade);
      }
    }
  }

  return {
    trades,
    openPositions,
    equityCurve,
    drawdownSeries,
    greeksTimeSeries,
  };
}
