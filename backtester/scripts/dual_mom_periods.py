#!/usr/bin/env python3
"""
DUAL_MOMENTUM — Original vs Improved (MACD<0 exit)
Period-wise comparison with natural exits (no forced close).
"""

import json, math, sys
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).parent))
from pit_backtest_2012 import (
    Candle, run_backtest, DATA_DIR, sma, ema, rsi, atr, adx,
)
from all_strategies_analysis import (
    load_data_and_universe, strategy_dual_momentum, macd_indicator, crossover, crossunder,
)

# ─── Dual Momentum Variants ──────────────────────────────────────────────────

def dual_mom_original(candles):
    """Original: exit when price < SMA200 or drops below 50% of 52W range."""
    return strategy_dual_momentum(candles)

def dual_mom_macd_exit(candles):
    """Improved: also exit when MACD turns negative."""
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

def dual_mom_macd_stop(candles):
    """Improved v2: MACD<0 exit + 12% stop loss."""
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
            loss = (closes[i] - entry_price) / entry_price * 100 if entry_price > 0 else 0
            if closes[i] < sma200[i] or pct < 50 or macd_line[i] < 0 or loss < -12:
                signals.append(('SELL', i)); in_pos = False
    return signals

VARIANTS = {
    'Original': dual_mom_original,
    'MACD<0 exit': dual_mom_macd_exit,
    'MACD<0 + 12% SL': dual_mom_macd_stop,
}

PERIODS = [
    ('2012-01-01', '2015-01-01', '2012-15'),
    ('2015-01-01', '2018-01-01', '2015-18'),
    ('2018-01-01', '2020-03-01', '2018-20'),
    ('2020-03-01', '2022-01-01', '2020-22'),
    ('2022-01-01', '2024-01-01', '2022-24'),
    ('2024-01-01', '2026-04-01', '2024-26'),
]


def run_variant_on_period(all_data, initial, events, strat_fn, start, end):
    """Run strategy with natural exits (no forced close)."""
    # Build universe as of start
    universe = dict(initial)
    for date, symbol, action, category in events:
        if date > start: break
        if action == 'ADD': universe[symbol] = category
        elif action == 'REMOVE': universe.pop(symbol, None)

    # Apply events during period
    period_events = [(d, s, a, c) for d, s, a, c in events if start < d <= end]
    recon_dates = sorted(set(d for d, _, _, _ in period_events))
    windows = []
    prev = start
    for rd in recon_dates:
        windows.append((prev, rd)); prev = rd
    windows.append((prev, end))

    current_universe = dict(universe)
    stock_trades = defaultdict(list)

    for win_start, win_end in windows:
        for date, symbol, action, category in period_events:
            if date < win_start: continue
            if date > win_start: break
            if action == 'ADD': current_universe[symbol] = category
            elif action == 'REMOVE': current_universe.pop(symbol, None)

        for symbol in current_universe:
            if symbol not in all_data: continue
            candles = all_data[symbol]
            start_idx = 0
            for ii, c in enumerate(candles):
                if c.date >= win_start: start_idx = ii; break
            lookback = max(0, start_idx - 300)
            # Natural exit: give ALL candles beyond period end
            window_candles = candles[lookback:]
            if len(window_candles) < 300: continue

            result = run_backtest(window_candles, strat_fn, symbol,
                                  current_universe.get(symbol, 'MIDCAP'), 'DM')
            for t in result.trade_list:
                if win_start <= t.entry_date <= win_end:
                    stock_trades[symbol].append(t)

    # Aggregate
    total_trades = 0; total_wins = 0; still_open = 0
    hold_sum = 0; last_exit = ''
    stock_cagrs = []

    for symbol, trades in stock_trades.items():
        if not trades: continue
        trades.sort(key=lambda t: t.entry_date)
        eq = 1.0; ad = set()
        stock_candles = all_data.get(symbol, [])
        last_candle = stock_candles[-1].date if stock_candles else '2026-04-01'

        for t in trades:
            eq *= (1 + t.net_pnl_pct / 100)
            total_trades += 1
            hold_sum += t.holding_days
            if t.net_pnl_pct > 0: total_wins += 1
            if t.exit_date >= last_candle: still_open += 1
            if t.exit_date > last_exit: last_exit = t.exit_date
            ed = datetime.strptime(t.entry_date[:10], '%Y-%m-%d')
            xd = datetime.strptime(t.exit_date[:10], '%Y-%m-%d')
            d = ed
            while d <= xd: ad.add(d); d += timedelta(days=1)
        ay = len(ad) / 365.25
        if ay > 0.1 and eq > 0:
            stock_cagrs.append((eq ** (1/ay) - 1) * 100)

    if not stock_cagrs:
        return None

    avg_cagr = sum(stock_cagrs) / len(stock_cagrs)
    wr = total_wins / total_trades * 100 if total_trades > 0 else 0
    avg_hold = hold_sum / total_trades if total_trades > 0 else 0

    # Spill: trades that exited after period end
    spill = sum(1 for sym, trades in stock_trades.items()
                for t in trades if t.exit_date > end)

    return {
        'trades': total_trades, 'wr': wr, 'active_cagr': avg_cagr,
        'avg_hold': avg_hold, 'still_open': still_open, 'last_exit': last_exit,
        'spill': spill,
    }


def main():
    print("Loading data...")
    all_data, initial, events = load_data_and_universe()
    print(f"  {len(all_data)} stocks\n")

    for vname, vfn in VARIANTS.items():
        print(f"{'='*100}")
        print(f"  DUAL_MOMENTUM — {vname}")
        print(f"{'='*100}")
        print(f"  {'Period':<12} {'Act%':>7} {'Trades':>7} {'WR%':>6} {'AvgHold':>8} {'Spill':>6} {'Open':>5} {'LastExit':>24}")
        print(f"  {'-'*80}")

        for p_start, p_end, p_label in PERIODS:
            r = run_variant_on_period(all_data, initial, events, vfn, p_start, p_end)
            if r:
                last = r['last_exit'][:10] if r['last_exit'] else '-'
                if r['last_exit'] and r['last_exit'] > p_end:
                    end_dt = datetime.strptime(p_end, '%Y-%m-%d')
                    last_dt = datetime.strptime(r['last_exit'][:10], '%Y-%m-%d')
                    days_over = (last_dt - end_dt).days
                    last = f"{last} (+{days_over}d)"
                open_str = str(r['still_open']) if r['still_open'] > 0 else '-'
                print(f"  {p_label:<12} {r['active_cagr']:>7.1f} {r['trades']:>7} {r['wr']:>6.1f} {r['avg_hold']:>7.0f}d {r['spill']:>6} {open_str:>5} {last:>24}")
            else:
                print(f"  {p_label:<12} {'N/A':>7}")
        print()

if __name__ == '__main__':
    main()
