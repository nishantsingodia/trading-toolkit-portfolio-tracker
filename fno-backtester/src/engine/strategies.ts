import type {
  FnoSignal,
  FnoStrategyDefinition,
  FnoStrategyName,
  OptionsChainSnapshot,
  Candle,
  LegSignal,
  Underlying,
} from "./types.js";
import { getATMStrike, enumerateStrikes, findStrikeByDelta, calculateMaxPain, calculatePCR, calculateIVPercentile } from "./options-chain.js";
import { getDTE, getNextExpiry, getLotSize } from "./expiry-calendar.js";
import { ema, rsi, bollingerBands, crossover, crossunder } from "./indicators.js";

// ── Helpers ─────────────────────────────────────────────────────────

/** Extract underlying from params (set by caller), default to NIFTY */
function getUnderlying(params: Record<string, number | string>): Underlying {
  const u = params.__underlying;
  return u === "BANKNIFTY" ? "BANKNIFTY" : "NIFTY";
}

function getAvgIV(chain: OptionsChainSnapshot, underlying: Underlying): number {
  let total = 0;
  let count = 0;
  const atm = getATMStrike(chain.spotPrice, underlying);
  const data = chain.strikes.get(atm);
  if (data) {
    total += data.ce.iv + data.pe.iv;
    count += 2;
  }
  return count > 0 ? total / count : 0.15;
}

function timeFromTimestamp(ts: string): string {
  // Extract HH:mm from "YYYY-MM-DDTHH:mm:ss"
  return ts.slice(11, 16);
}

// ── Strategy 1: Short Straddle ──────────────────────────────────────

function shortStraddle(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  params: Record<string, number | string>
): FnoSignal[] {
  const signals: FnoSignal[] = [];
  const ivPercentileMin = Number(params.ivPercentileMin ?? 50);
  const entryDteMin = Number(params.entryDteMin ?? 7);
  const entryDteMax = Number(params.entryDteMax ?? 15);
  const targetPct = Number(params.targetPct ?? 50);
  const stopLossPct = Number(params.stopLossPct ?? 50);
  const exitDte = Number(params.exitDte ?? 2);

  const underlying = getUnderlying(params);
  let openPosition: { id: string; entryPremium: number; expiry: string; strike: number } | null = null;
  let posCounter = 0;

  const ivHistory: number[] = [];

  for (let i = 0; i < chainHistory.length; i++) {
    const chain = chainHistory[i];
    const dateStr = chain.timestamp.slice(0, 10);
    const currentIV = getAvgIV(chain, underlying);
    ivHistory.push(currentIV);

    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const dte = getDTE(dateStr, expiry);

    if (openPosition) {
      // Check exit conditions
      const atm = openPosition.strike;
      const ceQuote = chain.strikes.get(atm)?.ce;
      const peQuote = chain.strikes.get(atm)?.pe;
      if (ceQuote && peQuote) {
        const currentPremium = ceQuote.price + peQuote.price;
        const decayPct = ((openPosition.entryPremium - currentPremium) / openPosition.entryPremium) * 100;
        const lossPct = ((currentPremium - openPosition.entryPremium) / openPosition.entryPremium) * 100;
        const currentDte = getDTE(dateStr, openPosition.expiry);

        if (decayPct >= targetPct || lossPct >= stopLossPct || currentDte <= exitDte) {
          const reason = decayPct >= targetPct ? "target_hit" : lossPct >= stopLossPct ? "stop_loss" : "time_exit";
          signals.push({
            timestamp: chain.timestamp,
            type: "CLOSE",
            positionId: openPosition.id,
            legs: [],
            reason,
          });
          openPosition = null;
        }
      }
      continue;
    }

    // Check entry conditions
    if (dte < entryDteMin || dte > entryDteMax) continue;
    const ivPct = calculateIVPercentile(ivHistory.slice(0, -1), currentIV);
    if (ivPct < ivPercentileMin && ivHistory.length > 5) continue;

    const atm = getATMStrike(chain.spotPrice, underlying);
    const ceQuote = chain.strikes.get(atm)?.ce;
    const peQuote = chain.strikes.get(atm)?.pe;
    if (!ceQuote || !peQuote) continue;

    const posId = `short_straddle_${++posCounter}`;
    signals.push({
      timestamp: chain.timestamp,
      type: "OPEN",
      positionId: posId,
      legs: [
        { strike: atm, optionType: "CE", side: "SELL", expiry, lots: 1 },
        { strike: atm, optionType: "PE", side: "SELL", expiry, lots: 1 },
      ],
      reason: `IV pct ${ivPct.toFixed(0)}%, DTE ${dte}`,
    });

    openPosition = { id: posId, entryPremium: ceQuote.price + peQuote.price, expiry, strike: atm };
  }

  return signals;
}

// ── Strategy 2: Short Strangle ──────────────────────────────────────

function shortStrangle(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  params: Record<string, number | string>
): FnoSignal[] {
  const signals: FnoSignal[] = [];
  const ceDelta = Number(params.ceDelta ?? 0.20);
  const peDelta = Number(params.peDelta ?? -0.20);
  const entryDteMin = Number(params.entryDteMin ?? 10);
  const entryDteMax = Number(params.entryDteMax ?? 21);
  const targetPct = Number(params.targetPct ?? 60);
  const stopLossPct = Number(params.stopLossPct ?? 100);
  const exitDte = Number(params.exitDte ?? 3);

  const underlying = getUnderlying(params);
  let openPos: { id: string; entryPrem: number; expiry: string; ceStrike: number; peStrike: number } | null = null;
  let posCounter = 0;

  for (let i = 0; i < chainHistory.length; i++) {
    const chain = chainHistory[i];
    const dateStr = chain.timestamp.slice(0, 10);
    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const dte = getDTE(dateStr, expiry);

    if (openPos) {
      const ceQ = chain.strikes.get(openPos.ceStrike)?.ce;
      const peQ = chain.strikes.get(openPos.peStrike)?.pe;
      if (ceQ && peQ) {
        const current = ceQ.price + peQ.price;
        const decay = ((openPos.entryPrem - current) / openPos.entryPrem) * 100;
        const loss = ((current - openPos.entryPrem) / openPos.entryPrem) * 100;
        const curDte = getDTE(dateStr, openPos.expiry);

        if (decay >= targetPct || loss >= stopLossPct || curDte <= exitDte) {
          signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: decay >= targetPct ? "target_hit" : loss >= stopLossPct ? "stop_loss" : "time_exit" });
          openPos = null;
        }
      }
      continue;
    }

    if (dte < entryDteMin || dte > entryDteMax) continue;

    const ceStrike = findStrikeByDelta(chain, ceDelta, "CE");
    const peStrike = findStrikeByDelta(chain, peDelta, "PE");
    if (ceStrike === 0 || peStrike === 0) continue;

    const ceQ = chain.strikes.get(ceStrike)?.ce;
    const peQ = chain.strikes.get(peStrike)?.pe;
    if (!ceQ || !peQ) continue;

    const posId = `short_strangle_${++posCounter}`;
    signals.push({
      timestamp: chain.timestamp, type: "OPEN", positionId: posId,
      legs: [
        { strike: ceStrike, optionType: "CE", side: "SELL", expiry, lots: 1 },
        { strike: peStrike, optionType: "PE", side: "SELL", expiry, lots: 1 },
      ],
      reason: `CE delta ${ceDelta}, PE delta ${peDelta}, DTE ${dte}`,
    });
    openPos = { id: posId, entryPrem: ceQ.price + peQ.price, expiry, ceStrike, peStrike };
  }

  return signals;
}

// ── Strategy 3: Iron Condor ─────────────────────────────────────────

function ironCondor(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  params: Record<string, number | string>
): FnoSignal[] {
  const signals: FnoSignal[] = [];
  const shortDelta = Number(params.shortDelta ?? 0.16);
  const wingWidth = Number(params.wingWidth ?? 150);
  const entryDteMin = Number(params.entryDteMin ?? 14);
  const entryDteMax = Number(params.entryDteMax ?? 30);
  const targetPct = Number(params.targetPct ?? 50);
  const stopLossMultiplier = Number(params.stopLossMultiplier ?? 2);
  const exitDte = Number(params.exitDte ?? 5);

  const underlying = getUnderlying(params);
  let openPos: { id: string; credit: number; expiry: string; ceShort: number; pShort: number } | null = null;
  let posCounter = 0;

  for (let i = 0; i < chainHistory.length; i++) {
    const chain = chainHistory[i];
    const dateStr = chain.timestamp.slice(0, 10);
    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const dte = getDTE(dateStr, expiry);

    if (openPos) {
      const curDte = getDTE(dateStr, openPos.expiry);
      // Simplified: check time exit
      if (curDte <= exitDte) {
        signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: "time_exit" });
        openPos = null;
      }
      continue;
    }

    if (dte < entryDteMin || dte > entryDteMax) continue;

    const ceShort = findStrikeByDelta(chain, shortDelta, "CE");
    const peShort = findStrikeByDelta(chain, -shortDelta, "PE");
    if (ceShort === 0 || peShort === 0) continue;

    const ceLong = ceShort + wingWidth;
    const peLong = peShort - wingWidth;
    if (peLong <= 0) continue;

    // Check all strikes exist in chain
    if (!chain.strikes.has(ceShort) || !chain.strikes.has(peShort)) continue;

    const posId = `iron_condor_${++posCounter}`;
    signals.push({
      timestamp: chain.timestamp, type: "OPEN", positionId: posId,
      legs: [
        { strike: ceShort, optionType: "CE", side: "SELL", expiry, lots: 1 },
        { strike: ceLong, optionType: "CE", side: "BUY", expiry, lots: 1 },
        { strike: peShort, optionType: "PE", side: "SELL", expiry, lots: 1 },
        { strike: peLong, optionType: "PE", side: "BUY", expiry, lots: 1 },
      ],
      reason: `IC: sell CE${ceShort}/PE${peShort}, wings ${wingWidth}pts, DTE ${dte}`,
    });
    openPos = { id: posId, credit: 0, expiry, ceShort, pShort: peShort };
  }

  return signals;
}

// ── Strategy 4: Iron Butterfly ──────────────────────────────────────

function ironButterfly(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  params: Record<string, number | string>
): FnoSignal[] {
  const signals: FnoSignal[] = [];
  const wingWidth = Number(params.wingWidth ?? 250);
  const entryDteMin = Number(params.entryDteMin ?? 7);
  const entryDteMax = Number(params.entryDteMax ?? 21);
  const exitDte = Number(params.exitDte ?? 3);

  const underlying = getUnderlying(params);
  let openPos: { id: string; expiry: string } | null = null;
  let posCounter = 0;

  for (let i = 0; i < chainHistory.length; i++) {
    const chain = chainHistory[i];
    const dateStr = chain.timestamp.slice(0, 10);
    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const dte = getDTE(dateStr, expiry);

    if (openPos) {
      if (getDTE(dateStr, openPos.expiry) <= exitDte) {
        signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: "time_exit" });
        openPos = null;
      }
      continue;
    }

    if (dte < entryDteMin || dte > entryDteMax) continue;

    const atm = getATMStrike(chain.spotPrice, underlying);
    const posId = `iron_butterfly_${++posCounter}`;
    signals.push({
      timestamp: chain.timestamp, type: "OPEN", positionId: posId,
      legs: [
        { strike: atm, optionType: "CE", side: "SELL", expiry, lots: 1 },
        { strike: atm, optionType: "PE", side: "SELL", expiry, lots: 1 },
        { strike: atm + wingWidth, optionType: "CE", side: "BUY", expiry, lots: 1 },
        { strike: atm - wingWidth, optionType: "PE", side: "BUY", expiry, lots: 1 },
      ],
      reason: `IB at ${atm}, wings ${wingWidth}pts, DTE ${dte}`,
    });
    openPos = { id: posId, expiry };
  }

  return signals;
}

// ── Strategy 5: Deep OTM Sell (Custom) ──────────────────────────────

function deepOtmSell(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  params: Record<string, number | string>
): FnoSignal[] {
  const signals: FnoSignal[] = [];
  const otmDistance = Number(params.otmDistance ?? 1000);
  const minPremium = Number(params.minPremium ?? 50);
  const targetDecayPct = Number(params.targetDecayPct ?? 80);
  const stopLossMultiplier = Number(params.stopLossMultiplier ?? 2);
  const dangerBufferPts = Number(params.dangerBufferPts ?? 200);
  const entryDteMin = Number(params.entryDteMin ?? 7);
  const entryDteMax = Number(params.entryDteMax ?? 20);

  const underlying = getUnderlying(params);
  let openPos: { id: string; ceStrike: number; peStrike: number; entryPrem: number; expiry: string } | null = null;
  let posCounter = 0;

  for (let i = 0; i < chainHistory.length; i++) {
    const chain = chainHistory[i];
    const dateStr = chain.timestamp.slice(0, 10);
    const spot = chain.spotPrice;
    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const dte = getDTE(dateStr, expiry);

    if (openPos) {
      const ceQ = chain.strikes.get(openPos.ceStrike)?.ce;
      const peQ = chain.strikes.get(openPos.peStrike)?.pe;

      if (ceQ && peQ) {
        const currentPrem = ceQ.price + peQ.price;
        const decayPct = ((openPos.entryPrem - currentPrem) / openPos.entryPrem) * 100;

        // Danger: spot getting close to either (now correctly-OTM) strike.
        // CE is above spot → danger when spot rises toward it; PE is below spot → danger when spot falls toward it.
        const ceDanger = spot >= openPos.ceStrike - dangerBufferPts;
        const peDanger = spot <= openPos.peStrike + dangerBufferPts;
        // SL: premium doubled
        const slHit = currentPrem >= openPos.entryPrem * stopLossMultiplier;

        if (decayPct >= targetDecayPct || slHit || ceDanger || peDanger) {
          const reason = decayPct >= targetDecayPct ? "target_hit" : slHit ? "stop_loss" : "danger_exit";
          signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason });
          openPos = null;
        }
      }
      continue;
    }

    if (dte < entryDteMin || dte > entryDteMax) continue;

    // CE strike = spot + otmDistance (deep OTM call, ABOVE spot)
    // PE strike = spot - otmDistance (deep OTM put, BELOW spot)
    // (was inverted: spot-dist for CE / spot+dist for PE sold deep ITM options instead of OTM)
    const ceStrike = getATMStrike(spot + otmDistance, underlying);
    const peStrike = getATMStrike(spot - otmDistance, underlying);

    const ceQ = chain.strikes.get(ceStrike)?.ce;
    const peQ = chain.strikes.get(peStrike)?.pe;
    if (!ceQ || !peQ) continue;

    // Premium filter
    if (ceQ.price < minPremium || peQ.price < minPremium) continue;

    const posId = `deep_otm_sell_${++posCounter}`;
    signals.push({
      timestamp: chain.timestamp, type: "OPEN", positionId: posId,
      legs: [
        { strike: ceStrike, optionType: "CE", side: "SELL", expiry, lots: 1 },
        { strike: peStrike, optionType: "PE", side: "SELL", expiry, lots: 1 },
      ],
      reason: `Deep OTM: sell CE${ceStrike} (₹${ceQ.price.toFixed(0)}) + PE${peStrike} (₹${peQ.price.toFixed(0)}), DTE ${dte}`,
    });
    openPos = { id: posId, ceStrike, peStrike, entryPrem: ceQ.price + peQ.price, expiry };
  }

  return signals;
}

// ── Strategy 6: Bull Call Spread ────────────────────────────────────

function bullCallSpread(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  params: Record<string, number | string>
): FnoSignal[] {
  const signals: FnoSignal[] = [];
  const spreadWidth = Number(params.spreadWidth ?? 150);
  const entryDteMin = Number(params.entryDteMin ?? 7);
  const entryDteMax = Number(params.entryDteMax ?? 21);
  const rsiMin = Number(params.rsiMin ?? 55);
  const exitDte = Number(params.exitDte ?? 3);

  const closes = spotCandles.map(c => c.close);
  const rsiValues = rsi(closes, 14);

  const underlying = getUnderlying(params);
  let openPos: { id: string; expiry: string } | null = null;
  let posCounter = 0;

  for (let i = 0; i < chainHistory.length && i < spotCandles.length; i++) {
    const chain = chainHistory[i];
    const dateStr = chain.timestamp.slice(0, 10);
    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const dte = getDTE(dateStr, expiry);

    if (openPos) {
      if (getDTE(dateStr, openPos.expiry) <= exitDte) {
        signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: "time_exit" });
        openPos = null;
      }
      continue;
    }

    if (dte < entryDteMin || dte > entryDteMax) continue;
    if (isNaN(rsiValues[i]) || rsiValues[i] < rsiMin) continue;

    const atm = getATMStrike(chain.spotPrice, underlying);
    const posId = `bull_call_spread_${++posCounter}`;
    signals.push({
      timestamp: chain.timestamp, type: "OPEN", positionId: posId,
      legs: [
        { strike: atm, optionType: "CE", side: "BUY", expiry, lots: 1 },
        { strike: atm + spreadWidth, optionType: "CE", side: "SELL", expiry, lots: 1 },
      ],
      reason: `Bull CS at ${atm}, RSI ${rsiValues[i].toFixed(1)}, DTE ${dte}`,
    });
    openPos = { id: posId, expiry };
  }

  return signals;
}

// ── Strategy 7: Bear Put Spread ─────────────────────────────────────

function bearPutSpread(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  params: Record<string, number | string>
): FnoSignal[] {
  const signals: FnoSignal[] = [];
  const spreadWidth = Number(params.spreadWidth ?? 150);
  const entryDteMin = Number(params.entryDteMin ?? 7);
  const entryDteMax = Number(params.entryDteMax ?? 21);
  const rsiMax = Number(params.rsiMax ?? 45);
  const exitDte = Number(params.exitDte ?? 3);

  const closes = spotCandles.map(c => c.close);
  const rsiValues = rsi(closes, 14);

  const underlying = getUnderlying(params);
  let openPos: { id: string; expiry: string } | null = null;
  let posCounter = 0;

  for (let i = 0; i < chainHistory.length && i < spotCandles.length; i++) {
    const chain = chainHistory[i];
    const dateStr = chain.timestamp.slice(0, 10);
    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const dte = getDTE(dateStr, expiry);

    if (openPos) {
      if (getDTE(dateStr, openPos.expiry) <= exitDte) {
        signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: "time_exit" });
        openPos = null;
      }
      continue;
    }

    if (dte < entryDteMin || dte > entryDteMax) continue;
    if (isNaN(rsiValues[i]) || rsiValues[i] > rsiMax) continue;

    const atm = getATMStrike(chain.spotPrice, underlying);
    const posId = `bear_put_spread_${++posCounter}`;
    signals.push({
      timestamp: chain.timestamp, type: "OPEN", positionId: posId,
      legs: [
        { strike: atm, optionType: "PE", side: "BUY", expiry, lots: 1 },
        { strike: atm - spreadWidth, optionType: "PE", side: "SELL", expiry, lots: 1 },
      ],
      reason: `Bear PS at ${atm}, RSI ${rsiValues[i].toFixed(1)}, DTE ${dte}`,
    });
    openPos = { id: posId, expiry };
  }

  return signals;
}

// ── Strategy 8: EMA50 Directional (Custom — Intraday) ───────────────

function ema50Directional(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  params: Record<string, number | string>
): FnoSignal[] {
  const underlying = getUnderlying(params);
  const signals: FnoSignal[] = [];
  const emaPeriod = Number(params.emaPeriod ?? 50);
  const confirmCandles = Number(params.confirmCandles ?? 3);
  const targetPct = Number(params.targetPct ?? 50);
  const stopLossPct = Number(params.stopLossPct ?? 30);
  const entryStartTime = String(params.entryStartTime ?? "09:35");
  const entryEndTime = String(params.entryEndTime ?? "14:00");
  const exitTime = String(params.exitTime ?? "15:15");

  const closes = spotCandles.map(c => c.close);
  const emaValues = ema(closes, emaPeriod);

  let openPos: {
    id: string; side: "CE" | "PE"; entryPrice: number; strike: number; expiry: string;
  } | null = null;
  let posCounter = 0;
  let aboveCount = 0;
  let belowCount = 0;

  for (let i = 1; i < spotCandles.length && i < chainHistory.length; i++) {
    const chain = chainHistory[i];
    const candle = spotCandles[i];
    const time = timeFromTimestamp(candle.timestamp);
    const dateStr = candle.timestamp.slice(0, 10);

    if (isNaN(emaValues[i])) continue;

    // Track consecutive candles above/below EMA
    if (candle.close > emaValues[i]) {
      aboveCount++;
      belowCount = 0;
    } else {
      belowCount++;
      aboveCount = 0;
    }

    // Mandatory time exit
    if (openPos && time >= exitTime) {
      signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: "time_exit" });
      openPos = null;
      continue;
    }

    // Check exit for open position
    if (openPos) {
      const q = chain.strikes.get(openPos.strike);
      const quote = openPos.side === "CE" ? q?.ce : q?.pe;
      if (quote) {
        const pnlPct = ((quote.price - openPos.entryPrice) / openPos.entryPrice) * 100;
        if (pnlPct >= targetPct || pnlPct <= -stopLossPct) {
          signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: pnlPct >= targetPct ? "target_hit" : "stop_loss" });
          openPos = null;
        }
        // Reverse signal exit
        else if ((openPos.side === "CE" && belowCount >= 2) || (openPos.side === "PE" && aboveCount >= 2)) {
          signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: "reverse_signal" });
          openPos = null;
        }
      }
      continue;
    }

    // Entry conditions
    if (time < entryStartTime || time > entryEndTime) continue;

    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const atm = getATMStrike(chain.spotPrice, underlying);

    if (aboveCount >= confirmCandles && crossover(closes, emaValues, i)) {
      const posId = `ema50_ce_${++posCounter}`;
      const ceQ = chain.strikes.get(atm)?.ce;
      if (!ceQ) continue;
      signals.push({
        timestamp: chain.timestamp, type: "OPEN", positionId: posId,
        legs: [{ strike: atm, optionType: "CE", side: "BUY", expiry, lots: 1 }],
        reason: `EMA50 bullish crossover, ${confirmCandles} candles confirmed`,
      });
      openPos = { id: posId, side: "CE", entryPrice: ceQ.price, strike: atm, expiry };
    } else if (belowCount >= confirmCandles && crossunder(closes, emaValues, i)) {
      const posId = `ema50_pe_${++posCounter}`;
      const peQ = chain.strikes.get(atm)?.pe;
      if (!peQ) continue;
      signals.push({
        timestamp: chain.timestamp, type: "OPEN", positionId: posId,
        legs: [{ strike: atm, optionType: "PE", side: "BUY", expiry, lots: 1 }],
        reason: `EMA50 bearish crossover, ${confirmCandles} candles confirmed`,
      });
      openPos = { id: posId, side: "PE", entryPrice: peQ.price, strike: atm, expiry };
    }
  }

  return signals;
}

// ── Strategy 9: Long Straddle ───────────────────────────────────────

function longStraddle(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  params: Record<string, number | string>
): FnoSignal[] {
  const signals: FnoSignal[] = [];
  const ivPercentileMax = Number(params.ivPercentileMax ?? 25);
  const entryDteMin = Number(params.entryDteMin ?? 3);
  const entryDteMax = Number(params.entryDteMax ?? 10);
  const targetPct = Number(params.targetPct ?? 40);
  const stopLossPct = Number(params.stopLossPct ?? 25);
  const exitDte = Number(params.exitDte ?? 1);

  const underlying = getUnderlying(params);
  let openPos: { id: string; entryPrem: number; strike: number; expiry: string } | null = null;
  let posCounter = 0;
  const ivHistory: number[] = [];

  for (let i = 0; i < chainHistory.length; i++) {
    const chain = chainHistory[i];
    const dateStr = chain.timestamp.slice(0, 10);
    const currentIV = getAvgIV(chain, underlying);
    ivHistory.push(currentIV);
    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const dte = getDTE(dateStr, expiry);

    if (openPos) {
      const ceQ = chain.strikes.get(openPos.strike)?.ce;
      const peQ = chain.strikes.get(openPos.strike)?.pe;
      if (ceQ && peQ) {
        const current = ceQ.price + peQ.price;
        const gainPct = ((current - openPos.entryPrem) / openPos.entryPrem) * 100;
        const lossPct = ((openPos.entryPrem - current) / openPos.entryPrem) * 100;
        const curDte = getDTE(dateStr, openPos.expiry);

        if (gainPct >= targetPct || lossPct >= stopLossPct || curDte <= exitDte) {
          signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: gainPct >= targetPct ? "target_hit" : lossPct >= stopLossPct ? "stop_loss" : "time_exit" });
          openPos = null;
        }
      }
      continue;
    }

    if (dte < entryDteMin || dte > entryDteMax) continue;
    const ivPct = calculateIVPercentile(ivHistory.slice(0, -1), currentIV);
    if (ivPct > ivPercentileMax && ivHistory.length > 5) continue;

    const atm = getATMStrike(chain.spotPrice, underlying);
    const ceQ = chain.strikes.get(atm)?.ce;
    const peQ = chain.strikes.get(atm)?.pe;
    if (!ceQ || !peQ) continue;

    const posId = `long_straddle_${++posCounter}`;
    signals.push({
      timestamp: chain.timestamp, type: "OPEN", positionId: posId,
      legs: [
        { strike: atm, optionType: "CE", side: "BUY", expiry, lots: 1 },
        { strike: atm, optionType: "PE", side: "BUY", expiry, lots: 1 },
      ],
      reason: `Low IV pct ${ivPct.toFixed(0)}%, DTE ${dte}`,
    });
    openPos = { id: posId, entryPrem: ceQ.price + peQ.price, strike: atm, expiry };
  }

  return signals;
}

// ── Strategy 10: Calendar Spread ────────────────────────────────────

function calendarSpread(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  params: Record<string, number | string>
): FnoSignal[] {
  const signals: FnoSignal[] = [];
  const nearDteMin = Number(params.nearDteMin ?? 3);
  const nearDteMax = Number(params.nearDteMax ?? 7);
  const spotMoveExitPct = Number(params.spotMoveExitPct ?? 3);

  const underlying = getUnderlying(params);
  let openPos: { id: string; nearExpiry: string; farExpiry: string; strike: number; entrySpot: number } | null = null;
  let posCounter = 0;

  for (let i = 0; i < chainHistory.length; i++) {
    const chain = chainHistory[i];
    const dateStr = chain.timestamp.slice(0, 10);
    const nearExpiry = getNextExpiry(underlying, dateStr, "weekly");
    const nearDte = getDTE(dateStr, nearExpiry);

    if (openPos) {
      const movePct = Math.abs((chain.spotPrice - openPos.entrySpot) / openPos.entrySpot) * 100;
      const nearDteNow = getDTE(dateStr, openPos.nearExpiry);
      if (movePct >= spotMoveExitPct || nearDteNow <= 0) {
        signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: movePct >= spotMoveExitPct ? "spot_move_exit" : "near_expiry" });
        openPos = null;
      }
      continue;
    }

    if (nearDte < nearDteMin || nearDte > nearDteMax) continue;

    // Get far expiry (next week after near)
    const farDate = new Date(nearExpiry + "T00:00:00Z");
    farDate.setUTCDate(farDate.getUTCDate() + 1);
    const farExpiry = getNextExpiry(underlying, farDate.toISOString().slice(0, 10), "weekly");
    if (farExpiry === nearExpiry) continue;

    const atm = getATMStrike(chain.spotPrice, underlying);
    const posId = `calendar_spread_${++posCounter}`;
    signals.push({
      timestamp: chain.timestamp, type: "OPEN", positionId: posId,
      legs: [
        { strike: atm, optionType: "CE", side: "SELL", expiry: nearExpiry, lots: 1 },
        { strike: atm, optionType: "CE", side: "BUY", expiry: farExpiry, lots: 1 },
      ],
      reason: `Calendar: sell ${nearExpiry} buy ${farExpiry} at ${atm}`,
    });
    openPos = { id: posId, nearExpiry, farExpiry, strike: atm, entrySpot: chain.spotPrice };
  }

  return signals;
}

// ── Strategy 11: 9:20 Short Straddle ────────────────────────────────

function straddle920(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  params: Record<string, number | string>
): FnoSignal[] {
  const signals: FnoSignal[] = [];
  const entryTime = String(params.entryTime ?? "09:20");
  const exitTime = String(params.exitTime ?? "15:15");
  const targetPct = Number(params.targetPct ?? 50);
  const stopLossPct = Number(params.stopLossPct ?? 30);

  const underlying = getUnderlying(params);
  let openPos: { id: string; entryPrem: number; strike: number; expiry: string } | null = null;
  let posCounter = 0;

  for (let i = 0; i < chainHistory.length; i++) {
    const chain = chainHistory[i];
    const time = timeFromTimestamp(chain.timestamp);
    const dateStr = chain.timestamp.slice(0, 10);

    // Mandatory time exit
    if (openPos && time >= exitTime) {
      signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: "time_exit" });
      openPos = null;
      continue;
    }

    if (openPos) {
      const ceQ = chain.strikes.get(openPos.strike)?.ce;
      const peQ = chain.strikes.get(openPos.strike)?.pe;
      if (ceQ && peQ) {
        const current = ceQ.price + peQ.price;
        const decayPct = ((openPos.entryPrem - current) / openPos.entryPrem) * 100;
        const lossPct = ((current - openPos.entryPrem) / openPos.entryPrem) * 100;

        if (decayPct >= targetPct || lossPct >= stopLossPct) {
          signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: decayPct >= targetPct ? "target_hit" : "stop_loss" });
          openPos = null;
        }
      }
      continue;
    }

    // Entry at 9:20
    if (time !== entryTime) continue;

    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const atm = getATMStrike(chain.spotPrice, underlying);
    const ceQ = chain.strikes.get(atm)?.ce;
    const peQ = chain.strikes.get(atm)?.pe;
    if (!ceQ || !peQ) continue;

    const posId = `straddle_920_${++posCounter}`;
    signals.push({
      timestamp: chain.timestamp, type: "OPEN", positionId: posId,
      legs: [
        { strike: atm, optionType: "CE", side: "SELL", expiry, lots: 1 },
        { strike: atm, optionType: "PE", side: "SELL", expiry, lots: 1 },
      ],
      reason: `9:20 straddle at ${atm}, premium ₹${(ceQ.price + peQ.price).toFixed(0)}`,
    });
    openPos = { id: posId, entryPrem: ceQ.price + peQ.price, strike: atm, expiry };
  }

  return signals;
}

// ── Strategy 12: OI Max Pain ────────────────────────────────────────

function oiMaxPain(
  chainHistory: OptionsChainSnapshot[],
  spotCandles: Candle[],
  params: Record<string, number | string>
): FnoSignal[] {
  const signals: FnoSignal[] = [];
  const maxPainDeviationMin = Number(params.maxPainDeviationMin ?? 200);
  const convergenceTarget = Number(params.convergenceTarget ?? 50);
  const stopLossDeviation = Number(params.stopLossDeviation ?? 150);
  const entryDte = Number(params.entryDte ?? 2);

  const underlying = getUnderlying(params);
  let openPos: { id: string; maxPain: number; expiry: string } | null = null;
  let posCounter = 0;

  for (let i = 0; i < chainHistory.length; i++) {
    const chain = chainHistory[i];
    const dateStr = chain.timestamp.slice(0, 10);
    const expiry = getNextExpiry(underlying, dateStr, "weekly");
    const dte = getDTE(dateStr, expiry);
    const spot = chain.spotPrice;
    const maxPain = calculateMaxPain(chain);

    if (openPos) {
      const distToMaxPain = Math.abs(spot - openPos.maxPain);
      if (distToMaxPain <= convergenceTarget) {
        signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: "target_hit" });
        openPos = null;
      } else if (distToMaxPain > maxPainDeviationMin + stopLossDeviation) {
        signals.push({ timestamp: chain.timestamp, type: "CLOSE", positionId: openPos.id, legs: [], reason: "stop_loss" });
        openPos = null;
      }
      continue;
    }

    if (dte > entryDte || dte === 0) continue;

    const deviation = Math.abs(spot - maxPain);
    if (deviation < maxPainDeviationMin) continue;

    const pcr = calculatePCR(chain);
    const atm = getATMStrike(spot, underlying);

    // If spot > maxPain: sell CE (expect drop). If spot < maxPain: sell PE (expect rise).
    const posId = `oi_max_pain_${++posCounter}`;
    if (spot > maxPain) {
      signals.push({
        timestamp: chain.timestamp, type: "OPEN", positionId: posId,
        legs: [{ strike: atm, optionType: "CE", side: "SELL", expiry, lots: 1 }],
        reason: `Max pain ${maxPain}, spot ${spot.toFixed(0)} above, PCR ${pcr.toFixed(2)}`,
      });
    } else {
      signals.push({
        timestamp: chain.timestamp, type: "OPEN", positionId: posId,
        legs: [{ strike: atm, optionType: "PE", side: "SELL", expiry, lots: 1 }],
        reason: `Max pain ${maxPain}, spot ${spot.toFixed(0)} below, PCR ${pcr.toFixed(2)}`,
      });
    }
    openPos = { id: posId, maxPain, expiry };
  }

  return signals;
}

// ── Strategy Registry ───────────────────────────────────────────────

export const FNO_STRATEGY_REGISTRY: Record<FnoStrategyName, FnoStrategyDefinition> = {
  short_straddle: {
    name: "short_straddle",
    fn: shortStraddle,
    defaults: { ivPercentileMin: 50, entryDteMin: 7, entryDteMax: 15, targetPct: 50, stopLossPct: 50, exitDte: 2, spotMovePct: 2 },
    description: "Sell ATM CE + PE, profit from time decay in range-bound markets",
    executionMode: "positional",
    refreshInterval: "30m",
    regimes: ["range_bound"],
    vixRange: { min: 0, max: 18 },
  },
  short_strangle: {
    name: "short_strangle",
    fn: shortStrangle,
    defaults: { ceDelta: 0.20, peDelta: -0.20, ivPercentileMin: 40, entryDteMin: 10, entryDteMax: 21, targetPct: 60, stopLossPct: 100, exitDte: 3 },
    description: "Sell OTM CE + PE (delta ~0.2), wider profit zone than straddle",
    executionMode: "positional",
    refreshInterval: "30m",
    regimes: ["range_bound"],
    vixRange: { min: 0, max: 20 },
  },
  iron_condor: {
    name: "iron_condor",
    fn: ironCondor,
    defaults: { shortDelta: 0.16, wingWidth: 150, entryDteMin: 14, entryDteMax: 30, targetPct: 50, stopLossMultiplier: 2, exitDte: 5, adjustmentBuffer: 50 },
    description: "Short strangle with protective wings — defined risk, 77-87% win rate",
    executionMode: "positional",
    refreshInterval: "30m",
    regimes: ["range_bound"],
    vixRange: { min: 0, max: 15 },
  },
  iron_butterfly: {
    name: "iron_butterfly",
    fn: ironButterfly,
    defaults: { wingWidth: 250, entryDteMin: 7, entryDteMax: 21, vixMax: 13, targetPct: 40, stopLossMultiplier: 1.5, exitDte: 3 },
    description: "ATM straddle + OTM wings, max theta at ATM, tight range",
    executionMode: "positional",
    refreshInterval: "30m",
    regimes: ["range_bound"],
    vixRange: { min: 0, max: 13 },
  },
  deep_otm_sell: {
    name: "deep_otm_sell",
    fn: deepOtmSell,
    defaults: { otmDistance: 1000, minPremium: 50, targetDecayPct: 80, stopLossMultiplier: 2, dangerBufferPts: 200, entryDteMin: 7, entryDteMax: 20, vixMax: 20, vixHighOtmDistance: 1500 },
    description: "Sell deep OTM CE + PE (1000pts away), wait for premium to decay to near-zero",
    executionMode: "positional",
    refreshInterval: "1h",
    regimes: ["range_bound", "trending_up", "trending_down"],
    vixRange: { min: 0, max: 20 },
  },
  bull_call_spread: {
    name: "bull_call_spread",
    fn: bullCallSpread,
    defaults: { spreadWidth: 150, ivPercentileMax: 40, entryDteMin: 7, entryDteMax: 21, targetPct: 70, stopLossPct: 50, exitDte: 3, rsiMin: 55 },
    description: "Buy lower CE + sell higher CE on bullish breakout with RSI confirmation",
    executionMode: "positional",
    refreshInterval: "15m",
    regimes: ["trending_up"],
    vixRange: { min: 0, max: 18 },
  },
  bear_put_spread: {
    name: "bear_put_spread",
    fn: bearPutSpread,
    defaults: { spreadWidth: 150, ivPercentileMax: 40, entryDteMin: 7, entryDteMax: 21, targetPct: 70, stopLossPct: 50, exitDte: 3, rsiMax: 45 },
    description: "Buy higher PE + sell lower PE on bearish breakdown with RSI confirmation",
    executionMode: "positional",
    refreshInterval: "15m",
    regimes: ["trending_down"],
    vixRange: { min: 0, max: 18 },
  },
  ema50_directional: {
    name: "ema50_directional",
    fn: ema50Directional,
    defaults: { emaPeriod: 50, confirmCandles: 3, reverseConfirmCandles: 2, targetPct: 50, stopLossPct: 30, entryStartTime: "09:35", entryEndTime: "14:00", exitTime: "15:15", strikeSelection: "atm" },
    description: "Buy CE/PE based on 1-min EMA(50) crossover — intraday only",
    executionMode: "intraday",
    refreshInterval: "1m",
    regimes: ["trending_up", "trending_down"],
    vixRange: { min: 12, max: 30 },
  },
  long_straddle: {
    name: "long_straddle",
    fn: longStraddle,
    defaults: { ivPercentileMax: 25, entryDteMin: 3, entryDteMax: 10, targetPct: 40, stopLossPct: 25, exitDte: 1, bollingerSqueeze: 0.05 },
    description: "Buy ATM CE + PE when IV is cheap, profit from big moves/events",
    executionMode: "positional",
    refreshInterval: "15m",
    regimes: ["high_volatility"],
    vixRange: { min: 0, max: 25 },
  },
  calendar_spread: {
    name: "calendar_spread",
    fn: calendarSpread,
    defaults: { ivDifferentialMin: 3, nearDteMin: 3, nearDteMax: 7, spotMoveExitPct: 3 },
    description: "Sell near-expiry + buy far-expiry, profit from differential time decay",
    executionMode: "positional",
    refreshInterval: "30m",
    regimes: ["range_bound"],
    vixRange: { min: 0, max: 20 },
  },
  straddle_920: {
    name: "straddle_920",
    fn: straddle920,
    defaults: { entryTime: "09:20", exitTime: "15:15", targetPct: 50, stopLossPct: 30, legStopMultiplier: 3, skipGapPct: 1, vixMin: 10 },
    description: "9:20 AM short straddle — sell ATM at open, close same day",
    executionMode: "intraday",
    refreshInterval: "1m",
    regimes: ["range_bound", "high_volatility"],
    vixRange: { min: 10, max: 30 },
  },
  oi_max_pain: {
    name: "oi_max_pain",
    fn: oiMaxPain,
    defaults: { maxPainDeviationMin: 200, convergenceTarget: 50, stopLossDeviation: 150, pcrBullish: 0.8, pcrBearish: 0.6, entryDte: 2 },
    description: "Trade toward max pain strike in last 2 DTE using OI analysis",
    executionMode: "positional",
    refreshInterval: "30m",
    regimes: ["range_bound"],
    vixRange: { min: 0, max: 25 },
  },
};
