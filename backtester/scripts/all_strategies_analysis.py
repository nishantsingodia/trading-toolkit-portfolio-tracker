#!/usr/bin/env python3
"""
All 27 Strategies — Dynamic Universe Analysis
==============================================
Runs every strategy individually on the dynamic 2012-2026 universe.
Shows Total CAGR, Active CAGR, WR, PF for each to decide which to keep/drop.
Then runs combined portfolios.
"""

import json, math, sys
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).parent))
from pit_backtest_2012 import (
    Candle, run_backtest, calc_round_trip_cost, Trade, DATA_DIR,
    sma, ema, rsi, atr, adx, bollinger_bands, supertrend, obv, stochastic, donchian,
)

SCRIPT_DIR = Path(__file__).parent
RECON_FILE = SCRIPT_DIR / "recon_events.json"
STOCKS_2012_FILE = SCRIPT_DIR / "stocks_2012.json"

# ─── Helper indicators ────────────────────────────────────────────────────────

def crossover(a, b, i):
    if i < 1: return False
    return (not math.isnan(a[i]) and not math.isnan(b[i]) and
            not math.isnan(a[i-1]) and not math.isnan(b[i-1]) and
            a[i-1] <= b[i-1] and a[i] > b[i])

def crossunder(a, b, i):
    if i < 1: return False
    return (not math.isnan(a[i]) and not math.isnan(b[i]) and
            not math.isnan(a[i-1]) and not math.isnan(b[i-1]) and
            a[i-1] >= b[i-1] and a[i] < b[i])

def macd_indicator(closes, fast=12, slow=26, signal_p=9):
    ema_fast = ema(closes, fast)
    ema_slow = ema(closes, slow)
    macd_line = [float('nan')] * len(closes)
    for i in range(len(closes)):
        if not math.isnan(ema_fast[i]) and not math.isnan(ema_slow[i]):
            macd_line[i] = ema_fast[i] - ema_slow[i]
    valid = [v for v in macd_line if not math.isnan(v)]
    signal_line = ema(macd_line, signal_p)
    histogram = [float('nan')] * len(closes)
    for i in range(len(closes)):
        if not math.isnan(macd_line[i]) and not math.isnan(signal_line[i]):
            histogram[i] = macd_line[i] - signal_line[i]
    return macd_line, signal_line, histogram

# ─── All 27 Strategies (adapted to Candle objects) ───────────────────────────

# --- Dashboard 6 ---

def strategy_bb_squeeze(candles):
    closes = [c.close for c in candles]
    upper, lower, middle, width = bollinger_bands(closes, 20, 2.0)
    signals = []
    valid_w = [w for w in width if not math.isnan(w)]
    if not valid_w: return signals
    avg_width = sum(valid_w) / len(valid_w)
    squeeze_level = avg_width * 0.5
    in_squeeze = False
    for i in range(1, len(candles)):
        if math.isnan(width[i]) or math.isnan(upper[i]) or math.isnan(lower[i]): continue
        if width[i] < squeeze_level:
            in_squeeze = True
        elif in_squeeze:
            in_squeeze = False
            if candles[i].close > upper[i]: signals.append(('BUY', i))
            elif candles[i].close < lower[i]: signals.append(('SELL', i))
    return signals

def strategy_adx_ema(candles):
    closes = [c.close for c in candles]
    ema50 = ema(closes, 50)
    adx_vals, _, _ = adx(candles, 14)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if math.isnan(ema50[i]) or math.isnan(adx_vals[i]) or math.isnan(ema50[i-1]): continue
        if not in_pos and adx_vals[i] > 25 and closes[i] > ema50[i] and closes[i-1] <= ema50[i-1]:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and (closes[i] < ema50[i] or adx_vals[i] < 15):
            signals.append(('SELL', i)); in_pos = False
    return signals

def strategy_supertrend(candles):
    _, direction = supertrend(candles, 10, 3.0)
    signals = []
    for i in range(1, len(candles)):
        if direction[i] == 1 and direction[i-1] == -1: signals.append(('BUY', i))
        elif direction[i] == -1 and direction[i-1] == 1: signals.append(('SELL', i))
    return signals

def strategy_turtle(candles):
    upper, lower = donchian(candles, 20, 15)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if not in_pos and not math.isnan(upper[i]) and candles[i].close > upper[i]:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and not math.isnan(lower[i]) and candles[i].close < lower[i]:
            signals.append(('SELL', i)); in_pos = False
    return signals

def strategy_obv_ema(candles):
    closes = [c.close for c in candles]
    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)
    obv_vals = obv(candles)
    obv_ema21 = ema(obv_vals, 21)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if any(math.isnan(v) for v in [ema20[i], ema50[i], obv_ema21[i]]): continue
        ema_bull = ema20[i] > ema50[i]
        obv_bull = obv_vals[i] > obv_ema21[i]
        if not in_pos and ema_bull and obv_bull:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and (not ema_bull or not obv_bull):
            signals.append(('SELL', i)); in_pos = False
    return signals

def strategy_stochastic(candles):
    k_vals, d_vals = stochastic(candles, 10, 3)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if any(math.isnan(v) for v in [k_vals[i], d_vals[i], k_vals[i-1], d_vals[i-1]]): continue
        if not in_pos and k_vals[i-1] <= 20 and k_vals[i-1] <= d_vals[i-1] and k_vals[i] > d_vals[i]:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and k_vals[i-1] >= 80 and k_vals[i-1] >= d_vals[i-1] and k_vals[i] < d_vals[i]:
            signals.append(('SELL', i)); in_pos = False
    return signals

# --- Extended technical (S11-S18) ---

def strategy_ema_20_50(candles):
    closes = [c.close for c in candles]
    fast = ema(closes, 20); slow = ema(closes, 50)
    signals = []
    for i in range(1, len(candles)):
        if crossover(fast, slow, i): signals.append(('BUY', i))
        elif crossunder(fast, slow, i): signals.append(('SELL', i))
    return signals

def strategy_ema_12_26(candles):
    closes = [c.close for c in candles]
    fast = ema(closes, 12); slow = ema(closes, 26)
    signals = []
    for i in range(1, len(candles)):
        if crossover(fast, slow, i): signals.append(('BUY', i))
        elif crossunder(fast, slow, i): signals.append(('SELL', i))
    return signals

def strategy_sma_50_200(candles):
    closes = [c.close for c in candles]
    fast = sma(closes, 50); slow = sma(closes, 200)
    signals = []
    for i in range(1, len(candles)):
        if crossover(fast, slow, i): signals.append(('BUY', i))
        elif crossunder(fast, slow, i): signals.append(('SELL', i))
    return signals

def strategy_ema_50_200(candles):
    closes = [c.close for c in candles]
    fast = ema(closes, 50); slow = ema(closes, 200)
    signals = []
    for i in range(1, len(candles)):
        if crossover(fast, slow, i): signals.append(('BUY', i))
        elif crossunder(fast, slow, i): signals.append(('SELL', i))
    return signals

def strategy_triple_ema(candles):
    closes = [c.close for c in candles]
    ema12 = ema(closes, 12); ema50 = ema(closes, 50); ema200 = ema(closes, 200)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if any(math.isnan(v) for v in [ema12[i], ema50[i], ema200[i]]): continue
        if not in_pos and crossover(ema12, ema50, i) and ema50[i] > ema200[i]:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and crossunder(ema12, ema50, i):
            signals.append(('SELL', i)); in_pos = False
    return signals

def strategy_adx_di_cross(candles):
    adx_vals, plus_di, minus_di = adx(candles, 14)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if any(math.isnan(v) for v in [adx_vals[i], plus_di[i], minus_di[i]]): continue
        if not in_pos and crossover(plus_di, minus_di, i) and adx_vals[i] > 20:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and (crossover(minus_di, plus_di, i) or adx_vals[i] < 15):
            signals.append(('SELL', i)); in_pos = False
    return signals

def strategy_bb_rsi_reversion(candles):
    closes = [c.close for c in candles]
    upper, lower, middle, _ = bollinger_bands(closes, 20, 2.0)
    rsi_vals = rsi(closes, 14)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if math.isnan(lower[i]) or math.isnan(rsi_vals[i]): continue
        if not in_pos and closes[i] <= lower[i] and rsi_vals[i] < 30:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and (closes[i] >= middle[i] or rsi_vals[i] > 70):
            signals.append(('SELL', i)); in_pos = False
    return signals

def strategy_macd_histogram(candles):
    closes = [c.close for c in candles]
    _, _, histogram = macd_indicator(closes, 12, 26, 9)
    signals = []
    in_pos = False
    for i in range(2, len(candles)):
        if any(math.isnan(histogram[j]) for j in [i, i-1]): continue
        if not in_pos and histogram[i] > 0 and histogram[i] > histogram[i-1] and histogram[i-1] <= 0:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and histogram[i] < 0 and histogram[i] < histogram[i-1] and histogram[i-1] >= 0:
            signals.append(('SELL', i)); in_pos = False
    return signals

def strategy_stoch_rsi_double(candles):
    closes = [c.close for c in candles]
    rsi_vals = rsi(closes, 14)
    k_vals, d_vals = stochastic(candles, 14, 3)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if any(math.isnan(v) for v in [k_vals[i], d_vals[i], rsi_vals[i]]): continue
        if not in_pos and k_vals[i] < 20 and rsi_vals[i] < 35 and crossover(k_vals, d_vals, i):
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and k_vals[i] > 80 and rsi_vals[i] > 65 and crossunder(k_vals, d_vals, i):
            signals.append(('SELL', i)); in_pos = False
    return signals

# --- Additional technical (S19-S22) ---

def strategy_rsi_ob_os(candles):
    closes = [c.close for c in candles]
    rsi_vals = rsi(closes, 14)
    signals = []
    for i in range(1, len(candles)):
        if math.isnan(rsi_vals[i]) or math.isnan(rsi_vals[i-1]): continue
        if rsi_vals[i-1] <= 30 and rsi_vals[i] > 30: signals.append(('BUY', i))
        elif rsi_vals[i-1] >= 70 and rsi_vals[i] < 70: signals.append(('SELL', i))
    return signals

def strategy_macd_signal(candles):
    closes = [c.close for c in candles]
    macd_line, signal_line, _ = macd_indicator(closes, 12, 26, 9)
    signals = []
    for i in range(1, len(candles)):
        if crossover(macd_line, signal_line, i): signals.append(('BUY', i))
        elif crossunder(macd_line, signal_line, i): signals.append(('SELL', i))
    return signals

def strategy_vwap_cross(candles):
    """Rolling VWAP crossover."""
    closes = [c.close for c in candles]
    volumes = [c.volume for c in candles]
    # Rolling 20-period VWAP
    n = len(candles)
    vwap = [float('nan')] * n
    period = 20
    for i in range(period - 1, n):
        pv_sum = sum(closes[j] * volumes[j] for j in range(i-period+1, i+1))
        v_sum = sum(volumes[j] for j in range(i-period+1, i+1))
        vwap[i] = pv_sum / v_sum if v_sum > 0 else closes[i]
    signals = []
    for i in range(1, n):
        if crossover(closes, vwap, i): signals.append(('BUY', i))
        elif crossunder(closes, vwap, i): signals.append(('SELL', i))
    return signals

def strategy_price_x_ema50(candles):
    closes = [c.close for c in candles]
    ema50 = ema(closes, 50)
    signals = []
    for i in range(1, len(candles)):
        if math.isnan(ema50[i]): continue
        if crossover(closes, ema50, i): signals.append(('BUY', i))
        elif crossunder(closes, ema50, i): signals.append(('SELL', i))
    return signals

# --- Famous Investor Strategies (S23-S27) ---

def strategy_dual_momentum(candles):
    """Antonacci — absolute + relative momentum. IMPROVED: MACD<0 exit."""
    closes = [c.close for c in candles]
    highs = [c.high for c in candles]
    sma200 = sma(closes, 200)
    macd_line, _, _ = macd_indicator(closes, 12, 26, 9)
    signals = []
    in_pos = False
    for i in range(252, len(candles)):
        if math.isnan(sma200[i]) or math.isnan(macd_line[i]): continue
        high_52w = max(highs[max(0,i-252):i+1])
        low_52w = min(closes[max(0,i-252):i+1])
        range_52w = high_52w - low_52w
        pct_in_range = ((closes[i] - low_52w) / range_52w * 100) if range_52w > 0 else 50
        if not in_pos and closes[i] > sma200[i] and pct_in_range >= 75 and macd_line[i] > 0:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and (closes[i] < sma200[i] or pct_in_range < 50 or macd_line[i] < 0):
            signals.append(('SELL', i)); in_pos = False
    return signals

def strategy_canslim(candles):
    """O'Neil CAN SLIM — SMA50 breakout + volume near 52W high."""
    closes = [c.close for c in candles]
    highs = [c.high for c in candles]
    volumes = [c.volume for c in candles]
    sma50 = sma(closes, 50)
    rsi_vals = rsi(closes, 14)
    vol_avg = sma(volumes, 20)
    signals = []
    in_pos = False; entry_price = 0
    for i in range(252, len(candles)):
        if math.isnan(sma50[i]) or math.isnan(rsi_vals[i]) or math.isnan(vol_avg[i]) or vol_avg[i] == 0: continue
        high_52w = max(highs[max(0,i-252):i+1])
        pct_from_high = ((high_52w - closes[i]) / high_52w * 100) if high_52w > 0 else 100
        if not in_pos:
            if closes[i] > sma50[i] and volumes[i] > 1.5 * vol_avg[i] and pct_from_high <= 10 and 50 <= rsi_vals[i] <= 80:
                signals.append(('BUY', i)); in_pos = True; entry_price = closes[i]
        else:
            loss_pct = ((closes[i] - entry_price) / entry_price) * 100
            if closes[i] < sma50[i] or loss_pct <= -8:
                signals.append(('SELL', i)); in_pos = False
    return signals

def strategy_jhunjhunwala(candles):
    """Jhunjhunwala Contrarian — RSI oversold reversal + EMA21 confirmation + volume."""
    closes = [c.close for c in candles]
    volumes = [c.volume for c in candles]
    rsi_vals = rsi(closes, 14)
    ema21 = ema(closes, 21)
    vol_avg = sma(volumes, 20)
    signals = []
    in_pos = False; entry_price = 0; oversold_days = 0
    for i in range(1, len(candles)):
        if math.isnan(rsi_vals[i]) or math.isnan(ema21[i]) or math.isnan(vol_avg[i]) or vol_avg[i] == 0:
            oversold_days = 0; continue
        if rsi_vals[i] < 30:
            oversold_days += 1
        else:
            if not in_pos and oversold_days >= 2 and rsi_vals[i] > 30 and closes[i] > ema21[i] and volumes[i] > vol_avg[i]:
                signals.append(('BUY', i)); in_pos = True; entry_price = closes[i]
            oversold_days = 0
        if in_pos:
            loss_pct = ((closes[i] - entry_price) / entry_price) * 100
            if (rsi_vals[i] > 70 and closes[i] < ema21[i]) or loss_pct <= -15:
                signals.append(('SELL', i)); in_pos = False
    return signals

def strategy_aladdin(candles):
    """BlackRock Aladdin — ADX + MACD + SMA50 + RSI multi-factor systematic."""
    closes = [c.close for c in candles]
    adx_vals, _, _ = adx(candles, 14)
    _, _, histogram = macd_indicator(closes, 12, 26, 9)
    sma50 = sma(closes, 50)
    rsi_vals = rsi(closes, 14)
    atr_vals = atr(candles, 14)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if any(math.isnan(v) for v in [adx_vals[i], histogram[i], sma50[i], rsi_vals[i], atr_vals[i]]): continue
        if not in_pos and adx_vals[i] > 25 and histogram[i] > 0 and closes[i] > sma50[i] and rsi_vals[i] > 50:
            if i > 0 and not (adx_vals[i-1] > 25 and histogram[i-1] > 0 and closes[i-1] > sma50[i-1] and rsi_vals[i-1] > 50):
                signals.append(('BUY', i)); in_pos = True
        elif in_pos:
            if adx_vals[i] < 20 or histogram[i] < 0 or closes[i] < sma50[i] - 2 * atr_vals[i]:
                signals.append(('SELL', i)); in_pos = False
    return signals

def strategy_minervini(candles):
    """Minervini Stage 2 SEPA — SMA50>SMA200 + within 25% of 52W high + volume breakout."""
    closes = [c.close for c in candles]
    highs = [c.high for c in candles]
    volumes = [c.volume for c in candles]
    sma50 = sma(closes, 50)
    sma200 = sma(closes, 200)
    vol_avg = sma(volumes, 20)
    signals = []
    in_pos = False; entry_price = 0
    for i in range(252, len(candles)):
        if math.isnan(sma50[i]) or math.isnan(sma200[i]) or math.isnan(vol_avg[i]) or vol_avg[i] == 0: continue
        high_52w = max(highs[max(0,i-252):i+1])
        low_52w = min(closes[max(0,i-252):i+1])
        pct_from_high = ((high_52w - closes[i]) / high_52w * 100) if high_52w > 0 else 100
        if not in_pos:
            if sma50[i] > sma200[i] and closes[i] > sma50[i] and pct_from_high <= 25 and closes[i] > low_52w * 1.3 and volumes[i] > 1.5 * vol_avg[i]:
                signals.append(('BUY', i)); in_pos = True; entry_price = closes[i]
        else:
            loss_pct = ((closes[i] - entry_price) / entry_price) * 100
            if closes[i] < sma50[i] or loss_pct <= -8:
                signals.append(('SELL', i)); in_pos = False
    return signals

# ─── Strategy Registry ────────────────────────────────────────────────────────

ALL_STRATEGIES = {
    # Dashboard 6
    'BB_SQUEEZE': strategy_bb_squeeze,
    'ADX_EMA': strategy_adx_ema,
    'SUPERTREND': strategy_supertrend,
    'TURTLE': strategy_turtle,
    'OBV_EMA': strategy_obv_ema,
    'STOCHASTIC': strategy_stochastic,
    # EMA/SMA crossovers
    'EMA_20_50': strategy_ema_20_50,
    'EMA_12_26': strategy_ema_12_26,
    'SMA_50_200': strategy_sma_50_200,
    'EMA_50_200': strategy_ema_50_200,
    'TRIPLE_EMA': strategy_triple_ema,
    'PRICE_x_EMA50': strategy_price_x_ema50,
    # ADX variants
    'ADX_DI_CROSS': strategy_adx_di_cross,
    # Mean reversion
    'BB_RSI_REVERT': strategy_bb_rsi_reversion,
    'RSI_OB_OS': strategy_rsi_ob_os,
    'STOCH_RSI_DBL': strategy_stoch_rsi_double,
    # Momentum
    'MACD_SIGNAL': strategy_macd_signal,
    'MACD_HISTOGRAM': strategy_macd_histogram,
    'VWAP_CROSS': strategy_vwap_cross,
    # Famous investors
    'DUAL_MOMENTUM': strategy_dual_momentum,
    'CANSLIM': strategy_canslim,
    'JHUNJHUNWALA': strategy_jhunjhunwala,
    'ALADDIN': strategy_aladdin,
    'MINERVINI': strategy_minervini,
}

# ─── Dynamic Universe Runner ─────────────────────────────────────────────────

def load_data_and_universe():
    all_data = {}
    for f in DATA_DIR.glob("*.json"):
        sym = f.stem
        with open(f) as fh:
            raw = json.load(fh)
        candles = [Candle(**c) for c in raw]
        if len(candles) >= 200:
            all_data[sym] = candles

    with open(STOCKS_2012_FILE) as f:
        stocks_2012 = json.load(f)
    initial = {sym: info['category'] for sym, info in stocks_2012.items()}

    with open(RECON_FILE) as f:
        raw_events = json.load(f)
    events = [(e['date'], e['symbol'], e['action'], e['category'])
              for e in raw_events if e['date'] >= '2012-01-01']
    events.sort(key=lambda x: x[0])

    return all_data, initial, events


def run_single_strategy_dynamic(all_data, initial, events, strat_name, strat_fn,
                                 start='2012-01-01', end='2026-04-01'):
    """Run one strategy on dynamic universe, return per-stock results."""
    recon_dates = sorted(set(e[0] for e in events if e[0] > start and e[0] <= end))
    windows = []
    prev = start
    for rd in recon_dates:
        windows.append((prev, rd)); prev = rd
    windows.append((prev, end))

    current_universe = dict(initial)
    stock_trades = defaultdict(list)
    stock_category = dict(initial)

    for win_start, win_end in windows:
        for date, symbol, action, category in events:
            if date < win_start: continue
            if date > win_start: break
            if action == 'ADD':
                if symbol not in current_universe:
                    current_universe[symbol] = category
                    stock_category[symbol] = category
            elif action == 'REMOVE':
                current_universe.pop(symbol, None)

        for symbol in current_universe:
            if symbol not in all_data: continue
            candles = all_data[symbol]
            start_idx = 0
            for ii, c in enumerate(candles):
                if c.date >= win_start: start_idx = ii; break
            lookback = max(0, start_idx - 250)
            window_candles = [c for c in candles[lookback:] if c.date <= win_end]
            if len(window_candles) < 200: continue

            result = run_backtest(window_candles, strat_fn, symbol,
                                  current_universe.get(symbol, 'MIDCAP'), strat_name)
            for t in result.trade_list:
                if win_start <= t.entry_date <= win_end:
                    stock_trades[symbol].append(t)

    # Compute metrics per stock
    results = []
    for symbol, trades in stock_trades.items():
        if not trades: continue
        trades.sort(key=lambda t: t.entry_date)
        equity = 1.0; wins = 0; active_dates = set()
        for t in trades:
            equity *= (1 + t.net_pnl_pct / 100)
            if t.net_pnl_pct > 0: wins += 1
            ed = datetime.strptime(t.entry_date[:10], '%Y-%m-%d')
            xd = datetime.strptime(t.exit_date[:10], '%Y-%m-%d')
            d = ed
            while d <= xd: active_dates.add(d); d += timedelta(days=1)

        total_years = (datetime.strptime(end, '%Y-%m-%d') - datetime.strptime(start, '%Y-%m-%d')).days / 365.25
        active_years = len(active_dates) / 365.25
        total_cagr = (equity ** (1/total_years) - 1) * 100 if total_years > 0 and equity > 0 else 0
        active_cagr = (equity ** (1/active_years) - 1) * 100 if active_years > 0.1 and equity > 0 else 0

        candles = all_data.get(symbol, [])
        pc = [c for c in candles if start <= c.date <= end]
        bh = (pc[-1].close / pc[0].close) if len(pc) >= 2 and pc[0].close > 0 else 1
        bh_cagr = (bh ** (1/total_years) - 1) * 100 if total_years > 0 and bh > 0 else 0

        gp = sum(t.net_pnl_pct for t in trades if t.net_pnl_pct > 0)
        gl = abs(sum(t.net_pnl_pct for t in trades if t.net_pnl_pct < 0))

        results.append({
            'symbol': symbol, 'category': stock_category.get(symbol, 'MIDCAP'),
            'trades': len(trades), 'wins': wins,
            'wr': wins/len(trades)*100, 'pf': gp/gl if gl > 0 else 99.9,
            'equity': equity, 'total_cagr': total_cagr, 'active_cagr': active_cagr,
            'bh_cagr': bh_cagr, 'active_years': active_years,
        })
    return results


def main():
    print("Loading data...")
    all_data, initial, events = load_data_and_universe()
    print(f"  {len(all_data)} stocks, {len(initial)} initial universe, {len(events)} recon events\n")

    print("=" * 115)
    print("ALL 24 STRATEGIES — Individual Performance (Dynamic Universe 2012-2026)")
    print("=" * 115)
    print(f"  {'#':<3} {'Strategy':<18} {'Type':<15} {'Stocks':>6} {'Trades':>7} {'WR%':>6} {'PF':>6} "
          f"{'Total%':>8} {'Active%':>9} {'B&H%':>6} {'ActYrs':>7} {'Verdict':>8}")
    print(f"  {'-'*113}")

    TYPES = {
        'BB_SQUEEZE': 'Breakout', 'ADX_EMA': 'Trend', 'SUPERTREND': 'Trend',
        'TURTLE': 'Breakout', 'OBV_EMA': 'Volume+Trend', 'STOCHASTIC': 'Mean-Rev',
        'EMA_20_50': 'Trend', 'EMA_12_26': 'Trend', 'SMA_50_200': 'Trend',
        'EMA_50_200': 'Trend', 'TRIPLE_EMA': 'Multi-TF', 'PRICE_x_EMA50': 'Trend',
        'ADX_DI_CROSS': 'Directional', 'BB_RSI_REVERT': 'Mean-Rev', 'RSI_OB_OS': 'Mean-Rev',
        'STOCH_RSI_DBL': 'Mean-Rev', 'MACD_SIGNAL': 'Momentum', 'MACD_HISTOGRAM': 'Momentum',
        'VWAP_CROSS': 'Volume', 'DUAL_MOMENTUM': 'Momentum', 'CANSLIM': 'Breakout',
        'JHUNJHUNWALA': 'Contrarian', 'ALADDIN': 'Multi-Factor', 'MINERVINI': 'Breakout',
    }

    all_strat_results = {}
    for idx, (strat_name, strat_fn) in enumerate(ALL_STRATEGIES.items()):
        results = run_single_strategy_dynamic(all_data, initial, events, strat_name, strat_fn)
        all_strat_results[strat_name] = results

        if not results:
            print(f"  {idx+1:<3} {strat_name:<18} {TYPES.get(strat_name,'?'):<15} {'N/A':>6}")
            continue

        avg_tc = sum(r['total_cagr'] for r in results) / len(results)
        avg_ac = sum(r['active_cagr'] for r in results) / len(results)
        avg_bh = sum(r['bh_cagr'] for r in results) / len(results)
        tt = sum(r['trades'] for r in results)
        tw = sum(r['wins'] for r in results)
        wr = tw/tt*100 if tt > 0 else 0
        gp = sum(r['pf'] * max(r['trades'] - r['wins'], 1) for r in results if r['pf'] < 99)
        gl_count = sum(max(r['trades'] - r['wins'], 1) for r in results if r['pf'] < 99)
        avg_pf_approx = gp / gl_count if gl_count > 0 else 0
        # Better PF: aggregate
        total_gp = sum(sum(1 for _ in range(r['wins'])) * (r['pf'] if r['pf'] < 99 else 1) for r in results)
        avg_ay = sum(r['active_years'] for r in results) / len(results)

        # Simple PF from all trades
        all_gp = sum(r['equity'] - 1 for r in results if r['equity'] > 1)
        all_gl = abs(sum(r['equity'] - 1 for r in results if r['equity'] < 1))
        pf = all_gp / all_gl if all_gl > 0 else 99.9

        verdict = "KEEP" if avg_tc > 0 and avg_ac > 5 else "DROP" if avg_tc < 0 or avg_ac < 0 else "WEAK"
        print(f"  {idx+1:<3} {strat_name:<18} {TYPES.get(strat_name,'?'):<15} {len(results):>6} {tt:>7} {wr:>6.1f} {pf:>6.2f} "
              f"{avg_tc:>8.1f} {avg_ac:>9.1f} {avg_bh:>6.1f} {avg_ay:>7.1f} {verdict:>8}")

    # ── Recommendations ──
    print(f"\n{'='*80}")
    print("RECOMMENDATION: Strategies sorted by Active CAGR")
    print(f"{'='*80}")
    ranked = []
    for sn, results in all_strat_results.items():
        if not results: continue
        avg_tc = sum(r['total_cagr'] for r in results) / len(results)
        avg_ac = sum(r['active_cagr'] for r in results) / len(results)
        tt = sum(r['trades'] for r in results)
        tw = sum(r['wins'] for r in results)
        ranked.append((sn, avg_tc, avg_ac, tt, tw/tt*100 if tt > 0 else 0))
    ranked.sort(key=lambda x: x[2], reverse=True)

    print(f"  {'Rank':<5} {'Strategy':<18} {'Total%':>8} {'Active%':>9} {'Trades':>8} {'WR%':>6} {'Action':<8}")
    print(f"  {'-'*65}")
    for i, (sn, tc, ac, tt, wr) in enumerate(ranked):
        action = "KEEP" if ac > 5 else "DROP" if ac < 0 else "WEAK"
        marker = " ***" if ac > 10 else ""
        print(f"  {i+1:<5} {sn:<18} {tc:>8.1f} {ac:>9.1f} {tt:>8} {wr:>6.1f} {action:<8}{marker}")

    # Count keeps
    keeps = [sn for sn, tc, ac, tt, wr in ranked if ac > 5]
    drops = [sn for sn, tc, ac, tt, wr in ranked if ac < 0]
    print(f"\n  KEEP ({len(keeps)}): {', '.join(keeps)}")
    print(f"  DROP ({len(drops)}): {', '.join(drops)}")

if __name__ == '__main__':
    main()
