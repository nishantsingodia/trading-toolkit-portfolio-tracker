import type { FnoPosition, FnoBacktestConfig, Greeks } from "./types.js";

export interface RiskBreach {
  type: "delta" | "gamma" | "vega" | "stop_loss" | "daily_loss" | "max_positions";
  message: string;
}

/**
 * Check if portfolio aggregate Greeks exceed limits.
 */
export function checkPortfolioGreeksLimits(
  positions: FnoPosition[],
  limits: FnoBacktestConfig["portfolioGreeksLimits"]
): RiskBreach | null {
  let totalDelta = 0;
  let totalGamma = 0;
  let totalVega = 0;

  for (const pos of positions) {
    if (pos.status !== "OPEN") continue;
    totalDelta += pos.aggregateGreeks.delta;
    totalGamma += pos.aggregateGreeks.gamma;
    totalVega += pos.aggregateGreeks.vega;
  }

  if (Math.abs(totalDelta) > limits.maxAbsDelta) {
    return {
      type: "delta",
      message: `Portfolio delta ${totalDelta.toFixed(4)} exceeds limit ±${limits.maxAbsDelta}`,
    };
  }

  if (Math.abs(totalGamma) > limits.maxGamma) {
    return {
      type: "gamma",
      message: `Portfolio gamma ${totalGamma.toFixed(4)} exceeds limit ±${limits.maxGamma}`,
    };
  }

  if (Math.abs(totalVega) > limits.maxVega) {
    return {
      type: "vega",
      message: `Portfolio vega ${totalVega.toFixed(4)} exceeds limit ±${limits.maxVega}`,
    };
  }

  return null;
}

/**
 * Check if a position has hit its stop-loss.
 * Stop-loss = max loss per trade (absolute INR).
 */
export function checkPositionStopLoss(
  position: FnoPosition,
  maxLossPerTrade: number
): boolean {
  return position.currentPnl < -maxLossPerTrade;
}

/**
 * Check if daily loss limit has been exceeded.
 */
export function checkDailyLossLimit(
  dailyPnl: number,
  maxLossPerDay: number
): boolean {
  return dailyPnl < -maxLossPerDay;
}

/**
 * Check if max number of open positions has been reached.
 */
export function checkMaxPositions(
  openPositionCount: number,
  maxPositions: number
): boolean {
  return openPositionCount >= maxPositions;
}

/**
 * Calculate simplified margin for a position.
 *
 * Naked short option: ~15% of spot * lot_size per lot
 * Spreads/hedged: max loss of the spread
 * Long options: premium paid (no margin needed beyond that)
 */
export function calculateSimplifiedMargin(
  position: FnoPosition,
  spotPrice: number
): number {
  let totalMargin = 0;
  const hasShortLegs = position.legs.some((l) => l.side === "SELL");
  const hasLongLegs = position.legs.some((l) => l.side === "BUY");

  if (hasShortLegs && hasLongLegs) {
    // Spread/hedged position — margin = max possible loss
    // For iron condor/butterfly: max loss = wing width * lot_size - net credit
    // For vertical spreads: max loss = spread width * lot_size - net credit
    const shortLegs = position.legs.filter((l) => l.side === "SELL");
    const longLegs = position.legs.filter((l) => l.side === "BUY");

    // Find the max spread width between paired short-long legs of same type
    let maxSpreadWidth = 0;
    for (const shortLeg of shortLegs) {
      for (const longLeg of longLegs) {
        if (shortLeg.optionType === longLeg.optionType) {
          const width = Math.abs(shortLeg.strike - longLeg.strike);
          maxSpreadWidth = Math.max(maxSpreadWidth, width);
        }
      }
    }

    if (maxSpreadWidth > 0) {
      const lotSize = position.legs[0].lotSize;
      const lots = position.legs[0].lots;
      totalMargin = maxSpreadWidth * lotSize * lots;
    } else {
      // No paired legs found — fallback to naked margin
      for (const leg of position.legs) {
        if (leg.side === "SELL") {
          totalMargin += spotPrice * leg.lotSize * leg.lots * 0.15;
        }
      }
    }
  } else if (hasShortLegs) {
    // Naked short — ~15% of spot * lot_size per lot
    for (const leg of position.legs) {
      if (leg.side === "SELL") {
        totalMargin += spotPrice * leg.lotSize * leg.lots * 0.15;
      }
    }
  } else {
    // All long — margin = total premium paid
    for (const leg of position.legs) {
      totalMargin += leg.entryPrice * leg.lotSize * leg.lots;
    }
  }

  return totalMargin;
}

/**
 * Aggregate check — should a position be force-closed?
 */
export function shouldForceClose(
  position: FnoPosition,
  config: FnoBacktestConfig,
  dailyPnl: number,
  openPositionCount: number
): { close: boolean; reason: string } {
  // Check position stop-loss
  if (checkPositionStopLoss(position, config.maxLossPerTrade)) {
    return { close: true, reason: `Position SL hit: loss ₹${Math.abs(position.currentPnl).toFixed(0)} > max ₹${config.maxLossPerTrade}` };
  }

  // Check daily loss limit
  if (checkDailyLossLimit(dailyPnl, config.maxLossPerDay)) {
    return { close: true, reason: `Daily loss limit hit: ₹${Math.abs(dailyPnl).toFixed(0)} > max ₹${config.maxLossPerDay}` };
  }

  return { close: false, reason: "" };
}
