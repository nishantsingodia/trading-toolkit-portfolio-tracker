#!/usr/bin/env python3
"""
Active CAGR Analysis — computes both total and active CAGR for all strategies,
individually and combined (all 6, and all except Stochastic).
"""
import json, math, sys
from pathlib import Path

# Import everything from the main backtester
sys.path.insert(0, str(Path(__file__).parent))
from pit_backtest_2012 import (
    Candle, STRATEGIES, run_backtest, DATA_DIR, STOCKS_FILE
)

def active_cagr_from_trades(trade_list, candles):
    """
    Active CAGR: compound returns over ONLY the days the strategy was invested.
    Total CAGR: compound returns over the ENTIRE period (including idle time).
    """
    if not trade_list:
        return 0, 0, 0, 0

    equity = 1.0
    total_hold_days = 0
    for t in trade_list:
        r = t.net_pnl_pct / 100
        equity *= (1 + r)
        total_hold_days += t.holding_days

    # Total period
    from datetime import datetime
    first = datetime.strptime(candles[0].date[:10], '%Y-%m-%d')
    last = datetime.strptime(candles[-1].date[:10], '%Y-%m-%d')
    total_years = (last - first).days / 365.25
    active_years = total_hold_days / 365.25

    total_cagr = 0
    if total_years > 0 and equity > 0:
        total_cagr = (equity ** (1 / total_years) - 1) * 100

    active_cagr = 0
    if active_years > 0.1 and equity > 0:  # minimum ~1 month active
        active_cagr = (equity ** (1 / active_years) - 1) * 100

    return total_cagr, active_cagr, total_hold_days, active_years


def combined_portfolio_trades(all_data, strategy_names):
    """
    Run multiple strategies on all stocks. For each stock, merge all trades
    from all strategies chronologically. Compound returns sequentially.
    Returns per-stock results with combined metrics.
    """
    results = []
    for symbol, (candles, category) in all_data.items():
        all_trades = []
        for strat_name in strategy_names:
            strat_fn = STRATEGIES[strat_name]
            result = run_backtest(candles, strat_fn, symbol, category, strat_name)
            all_trades.extend(result.trade_list)

        if not all_trades:
            continue

        # Sort trades by entry date
        all_trades.sort(key=lambda t: t.entry_date)

        # Compound equity + compute actual calendar days in any position
        equity = 1.0
        wins = 0
        gross_profit = 0
        gross_loss = 0
        # Track unique calendar days where at least one strategy is in a trade
        active_dates = set()
        for t in all_trades:
            r = t.net_pnl_pct / 100
            equity *= (1 + r)
            if t.net_pnl_pct > 0:
                wins += 1
                gross_profit += t.net_pnl_pct
            else:
                gross_loss += abs(t.net_pnl_pct)

        # Compute actual calendar days in any position (union of all trade date ranges)
        from datetime import datetime, timedelta
        for t in all_trades:
            entry_dt = datetime.strptime(t.entry_date[:10], '%Y-%m-%d')
            exit_dt = datetime.strptime(t.exit_date[:10], '%Y-%m-%d')
            d = entry_dt
            while d <= exit_dt:
                active_dates.add(d)
                d += timedelta(days=1)

        first = datetime.strptime(candles[0].date[:10], '%Y-%m-%d')
        last = datetime.strptime(candles[-1].date[:10], '%Y-%m-%d')
        total_years = (last - first).days / 365.25
        active_years = len(active_dates) / 365.25  # unique calendar days, no double-counting

        total_cagr = (equity ** (1 / total_years) - 1) * 100 if total_years > 0 and equity > 0 else 0
        active_cagr = (equity ** (1 / active_years) - 1) * 100 if active_years > 0.1 and equity > 0 else 0

        bh_return = candles[-1].close / candles[0].close
        bh_cagr = (bh_return ** (1 / total_years) - 1) * 100 if total_years > 0 and bh_return > 0 else 0

        pf = gross_profit / gross_loss if gross_loss > 0 else 99.9
        wr = wins / len(all_trades) * 100 if all_trades else 0

        results.append({
            'symbol': symbol,
            'category': category,
            'trades': len(all_trades),
            'wins': wins,
            'wr': wr,
            'pf': pf,
            'equity': equity,
            'total_cagr': total_cagr,
            'active_cagr': active_cagr,
            'bh_cagr': bh_cagr,
            'total_years': total_years,
            'active_years': active_years,
            'hold_days': len(active_dates),
        })
    return results


def main():
    # Load stock list and candle data
    with open(STOCKS_FILE) as f:
        stocks = json.load(f)

    all_data = {}
    for symbol, info in stocks.items():
        cache_file = DATA_DIR / f"{symbol}.json"
        if not cache_file.exists():
            continue
        with open(cache_file) as f:
            raw = json.load(f)
        candles = [Candle(**c) for c in raw]
        if len(candles) >= 200:
            all_data[symbol] = (candles, info['category'])

    print(f"Loaded {len(all_data)} stocks (14 years, 2012-2026)\n")

    # ──────────────────────────────────────────────────────────────────────
    # 1. Individual strategy: Total CAGR vs Active CAGR
    # ──────────────────────────────────────────────────────────────────────
    print("=" * 95)
    print("1. INDIVIDUAL STRATEGY — Total CAGR vs Active CAGR")
    print("=" * 95)
    print(f"{'Strategy':<15} {'Stocks':>6} {'Trades':>7} {'WR%':>6} {'PF':>6} "
          f"{'Total CAGR%':>12} {'Active CAGR%':>13} {'Avg Hold':>9} {'Active Yrs':>11} {'B&H%':>7}")
    print("-" * 95)

    strat_details = {}
    for strat_name, strat_fn in STRATEGIES.items():
        total_cagrs = []
        active_cagrs = []
        bh_cagrs = []
        total_trades = 0
        total_wins = 0
        total_hold = 0
        total_active_yrs = 0
        gp = 0
        gl = 0
        n_stocks = 0

        for symbol, (candles, category) in all_data.items():
            result = run_backtest(candles, strat_fn, symbol, category, strat_name)
            if result.trades == 0:
                continue

            tc, ac, hd, ay = active_cagr_from_trades(result.trade_list, candles)
            total_cagrs.append(tc)
            active_cagrs.append(ac)
            bh_cagrs.append(result.bh_cagr)
            total_trades += result.trades
            total_wins += result.wins
            total_hold += hd
            total_active_yrs += ay
            n_stocks += 1
            for t in result.trade_list:
                if t.net_pnl_pct > 0:
                    gp += t.net_pnl_pct
                else:
                    gl += abs(t.net_pnl_pct)

        avg_tc = sum(total_cagrs) / len(total_cagrs) if total_cagrs else 0
        avg_ac = sum(active_cagrs) / len(active_cagrs) if active_cagrs else 0
        avg_bh = sum(bh_cagrs) / len(bh_cagrs) if bh_cagrs else 0
        wr = total_wins / total_trades * 100 if total_trades > 0 else 0
        pf = gp / gl if gl > 0 else 99.9
        avg_hold = total_hold / total_trades if total_trades > 0 else 0
        avg_active = total_active_yrs / n_stocks if n_stocks > 0 else 0

        strat_details[strat_name] = {
            'total_cagr': avg_tc, 'active_cagr': avg_ac, 'bh_cagr': avg_bh,
            'trades': total_trades, 'wins': total_wins, 'wr': wr, 'pf': pf,
            'stocks': n_stocks, 'avg_hold': avg_hold, 'avg_active_yrs': avg_active,
        }

        print(f"{strat_name:<15} {n_stocks:>6} {total_trades:>7} {wr:>6.1f} {pf:>6.2f} "
              f"{avg_tc:>12.1f} {avg_ac:>13.1f} {avg_hold:>8.0f}d {avg_active:>10.1f} {avg_bh:>7.1f}")

    # LC vs MC breakdown
    print(f"\n{'Strategy':<15} {'LC Total%':>10} {'LC Active%':>11} {'MC Total%':>10} {'MC Active%':>11}")
    print("-" * 60)
    for strat_name, strat_fn in STRATEGIES.items():
        lc_tc, lc_ac, mc_tc, mc_ac = [], [], [], []
        for symbol, (candles, category) in all_data.items():
            result = run_backtest(candles, strat_fn, symbol, category, strat_name)
            if result.trades == 0:
                continue
            tc, ac, _, _ = active_cagr_from_trades(result.trade_list, candles)
            if category == 'LARGECAP':
                lc_tc.append(tc); lc_ac.append(ac)
            else:
                mc_tc.append(tc); mc_ac.append(ac)
        print(f"{strat_name:<15} "
              f"{sum(lc_tc)/len(lc_tc) if lc_tc else 0:>10.1f} "
              f"{sum(lc_ac)/len(lc_ac) if lc_ac else 0:>11.1f} "
              f"{sum(mc_tc)/len(mc_tc) if mc_tc else 0:>10.1f} "
              f"{sum(mc_ac)/len(mc_ac) if mc_ac else 0:>11.1f}")

    # ──────────────────────────────────────────────────────────────────────
    # 2. All 6 strategies combined
    # ──────────────────────────────────────────────────────────────────────
    print(f"\n{'=' * 95}")
    print("2. ALL 6 STRATEGIES COMBINED (per stock: run all, compound returns)")
    print(f"{'=' * 95}")

    all6 = list(STRATEGIES.keys())
    combo_results = combined_portfolio_trades(all_data, all6)

    if combo_results:
        avg_tc = sum(r['total_cagr'] for r in combo_results) / len(combo_results)
        avg_ac = sum(r['active_cagr'] for r in combo_results) / len(combo_results)
        avg_bh = sum(r['bh_cagr'] for r in combo_results) / len(combo_results)
        total_trades = sum(r['trades'] for r in combo_results)
        total_wins = sum(r['wins'] for r in combo_results)
        wr = total_wins / total_trades * 100 if total_trades > 0 else 0
        avg_eq = sum(r['equity'] for r in combo_results) / len(combo_results)
        avg_active_yrs = sum(r['active_years'] for r in combo_results) / len(combo_results)
        gp = sum(r['pf'] * (r['trades'] - r['wins']) for r in combo_results if r['pf'] < 99)  # rough
        # Proper PF
        all_pf_num = 0
        all_pf_den = 0
        for r in combo_results:
            if r['pf'] < 99:
                loss_per_trade = 1  # normalized
                all_pf_num += r['pf'] * (r['trades'] - r['wins'])
                all_pf_den += (r['trades'] - r['wins'])

        lc = [r for r in combo_results if r['category'] == 'LARGECAP']
        mc = [r for r in combo_results if r['category'] == 'MIDCAP']

        print(f"\n  {'Metric':<25} {'All':>10} {'LARGECAP':>12} {'MIDCAP':>12}")
        print(f"  {'-'*60}")
        print(f"  {'Stocks':<25} {len(combo_results):>10} {len(lc):>12} {len(mc):>12}")
        print(f"  {'Total Trades':<25} {total_trades:>10} {sum(r['trades'] for r in lc):>12} {sum(r['trades'] for r in mc):>12}")
        print(f"  {'Win Rate %':<25} {wr:>10.1f} {sum(r['wins'] for r in lc)/max(sum(r['trades'] for r in lc),1)*100:>12.1f} {sum(r['wins'] for r in mc)/max(sum(r['trades'] for r in mc),1)*100:>12.1f}")
        print(f"  {'Avg Equity Multiple':<25} {avg_eq:>10.2f}x {sum(r['equity'] for r in lc)/max(len(lc),1):>11.2f}x {sum(r['equity'] for r in mc)/max(len(mc),1):>11.2f}x")
        print(f"  {'Total CAGR %':<25} {avg_tc:>10.1f} {sum(r['total_cagr'] for r in lc)/max(len(lc),1):>12.1f} {sum(r['total_cagr'] for r in mc)/max(len(mc),1):>12.1f}")
        print(f"  {'Active CAGR %':<25} {avg_ac:>10.1f} {sum(r['active_cagr'] for r in lc)/max(len(lc),1):>12.1f} {sum(r['active_cagr'] for r in mc)/max(len(mc),1):>12.1f}")
        print(f"  {'Buy & Hold CAGR %':<25} {avg_bh:>10.1f} {sum(r['bh_cagr'] for r in lc)/max(len(lc),1):>12.1f} {sum(r['bh_cagr'] for r in mc)/max(len(mc),1):>12.1f}")
        print(f"  {'Avg Active Years':<25} {avg_active_yrs:>10.1f} {sum(r['active_years'] for r in lc)/max(len(lc),1):>12.1f} {sum(r['active_years'] for r in mc)/max(len(mc),1):>12.1f}")
        print(f"  {'Beats B&H?':<25} {'YES' if avg_tc > avg_bh else 'NO':>10} {'YES' if sum(r['total_cagr'] for r in lc)/max(len(lc),1) > sum(r['bh_cagr'] for r in lc)/max(len(lc),1) else 'NO':>12} {'YES' if sum(r['total_cagr'] for r in mc)/max(len(mc),1) > sum(r['bh_cagr'] for r in mc)/max(len(mc),1) else 'NO':>12}")

        # Top 10 and Bottom 10 stocks
        sorted_by_eq = sorted(combo_results, key=lambda r: r['equity'], reverse=True)
        print(f"\n  Top 10 stocks (6-strategy combined):")
        print(f"  {'Symbol':<15} {'Cat':>8} {'Trades':>7} {'Equity':>8} {'Total%':>8} {'Active%':>9} {'B&H%':>7}")
        for r in sorted_by_eq[:10]:
            print(f"  {r['symbol']:<15} {r['category']:>8} {r['trades']:>7} {r['equity']:>7.2f}x {r['total_cagr']:>8.1f} {r['active_cagr']:>9.1f} {r['bh_cagr']:>7.1f}")

        print(f"\n  Bottom 10 stocks (6-strategy combined):")
        for r in sorted_by_eq[-10:]:
            print(f"  {r['symbol']:<15} {r['category']:>8} {r['trades']:>7} {r['equity']:>7.2f}x {r['total_cagr']:>8.1f} {r['active_cagr']:>9.1f} {r['bh_cagr']:>7.1f}")

    # ──────────────────────────────────────────────────────────────────────
    # 3. All strategies except Stochastic
    # ──────────────────────────────────────────────────────────────────────
    print(f"\n{'=' * 95}")
    print("3. ALL STRATEGIES EXCEPT STOCHASTIC (5 strategies combined)")
    print(f"{'=' * 95}")

    no_stoch = [s for s in STRATEGIES.keys() if s != 'STOCHASTIC']
    combo5 = combined_portfolio_trades(all_data, no_stoch)

    if combo5:
        avg_tc = sum(r['total_cagr'] for r in combo5) / len(combo5)
        avg_ac = sum(r['active_cagr'] for r in combo5) / len(combo5)
        avg_bh = sum(r['bh_cagr'] for r in combo5) / len(combo5)
        total_trades = sum(r['trades'] for r in combo5)
        total_wins = sum(r['wins'] for r in combo5)
        wr = total_wins / total_trades * 100 if total_trades > 0 else 0
        avg_eq = sum(r['equity'] for r in combo5) / len(combo5)
        avg_active_yrs = sum(r['active_years'] for r in combo5) / len(combo5)

        lc = [r for r in combo5 if r['category'] == 'LARGECAP']
        mc = [r for r in combo5 if r['category'] == 'MIDCAP']

        print(f"\n  {'Metric':<25} {'All':>10} {'LARGECAP':>12} {'MIDCAP':>12}")
        print(f"  {'-'*60}")
        print(f"  {'Stocks':<25} {len(combo5):>10} {len(lc):>12} {len(mc):>12}")
        print(f"  {'Total Trades':<25} {total_trades:>10} {sum(r['trades'] for r in lc):>12} {sum(r['trades'] for r in mc):>12}")
        print(f"  {'Win Rate %':<25} {wr:>10.1f} {sum(r['wins'] for r in lc)/max(sum(r['trades'] for r in lc),1)*100:>12.1f} {sum(r['wins'] for r in mc)/max(sum(r['trades'] for r in mc),1)*100:>12.1f}")
        print(f"  {'Avg Equity Multiple':<25} {avg_eq:>10.2f}x {sum(r['equity'] for r in lc)/max(len(lc),1):>11.2f}x {sum(r['equity'] for r in mc)/max(len(mc),1):>11.2f}x")
        print(f"  {'Total CAGR %':<25} {avg_tc:>10.1f} {sum(r['total_cagr'] for r in lc)/max(len(lc),1):>12.1f} {sum(r['total_cagr'] for r in mc)/max(len(mc),1):>12.1f}")
        print(f"  {'Active CAGR %':<25} {avg_ac:>10.1f} {sum(r['active_cagr'] for r in lc)/max(len(lc),1):>12.1f} {sum(r['active_cagr'] for r in mc)/max(len(mc),1):>12.1f}")
        print(f"  {'Buy & Hold CAGR %':<25} {avg_bh:>10.1f} {sum(r['bh_cagr'] for r in lc)/max(len(lc),1):>12.1f} {sum(r['bh_cagr'] for r in mc)/max(len(mc),1):>12.1f}")
        print(f"  {'Avg Active Years':<25} {avg_active_yrs:>10.1f} {sum(r['active_years'] for r in lc)/max(len(lc),1):>12.1f} {sum(r['active_years'] for r in mc)/max(len(mc),1):>12.1f}")
        print(f"  {'Beats B&H?':<25} {'YES' if avg_tc > avg_bh else 'NO':>10} {'YES' if sum(r['total_cagr'] for r in lc)/max(len(lc),1) > sum(r['bh_cagr'] for r in lc)/max(len(lc),1) else 'NO':>12} {'YES' if sum(r['total_cagr'] for r in mc)/max(len(mc),1) > sum(r['bh_cagr'] for r in mc)/max(len(mc),1) else 'NO':>12}")

    # ──────────────────────────────────────────────────────────────────────
    # Comparison table
    # ──────────────────────────────────────────────────────────────────────
    print(f"\n{'=' * 80}")
    print("COMPARISON SUMMARY")
    print(f"{'=' * 80}")
    print(f"{'Config':<30} {'Total CAGR%':>12} {'Active CAGR%':>13} {'B&H%':>7} {'Trades':>8} {'WR%':>6}")
    print("-" * 80)

    for strat_name in STRATEGIES:
        d = strat_details[strat_name]
        print(f"{strat_name:<30} {d['total_cagr']:>12.1f} {d['active_cagr']:>13.1f} {d['bh_cagr']:>7.1f} {d['trades']:>8} {d['wr']:>6.1f}")

    if combo_results:
        avg_tc6 = sum(r['total_cagr'] for r in combo_results) / len(combo_results)
        avg_ac6 = sum(r['active_cagr'] for r in combo_results) / len(combo_results)
        avg_bh6 = sum(r['bh_cagr'] for r in combo_results) / len(combo_results)
        tt6 = sum(r['trades'] for r in combo_results)
        tw6 = sum(r['wins'] for r in combo_results)
        print(f"{'ALL 6 COMBINED':<30} {avg_tc6:>12.1f} {avg_ac6:>13.1f} {avg_bh6:>7.1f} {tt6:>8} {tw6/tt6*100:>6.1f}")

    if combo5:
        avg_tc5 = sum(r['total_cagr'] for r in combo5) / len(combo5)
        avg_ac5 = sum(r['active_cagr'] for r in combo5) / len(combo5)
        avg_bh5 = sum(r['bh_cagr'] for r in combo5) / len(combo5)
        tt5 = sum(r['trades'] for r in combo5)
        tw5 = sum(r['wins'] for r in combo5)
        print(f"{'5 (excl Stochastic)':<30} {avg_tc5:>12.1f} {avg_ac5:>13.1f} {avg_bh5:>7.1f} {tt5:>8} {tw5/tt5*100:>6.1f}")

    print(f"\nActive CAGR = returns compounded over invested time only (idle cash time excluded)")
    print(f"Total CAGR  = returns spread over entire 14-year period (2012-2026)")

if __name__ == '__main__':
    main()
