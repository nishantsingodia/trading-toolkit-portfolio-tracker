#!/usr/bin/env python3
"""
Point-in-Time Equity Backtester — Survivorship-Bias-Free
=========================================================
Uses 2012 NIFTY 100 + MIDCAP 150 constituents (from NSE IndexInclExcl.xls).
Downloads 14 years of daily candles from Upstox free API (no auth needed).
Runs 6 dashboard strategies with multiple walk-forward period combinations.

Strategies (from Upstox Watchlist Dashboard):
  1. BB Squeeze     — Bollinger band squeeze breakout
  2. ADX+EMA        — ADX>25 + price crosses EMA50
  3. Supertrend     — ATR-adaptive trend direction change
  4. Turtle         — 20-day Donchian breakout, 15-day exit
  5. OBV+EMA        — EMA20/50 crossover with OBV volume confirmation
  6. Stochastic     — %K(10)/%D crossover in oversold zone

Walk-forward combos:
  Train → Test periods (years): 3→1, 5→2, 7→3, 10→3, 3→2, 5→3

Costs: Zerodha equity delivery (STT + exchange + SEBI + stamp + GST + slippage)

Usage:
  python3 pit_backtest_2012.py                    # full run
  python3 pit_backtest_2012.py --download-only     # just download candles
  python3 pit_backtest_2012.py --skip-download     # use cached candles
"""

import json, sys, time, math, argparse
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Tuple
from pathlib import Path
import urllib.request
import urllib.error

# ─── Config ───────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent.resolve()
DATA_DIR = SCRIPT_DIR / "candles_2012"
RESULTS_DIR = SCRIPT_DIR / "results"
STOCKS_FILE = SCRIPT_DIR / "stocks_2012.json"

UPSTOX_BASE = "https://api.upstox.com/v2/historical-candle"
FROM_DATE = "2012-01-01"
TO_DATE = "2026-04-01"

# Zerodha equity delivery costs
STT_RATE = 0.001         # 0.1% on buy+sell
EXCHANGE_TXN = 0.0000345  # NSE
SEBI_CHARGE = 0.000001    # Rs 10 per crore
STAMP_DUTY = 0.00015      # 0.015% on buy
GST_RATE = 0.18           # 18% on brokerage + exchange txn
SLIPPAGE = 0.0005         # 0.05% per trade

# ─── Data Structures ─────────────────────────────────────────────────────────

@dataclass
class Candle:
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: int

@dataclass
class Trade:
    entry_date: str
    entry_price: float
    exit_date: str
    exit_price: float
    pnl_pct: float
    cost_pct: float
    net_pnl_pct: float
    holding_days: int

@dataclass
class BacktestResult:
    symbol: str
    strategy: str
    category: str
    trades: int = 0
    wins: int = 0
    gross_pnl_pct: float = 0.0
    total_cost_pct: float = 0.0
    net_pnl_pct: float = 0.0
    max_drawdown_pct: float = 0.0
    win_rate: float = 0.0
    profit_factor: float = 0.0
    avg_hold_days: float = 0.0
    cagr: float = 0.0
    bh_cagr: float = 0.0
    sharpe: float = 0.0
    trade_list: List[Trade] = field(default_factory=list)

@dataclass
class WalkForwardResult:
    strategy: str
    train_years: int
    test_years: int
    n_folds: int
    in_sample_cagr: float
    out_sample_cagr: float
    degradation_pct: float
    oos_win_rate: float
    oos_profit_factor: float
    oos_trades: int
    oos_sharpe: float
    bh_cagr: float
    category_breakdown: Dict[str, float] = field(default_factory=dict)

# ─── Indicators ───────────────────────────────────────────────────────────────

def sma(data: List[float], period: int) -> List[float]:
    result = [float('nan')] * len(data)
    for i in range(period - 1, len(data)):
        result[i] = sum(data[i - period + 1:i + 1]) / period
    return result

def ema(data: List[float], period: int) -> List[float]:
    result = [float('nan')] * len(data)
    k = 2.0 / (period + 1)
    start = period - 1
    if start >= len(data):
        return result
    result[start] = sum(data[:period]) / period
    for i in range(start + 1, len(data)):
        result[i] = data[i] * k + result[i - 1] * (1 - k)
    return result

def rsi(closes: List[float], period: int = 14) -> List[float]:
    result = [float('nan')] * len(closes)
    if len(closes) < period + 1:
        return result
    gains = []
    losses = []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i - 1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    if avg_loss == 0:
        result[period] = 100.0
    else:
        result[period] = 100 - 100 / (1 + avg_gain / avg_loss)
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        if avg_loss == 0:
            result[i + 1] = 100.0
        else:
            result[i + 1] = 100 - 100 / (1 + avg_gain / avg_loss)
    return result

def atr(candles: List[Candle], period: int = 14) -> List[float]:
    result = [float('nan')] * len(candles)
    if len(candles) < 2:
        return result
    trs = []
    for i in range(1, len(candles)):
        tr = max(
            candles[i].high - candles[i].low,
            abs(candles[i].high - candles[i - 1].close),
            abs(candles[i].low - candles[i - 1].close)
        )
        trs.append(tr)
    if len(trs) < period:
        return result
    result[period] = sum(trs[:period]) / period
    for i in range(period, len(trs)):
        result[i + 1] = (result[i] * (period - 1) + trs[i]) / period
    return result

def adx(candles: List[Candle], period: int = 14) -> Tuple[List[float], List[float], List[float]]:
    n = len(candles)
    adx_vals = [float('nan')] * n
    plus_di = [float('nan')] * n
    minus_di = [float('nan')] * n
    if n < 2 * period + 1:
        return adx_vals, plus_di, minus_di

    plus_dm = []
    minus_dm = []
    tr_list = []
    for i in range(1, n):
        up = candles[i].high - candles[i - 1].high
        down = candles[i - 1].low - candles[i].low
        plus_dm.append(up if up > down and up > 0 else 0)
        minus_dm.append(down if down > up and down > 0 else 0)
        tr = max(
            candles[i].high - candles[i].low,
            abs(candles[i].high - candles[i - 1].close),
            abs(candles[i].low - candles[i - 1].close)
        )
        tr_list.append(tr)

    sm_plus = sum(plus_dm[:period])
    sm_minus = sum(minus_dm[:period])
    sm_tr = sum(tr_list[:period])

    dx_vals = []
    for i in range(period - 1, len(plus_dm)):
        if i == period - 1:
            pass
        else:
            sm_plus = sm_plus - sm_plus / period + plus_dm[i]
            sm_minus = sm_minus - sm_minus / period + minus_dm[i]
            sm_tr = sm_tr - sm_tr / period + tr_list[i]

        pdi = 100 * sm_plus / sm_tr if sm_tr > 0 else 0
        mdi = 100 * sm_minus / sm_tr if sm_tr > 0 else 0
        plus_di[i + 1] = pdi
        minus_di[i + 1] = mdi
        denom = pdi + mdi
        dx = 100 * abs(pdi - mdi) / denom if denom > 0 else 0
        dx_vals.append((i + 1, dx))

    if len(dx_vals) >= period:
        first_adx = sum(d for _, d in dx_vals[:period]) / period
        adx_vals[dx_vals[period - 1][0]] = first_adx
        prev_adx = first_adx
        for j in range(period, len(dx_vals)):
            idx, dx = dx_vals[j]
            new_adx = (prev_adx * (period - 1) + dx) / period
            adx_vals[idx] = new_adx
            prev_adx = new_adx

    return adx_vals, plus_di, minus_di

def bollinger_bands(closes: List[float], period: int = 20, std_dev: float = 2.0):
    upper = [float('nan')] * len(closes)
    lower = [float('nan')] * len(closes)
    middle = sma(closes, period)
    width = [float('nan')] * len(closes)
    for i in range(period - 1, len(closes)):
        m = middle[i]
        if math.isnan(m):
            continue
        variance = sum((closes[j] - m) ** 2 for j in range(i - period + 1, i + 1)) / period
        sd = math.sqrt(variance)
        upper[i] = m + std_dev * sd
        lower[i] = m - std_dev * sd
        width[i] = (upper[i] - lower[i]) / m if m > 0 else 0
    return upper, lower, middle, width

def supertrend(candles: List[Candle], period: int = 10, multiplier: float = 3.0):
    n = len(candles)
    direction = [0] * n
    st = [float('nan')] * n
    atr_vals = atr(candles, period)

    upper_band = [float('nan')] * n
    lower_band = [float('nan')] * n

    for i in range(period, n):
        if math.isnan(atr_vals[i]):
            continue
        hl2 = (candles[i].high + candles[i].low) / 2
        upper_band[i] = hl2 + multiplier * atr_vals[i]
        lower_band[i] = hl2 - multiplier * atr_vals[i]

        if i > period and not math.isnan(upper_band[i - 1]):
            if lower_band[i] < lower_band[i - 1] and candles[i - 1].close > lower_band[i - 1]:
                lower_band[i] = lower_band[i - 1]
            if upper_band[i] > upper_band[i - 1] and candles[i - 1].close < upper_band[i - 1]:
                upper_band[i] = upper_band[i - 1]

        if i == period:
            direction[i] = 1 if candles[i].close > upper_band[i] else -1
        else:
            prev_dir = direction[i - 1]
            if prev_dir == 1:
                direction[i] = -1 if candles[i].close < lower_band[i] else 1
            else:
                direction[i] = 1 if candles[i].close > upper_band[i] else -1

        st[i] = lower_band[i] if direction[i] == 1 else upper_band[i]

    return st, direction

def obv(candles: List[Candle]) -> List[float]:
    result = [0.0] * len(candles)
    for i in range(1, len(candles)):
        if candles[i].close > candles[i - 1].close:
            result[i] = result[i - 1] + candles[i].volume
        elif candles[i].close < candles[i - 1].close:
            result[i] = result[i - 1] - candles[i].volume
        else:
            result[i] = result[i - 1]
    return result

def stochastic(candles: List[Candle], k_period: int = 10, d_period: int = 3):
    n = len(candles)
    k_vals = [float('nan')] * n
    for i in range(k_period - 1, n):
        highest = max(c.high for c in candles[i - k_period + 1:i + 1])
        lowest = min(c.low for c in candles[i - k_period + 1:i + 1])
        denom = highest - lowest
        k_vals[i] = 100 * (candles[i].close - lowest) / denom if denom > 0 else 50
    d_vals = sma(k_vals, d_period)
    return k_vals, d_vals

def donchian(candles: List[Candle], entry_period: int = 20, exit_period: int = 15):
    n = len(candles)
    upper = [float('nan')] * n
    lower = [float('nan')] * n
    for i in range(entry_period, n):
        upper[i] = max(c.high for c in candles[i - entry_period:i])
    for i in range(exit_period, n):
        lower[i] = min(c.low for c in candles[i - exit_period:i])
    return upper, lower

# ─── Strategies ───────────────────────────────────────────────────────────────

def strategy_bb_squeeze(candles: List[Candle]) -> List[Tuple[str, int]]:
    """BB Squeeze: bands tighten then price breaks above upper band → BUY"""
    closes = [c.close for c in candles]
    upper, lower, middle, width = bollinger_bands(closes, 20, 2.0)
    signals = []

    # Average width for squeeze detection
    valid_w = [w for w in width if not math.isnan(w)]
    if not valid_w:
        return signals
    avg_width = sum(valid_w) / len(valid_w)
    squeeze_level = avg_width * 0.5

    in_squeeze = False
    for i in range(1, len(candles)):
        if math.isnan(width[i]) or math.isnan(upper[i]) or math.isnan(lower[i]):
            continue
        if width[i] < squeeze_level:
            in_squeeze = True
        elif in_squeeze:
            in_squeeze = False
            if candles[i].close > upper[i]:
                signals.append(('BUY', i))
            elif candles[i].close < lower[i]:
                signals.append(('SELL', i))
    return signals

def strategy_adx_ema(candles: List[Candle]) -> List[Tuple[str, int]]:
    """ADX+EMA: ADX>25 AND price crosses above EMA50 → BUY"""
    closes = [c.close for c in candles]
    ema50 = ema(closes, 50)
    adx_vals, _, _ = adx(candles, 14)
    signals = []

    in_pos = False
    for i in range(1, len(candles)):
        if math.isnan(ema50[i]) or math.isnan(adx_vals[i]) or math.isnan(ema50[i - 1]):
            continue
        if not in_pos:
            if adx_vals[i] > 25 and closes[i] > ema50[i] and closes[i - 1] <= ema50[i - 1]:
                signals.append(('BUY', i))
                in_pos = True
        else:
            if closes[i] < ema50[i] or adx_vals[i] < 15:
                signals.append(('SELL', i))
                in_pos = False
    return signals

def strategy_supertrend(candles: List[Candle]) -> List[Tuple[str, int]]:
    """Supertrend: direction flip → BUY/SELL"""
    _, direction = supertrend(candles, 10, 3.0)
    signals = []
    for i in range(1, len(candles)):
        if direction[i] == 1 and direction[i - 1] == -1:
            signals.append(('BUY', i))
        elif direction[i] == -1 and direction[i - 1] == 1:
            signals.append(('SELL', i))
    return signals

def strategy_turtle(candles: List[Candle]) -> List[Tuple[str, int]]:
    """Turtle: close > 20-day high → BUY, close < 15-day low → SELL"""
    upper, lower = donchian(candles, 20, 15)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if not in_pos:
            if not math.isnan(upper[i]) and candles[i].close > upper[i]:
                signals.append(('BUY', i))
                in_pos = True
        else:
            if not math.isnan(lower[i]) and candles[i].close < lower[i]:
                signals.append(('SELL', i))
                in_pos = False
    return signals

def strategy_obv_ema(candles: List[Candle]) -> List[Tuple[str, int]]:
    """OBV+EMA: EMA20>EMA50 AND OBV>EMA21(OBV) → BUY"""
    closes = [c.close for c in candles]
    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)
    obv_vals = obv(candles)
    obv_ema21 = ema(obv_vals, 21)
    signals = []

    in_pos = False
    for i in range(1, len(candles)):
        if any(math.isnan(v) for v in [ema20[i], ema50[i], obv_ema21[i]]):
            continue
        ema_bull = ema20[i] > ema50[i]
        obv_bull = obv_vals[i] > obv_ema21[i]
        if not in_pos:
            if ema_bull and obv_bull:
                signals.append(('BUY', i))
                in_pos = True
        else:
            if not ema_bull or not obv_bull:
                signals.append(('SELL', i))
                in_pos = False
    return signals

def strategy_stochastic(candles: List[Candle]) -> List[Tuple[str, int]]:
    """Stochastic: %K<20 crosses above %D → BUY, %K>80 crosses below %D → SELL"""
    k_vals, d_vals = stochastic(candles, 10, 3)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if any(math.isnan(v) for v in [k_vals[i], d_vals[i], k_vals[i - 1], d_vals[i - 1]]):
            continue
        if not in_pos:
            if k_vals[i - 1] <= 20 and k_vals[i - 1] <= d_vals[i - 1] and k_vals[i] > d_vals[i]:
                signals.append(('BUY', i))
                in_pos = True
        else:
            if k_vals[i - 1] >= 80 and k_vals[i - 1] >= d_vals[i - 1] and k_vals[i] < d_vals[i]:
                signals.append(('SELL', i))
                in_pos = False
    return signals

STRATEGIES = {
    'BB_SQUEEZE': strategy_bb_squeeze,
    'ADX_EMA': strategy_adx_ema,
    'SUPERTREND': strategy_supertrend,
    'TURTLE': strategy_turtle,
    'OBV_EMA': strategy_obv_ema,
    'STOCHASTIC': strategy_stochastic,
}

# ─── Cost Model ───────────────────────────────────────────────────────────────

def calc_round_trip_cost(buy_price: float, sell_price: float) -> float:
    """Calculate total cost % for a round-trip equity delivery trade."""
    buy_val = buy_price
    sell_val = sell_price

    stt = STT_RATE * (buy_val + sell_val)
    exchange = EXCHANGE_TXN * (buy_val + sell_val)
    sebi = SEBI_CHARGE * (buy_val + sell_val)
    stamp = STAMP_DUTY * buy_val
    brokerage = 0  # Zerodha free delivery
    gst = GST_RATE * (brokerage + exchange)
    slippage = SLIPPAGE * (buy_val + sell_val)

    total_cost = stt + exchange + sebi + stamp + gst + slippage
    avg_val = (buy_val + sell_val) / 2
    return (total_cost / avg_val) * 100 if avg_val > 0 else 0

# ─── Backtester Engine ────────────────────────────────────────────────────────

def run_backtest(candles: List[Candle], strategy_fn, symbol: str, category: str,
                 strategy_name: str) -> BacktestResult:
    """Run a single strategy on a single stock's candle data."""
    result = BacktestResult(symbol=symbol, strategy=strategy_name, category=category)

    if len(candles) < 200:
        return result

    signals = strategy_fn(candles)
    if not signals:
        return result

    # Execute at same-day close (scanner runs at 3:20 PM, trade in last 10 min)
    trades = []
    i = 0
    while i < len(signals):
        sig_type, sig_idx = signals[i]
        if sig_type != 'BUY':
            i += 1
            continue

        # Execute at signal day's close price
        entry_idx = sig_idx
        if entry_idx >= len(candles):
            break
        entry_price = candles[entry_idx].close

        # Find matching SELL
        exit_idx = None
        for j in range(i + 1, len(signals)):
            if signals[j][0] == 'SELL':
                exit_idx = signals[j][1]  # same day close
                i = j + 1
                break
        else:
            # No SELL found — force exit at last candle
            exit_idx = len(candles) - 1
            i = len(signals)

        if exit_idx >= len(candles):
            exit_idx = len(candles) - 1
        exit_price = candles[exit_idx].close

        pnl_pct = ((exit_price - entry_price) / entry_price) * 100
        cost_pct = calc_round_trip_cost(entry_price, exit_price)
        net_pnl = pnl_pct - cost_pct
        hold_days = exit_idx - entry_idx

        trades.append(Trade(
            entry_date=candles[entry_idx].date,
            entry_price=entry_price,
            exit_date=candles[exit_idx].date,
            exit_price=exit_price,
            pnl_pct=pnl_pct,
            cost_pct=cost_pct,
            net_pnl_pct=net_pnl,
            holding_days=hold_days,
        ))

    if not trades:
        return result

    # Metrics
    result.trades = len(trades)
    result.wins = sum(1 for t in trades if t.net_pnl_pct > 0)
    result.win_rate = result.wins / result.trades * 100
    result.gross_pnl_pct = sum(t.pnl_pct for t in trades)
    result.total_cost_pct = sum(t.cost_pct for t in trades)
    result.net_pnl_pct = sum(t.net_pnl_pct for t in trades)
    result.avg_hold_days = sum(t.holding_days for t in trades) / result.trades

    gross_profit = sum(t.net_pnl_pct for t in trades if t.net_pnl_pct > 0)
    gross_loss = abs(sum(t.net_pnl_pct for t in trades if t.net_pnl_pct < 0))
    result.profit_factor = gross_profit / gross_loss if gross_loss > 0 else 99.9

    # CAGR (compound returns)
    equity = 1.0
    peak = 1.0
    max_dd = 0.0
    monthly_returns = []
    for t in trades:
        r = t.net_pnl_pct / 100
        equity *= (1 + r)
        if equity > peak:
            peak = equity
        dd = (peak - equity) / peak * 100
        if dd > max_dd:
            max_dd = dd
        monthly_returns.append(r)
    result.max_drawdown_pct = max_dd

    first_date = datetime.strptime(candles[0].date[:10], '%Y-%m-%d')
    last_date = datetime.strptime(candles[-1].date[:10], '%Y-%m-%d')
    years = (last_date - first_date).days / 365.25
    if years > 0 and equity > 0:
        result.cagr = (equity ** (1 / years) - 1) * 100

    # Buy & Hold CAGR
    bh_return = candles[-1].close / candles[0].close if candles[0].close > 0 else 1
    if years > 0 and bh_return > 0:
        result.bh_cagr = (bh_return ** (1 / years) - 1) * 100

    # Sharpe (annualized, using trade returns)
    if len(monthly_returns) > 1:
        avg_r = sum(monthly_returns) / len(monthly_returns)
        var_r = sum((r - avg_r) ** 2 for r in monthly_returns) / (len(monthly_returns) - 1)
        std_r = math.sqrt(var_r)
        trades_per_year = result.trades / years if years > 0 else 12
        if std_r > 0:
            result.sharpe = (avg_r / std_r) * math.sqrt(trades_per_year)

    result.trade_list = trades
    return result

# ─── Data Download ────────────────────────────────────────────────────────────

def download_candles(symbol: str, instrument_key: str, data_dir: Path) -> Optional[List[Candle]]:
    """Download daily candles from Upstox free API in yearly chunks (API limit ~1yr per request)."""
    cache_file = data_dir / f"{symbol}.json"
    if cache_file.exists():
        with open(cache_file) as f:
            raw = json.load(f)
        return [Candle(**c) for c in raw]

    encoded_key = urllib.request.quote(instrument_key, safe='')  # encodes | → %7C
    all_raw = []

    for year in range(2012, 2027):
        from_d = f"{year}-01-01"
        to_d = f"{year}-12-31" if year < 2026 else TO_DATE
        url = f"{UPSTOX_BASE}/{encoded_key}/day/{to_d}/{from_d}"

        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                })
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = json.loads(resp.read().decode())
                chunk = data.get('data', {}).get('candles', [])
                all_raw.extend(chunk)
                break
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
                if attempt == 2:
                    pass  # skip this year chunk, continue with others
                time.sleep(1)

    if not all_raw:
        return None

    candles = []
    seen_dates = set()
    for c in all_raw:
        d = c[0][:10]
        if d in seen_dates:
            continue
        seen_dates.add(d)
        candles.append(Candle(
            date=d,
            open=float(c[1]),
            high=float(c[2]),
            low=float(c[3]),
            close=float(c[4]),
            volume=int(c[5]),
        ))
    candles.sort(key=lambda c: c.date)

    # Cache
    with open(cache_file, 'w') as f:
        json.dump([{'date': c.date, 'open': c.open, 'high': c.high,
                     'low': c.low, 'close': c.close, 'volume': c.volume}
                    for c in candles], f)
    return candles

# ─── Walk-Forward Engine ──────────────────────────────────────────────────────

def slice_candles_by_date(candles: List[Candle], start: str, end: str) -> List[Candle]:
    """Slice candles between start and end date strings (YYYY-MM-DD)."""
    return [c for c in candles if start <= c.date <= end]

def walk_forward_test(
    all_candle_data: Dict[str, Tuple[List[Candle], str]],  # symbol → (candles, category)
    strategy_name: str,
    strategy_fn,
    train_years: int,
    test_years: int,
    data_start: str = "2012-01-01",
    data_end: str = "2026-03-31",
) -> Optional[WalkForwardResult]:
    """
    Walk-forward optimization with rolling windows.
    Returns aggregated out-of-sample results across all folds.
    """
    start_dt = datetime.strptime(data_start, '%Y-%m-%d')
    end_dt = datetime.strptime(data_end, '%Y-%m-%d')
    window = train_years + test_years

    # Generate fold boundaries
    folds = []
    fold_start = start_dt
    while True:
        train_end = fold_start + timedelta(days=train_years * 365)
        test_end = train_end + timedelta(days=test_years * 365)
        if test_end > end_dt:
            # Use remaining data as last test window
            test_end = end_dt
            if (test_end - train_end).days < 180:  # minimum 6 months test
                break
        folds.append({
            'train_start': fold_start.strftime('%Y-%m-%d'),
            'train_end': train_end.strftime('%Y-%m-%d'),
            'test_start': train_end.strftime('%Y-%m-%d'),
            'test_end': test_end.strftime('%Y-%m-%d'),
        })
        fold_start = train_end  # slide by test_years
        if fold_start >= end_dt:
            break

    if not folds:
        return None

    # Run each fold
    all_is_results = []
    all_oos_results = []
    cat_oos = {'LARGECAP': [], 'MIDCAP': []}

    for fold in folds:
        for symbol, (candles, category) in all_candle_data.items():
            # In-sample
            train_slice = slice_candles_by_date(candles, fold['train_start'], fold['train_end'])
            if len(train_slice) >= 200:
                is_result = run_backtest(train_slice, strategy_fn, symbol, category, strategy_name)
                if is_result.trades > 0:
                    all_is_results.append(is_result)

            # Out-of-sample
            test_slice = slice_candles_by_date(candles, fold['test_start'], fold['test_end'])
            if len(test_slice) >= 50:
                oos_result = run_backtest(test_slice, strategy_fn, symbol, category, strategy_name)
                if oos_result.trades > 0:
                    all_oos_results.append(oos_result)
                    if category in cat_oos:
                        cat_oos[category].append(oos_result)

    if not all_oos_results:
        return None

    # Aggregate
    def agg_cagr(results):
        if not results:
            return 0
        return sum(r.cagr for r in results) / len(results)

    def agg_bh_cagr(results):
        if not results:
            return 0
        return sum(r.bh_cagr for r in results) / len(results)

    def agg_wr(results):
        total_trades = sum(r.trades for r in results)
        total_wins = sum(r.wins for r in results)
        return total_wins / total_trades * 100 if total_trades > 0 else 0

    def agg_pf(results):
        gp = sum(sum(t.net_pnl_pct for t in r.trade_list if t.net_pnl_pct > 0) for r in results)
        gl = abs(sum(sum(t.net_pnl_pct for t in r.trade_list if t.net_pnl_pct < 0) for r in results))
        return gp / gl if gl > 0 else 99.9

    def agg_sharpe(results):
        all_returns = []
        for r in results:
            all_returns.extend(t.net_pnl_pct / 100 for t in r.trade_list)
        if len(all_returns) < 2:
            return 0
        avg = sum(all_returns) / len(all_returns)
        var = sum((r - avg) ** 2 for r in all_returns) / (len(all_returns) - 1)
        std = math.sqrt(var)
        return avg / std * math.sqrt(252) if std > 0 else 0

    is_cagr = agg_cagr(all_is_results)
    oos_cagr = agg_cagr(all_oos_results)
    degradation = ((is_cagr - oos_cagr) / abs(is_cagr) * 100) if is_cagr != 0 else 0

    return WalkForwardResult(
        strategy=strategy_name,
        train_years=train_years,
        test_years=test_years,
        n_folds=len(folds),
        in_sample_cagr=is_cagr,
        out_sample_cagr=oos_cagr,
        degradation_pct=degradation,
        oos_win_rate=agg_wr(all_oos_results),
        oos_profit_factor=agg_pf(all_oos_results),
        oos_trades=sum(r.trades for r in all_oos_results),
        oos_sharpe=agg_sharpe(all_oos_results),
        bh_cagr=agg_bh_cagr(all_oos_results),
        category_breakdown={
            'LARGECAP': agg_cagr(cat_oos['LARGECAP']),
            'MIDCAP': agg_cagr(cat_oos['MIDCAP']),
        }
    )

# ─── Main ─────────────────────────────────────────────────────────────────────

WALK_FORWARD_COMBOS = [
    (3, 1),   # 3yr train → 1yr test
    (3, 2),   # 3yr train → 2yr test
    (5, 2),   # 5yr train → 2yr test
    (5, 3),   # 5yr train → 3yr test
    (7, 3),   # 7yr train → 3yr test
    (10, 3),  # 10yr train → 3yr test
]

def main():
    parser = argparse.ArgumentParser(description='Point-in-Time Equity Backtester')
    parser.add_argument('--download-only', action='store_true', help='Only download candles')
    parser.add_argument('--skip-download', action='store_true', help='Use cached candles')
    args = parser.parse_args()

    # Load stock list
    if not STOCKS_FILE.exists():
        # Copy from /tmp if available
        tmp_file = Path('/tmp/stocks_2012.json')
        if tmp_file.exists():
            import shutil
            shutil.copy(tmp_file, STOCKS_FILE)
        else:
            print(f"ERROR: {STOCKS_FILE} not found. Run the constituent builder first.")
            sys.exit(1)

    with open(STOCKS_FILE) as f:
        stocks = json.load(f)

    print(f"=== Point-in-Time Equity Backtester (2012-2026) ===")
    print(f"Stocks: {len(stocks)} ({sum(1 for v in stocks.values() if v['category']=='LARGECAP')} LC + "
          f"{sum(1 for v in stocks.values() if v['category']=='MIDCAP')} MC)")
    print(f"Strategies: {', '.join(STRATEGIES.keys())}")
    print(f"Walk-forward combos: {WALK_FORWARD_COMBOS}")
    print()

    # ── Download candles ──
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    if not args.skip_download:
        print("── Downloading candle data from Upstox ──")
        downloaded = 0
        cached = 0
        failed = 0
        for i, (symbol, info) in enumerate(stocks.items()):
            cache_file = DATA_DIR / f"{symbol}.json"
            if cache_file.exists():
                cached += 1
                continue
            result = download_candles(symbol, info['key'], DATA_DIR)
            if result:
                downloaded += 1
                print(f"  [{i+1}/{len(stocks)}] {symbol}: {len(result)} candles ({result[0].date} → {result[-1].date})")
            else:
                failed += 1
                print(f"  [{i+1}/{len(stocks)}] {symbol}: NO DATA")
            time.sleep(0.5)  # rate limit between stocks (15 requests each)
        print(f"\nDownloaded: {downloaded}, Cached: {cached}, Failed: {failed}")

    if args.download_only:
        print("Download complete. Exiting.")
        return

    # ── Load all candle data ──
    print("\n── Loading candle data ──")
    all_data = {}  # symbol → (candles, category)
    for symbol, info in stocks.items():
        cache_file = DATA_DIR / f"{symbol}.json"
        if not cache_file.exists():
            continue
        with open(cache_file) as f:
            raw = json.load(f)
        candles = [Candle(**c) for c in raw]
        if len(candles) >= 200:
            all_data[symbol] = (candles, info['category'])
    print(f"Loaded {len(all_data)} stocks with sufficient data (>200 candles)")

    lc = sum(1 for _, (_, cat) in all_data.items() if cat == 'LARGECAP')
    mc = sum(1 for _, (_, cat) in all_data.items() if cat == 'MIDCAP')
    print(f"  LARGECAP: {lc}, MIDCAP: {mc}")

    # ── Full-period backtest (for reference) ──
    print("\n── Full-Period Backtest (2012-2026) ──")
    full_results = {}
    for strat_name, strat_fn in STRATEGIES.items():
        strat_results = []
        for symbol, (candles, category) in all_data.items():
            result = run_backtest(candles, strat_fn, symbol, category, strat_name)
            if result.trades > 0:
                strat_results.append(result)
        full_results[strat_name] = strat_results

    print(f"\n{'Strategy':<15} {'Stocks':>6} {'Trades':>7} {'WR%':>6} {'PF':>6} "
          f"{'CAGR%':>7} {'B&H%':>7} {'Sharpe':>7} {'MaxDD%':>7}")
    print("-" * 80)
    for strat_name in STRATEGIES:
        results = full_results[strat_name]
        if not results:
            print(f"{strat_name:<15} {'N/A':>6}")
            continue
        avg_cagr = sum(r.cagr for r in results) / len(results)
        avg_bh = sum(r.bh_cagr for r in results) / len(results)
        total_trades = sum(r.trades for r in results)
        total_wins = sum(r.wins for r in results)
        wr = total_wins / total_trades * 100 if total_trades > 0 else 0
        gp = sum(sum(t.net_pnl_pct for t in r.trade_list if t.net_pnl_pct > 0) for r in results)
        gl = abs(sum(sum(t.net_pnl_pct for t in r.trade_list if t.net_pnl_pct < 0) for r in results))
        pf = gp / gl if gl > 0 else 99.9
        all_returns = []
        for r in results:
            all_returns.extend(t.net_pnl_pct / 100 for t in r.trade_list)
        if len(all_returns) > 1:
            avg_r = sum(all_returns) / len(all_returns)
            var_r = sum((r - avg_r) ** 2 for r in all_returns) / (len(all_returns) - 1)
            sharpe = avg_r / math.sqrt(var_r) * math.sqrt(252) if var_r > 0 else 0
        else:
            sharpe = 0
        max_dd = max(r.max_drawdown_pct for r in results) if results else 0

        print(f"{strat_name:<15} {len(results):>6} {total_trades:>7} {wr:>6.1f} {pf:>6.2f} "
              f"{avg_cagr:>7.1f} {avg_bh:>7.1f} {sharpe:>7.2f} {max_dd:>7.1f}")

    # Category breakdown
    print(f"\n{'Strategy':<15} {'LC CAGR%':>9} {'MC CAGR%':>9} {'LC B&H%':>9} {'MC B&H%':>9}")
    print("-" * 55)
    for strat_name in STRATEGIES:
        results = full_results[strat_name]
        lc_r = [r for r in results if r.category == 'LARGECAP']
        mc_r = [r for r in results if r.category == 'MIDCAP']
        lc_cagr = sum(r.cagr for r in lc_r) / len(lc_r) if lc_r else 0
        mc_cagr = sum(r.cagr for r in mc_r) / len(mc_r) if mc_r else 0
        lc_bh = sum(r.bh_cagr for r in lc_r) / len(lc_r) if lc_r else 0
        mc_bh = sum(r.bh_cagr for r in mc_r) / len(mc_r) if mc_r else 0
        print(f"{strat_name:<15} {lc_cagr:>9.1f} {mc_cagr:>9.1f} {lc_bh:>9.1f} {mc_bh:>9.1f}")

    # ── Walk-Forward Tests ──
    print(f"\n{'='*80}")
    print(f"── Walk-Forward Analysis ──")
    print(f"{'='*80}")

    wf_results = []
    for train_yr, test_yr in WALK_FORWARD_COMBOS:
        print(f"\n── Train {train_yr}yr → Test {test_yr}yr ──")
        print(f"{'Strategy':<15} {'Folds':>5} {'IS CAGR%':>9} {'OOS CAGR%':>10} {'Degrade%':>9} "
              f"{'OOS WR%':>8} {'OOS PF':>7} {'OOS Sharpe':>10} {'B&H%':>7} {'LC OOS%':>8} {'MC OOS%':>8}")
        print("-" * 110)

        for strat_name, strat_fn in STRATEGIES.items():
            wf = walk_forward_test(all_data, strat_name, strat_fn, train_yr, test_yr)
            if wf:
                wf_results.append(wf)
                lc_oos = wf.category_breakdown.get('LARGECAP', 0)
                mc_oos = wf.category_breakdown.get('MIDCAP', 0)
                print(f"{strat_name:<15} {wf.n_folds:>5} {wf.in_sample_cagr:>9.1f} {wf.out_sample_cagr:>10.1f} "
                      f"{wf.degradation_pct:>9.1f} {wf.oos_win_rate:>8.1f} {wf.oos_profit_factor:>7.2f} "
                      f"{wf.oos_sharpe:>10.2f} {wf.bh_cagr:>7.1f} {lc_oos:>8.1f} {mc_oos:>8.1f}")
            else:
                print(f"{strat_name:<15} {'N/A':>5}")

    # ── Summary: Best walk-forward combo per strategy ──
    print(f"\n{'='*80}")
    print(f"── Best Walk-Forward Combo per Strategy (by OOS CAGR) ──")
    print(f"{'='*80}")
    print(f"{'Strategy':<15} {'Best Combo':>12} {'OOS CAGR%':>10} {'OOS PF':>7} {'Degrade%':>9} {'B&H%':>7} {'Beats B&H?':>11}")
    print("-" * 75)

    for strat_name in STRATEGIES:
        strat_wf = [w for w in wf_results if w.strategy == strat_name]
        if not strat_wf:
            continue
        best = max(strat_wf, key=lambda w: w.out_sample_cagr)
        beats = "YES" if best.out_sample_cagr > best.bh_cagr else "NO"
        combo = f"{best.train_years}→{best.test_years}"
        print(f"{strat_name:<15} {combo:>12} {best.out_sample_cagr:>10.1f} {best.oos_profit_factor:>7.2f} "
              f"{best.degradation_pct:>9.1f} {best.bh_cagr:>7.1f} {beats:>11}")

    # ── Save results to JSON ──
    results_file = RESULTS_DIR / f"wf_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    save_data = {
        'run_date': datetime.now().isoformat(),
        'stocks_count': len(all_data),
        'largecap_count': lc,
        'midcap_count': mc,
        'full_period': {},
        'walk_forward': [],
    }
    for strat_name in STRATEGIES:
        results = full_results[strat_name]
        if results:
            total_trades = sum(r.trades for r in results)
            total_wins = sum(r.wins for r in results)
            save_data['full_period'][strat_name] = {
                'avg_cagr': sum(r.cagr for r in results) / len(results),
                'avg_bh_cagr': sum(r.bh_cagr for r in results) / len(results),
                'total_trades': total_trades,
                'win_rate': total_wins / total_trades * 100 if total_trades > 0 else 0,
                'stocks_tested': len(results),
            }
    for wf in wf_results:
        save_data['walk_forward'].append({
            'strategy': wf.strategy,
            'train_years': wf.train_years,
            'test_years': wf.test_years,
            'n_folds': wf.n_folds,
            'is_cagr': wf.in_sample_cagr,
            'oos_cagr': wf.out_sample_cagr,
            'degradation_pct': wf.degradation_pct,
            'oos_win_rate': wf.oos_win_rate,
            'oos_profit_factor': wf.oos_profit_factor,
            'oos_trades': wf.oos_trades,
            'oos_sharpe': wf.oos_sharpe,
            'bh_cagr': wf.bh_cagr,
            'largecap_oos_cagr': wf.category_breakdown.get('LARGECAP', 0),
            'midcap_oos_cagr': wf.category_breakdown.get('MIDCAP', 0),
        })

    with open(results_file, 'w') as f:
        json.dump(save_data, f, indent=2)
    print(f"\nResults saved to: {results_file}")

if __name__ == '__main__':
    main()
