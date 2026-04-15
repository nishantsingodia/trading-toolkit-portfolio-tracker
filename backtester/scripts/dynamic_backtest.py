#!/usr/bin/env python3
"""
Dynamic Universe Backtester — Replays NSE index reconstitutions
================================================================
Unlike the static backtester, this adds/removes stocks from the trading universe
at each semi-annual reconstitution date, matching real index behaviour.

Uses recon_events.json (from IndexInclExcl.xls) to know when stocks enter/exit
NIFTY 100 (LARGECAP) and MIDCAP 150 indices.

Stocks are only traded while they're in the index. When removed, any open
position is force-closed on the removal date.

Usage:
  python3 dynamic_backtest.py
  python3 dynamic_backtest.py --no-stoch   # exclude Stochastic
"""

import json, math, sys, argparse
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).parent))
from pit_backtest_2012 import (
    Candle, STRATEGIES, run_backtest, calc_round_trip_cost,
    Trade, BacktestResult, DATA_DIR,
    strategy_bb_squeeze, strategy_adx_ema, strategy_supertrend,
    strategy_turtle, strategy_obv_ema, strategy_stochastic,
)

SCRIPT_DIR = Path(__file__).parent
RECON_FILE = SCRIPT_DIR / "recon_events.json"
ALL_SYMBOLS_FILE = SCRIPT_DIR / "all_symbols.json"
STOCKS_2012_FILE = SCRIPT_DIR / "stocks_2012.json"


def load_candle_data():
    """Load all available candle data."""
    all_data = {}
    for f in DATA_DIR.glob("*.json"):
        sym = f.stem
        with open(f) as fh:
            raw = json.load(fh)
        candles = [Candle(**c) for c in raw]
        if len(candles) >= 50:
            all_data[sym] = candles
    return all_data


def build_universe_timeline():
    """
    Build a timeline: for each date, which stocks are in LARGECAP / MIDCAP.
    Returns:
      - events: sorted list of (date_str, symbol, action, category)
      - initial_universe: dict of {symbol: category} as of 2012-01-01
    """
    # Load 2012 baseline
    with open(STOCKS_2012_FILE) as f:
        stocks_2012 = json.load(f)
    initial = {sym: info['category'] for sym, info in stocks_2012.items()}

    # Load reconstitution events
    with open(RECON_FILE) as f:
        raw_events = json.load(f)

    # Only events from 2012 onwards, sorted by date
    events = [(e['date'], e['symbol'], e['action'], e['category']) for e in raw_events
              if e['date'] >= '2012-01-01']
    events.sort(key=lambda x: x[0])

    return events, initial


def slice_candles(candles, start_date, end_date):
    """Get candles between start and end dates."""
    return [c for c in candles if start_date <= c.date <= end_date]


def run_dynamic_backtest(all_candle_data, strategy_names, start='2012-01-01', end='2026-04-01'):
    """
    Run backtest with dynamic universe.
    For each reconstitution period, only trade stocks that are in the index.
    """
    events, universe = build_universe_timeline()

    # Build reconstitution windows: periods between recon dates
    recon_dates = sorted(set(e[0] for e in events))
    # Add start and end
    windows = []
    prev_date = start
    for rd in recon_dates:
        if rd <= start:
            continue
        if rd > end:
            break
        windows.append((prev_date, rd))
        prev_date = rd
    windows.append((prev_date, end))

    # Track universe changes
    current_universe = dict(universe)  # {symbol: category}

    # Results per stock: accumulate trades across all windows
    stock_trades = defaultdict(list)  # symbol → list of Trade
    stock_category = dict(universe)
    stock_windows_active = defaultdict(int)  # how many windows each stock was active

    strategy_fns = {name: STRATEGIES[name] for name in strategy_names}

    print(f"  Reconstitution windows: {len(windows)}")
    print(f"  Initial universe: {len(current_universe)} stocks")
    print(f"  Strategies: {', '.join(strategy_names)}")

    for win_idx, (win_start, win_end) in enumerate(windows):
        # Apply events at this window's start date
        for date, symbol, action, category in events:
            if date < win_start:
                continue
            if date > win_start:
                break
            if action == 'ADD':
                if symbol not in current_universe:
                    current_universe[symbol] = category
                    stock_category[symbol] = category
            elif action == 'REMOVE':
                current_universe.pop(symbol, None)

        # Run strategies on current universe for this window
        for symbol, category in current_universe.items():
            if symbol not in all_candle_data:
                continue

            candles = all_candle_data[symbol]
            # Get candles for this window, but include lookback (200 candles before start)
            # Find the index of win_start
            start_idx = 0
            for i, c in enumerate(candles):
                if c.date >= win_start:
                    start_idx = i
                    break

            # Include 250 candles before for indicator warmup
            lookback_start = max(0, start_idx - 250)
            window_candles = [c for c in candles[lookback_start:] if c.date <= win_end]

            if len(window_candles) < 200:
                continue

            stock_windows_active[symbol] += 1

            # Run each strategy
            for strat_name, strat_fn in strategy_fns.items():
                result = run_backtest(window_candles, strat_fn, symbol, category, strat_name)
                # Only keep trades that START within this window (not in lookback)
                for t in result.trade_list:
                    if t.entry_date >= win_start and t.entry_date <= win_end:
                        stock_trades[symbol].append(t)

        if (win_idx + 1) % 5 == 0 or win_idx == len(windows) - 1:
            print(f"    Window {win_idx+1}/{len(windows)}: {win_start} → {win_end}, "
                  f"universe={len(current_universe)}, "
                  f"trades so far={sum(len(v) for v in stock_trades.values())}")

    return stock_trades, stock_category, stock_windows_active, all_candle_data


def compute_metrics(stock_trades, stock_category, stock_windows, all_candle_data,
                    start='2012-01-01', end='2026-04-01'):
    """Compute portfolio-level metrics from accumulated trades."""
    results = []

    for symbol, trades in stock_trades.items():
        if not trades:
            continue

        category = stock_category.get(symbol, 'UNKNOWN')
        candles = all_candle_data.get(symbol, [])
        if not candles:
            continue

        # Sort trades by entry date
        trades.sort(key=lambda t: t.entry_date)

        # Compound equity
        equity = 1.0
        wins = 0
        active_dates = set()

        for t in trades:
            r = t.net_pnl_pct / 100
            equity *= (1 + r)
            if t.net_pnl_pct > 0:
                wins += 1
            # Track active days
            entry_dt = datetime.strptime(t.entry_date[:10], '%Y-%m-%d')
            exit_dt = datetime.strptime(t.exit_date[:10], '%Y-%m-%d')
            d = entry_dt
            while d <= exit_dt:
                active_dates.add(d)
                d += timedelta(days=1)

        # Dates
        first_dt = datetime.strptime(start, '%Y-%m-%d')
        last_dt = datetime.strptime(end, '%Y-%m-%d')
        total_years = (last_dt - first_dt).days / 365.25
        active_years = len(active_dates) / 365.25

        total_cagr = (equity ** (1 / total_years) - 1) * 100 if total_years > 0 and equity > 0 else 0
        active_cagr = (equity ** (1 / active_years) - 1) * 100 if active_years > 0.1 and equity > 0 else 0

        # B&H CAGR - use candle data within period
        period_candles = [c for c in candles if start <= c.date <= end]
        if len(period_candles) >= 2:
            bh_return = period_candles[-1].close / period_candles[0].close
            bh_cagr = (bh_return ** (1 / total_years) - 1) * 100 if bh_return > 0 else 0
        else:
            bh_cagr = 0

        wr = wins / len(trades) * 100 if trades else 0
        gp = sum(t.net_pnl_pct for t in trades if t.net_pnl_pct > 0)
        gl = abs(sum(t.net_pnl_pct for t in trades if t.net_pnl_pct < 0))
        pf = gp / gl if gl > 0 else 99.9

        results.append({
            'symbol': symbol,
            'category': category,
            'trades': len(trades),
            'wins': wins,
            'wr': wr,
            'pf': pf,
            'equity': equity,
            'total_cagr': total_cagr,
            'active_cagr': active_cagr,
            'bh_cagr': bh_cagr,
            'total_years': total_years,
            'active_years': active_years,
            'windows_active': stock_windows.get(symbol, 0),
        })

    return results


def print_results(results, label):
    """Print formatted results table."""
    if not results:
        print(f"  No results for {label}")
        return

    lc = [r for r in results if r['category'] == 'LARGECAP']
    mc = [r for r in results if r['category'] == 'MIDCAP']

    total_trades = sum(r['trades'] for r in results)
    total_wins = sum(r['wins'] for r in results)

    avg_tc = sum(r['total_cagr'] for r in results) / len(results)
    avg_ac = sum(r['active_cagr'] for r in results) / len(results)
    avg_bh = sum(r['bh_cagr'] for r in results) / len(results)
    avg_eq = sum(r['equity'] for r in results) / len(results)
    avg_ay = sum(r['active_years'] for r in results) / len(results)
    wr = total_wins / total_trades * 100 if total_trades > 0 else 0

    def cat_avg(cat_list, field):
        return sum(r[field] for r in cat_list) / len(cat_list) if cat_list else 0

    print(f"\n  {'Metric':<25} {'All':>12} {'LARGECAP':>12} {'MIDCAP':>12}")
    print(f"  {'-'*63}")
    print(f"  {'Stocks Traded':<25} {len(results):>12} {len(lc):>12} {len(mc):>12}")
    print(f"  {'Total Trades':<25} {total_trades:>12} {sum(r['trades'] for r in lc):>12} {sum(r['trades'] for r in mc):>12}")
    print(f"  {'Win Rate %':<25} {wr:>12.1f} {sum(r['wins'] for r in lc)/max(sum(r['trades'] for r in lc),1)*100:>12.1f} {sum(r['wins'] for r in mc)/max(sum(r['trades'] for r in mc),1)*100:>12.1f}")
    print(f"  {'Avg Equity Multiple':<25} {avg_eq:>11.1f}x {cat_avg(lc, 'equity'):>11.1f}x {cat_avg(mc, 'equity'):>11.1f}x")
    print(f"  {'Total CAGR %':<25} {avg_tc:>12.1f} {cat_avg(lc, 'total_cagr'):>12.1f} {cat_avg(mc, 'total_cagr'):>12.1f}")
    print(f"  {'Active CAGR %':<25} {avg_ac:>12.1f} {cat_avg(lc, 'active_cagr'):>12.1f} {cat_avg(mc, 'active_cagr'):>12.1f}")
    print(f"  {'Buy & Hold CAGR %':<25} {avg_bh:>12.1f} {cat_avg(lc, 'bh_cagr'):>12.1f} {cat_avg(mc, 'bh_cagr'):>12.1f}")
    print(f"  {'Avg Active Years':<25} {avg_ay:>12.1f} {cat_avg(lc, 'active_years'):>12.1f} {cat_avg(mc, 'active_years'):>12.1f}")
    print(f"  {'Beats B&H?':<25} {'YES' if avg_tc > avg_bh else 'NO':>12} {'YES' if cat_avg(lc,'total_cagr') > cat_avg(lc,'bh_cagr') else 'NO':>12} {'YES' if cat_avg(mc,'total_cagr') > cat_avg(mc,'bh_cagr') else 'NO':>12}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--no-stoch', action='store_true', help='Exclude Stochastic')
    args = parser.parse_args()

    print("=" * 80)
    print("DYNAMIC UNIVERSE BACKTESTER (2012-2026)")
    print("Stocks added/removed at each semi-annual NSE reconstitution")
    print("=" * 80)

    # Load candle data
    print("\nLoading candle data...")
    all_candle_data = load_candle_data()
    print(f"  {len(all_candle_data)} stocks with candle data")

    # ── Run all 6 strategies ──
    print(f"\n{'='*80}")
    print("ALL 6 STRATEGIES — Dynamic Universe")
    print(f"{'='*80}")
    all6 = list(STRATEGIES.keys())
    trades6, cats6, wins6, _ = run_dynamic_backtest(all_candle_data, all6)
    results6 = compute_metrics(trades6, cats6, wins6, all_candle_data)
    print_results(results6, "All 6 strategies")

    # Top/Bottom 10
    sorted_eq = sorted(results6, key=lambda r: r['equity'], reverse=True)
    print(f"\n  Top 10 stocks:")
    print(f"  {'Symbol':<15} {'Cat':>8} {'Trades':>7} {'Equity':>10} {'Total%':>8} {'Active%':>9} {'B&H%':>7} {'Windows':>8}")
    for r in sorted_eq[:10]:
        print(f"  {r['symbol']:<15} {r['category']:>8} {r['trades']:>7} {r['equity']:>9.1f}x {r['total_cagr']:>8.1f} {r['active_cagr']:>9.1f} {r['bh_cagr']:>7.1f} {r['windows_active']:>8}")

    print(f"\n  Bottom 10 stocks:")
    for r in sorted_eq[-10:]:
        print(f"  {r['symbol']:<15} {r['category']:>8} {r['trades']:>7} {r['equity']:>9.2f}x {r['total_cagr']:>8.1f} {r['active_cagr']:>9.1f} {r['bh_cagr']:>7.1f} {r['windows_active']:>8}")

    # ── Run 5 strategies (no Stochastic) ──
    print(f"\n{'='*80}")
    print("5 STRATEGIES (excl Stochastic) — Dynamic Universe")
    print(f"{'='*80}")
    no_stoch = [s for s in STRATEGIES.keys() if s != 'STOCHASTIC']
    trades5, cats5, wins5, _ = run_dynamic_backtest(all_candle_data, no_stoch)
    results5 = compute_metrics(trades5, cats5, wins5, all_candle_data)
    print_results(results5, "5 strategies (no Stoch)")

    # ── Individual strategies ──
    print(f"\n{'='*80}")
    print("INDIVIDUAL STRATEGIES — Dynamic Universe")
    print(f"{'='*80}")
    print(f"\n  {'Strategy':<15} {'Stocks':>6} {'Trades':>7} {'WR%':>6} {'Total%':>8} {'Active%':>9} {'B&H%':>7}")
    print(f"  {'-'*62}")

    for strat_name in STRATEGIES:
        trades_s, cats_s, wins_s, _ = run_dynamic_backtest(all_candle_data, [strat_name])
        results_s = compute_metrics(trades_s, cats_s, wins_s, all_candle_data)
        if results_s:
            avg_tc = sum(r['total_cagr'] for r in results_s) / len(results_s)
            avg_ac = sum(r['active_cagr'] for r in results_s) / len(results_s)
            avg_bh = sum(r['bh_cagr'] for r in results_s) / len(results_s)
            tt = sum(r['trades'] for r in results_s)
            tw = sum(r['wins'] for r in results_s)
            wr = tw / tt * 100 if tt > 0 else 0
            print(f"  {strat_name:<15} {len(results_s):>6} {tt:>7} {wr:>6.1f} {avg_tc:>8.1f} {avg_ac:>9.1f} {avg_bh:>7.1f}")

    # ── Comparison: Static vs Dynamic ──
    print(f"\n{'='*80}")
    print("COMPARISON: Static 2012 Universe vs Dynamic Reconstitution")
    print(f"{'='*80}")

    # Load static results from earlier run
    static_results_file = sorted(Path(SCRIPT_DIR / "results").glob("wf_results_*.json"))
    if static_results_file:
        with open(static_results_file[-1]) as f:
            static = json.load(f)
        print(f"\n  {'Config':<35} {'Total CAGR%':>12} {'Stocks':>8}")
        print(f"  {'-'*58}")
        for strat, data in static.get('full_period', {}).items():
            print(f"  Static  {strat:<25} {data['avg_cagr']:>12.1f} {data['stocks_tested']:>8}")

    print(f"\n  {'Config':<35} {'Total CAGR%':>12} {'Active CAGR%':>13} {'Stocks':>8}")
    print(f"  {'-'*72}")
    if results6:
        avg_tc6 = sum(r['total_cagr'] for r in results6) / len(results6)
        avg_ac6 = sum(r['active_cagr'] for r in results6) / len(results6)
        print(f"  Dynamic All 6 Combined        {avg_tc6:>12.1f} {avg_ac6:>13.1f} {len(results6):>8}")
    if results5:
        avg_tc5 = sum(r['total_cagr'] for r in results5) / len(results5)
        avg_ac5 = sum(r['active_cagr'] for r in results5) / len(results5)
        print(f"  Dynamic 5 (excl Stoch)         {avg_tc5:>12.1f} {avg_ac5:>13.1f} {len(results5):>8}")


if __name__ == '__main__':
    main()
