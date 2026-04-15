#!/usr/bin/env python3
"""
Strategy Deep-Dive Analysis
- Q1: Overlap between BB_RSI_REVERT, STOCH_RSI_DBL, RSI_OB_OS, CANSLIM
- Q2: BB_RSI_REVERT exit variants (hold longer?)
- Q3: CANSLIM vs MINERVINI overlap
- Q4: DUAL_MOMENTUM exit variants
- Q8: ADX_EMA optimization (different EMA periods)
- Q9: BB_SQUEEZE overlap with top strategies
"""

import json, math, sys
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).parent))
from pit_backtest_2012 import (
    Candle, run_backtest, DATA_DIR,
    sma, ema, rsi, atr, adx, bollinger_bands, supertrend, obv, stochastic, donchian,
)
from all_strategies_analysis import (
    ALL_STRATEGIES, load_data_and_universe,
    strategy_bb_rsi_reversion, strategy_stoch_rsi_double, strategy_rsi_ob_os,
    strategy_canslim, strategy_minervini, strategy_bb_squeeze,
    strategy_supertrend, strategy_adx_ema, strategy_dual_momentum,
    crossover, crossunder, macd_indicator,
)

# ─── Load data ──────────────────────────────────────────────────────────────

print("Loading data...")
all_data, initial, events = load_data_and_universe()

# Build full universe (replay all events)
universe = dict(initial)
for e in events:
    if e[1] in all_data:
        if e[2] == 'ADD':
            universe[e[1]] = e[3]
        elif e[2] == 'REMOVE':
            universe.pop(e[1], None)

# Use all stocks with data
stocks = {sym: candles for sym, candles in all_data.items() if len(candles) >= 500}
print(f"  {len(stocks)} stocks with 500+ candles\n")


def get_buy_signals(candles, strategy_fn):
    """Get set of (date_index, date_str) for all BUY signals."""
    signals = strategy_fn(candles)
    buys = set()
    for sig_type, idx in signals:
        if sig_type == 'BUY' and idx < len(candles):
            buys.add(candles[idx].date)
    return buys


# ═══════════════════════════════════════════════════════════════════════════════
# Q1: OVERLAP — BB_RSI_REVERT vs STOCH_RSI_DBL vs RSI_OB_OS vs CANSLIM
# ═══════════════════════════════════════════════════════════════════════════════
print("=" * 90)
print("Q1: SIGNAL OVERLAP — Do these strategies buy the SAME stock on the SAME day?")
print("=" * 90)

strats_q1 = {
    'BB_RSI': strategy_bb_rsi_reversion,
    'STOCH_RSI': strategy_stoch_rsi_double,
    'RSI_OB_OS': strategy_rsi_ob_os,
    'CANSLIM': strategy_canslim,
}

# For each stock, get BUY dates for each strategy
pair_overlaps = defaultdict(lambda: {'both': 0, 'only_a': 0, 'only_b': 0})
triple_overlap = 0
all_four = 0
strat_signal_counts = defaultdict(int)

# Also track: when one fires and the other doesn't, what happens?
# i.e., when BB_RSI fires but STOCH_RSI doesn't, does BB_RSI still win?
exclusive_results = defaultdict(lambda: {'trades': 0, 'wins': 0, 'pnl': 0})

for sym, candles in stocks.items():
    buys = {}
    for name, fn in strats_q1.items():
        buys[name] = get_buy_signals(candles, fn)
        strat_signal_counts[name] += len(buys[name])

    # Pairwise overlap
    names = list(strats_q1.keys())
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = names[i], names[j]
            overlap = buys[a] & buys[b]
            only_a = buys[a] - buys[b]
            only_b = buys[b] - buys[a]
            key = f"{a} × {b}"
            pair_overlaps[key]['both'] += len(overlap)
            pair_overlaps[key]['only_a'] += len(only_a)
            pair_overlaps[key]['only_b'] += len(only_b)

    # All 3 mean-rev overlap
    mr3 = buys['BB_RSI'] & buys['STOCH_RSI'] & buys['RSI_OB_OS']
    triple_overlap += len(mr3)

    # All 4
    a4 = mr3 & buys['CANSLIM']
    all_four += len(a4)

print(f"\n  Total BUY signals across all stocks:")
for name, count in strat_signal_counts.items():
    print(f"    {name:<15} {count:>6} signals")

print(f"\n  Pairwise overlap (same stock, same day):")
print(f"  {'Pair':<30} {'Both':>6} {'Only A':>8} {'Only B':>8} {'Overlap%':>9}")
print(f"  {'-'*65}")
for key, v in sorted(pair_overlaps.items()):
    total = v['both'] + v['only_a'] + v['only_b']
    pct = v['both'] / total * 100 if total > 0 else 0
    print(f"  {key:<30} {v['both']:>6} {v['only_a']:>8} {v['only_b']:>8} {pct:>8.1f}%")

print(f"\n  All 3 mean-rev fire same day: {triple_overlap} times")
print(f"  All 4 (incl CANSLIM) fire same day: {all_four} times")

# Now check: when BB_RSI fires ALONE (no STOCH_RSI), is it still profitable?
print(f"\n  Exclusive signal analysis (2024-26 period):")
print(f"  When a strategy fires but the other DOESN'T — is it still a good signal?")

for sym, candles in stocks.items():
    recent = [c for c in candles if c.date >= '2024-01-01']
    if len(recent) < 100:
        continue
    buys_bb = get_buy_signals(recent, strategy_bb_rsi_reversion)
    buys_sr = get_buy_signals(recent, strategy_stoch_rsi_double)
    buys_rsi = get_buy_signals(recent, strategy_rsi_ob_os)

    # BB_RSI exclusive (fires but STOCH_RSI doesn't)
    bb_only = buys_bb - buys_sr
    bb_shared = buys_bb & buys_sr

    for date_str in bb_only:
        idx = next((i for i, c in enumerate(recent) if c.date == date_str), None)
        if idx and idx + 20 < len(recent):
            ret = (recent[idx + 20].close - recent[idx].close) / recent[idx].close * 100
            exclusive_results['BB_only (not STOCH)']['trades'] += 1
            exclusive_results['BB_only (not STOCH)']['pnl'] += ret
            if ret > 0:
                exclusive_results['BB_only (not STOCH)']['wins'] += 1

    for date_str in bb_shared:
        idx = next((i for i, c in enumerate(recent) if c.date == date_str), None)
        if idx and idx + 20 < len(recent):
            ret = (recent[idx + 20].close - recent[idx].close) / recent[idx].close * 100
            exclusive_results['BB+STOCH together']['trades'] += 1
            exclusive_results['BB+STOCH together']['pnl'] += ret
            if ret > 0:
                exclusive_results['BB+STOCH together']['wins'] += 1

    sr_only = buys_sr - buys_bb
    for date_str in sr_only:
        idx = next((i for i, c in enumerate(recent) if c.date == date_str), None)
        if idx and idx + 20 < len(recent):
            ret = (recent[idx + 20].close - recent[idx].close) / recent[idx].close * 100
            exclusive_results['STOCH_only (not BB)']['trades'] += 1
            exclusive_results['STOCH_only (not BB)']['pnl'] += ret
            if ret > 0:
                exclusive_results['STOCH_only (not BB)']['wins'] += 1

    # CANSLIM vs mean-rev
    buys_cs = get_buy_signals(recent, strategy_canslim)
    cs_not_mr = buys_cs - (buys_bb | buys_sr | buys_rsi)
    for date_str in cs_not_mr:
        idx = next((i for i, c in enumerate(recent) if c.date == date_str), None)
        if idx and idx + 20 < len(recent):
            ret = (recent[idx + 20].close - recent[idx].close) / recent[idx].close * 100
            exclusive_results['CANSLIM_only (no mean-rev)']['trades'] += 1
            exclusive_results['CANSLIM_only (no mean-rev)']['pnl'] += ret
            if ret > 0:
                exclusive_results['CANSLIM_only (no mean-rev)']['wins'] += 1

print(f"\n  {'Signal Type':<30} {'Trades':>7} {'WR%':>6} {'Avg Ret 20d':>12}")
print(f"  {'-'*58}")
for key, v in exclusive_results.items():
    wr = v['wins'] / v['trades'] * 100 if v['trades'] > 0 else 0
    avg = v['pnl'] / v['trades'] if v['trades'] > 0 else 0
    print(f"  {key:<30} {v['trades']:>7} {wr:>6.1f} {avg:>11.2f}%")


# ═══════════════════════════════════════════════════════════════════════════════
# Q2: BB_RSI_REVERT — Exit variants
# ═══════════════════════════════════════════════════════════════════════════════
print(f"\n\n{'='*90}")
print("Q2: BB_RSI_REVERT — What if we hold LONGER? Different exit conditions")
print("=" * 90)

def bb_rsi_variant_upper_bb(candles):
    """Exit at UPPER BB instead of middle BB."""
    closes = [c.close for c in candles]
    upper, lower, middle, _ = bollinger_bands(closes, 20, 2.0)
    rsi_vals = rsi(closes, 14)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if math.isnan(lower[i]) or math.isnan(rsi_vals[i]): continue
        if not in_pos and closes[i] <= lower[i] and rsi_vals[i] < 30:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and (closes[i] >= upper[i] or rsi_vals[i] > 80):
            signals.append(('SELL', i)); in_pos = False
    return signals

def bb_rsi_variant_rsi60(candles):
    """Exit at RSI > 60 (earlier than 70)."""
    closes = [c.close for c in candles]
    upper, lower, middle, _ = bollinger_bands(closes, 20, 2.0)
    rsi_vals = rsi(closes, 14)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if math.isnan(lower[i]) or math.isnan(rsi_vals[i]): continue
        if not in_pos and closes[i] <= lower[i] and rsi_vals[i] < 30:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and rsi_vals[i] > 60:
            signals.append(('SELL', i)); in_pos = False
    return signals

def bb_rsi_variant_trailing_stop(candles):
    """Original entry, but add 10% trailing stop from peak."""
    closes = [c.close for c in candles]
    upper, lower, middle, _ = bollinger_bands(closes, 20, 2.0)
    rsi_vals = rsi(closes, 14)
    signals = []
    in_pos = False
    peak = 0
    for i in range(1, len(candles)):
        if math.isnan(lower[i]) or math.isnan(rsi_vals[i]): continue
        if not in_pos and closes[i] <= lower[i] and rsi_vals[i] < 30:
            signals.append(('BUY', i)); in_pos = True; peak = closes[i]
        elif in_pos:
            if closes[i] > peak: peak = closes[i]
            drawdown = (peak - closes[i]) / peak * 100
            if closes[i] >= middle[i] or rsi_vals[i] > 70 or drawdown > 10:
                signals.append(('SELL', i)); in_pos = False
    return signals

def bb_rsi_variant_hold_longer(candles):
    """Exit only when RSI > 70 (remove middle BB exit)."""
    closes = [c.close for c in candles]
    upper, lower, middle, _ = bollinger_bands(closes, 20, 2.0)
    rsi_vals = rsi(closes, 14)
    signals = []
    in_pos = False
    for i in range(1, len(candles)):
        if math.isnan(lower[i]) or math.isnan(rsi_vals[i]): continue
        if not in_pos and closes[i] <= lower[i] and rsi_vals[i] < 30:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and rsi_vals[i] > 70:
            signals.append(('SELL', i)); in_pos = False
    return signals

variants = {
    'Original (mid BB or RSI>70)': strategy_bb_rsi_reversion,
    'Upper BB or RSI>80': bb_rsi_variant_upper_bb,
    'RSI > 60 (quick exit)': bb_rsi_variant_rsi60,
    'RSI > 70 only (hold longer)': bb_rsi_variant_hold_longer,
    'Original + 10% trailing': bb_rsi_variant_trailing_stop,
}

print(f"\n  {'Variant':<30} {'Trades':>7} {'WR%':>6} {'AvgHold':>8} {'Act CAGR%':>10}")
print(f"  {'-'*65}")
for name, fn in variants.items():
    total_t = 0; total_w = 0; total_hold = 0
    cagrs = []
    for sym, candles in stocks.items():
        r = run_backtest(candles, fn, sym, 'X', name)
        if r.trades > 0:
            total_t += r.trades; total_w += r.wins
            total_hold += sum(t.holding_days for t in r.trade_list)
            # Active CAGR
            eq = 1.0
            ad = set()
            for t in r.trade_list:
                eq *= (1 + t.net_pnl_pct / 100)
                ed = datetime.strptime(t.entry_date[:10], '%Y-%m-%d')
                xd = datetime.strptime(t.exit_date[:10], '%Y-%m-%d')
                d = ed
                while d <= xd: ad.add(d); d += timedelta(days=1)
            ay = len(ad) / 365.25
            if ay > 0.1 and eq > 0:
                cagrs.append((eq ** (1/ay) - 1) * 100)
    wr = total_w / total_t * 100 if total_t > 0 else 0
    ah = total_hold / total_t if total_t > 0 else 0
    avg_cagr = sum(cagrs) / len(cagrs) if cagrs else 0
    print(f"  {name:<30} {total_t:>7} {wr:>6.1f} {ah:>7.0f}d {avg_cagr:>10.1f}")


# ═══════════════════════════════════════════════════════════════════════════════
# Q3: CANSLIM vs MINERVINI overlap
# ═══════════════════════════════════════════════════════════════════════════════
print(f"\n\n{'='*90}")
print("Q3: CANSLIM vs MINERVINI — Signal overlap")
print("=" * 90)

cs_total = 0; mn_total = 0; both_total = 0
cs_only_wins = 0; cs_only_total = 0
mn_only_wins = 0; mn_only_total = 0

for sym, candles in stocks.items():
    buys_cs = get_buy_signals(candles, strategy_canslim)
    buys_mn = get_buy_signals(candles, strategy_minervini)
    cs_total += len(buys_cs)
    mn_total += len(buys_mn)
    both = buys_cs & buys_mn
    both_total += len(both)
    cs_only = buys_cs - buys_mn
    mn_only = buys_mn - buys_cs

    # 20-day forward return for exclusive signals
    for date_str in cs_only:
        idx = next((i for i, c in enumerate(candles) if c.date == date_str), None)
        if idx and idx + 20 < len(candles):
            ret = (candles[idx + 20].close - candles[idx].close) / candles[idx].close * 100
            cs_only_total += 1
            if ret > 0: cs_only_wins += 1
    for date_str in mn_only:
        idx = next((i for i, c in enumerate(candles) if c.date == date_str), None)
        if idx and idx + 20 < len(candles):
            ret = (candles[idx + 20].close - candles[idx].close) / candles[idx].close * 100
            mn_only_total += 1
            if ret > 0: mn_only_wins += 1

overlap_pct = both_total / (cs_total + mn_total - both_total) * 100 if (cs_total + mn_total - both_total) > 0 else 0
print(f"\n  CANSLIM signals:   {cs_total}")
print(f"  MINERVINI signals: {mn_total}")
print(f"  Same stock+day:    {both_total} ({overlap_pct:.1f}% overlap)")
print(f"  CANSLIM-only:      {cs_total - both_total} (WR 20d: {cs_only_wins/cs_only_total*100:.1f}%)" if cs_only_total > 0 else "")
print(f"  MINERVINI-only:    {mn_total - both_total} (WR 20d: {mn_only_wins/mn_only_total*100:.1f}%)" if mn_only_total > 0 else "")


# ═══════════════════════════════════════════════════════════════════════════════
# Q4: DUAL_MOMENTUM — Exit variants
# ═══════════════════════════════════════════════════════════════════════════════
print(f"\n\n{'='*90}")
print("Q4: DUAL_MOMENTUM — Improved exit strategies")
print("=" * 90)

def dual_mom_tighter_exit(candles):
    """Exit at 40% of 52W range instead of 50%."""
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
        pct = ((closes[i] - low_52w) / range_52w * 100) if range_52w > 0 else 50
        if not in_pos and closes[i] > sma200[i] and pct >= 75 and macd_line[i] > 0:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and (closes[i] < sma200[i] or pct < 40):
            signals.append(('SELL', i)); in_pos = False
    return signals

def dual_mom_stop_loss(candles):
    """Original + 12% stop loss from entry."""
    closes = [c.close for c in candles]
    highs = [c.high for c in candles]
    sma200 = sma(closes, 200)
    macd_line, _, _ = macd_indicator(closes, 12, 26, 9)
    signals = []
    in_pos = False; entry_price = 0
    for i in range(252, len(candles)):
        if math.isnan(sma200[i]) or math.isnan(macd_line[i]): continue
        high_52w = max(highs[max(0,i-252):i+1])
        low_52w = min(closes[max(0,i-252):i+1])
        range_52w = high_52w - low_52w
        pct = ((closes[i] - low_52w) / range_52w * 100) if range_52w > 0 else 50
        if not in_pos and closes[i] > sma200[i] and pct >= 75 and macd_line[i] > 0:
            signals.append(('BUY', i)); in_pos = True; entry_price = closes[i]
        elif in_pos:
            loss = (closes[i] - entry_price) / entry_price * 100
            if closes[i] < sma200[i] or pct < 50 or loss < -12:
                signals.append(('SELL', i)); in_pos = False
    return signals

def dual_mom_macd_exit(candles):
    """Also exit when MACD turns negative."""
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
        pct = ((closes[i] - low_52w) / range_52w * 100) if range_52w > 0 else 50
        if not in_pos and closes[i] > sma200[i] and pct >= 75 and macd_line[i] > 0:
            signals.append(('BUY', i)); in_pos = True
        elif in_pos and (closes[i] < sma200[i] or pct < 50 or macd_line[i] < 0):
            signals.append(('SELL', i)); in_pos = False
    return signals

dm_variants = {
    'Original (SMA200 or <50% range)': strategy_dual_momentum,
    'Tighter (<40% range)': dual_mom_tighter_exit,
    'Original + 12% stop loss': dual_mom_stop_loss,
    'Original + MACD<0 exit': dual_mom_macd_exit,
}

print(f"\n  {'Variant':<35} {'Trades':>7} {'WR%':>6} {'AvgHold':>8} {'Act CAGR%':>10}")
print(f"  {'-'*70}")
for name, fn in dm_variants.items():
    total_t = 0; total_w = 0; total_hold = 0; cagrs = []
    for sym, candles in stocks.items():
        r = run_backtest(candles, fn, sym, 'X', name)
        if r.trades > 0:
            total_t += r.trades; total_w += r.wins
            total_hold += sum(t.holding_days for t in r.trade_list)
            eq = 1.0; ad = set()
            for t in r.trade_list:
                eq *= (1 + t.net_pnl_pct / 100)
                ed = datetime.strptime(t.entry_date[:10], '%Y-%m-%d')
                xd = datetime.strptime(t.exit_date[:10], '%Y-%m-%d')
                d = ed
                while d <= xd: ad.add(d); d += timedelta(days=1)
            ay = len(ad) / 365.25
            if ay > 0.1 and eq > 0: cagrs.append((eq ** (1/ay) - 1) * 100)
    wr = total_w / total_t * 100 if total_t > 0 else 0
    ah = total_hold / total_t if total_t > 0 else 0
    avg_cagr = sum(cagrs) / len(cagrs) if cagrs else 0
    print(f"  {name:<35} {total_t:>7} {wr:>6.1f} {ah:>7.0f}d {avg_cagr:>10.1f}")


# ═══════════════════════════════════════════════════════════════════════════════
# Q7: SUPERTREND overlap with other strategies
# ═══════════════════════════════════════════════════════════════════════════════
print(f"\n\n{'='*90}")
print("Q7: SUPERTREND — Overlap with top strategies")
print("=" * 90)

st_overlaps = defaultdict(lambda: {'both': 0, 'st_only': 0, 'other_only': 0})
for sym, candles in stocks.items():
    buys_st = get_buy_signals(candles, strategy_supertrend)
    for name, fn in [('BB_RSI', strategy_bb_rsi_reversion), ('STOCH_RSI', strategy_stoch_rsi_double),
                      ('CANSLIM', strategy_canslim), ('DUAL_MOM', strategy_dual_momentum)]:
        buys_other = get_buy_signals(candles, fn)
        both = buys_st & buys_other
        st_overlaps[name]['both'] += len(both)
        st_overlaps[name]['st_only'] += len(buys_st - buys_other)
        st_overlaps[name]['other_only'] += len(buys_other - buys_st)

print(f"\n  {'SUPERTREND vs':<25} {'Both':>6} {'ST only':>8} {'Other only':>11} {'Overlap%':>9}")
print(f"  {'-'*62}")
for name, v in st_overlaps.items():
    total = v['both'] + v['st_only'] + v['other_only']
    pct = v['both'] / total * 100 if total > 0 else 0
    print(f"  {name:<25} {v['both']:>6} {v['st_only']:>8} {v['other_only']:>11} {pct:>8.1f}%")


# ═══════════════════════════════════════════════════════════════════════════════
# Q8: ADX_EMA — Try different EMA periods
# ═══════════════════════════════════════════════════════════════════════════════
print(f"\n\n{'='*90}")
print("Q8: ADX_EMA — Optimization (different EMA periods & ADX thresholds)")
print("=" * 90)

def make_adx_ema(ema_period, adx_entry, adx_exit):
    def strategy(candles):
        closes = [c.close for c in candles]
        ema_vals = ema(closes, ema_period)
        adx_vals, _, _ = adx(candles, 14)
        signals = []
        in_pos = False
        for i in range(1, len(candles)):
            if math.isnan(ema_vals[i]) or math.isnan(adx_vals[i]) or math.isnan(ema_vals[i-1]): continue
            if not in_pos and adx_vals[i] > adx_entry and closes[i] > ema_vals[i] and closes[i-1] <= ema_vals[i-1]:
                signals.append(('BUY', i)); in_pos = True
            elif in_pos and (closes[i] < ema_vals[i] or adx_vals[i] < adx_exit):
                signals.append(('SELL', i)); in_pos = False
        return signals
    return strategy

adx_variants = {
    'EMA50, ADX>25, exit<15 (orig)': make_adx_ema(50, 25, 15),
    'EMA21, ADX>25, exit<15': make_adx_ema(21, 25, 15),
    'EMA50, ADX>20, exit<15': make_adx_ema(50, 20, 15),
    'EMA50, ADX>30, exit<20': make_adx_ema(50, 30, 20),
    'EMA100, ADX>25, exit<15': make_adx_ema(100, 25, 15),
    'EMA21, ADX>20, exit<10': make_adx_ema(21, 20, 10),
}

print(f"\n  {'Variant':<35} {'Trades':>7} {'WR%':>6} {'AvgHold':>8} {'Act CAGR%':>10}")
print(f"  {'-'*70}")
for name, fn in adx_variants.items():
    total_t = 0; total_w = 0; total_hold = 0; cagrs = []
    for sym, candles in stocks.items():
        r = run_backtest(candles, fn, sym, 'X', name)
        if r.trades > 0:
            total_t += r.trades; total_w += r.wins
            total_hold += sum(t.holding_days for t in r.trade_list)
            eq = 1.0; ad = set()
            for t in r.trade_list:
                eq *= (1 + t.net_pnl_pct / 100)
                ed = datetime.strptime(t.entry_date[:10], '%Y-%m-%d')
                xd = datetime.strptime(t.exit_date[:10], '%Y-%m-%d')
                d = ed
                while d <= xd: ad.add(d); d += timedelta(days=1)
            ay = len(ad) / 365.25
            if ay > 0.1 and eq > 0: cagrs.append((eq ** (1/ay) - 1) * 100)
    wr = total_w / total_t * 100 if total_t > 0 else 0
    ah = total_hold / total_t if total_t > 0 else 0
    avg_cagr = sum(cagrs) / len(cagrs) if cagrs else 0
    print(f"  {name:<35} {total_t:>7} {wr:>6.1f} {ah:>7.0f}d {avg_cagr:>10.1f}")


# ═══════════════════════════════════════════════════════════════════════════════
# Q9: BB_SQUEEZE overlap with top strategies
# ═══════════════════════════════════════════════════════════════════════════════
print(f"\n\n{'='*90}")
print("Q9: BB_SQUEEZE — Overlap with top strategies")
print("=" * 90)

bbs_overlaps = defaultdict(lambda: {'both': 0, 'bbs_only': 0, 'other_only': 0})
for sym, candles in stocks.items():
    buys_bbs = get_buy_signals(candles, strategy_bb_squeeze)
    for name, fn in [('BB_RSI', strategy_bb_rsi_reversion), ('STOCH_RSI', strategy_stoch_rsi_double),
                      ('CANSLIM', strategy_canslim), ('SUPERTREND', strategy_supertrend)]:
        buys_other = get_buy_signals(candles, fn)
        both = buys_bbs & buys_other
        bbs_overlaps[name]['both'] += len(both)
        bbs_overlaps[name]['bbs_only'] += len(buys_bbs - buys_other)
        bbs_overlaps[name]['other_only'] += len(buys_other - buys_bbs)

print(f"\n  {'BB_SQUEEZE vs':<25} {'Both':>6} {'BBS only':>9} {'Other only':>11} {'Overlap%':>9}")
print(f"  {'-'*63}")
for name, v in bbs_overlaps.items():
    total = v['both'] + v['bbs_only'] + v['other_only']
    pct = v['both'] / total * 100 if total > 0 else 0
    print(f"  {name:<25} {v['both']:>6} {v['bbs_only']:>9} {v['other_only']:>11} {pct:>8.1f}%")

print(f"\n\nDone.")
