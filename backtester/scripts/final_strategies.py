#!/usr/bin/env python3
"""
Final 6 Strategies — Production Ready
======================================
Backtested 2012-2026, survivorship-bias-free, dynamic universe, natural exits.

Primary (always on):
  1. BB_RSI_REVERT   — 6/6, 16d hold, mean-reversion
  2. STOCH_RSI_DBL   — 6/6, 101d hold, double-oversold
  3. RSI_OB_OS       — 6/6, 98d hold, RSI reversal

Secondary (always on):
  4. CANSLIM         — 5/6, 30d hold, volume breakout
  5. DUAL_MOMENTUM   — 5/6, 38d hold, absolute+relative momentum (MACD<0 exit)

Conditional (trend markets only):
  6. SUPERTREND      — 4/6, 44d hold, ATR-adaptive trend
"""

import math
from typing import List, Tuple


# ─── Strategy Functions ───────────────────────────────────────────────────────
# Each takes a list of Candle objects and returns [(signal_type, candle_index), ...]
# Signal types: 'BUY' or 'SELL'
# All use same-day close execution (scanner at 3:20 PM)


def strategy_bb_rsi_revert(candles) -> List[Tuple[str, int]]:
    """
    Bollinger Band + RSI Mean Reversion
    BUY:  Price ≤ Lower BB(20,2) AND RSI(14) < 30
    SELL: Price ≥ Middle BB OR RSI > 70
    """
    from pit_backtest_2012 import bollinger_bands, rsi
    closes = [c.close for c in candles]
    upper, lower, middle, _ = bollinger_bands(closes, 20, 2.0)
    rsi_vals = rsi(closes, 14)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if math.isnan(lower[i]) or math.isnan(rsi_vals[i]):
            continue
        if not in_pos and closes[i] <= lower[i] and rsi_vals[i] < 30:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and (closes[i] >= middle[i] or rsi_vals[i] > 70):
            signals.append(('SELL', i)); in_pos = False
    return signals


def strategy_stoch_rsi_dbl(candles) -> List[Tuple[str, int]]:
    """
    Double Oversold: Stochastic + RSI
    BUY:  %K(14) < 20 AND RSI(14) < 35 AND %K crosses above %D
    SELL: %K > 80 AND RSI > 65 AND %K crosses below %D
    """
    from pit_backtest_2012 import rsi, stochastic
    closes = [c.close for c in candles]
    rsi_vals = rsi(closes, 14)
    k_vals, d_vals = stochastic(candles, 14, 3)
    signals = []
    in_pos = False

    def xover(a, b, i):
        return (not math.isnan(a[i]) and not math.isnan(b[i]) and
                not math.isnan(a[i-1]) and not math.isnan(b[i-1]) and
                a[i-1] <= b[i-1] and a[i] > b[i])

    def xunder(a, b, i):
        return (not math.isnan(a[i]) and not math.isnan(b[i]) and
                not math.isnan(a[i-1]) and not math.isnan(b[i-1]) and
                a[i-1] >= b[i-1] and a[i] < b[i])

    for i in range(1, len(candles)):
        if any(math.isnan(v) for v in [k_vals[i], d_vals[i], rsi_vals[i]]):
            continue
        if not in_pos and k_vals[i] < 20 and rsi_vals[i] < 35 and xover(k_vals, d_vals, i):
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and k_vals[i] > 80 and rsi_vals[i] > 65 and xunder(k_vals, d_vals, i):
            signals.append(('SELL', i)); in_pos = False
    return signals


def strategy_rsi_ob_os(candles) -> List[Tuple[str, int]]:
    """
    Classic RSI Reversal
    BUY:  RSI(14) crosses above 30 from below
    SELL: RSI(14) crosses below 70 from above
    """
    from pit_backtest_2012 import rsi
    closes = [c.close for c in candles]
    rsi_vals = rsi(closes, 14)
    signals = []
    for i in range(1, len(candles)):
        if math.isnan(rsi_vals[i]) or math.isnan(rsi_vals[i-1]):
            continue
        if rsi_vals[i-1] <= 30 and rsi_vals[i] > 30:
            signals.append(('BUY', i))
        elif rsi_vals[i-1] >= 70 and rsi_vals[i] < 70:
            signals.append(('SELL', i))
    return signals


def strategy_canslim(candles) -> List[Tuple[str, int]]:
    """
    O'Neil CAN SLIM Breakout
    BUY:  Price > SMA(50) AND Volume > 1.5× avg(20) AND within 10% of 52W high AND RSI 50-80
    SELL: Price < SMA(50) OR -8% stop loss
    """
    from pit_backtest_2012 import sma, rsi
    closes = [c.close for c in candles]
    highs = [c.high for c in candles]
    volumes = [c.volume for c in candles]
    sma50 = sma(closes, 50)
    rsi_vals = rsi(closes, 14)
    vol_avg = sma(volumes, 20)
    signals = []
    in_pos = False
    entry_price = 0
    for i in range(252, len(candles)):
        if math.isnan(sma50[i]) or math.isnan(rsi_vals[i]) or math.isnan(vol_avg[i]) or vol_avg[i] == 0:
            continue
        high_52w = max(highs[max(0, i-252):i+1])
        pct_from_high = ((high_52w - closes[i]) / high_52w * 100) if high_52w > 0 else 100
        if not in_pos:
            if (closes[i] > sma50[i] and volumes[i] > 1.5 * vol_avg[i]
                    and pct_from_high <= 10 and 50 <= rsi_vals[i] <= 80):
                signals.append(('BUY', i)); in_pos = True; entry_price = closes[i]
        else:
            loss_pct = ((closes[i] - entry_price) / entry_price) * 100
            if closes[i] < sma50[i] or loss_pct <= -8:
                signals.append(('SELL', i)); in_pos = False
    return signals


def strategy_dual_momentum(candles) -> List[Tuple[str, int]]:
    """
    Antonacci Dual Momentum — IMPROVED with MACD<0 exit
    BUY:  Price > SMA(200) AND in top 75% of 52W range AND MACD(12,26,9) > 0
    SELL: Price < SMA(200) OR below 50% of 52W range OR MACD < 0
    """
    from pit_backtest_2012 import sma, ema
    closes = [c.close for c in candles]
    highs = [c.high for c in candles]
    sma200 = sma(closes, 200)
    # MACD
    ema12 = ema(closes, 12)
    ema26 = ema(closes, 26)
    macd_line = [float('nan')] * len(closes)
    for i in range(len(closes)):
        if not math.isnan(ema12[i]) and not math.isnan(ema26[i]):
            macd_line[i] = ema12[i] - ema26[i]
    signals = []
    in_pos = False
    for i in range(252, len(candles)):
        if math.isnan(sma200[i]) or math.isnan(macd_line[i]):
            continue
        high_52w = max(highs[max(0, i-252):i+1])
        low_52w = min(closes[max(0, i-252):i+1])
        range_52w = high_52w - low_52w
        pct = ((closes[i] - low_52w) / range_52w * 100) if range_52w > 0 else 50
        if not in_pos and closes[i] > sma200[i] and pct >= 75 and macd_line[i] > 0:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and (closes[i] < sma200[i] or pct < 50 or macd_line[i] < 0):
            signals.append(('SELL', i)); in_pos = False
    return signals


def strategy_supertrend(candles) -> List[Tuple[str, int]]:
    """
    ATR-Adaptive Trend Following (CONDITIONAL — trend markets only)
    BUY:  Supertrend(10, 3.0) flips from bearish to bullish
    SELL: Flips from bullish to bearish
    """
    from pit_backtest_2012 import supertrend
    _, direction = supertrend(candles, 10, 3.0)
    signals = []
    for i in range(1, len(candles)):
        if direction[i] == 1 and direction[i-1] == -1:
            signals.append(('BUY', i))
        elif direction[i] == -1 and direction[i-1] == 1:
            signals.append(('SELL', i))
    return signals


# ─── Strategy Registry ────────────────────────────────────────────────────────

FINAL_STRATEGIES = {
    # Primary — always on
    'BB_RSI_REVERT': strategy_bb_rsi_revert,
    'STOCH_RSI_DBL': strategy_stoch_rsi_dbl,
    'RSI_OB_OS': strategy_rsi_ob_os,
    # Secondary — always on
    'CANSLIM': strategy_canslim,
    'DUAL_MOMENTUM': strategy_dual_momentum,
    # Conditional — trend markets only
    'SUPERTREND': strategy_supertrend,
}

STRATEGY_META = {
    'BB_RSI_REVERT': {'type': 'Mean-Rev', 'role': 'PRIMARY', 'avg_hold': '16d', 'consistency': '6/6'},
    'STOCH_RSI_DBL': {'type': 'Mean-Rev', 'role': 'PRIMARY', 'avg_hold': '101d', 'consistency': '6/6'},
    'RSI_OB_OS': {'type': 'Mean-Rev', 'role': 'PRIMARY', 'avg_hold': '98d', 'consistency': '6/6'},
    'CANSLIM': {'type': 'Breakout', 'role': 'SECONDARY', 'avg_hold': '30d', 'consistency': '5/6'},
    'DUAL_MOMENTUM': {'type': 'Momentum', 'role': 'SECONDARY', 'avg_hold': '38d', 'consistency': '5/6'},
    'SUPERTREND': {'type': 'Trend', 'role': 'CONDITIONAL', 'avg_hold': '44d', 'consistency': '4/6'},
}
