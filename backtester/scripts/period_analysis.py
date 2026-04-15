#!/usr/bin/env python3
"""
Period-wise Strategy Analysis
==============================
Train/validate on specific periods to see which strategies work when.

Period combos:
  1. Train 2012-2018 → Validate 2018-2022
  2. Train 2012-2022 → Validate 2022-2024
  3. Train 2012-2023 → Validate 2023-2026

Also shows standalone performance per period:
  - 2012-2018 (bull run)
  - 2018-2020 (COVID crash)
  - 2020-2022 (recovery rally)
  - 2022-2024 (consolidation)
  - 2024-2026 (recent)
"""

import json, math, sys
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).parent))
from pit_backtest_2012 import Candle, run_backtest, DATA_DIR
from all_strategies_analysis import (
    ALL_STRATEGIES, load_data_and_universe, crossover, crossunder,
)

SCRIPT_DIR = Path(__file__).parent


def run_strategy_on_period(all_data, initial, events, strat_name, strat_fn,
                           start, end):
    """
    Run one strategy on dynamic universe for a specific date range.
    NO forced exits — trades that start within [start, end] are allowed to
    exit naturally using candle data beyond 'end'. Only NEW positions are
    blocked after 'end'.
    """
    # Build universe as of start date by replaying events
    universe = dict(initial)
    for date, symbol, action, category in events:
        if date > start:
            break
        if action == 'ADD':
            universe[symbol] = category
        elif action == 'REMOVE':
            universe.pop(symbol, None)

    # Also apply events during the period
    period_events = [(d, s, a, c) for d, s, a, c in events if start < d <= end]
    recon_dates = sorted(set(d for d, _, _, _ in period_events))

    windows = []
    prev = start
    for rd in recon_dates:
        windows.append((prev, rd))
        prev = rd
    windows.append((prev, end))

    current_universe = dict(universe)
    stock_trades = defaultdict(list)
    stock_category = {}
    for s, c in current_universe.items():
        stock_category[s] = c

    for win_start, win_end in windows:
        # Apply recon events at this boundary
        for date, symbol, action, category in period_events:
            if date < win_start:
                continue
            if date > win_start:
                break
            if action == 'ADD':
                current_universe[symbol] = category
                stock_category[symbol] = category
            elif action == 'REMOVE':
                current_universe.pop(symbol, None)

        for symbol in current_universe:
            if symbol not in all_data:
                continue
            candles = all_data[symbol]
            # Find start index
            start_idx = 0
            for ii, c in enumerate(candles):
                if c.date >= win_start:
                    start_idx = ii
                    break
            lookback = max(0, start_idx - 250)
            # KEY CHANGE: give the strategy ALL candles through end of data
            # so trades can exit naturally. We filter entries by date later.
            window_candles = candles[lookback:]
            if len(window_candles) < 100:
                continue

            result = run_backtest(window_candles, strat_fn, symbol,
                                  current_universe.get(symbol, 'MIDCAP'), strat_name)
            for t in result.trade_list:
                # Only keep trades that ENTERED within [win_start, win_end]
                if win_start <= t.entry_date <= win_end:
                    stock_trades[symbol].append(t)

    # Aggregate
    total_trades = 0
    total_wins = 0
    total_gp = 0
    total_gl = 0
    exited_after_period = 0     # trades that exited AFTER the period end date
    still_open = 0              # trades whose exit = last candle (strategy never said SELL)
    equities = []
    active_days_all = set()
    stocks_traded = 0
    hold_days_sum = 0
    last_exit_date = ''         # when the very last trade actually closed

    end_dt = datetime.strptime(end, '%Y-%m-%d')

    for symbol, trades in stock_trades.items():
        if not trades:
            continue
        stocks_traded += 1
        trades.sort(key=lambda t: t.entry_date)
        eq = 1.0
        # Get last candle date for this stock to detect "still open"
        stock_candles = all_data.get(symbol, [])
        last_candle_date = stock_candles[-1].date if stock_candles else '2026-04-01'

        for t in trades:
            eq *= (1 + t.net_pnl_pct / 100)
            total_trades += 1
            hold_days_sum += t.holding_days
            if t.net_pnl_pct > 0:
                total_wins += 1
                total_gp += t.net_pnl_pct
            else:
                total_gl += abs(t.net_pnl_pct)
            # Track exits after period end
            if t.exit_date > end:
                exited_after_period += 1
            # Track if exit = last candle (means strategy never generated SELL = still open)
            if t.exit_date >= last_candle_date:
                still_open += 1
            # Track last exit
            if t.exit_date > last_exit_date:
                last_exit_date = t.exit_date
            # Active days
            ed = datetime.strptime(t.entry_date[:10], '%Y-%m-%d')
            exit_dt = datetime.strptime(t.exit_date[:10], '%Y-%m-%d')
            d = ed
            while d <= exit_dt:
                active_days_all.add(d)
                d += timedelta(days=1)
        equities.append(eq)

    if not equities:
        return None

    avg_eq = sum(equities) / len(equities)
    period_years = (datetime.strptime(end, '%Y-%m-%d') - datetime.strptime(start, '%Y-%m-%d')).days / 365.25
    total_cagr = (avg_eq ** (1 / period_years) - 1) * 100 if period_years > 0 and avg_eq > 0 else 0

    # Active CAGR per stock average
    stock_active_cagrs = []
    for symbol, trades in stock_trades.items():
        if not trades:
            continue
        eq = 1.0
        ad = set()
        for t in trades:
            eq *= (1 + t.net_pnl_pct / 100)
            ed = datetime.strptime(t.entry_date[:10], '%Y-%m-%d')
            xd = datetime.strptime(t.exit_date[:10], '%Y-%m-%d')
            d = ed
            while d <= xd:
                ad.add(d)
                d += timedelta(days=1)
        ay = len(ad) / 365.25
        if ay > 0.1 and eq > 0:
            stock_active_cagrs.append((eq ** (1 / ay) - 1) * 100)
    avg_active_cagr = sum(stock_active_cagrs) / len(stock_active_cagrs) if stock_active_cagrs else 0

    wr = total_wins / total_trades * 100 if total_trades > 0 else 0
    pf = total_gp / total_gl if total_gl > 0 else 99.9
    avg_hold = hold_days_sum / total_trades if total_trades > 0 else 0
    after_pct = exited_after_period / total_trades * 100 if total_trades > 0 else 0

    return {
        'stocks': stocks_traded,
        'trades': total_trades,
        'wr': wr,
        'pf': pf,
        'total_cagr': total_cagr,
        'active_cagr': avg_active_cagr,
        'period_years': period_years,
        'avg_hold_days': avg_hold,
        'exited_after': exited_after_period,
        'after_pct': after_pct,
        'still_open': still_open,
        'last_exit': last_exit_date,
    }


def main():
    print("Loading data...")
    all_data, initial, events = load_data_and_universe()
    print(f"  {len(all_data)} stocks loaded\n")

    # ── Define periods ──
    TRAIN_VAL_COMBOS = [
        ('2012-01-01', '2018-01-01', '2018-01-01', '2022-01-01', 'Train 2012-18 → Val 2018-22'),
        ('2012-01-01', '2022-01-01', '2022-01-01', '2024-01-01', 'Train 2012-22 → Val 2022-24'),
        ('2012-01-01', '2023-01-01', '2023-01-01', '2026-04-01', 'Train 2012-23 → Val 2023-26'),
    ]

    STANDALONE_PERIODS = [
        ('2012-01-01', '2015-01-01', '2012-15 (Recovery)'),
        ('2015-01-01', '2018-01-01', '2015-18 (Bull Run)'),
        ('2018-01-01', '2020-03-01', '2018-20 (Pre-COVID)'),
        ('2020-03-01', '2022-01-01', '2020-22 (COVID Rally)'),
        ('2022-01-01', '2024-01-01', '2022-24 (Consolidation)'),
        ('2024-01-01', '2026-04-01', '2024-26 (Recent)'),
    ]

    strat_names = list(ALL_STRATEGIES.keys())

    # ── 1. Train/Validate combos ──
    for train_start, train_end, val_start, val_end, label in TRAIN_VAL_COMBOS:
        print(f"\n{'='*120}")
        print(f"  {label}")
        print(f"{'='*120}")
        print(f"  {'Strategy':<18} {'Train Act%':>11}   {'Val Act%':>10}   {'Degradation':>12}")
        print(f"  {'-'*55}")

        for sn in strat_names:
            sf = ALL_STRATEGIES[sn]
            train_r = run_strategy_on_period(all_data, initial, events, sn, sf, train_start, train_end)
            val_r = run_strategy_on_period(all_data, initial, events, sn, sf, val_start, val_end)

            if not train_r or not val_r:
                print(f"  {sn:<18} {'N/A':>8}")
                continue

            deg = train_r['active_cagr'] - val_r['active_cagr']
            deg_str = f"{deg:+.1f}%"
            marker = " !!!" if abs(deg) > 15 else " **" if abs(deg) > 10 else ""

            print(f"  {sn:<18} {train_r['active_cagr']:>11.1f}   {val_r['active_cagr']:>10.1f}   {deg_str:>12}{marker}")

    # ── 2. Detailed per-strategy period breakdown ──
    print(f"\n\n{'='*130}")
    print(f"  STRATEGY × PERIOD — Active CAGR%, Trades, Forced Exits, Avg Hold Days")
    print(f"{'='*130}")

    period_labels = [p[2] for p in STANDALONE_PERIODS]
    strat_period_data = {}
    strat_period_full = {}

    for sn in strat_names:
        sf = ALL_STRATEGIES[sn]
        period_results = []
        active_cagrs = []
        for p_start, p_end, p_label in STANDALONE_PERIODS:
            r = run_strategy_on_period(all_data, initial, events, sn, sf, p_start, p_end)
            period_results.append(r)
            active_cagrs.append(r['active_cagr'] if r else 0)
        strat_period_data[sn] = active_cagrs
        strat_period_full[sn] = period_results

    # Print each strategy as a mini-table
    for sn in strat_names:
        results = strat_period_full[sn]
        if all(r is None for r in results):
            continue
        positive = sum(1 for x in strat_period_data[sn] if x > 0)
        print(f"\n  ── {sn} ({positive}/{len(STANDALONE_PERIODS)} positive) ──")
        print(f"  {'Period':<25} {'Act%':>6} {'Trades':>7} {'ExitAfter':>10} {'StillOpen':>10} {'AvgHold':>8} {'WR%':>6} {'LastExit':>12}")
        print(f"  {'-'*92}")
        for i, (p_start, p_end, p_label) in enumerate(STANDALONE_PERIODS):
            r = results[i]
            if r:
                after_str = f"{r['exited_after']}" if r['exited_after'] > 0 else "-"
                open_str = f"{r['still_open']}" if r['still_open'] > 0 else "-"
                last_exit = r['last_exit'][:10] if r['last_exit'] else '-'
                # Show how far past period end the last exit was
                if r['last_exit'] and r['last_exit'] > p_end:
                    end_dt = datetime.strptime(p_end, '%Y-%m-%d')
                    last_dt = datetime.strptime(r['last_exit'][:10], '%Y-%m-%d')
                    days_over = (last_dt - end_dt).days
                    last_exit = f"{last_exit} (+{days_over}d)"
                print(f"  {p_label:<25} {r['active_cagr']:>6.1f} {r['trades']:>7} {after_str:>10} {open_str:>10} {r['avg_hold_days']:>7.0f}d {r['wr']:>6.1f} {last_exit:>12}")
            else:
                print(f"  {p_label:<25} {'N/A':>6}")

    # ── 3. Summary: Best strategy per period ──
    print(f"\n\n{'='*80}")
    print(f"  BEST STRATEGY PER PERIOD")
    print(f"{'='*80}")
    for idx, (p_start, p_end, p_label) in enumerate(STANDALONE_PERIODS):
        best_name = None
        best_ac = -999
        for sn, acs in strat_period_data.items():
            if acs[idx] > best_ac:
                best_ac = acs[idx]
                best_name = sn
        print(f"  {p_label:<25} → {best_name:<18} Active CAGR: {best_ac:.1f}%")

    # ── 4. Most consistent strategies ──
    print(f"\n{'='*80}")
    print(f"  MOST CONSISTENT STRATEGIES (positive Active CAGR in most periods)")
    print(f"{'='*80}")
    consistency_ranked = []
    for sn, acs in strat_period_data.items():
        pos = sum(1 for x in acs if x > 0)
        avg = sum(acs) / len(acs) if acs else 0
        min_ac = min(acs) if acs else 0
        max_ac = max(acs) if acs else 0
        # Total trades and forced exits across all periods
        total_t = sum(r['trades'] for r in strat_period_full[sn] if r)
        total_after = sum(r['exited_after'] for r in strat_period_full[sn] if r)
        total_open = sum(r['still_open'] for r in strat_period_full[sn] if r)
        after_pct = total_after / total_t * 100 if total_t > 0 else 0
        avg_hold = sum(r['avg_hold_days'] * r['trades'] for r in strat_period_full[sn] if r) / total_t if total_t > 0 else 0
        consistency_ranked.append((sn, pos, avg, min_ac, max_ac, total_t, total_after, after_pct, total_open, avg_hold))
    consistency_ranked.sort(key=lambda x: (x[1], x[2]), reverse=True)

    print(f"  {'Strategy':<18} {'Pos':>4} {'Avg%':>6} {'Min%':>6} {'Max%':>6} {'Trades':>7} {'Spill':>6} {'Spill%':>7} {'Open':>5} {'AvgHold':>8} {'Verdict':<10}")
    print(f"  {'-'*90}")
    for sn, pos, avg, mn, mx, tt, ea, eap, so, ah in consistency_ranked:
        total = len(STANDALONE_PERIODS)
        verdict = "ROCK SOLID" if pos == total else "STRONG" if pos >= total-1 else "OKAY" if pos >= total-2 else "PATCHY"
        print(f"  {sn:<18} {pos:>2}/{total:<1} {avg:>6.1f} {mn:>6.1f} {mx:>6.1f} {tt:>7} {ea:>6} {eap:>6.1f}% {so:>5} {ah:>7.0f}d {verdict:<10}")


if __name__ == '__main__':
    main()
