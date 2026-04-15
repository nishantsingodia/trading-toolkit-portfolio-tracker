"""
V2 Advanced Backtester — Strategy Variations
=============================================
1. Deep OTM Sell: Roll the hurting leg deeper OTM, hold winner till premium < X
2. Short Straddle/Strangle: Test holding till expiry vs early exit

Uses REAL option chain data from SQLite.
"""

import sqlite3, json, sys, math
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

DB_PATH = Path(__file__).parent.parent / "data" / "nifty-options-history.db"
LOT_SIZE = 75
CAPITAL = 500000

# ── Preload all data into memory ─────────────────────────────────────

class DataStore:
    def __init__(self):
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        print("  Loading data into memory...")

        # Spots
        self.spots = {}
        for r in conn.execute("SELECT date, close FROM spot_candles ORDER BY date"):
            self.spots[r["date"]] = r["close"]

        # Option prices: (date, expiry, strike, right) -> close
        self.prices = {}
        for r in conn.execute("""
            SELECT date, expiry, strike, right, close, time FROM option_candles WHERE close > 0
            ORDER BY date, expiry, strike, right,
                     CASE WHEN time='10:45' THEN 0 WHEN time='10:30' THEN 1 ELSE 2 END, time DESC
        """):
            key = (r["date"], r["expiry"], r["strike"], r["right"])
            if key not in self.prices:
                self.prices[key] = r["close"]

        # Chain metrics
        self.metrics = {}
        for r in conn.execute("SELECT date, expiry, atm_iv FROM chain_metrics"):
            self.metrics[(r["date"], r["expiry"])] = {"atm_iv": r["atm_iv"]}

        self.all_expiries = sorted(set(k[1] for k in self.prices))
        self.trading_dates = sorted(self.spots.keys())

        conn.close()
        print(f"  Loaded {len(self.prices):,} prices, {len(self.spots)} spot days")

    def get_price(self, date, expiry, strike, right):
        return self.prices.get((date, expiry, strike, right))

    def get_spot(self, date):
        return self.spots.get(date)

    def get_atm(self, spot):
        return round(spot / 50) * 50

    def get_dte(self, date, expiry):
        return max(0, (datetime.strptime(expiry, "%Y-%m-%d") - datetime.strptime(date, "%Y-%m-%d")).days)

    def get_dates_in_range(self, f, t):
        return [d for d in self.trading_dates if f <= d <= t]

    def get_expiries_in_range(self, f, t):
        return [e for e in self.all_expiries if f <= e <= t]

# ── Cost calculator ──────────────────────────────────────────────────

def trade_cost(num_legs, avg_premium):
    """Cost per round-trip trade."""
    cost_per_leg = 10 + avg_premium * LOT_SIZE * 0.003  # brokerage + STT + exchange + GST approx
    return cost_per_leg * num_legs * 2  # buy + sell sides

# ── Strategy 1: Deep OTM Sell with ROLL ──────────────────────────────

def deep_otm_sell_with_roll(ds, from_date, to_date, params):
    """
    Deep OTM Sell with leg management:
    - If one leg's premium doubles (hurting), square off that leg and roll deeper OTM
    - Hold the profitable leg until premium drops below book_profit_below threshold
    - SL per leg (not combined)
    """
    trades = []
    otm_dist = params.get("otm_distance", 500)
    roll_distance = params.get("roll_distance", 200)  # roll 200pts deeper when hit
    sl_pct = params.get("sl_pct", 100)  # per-leg SL: if premium doubles
    book_below = params.get("book_profit_below", 15)  # book when premium < ₹15
    dte_min = params.get("dte_min", 7)
    dte_max = params.get("dte_max", 14)
    exit_dte = params.get("exit_dte", 2)
    min_premium = params.get("min_premium", 20)

    expiries = ds.get_expiries_in_range(from_date, to_date)
    dates = ds.get_dates_in_range(from_date, to_date)

    open_legs = []  # list of {strike, right, entry_price, entry_date, expiry, status}

    for date in dates:
        spot = ds.get_spot(date)
        if not spot:
            continue

        # Check each open leg
        legs_to_remove = []
        for i, leg in enumerate(open_legs):
            if leg["status"] == "closed":
                continue

            dte = ds.get_dte(date, leg["expiry"])
            price = ds.get_price(date, leg["expiry"], leg["strike"], leg["right"])
            if price is None:
                continue

            exit_reason = None

            # Time exit
            if dte <= exit_dte:
                exit_reason = "time_exit"

            # Per-leg SL: premium rose too much
            elif price > leg["entry_price"] * (1 + sl_pct / 100):
                exit_reason = "sl_roll"

            # Book profit: premium decayed below threshold
            elif price <= book_below:
                exit_reason = "book_below"

            if exit_reason:
                pnl = (leg["entry_price"] - price) * LOT_SIZE
                cost = trade_cost(1, leg["entry_price"])
                trades.append({
                    "entry_date": leg["entry_date"],
                    "exit_date": date,
                    "strike": leg["strike"],
                    "right": leg["right"],
                    "entry_price": leg["entry_price"],
                    "exit_price": price,
                    "pnl": round(pnl - cost, 2),
                    "exit_reason": exit_reason,
                    "expiry": leg["expiry"],
                })
                leg["status"] = "closed"

                # If SL hit, ROLL deeper OTM
                if exit_reason == "sl_roll" and dte > exit_dte + 1:
                    new_strike = leg["strike"] + roll_distance if leg["right"] == "CE" else leg["strike"] - roll_distance
                    new_price = ds.get_price(date, leg["expiry"], new_strike, leg["right"])
                    if new_price and new_price >= 5:
                        open_legs.append({
                            "strike": new_strike, "right": leg["right"],
                            "entry_price": new_price, "entry_date": date,
                            "expiry": leg["expiry"], "status": "open",
                        })

        # Clean closed legs
        open_legs = [l for l in open_legs if l["status"] == "open"]

        # Try to enter new position if no legs open
        if len(open_legs) == 0:
            for expiry in expiries:
                dte = ds.get_dte(date, expiry)
                if dte < dte_min or dte > dte_max:
                    continue

                atm = ds.get_atm(spot)
                ce_strike = atm + otm_dist
                pe_strike = atm - otm_dist

                ce_price = ds.get_price(date, expiry, ce_strike, "CE")
                pe_price = ds.get_price(date, expiry, pe_strike, "PE")
                if not ce_price or not pe_price:
                    continue
                if ce_price < min_premium and pe_price < min_premium:
                    continue

                open_legs.append({"strike": ce_strike, "right": "CE", "entry_price": ce_price, "entry_date": date, "expiry": expiry, "status": "open"})
                open_legs.append({"strike": pe_strike, "right": "PE", "entry_price": pe_price, "entry_date": date, "expiry": expiry, "status": "open"})
                break

    # Force close remaining
    if open_legs and dates:
        last = dates[-1]
        for leg in open_legs:
            if leg["status"] == "closed":
                continue
            price = ds.get_price(last, leg["expiry"], leg["strike"], leg["right"]) or 0
            pnl = (leg["entry_price"] - price) * LOT_SIZE
            trades.append({"entry_date": leg["entry_date"], "exit_date": last, "strike": leg["strike"], "right": leg["right"], "entry_price": leg["entry_price"], "exit_price": price, "pnl": round(pnl - trade_cost(1, leg["entry_price"]), 2), "exit_reason": "period_end", "expiry": leg["expiry"]})

    return trades

# ── Strategy 2: Short Straddle/Strangle hold till expiry ─────────────

def short_sell_strategy(ds, from_date, to_date, params):
    """
    Short Straddle or Strangle with option to hold till expiry.
    """
    trades = []
    strategy_type = params.get("type", "straddle")  # "straddle" or "strangle"
    otm_dist = params.get("otm_distance", 0)  # 0 for straddle, 300-500 for strangle
    dte_min = params.get("dte_min", 2)
    dte_max = params.get("dte_max", 5)
    target_pct = params.get("target_pct", None)  # None = no target, hold till expiry
    sl_pct = params.get("sl_pct", None)  # None = no SL, hold till expiry
    exit_dte = params.get("exit_dte", 0)  # 0 = hold to expiry

    expiries = ds.get_expiries_in_range(from_date, to_date)
    dates = ds.get_dates_in_range(from_date, to_date)

    open_pos = None

    for date in dates:
        spot = ds.get_spot(date)
        if not spot:
            continue

        # Check exit
        if open_pos:
            dte = ds.get_dte(date, open_pos["expiry"])
            ce_price = ds.get_price(date, open_pos["expiry"], open_pos["ce_strike"], "CE")
            pe_price = ds.get_price(date, open_pos["expiry"], open_pos["pe_strike"], "PE")

            if ce_price is not None and pe_price is not None:
                current = ce_price + pe_price
                entry = open_pos["entry_premium"]
                decay_pct = (entry - current) / entry * 100 if entry > 0 else 0
                rise_pct = (current - entry) / entry * 100 if entry > 0 else 0

                exit_reason = None
                if dte <= exit_dte:
                    exit_reason = "time_exit" if exit_dte > 0 else "expiry"
                elif target_pct and decay_pct >= target_pct:
                    exit_reason = "target_hit"
                elif sl_pct and rise_pct >= sl_pct:
                    exit_reason = "stop_loss"

                if exit_reason or dte <= 0:
                    exit_reason = exit_reason or "expiry"
                    pnl = (entry - current) * LOT_SIZE
                    legs = 2
                    cost = trade_cost(legs, entry / 2)
                    trades.append({
                        "entry_date": open_pos["entry_date"], "exit_date": date,
                        "expiry": open_pos["expiry"],
                        "entry_premium": entry, "exit_premium": current,
                        "pnl": round(pnl - cost, 2), "exit_reason": exit_reason,
                    })
                    open_pos = None

        # Try entry
        if not open_pos:
            for expiry in expiries:
                dte = ds.get_dte(date, expiry)
                if dte < dte_min or dte > dte_max:
                    continue

                atm = ds.get_atm(spot)
                ce_strike = atm + otm_dist
                pe_strike = atm - otm_dist if otm_dist > 0 else atm

                ce_price = ds.get_price(date, expiry, ce_strike, "CE")
                pe_price = ds.get_price(date, expiry, pe_strike, "PE")
                if not ce_price or not pe_price:
                    continue

                open_pos = {
                    "ce_strike": ce_strike, "pe_strike": pe_strike,
                    "entry_premium": ce_price + pe_price,
                    "entry_date": date, "expiry": expiry,
                }
                break

    # Force close
    if open_pos and dates:
        last = dates[-1]
        ce = ds.get_price(last, open_pos["expiry"], open_pos["ce_strike"], "CE") or 0
        pe = ds.get_price(last, open_pos["expiry"], open_pos["pe_strike"], "PE") or 0
        pnl = (open_pos["entry_premium"] - (ce + pe)) * LOT_SIZE
        trades.append({"entry_date": open_pos["entry_date"], "exit_date": last, "expiry": open_pos["expiry"], "entry_premium": open_pos["entry_premium"], "exit_premium": ce + pe, "pnl": round(pnl - trade_cost(2, open_pos["entry_premium"] / 2), 2), "exit_reason": "period_end"})

    return trades

# ── Metrics ──────────────────────────────────────────────────────────

def calc_metrics(trades):
    if not trades:
        return {"total_trades": 0, "total_pnl": 0, "win_rate": 0, "max_dd_pct": 0, "avg_pnl": 0, "exit_breakdown": {}}

    wins = [t for t in trades if t["pnl"] > 0]
    total_pnl = sum(t["pnl"] for t in trades)

    cum = peak = max_dd = 0
    for t in trades:
        cum += t["pnl"]
        peak = max(peak, cum)
        max_dd = max(max_dd, peak - cum)

    exits = defaultdict(int)
    for t in trades:
        exits[t["exit_reason"]] += 1

    return {
        "total_trades": len(trades),
        "total_pnl": round(total_pnl),
        "return_pct": round(total_pnl / CAPITAL * 100, 2),
        "win_rate": round(len(wins) / len(trades) * 100, 1),
        "max_dd_pct": round(max_dd / CAPITAL * 100, 2),
        "avg_pnl": round(total_pnl / len(trades)),
        "exit_breakdown": dict(exits),
    }

# ── Time Periods ─────────────────────────────────────────────────────

PERIODS = [
    ("2016-2018", "2016-01-01", "2018-12-31"),
    ("2019", "2019-01-01", "2019-12-31"),
    ("2020", "2020-01-01", "2020-12-31"),
    ("2021", "2021-01-01", "2021-12-31"),
    ("2022", "2022-01-01", "2022-12-31"),
    ("2023", "2023-01-01", "2023-12-31"),
    ("2024-2025", "2024-01-01", "2025-12-31"),
]

# ── Main ─────────────────────────────────────────────────────────────

def run_all_periods(ds, strategy_fn, params, label):
    total_trades = []
    period_results = {}
    for pname, f, t in PERIODS:
        trades = strategy_fn(ds, f, t, params)
        m = calc_metrics(trades)
        period_results[pname] = m
        total_trades.extend(trades)

    total_m = calc_metrics(total_trades)
    profitable_periods = sum(1 for m in period_results.values() if m["total_pnl"] > 0)
    return total_m, period_results, profitable_periods

def main():
    ds = DataStore()

    print("\n╔══════════════════════════════════════════════════════════════════════════╗")
    print("║  V2 ADVANCED BACKTEST — Roll Strategy + Hold-to-Expiry Variations     ║")
    print("╚══════════════════════════════════════════════════════════════════════════╝")

    # ══════════════════════════════════════════════════════════════════
    # TEST 1: Deep OTM Sell with ROLL — different book_profit_below
    # ══════════════════════════════════════════════════════════════════
    print(f"\n{'='*90}")
    print("  DEEP OTM SELL — WITH ROLL (square off hurting leg, roll deeper, hold winner till cheap)")
    print(f"{'='*90}")
    print(f"  Logic: If one leg doubles → close it, sell 200pts deeper OTM")
    print(f"         Hold profitable leg until premium drops below threshold")
    print()
    print(f"  {'Book Below':>12} {'Trades':>7} {'NET P&L':>10} {'Return%':>9} {'WR%':>6} {'MaxDD':>7} {'Profit/7':>9} {'Exits':>30}")
    print(f"  {'-'*85}")

    best_roll = None
    for book_below in [10, 15, 20, 25]:
        params = {"otm_distance": 500, "roll_distance": 200, "sl_pct": 100, "book_profit_below": book_below, "dte_min": 7, "dte_max": 14, "exit_dte": 2, "min_premium": 20}
        m, periods, prof = run_all_periods(ds, deep_otm_sell_with_roll, params, f"roll_book{book_below}")
        exits = " ".join(f"{k}:{v}" for k, v in sorted(m["exit_breakdown"].items(), key=lambda x: -x[1])[:3])
        ret = m.get("return_pct", 0)
        tag = "🏆" if not best_roll or ret > best_roll.get("ret", -999) else "  "
        if not best_roll or ret > best_roll.get("ret", -999):
            best_roll = {"m": m, "params": params, "periods": periods, "prof": prof, "ret": ret}
        print(f"  {tag} ₹{book_below:>9} {m['total_trades']:>7} ₹{m['total_pnl']:>+9,} {m['return_pct']:>+8.1f}% {m['win_rate']:>5.1f}% {m['max_dd_pct']:>6.1f}% {prof:>6}/7 {exits:>30}")

    # Compare with original (no roll)
    print(f"\n  vs Original (no roll, 40% target, 50% SL):")
    print(f"       Original: +445.9%, 78.2% WR, 11.7% DD, 7/7 periods")
    if best_roll:
        bm = best_roll['m']
        print(f"       Roll Best: {bm.get('return_pct',0):+.1f}%, {bm.get('win_rate',0):.1f}% WR, {bm.get('max_dd_pct',0):.1f}% DD, {best_roll['prof']}/7")
        print(f"       Params: book_below=₹{best_roll['params']['book_profit_below']}")

    # Show period breakdown for best
    if best_roll:
        print(f"\n  Best Roll — Per-period:")
        for pname, _, _ in PERIODS:
            pr = best_roll["periods"].get(pname, {})
            tag = "✅" if pr.get("total_pnl", 0) > 0 else "❌"
            print(f"    {tag} {pname:12} | {pr.get('total_trades',0):3} trades | ₹{pr.get('total_pnl',0):>+8,} ({pr.get('return_pct',0):>+6.1f}%) | WR {pr.get('win_rate',0):.0f}%")

    # ══════════════════════════════════════════════════════════════════
    # TEST 2: Short Straddle — hold to expiry vs early exit
    # ══════════════════════════════════════════════════════════════════
    print(f"\n{'='*90}")
    print("  SHORT STRADDLE — Hold to Expiry vs Early Exit")
    print(f"{'='*90}")
    print(f"  {'Variant':>35} {'Trades':>7} {'NET P&L':>10} {'Return%':>9} {'WR%':>6} {'MaxDD':>7} {'Prof/7':>7}")
    print(f"  {'-'*85}")

    straddle_variants = [
        ("Target 20%, SL 30%, Exit DTE=2", {"type": "straddle", "dte_min": 2, "dte_max": 5, "target_pct": 20, "sl_pct": 30, "exit_dte": 2}),
        ("Target 20%, SL 30%, Hold to expiry", {"type": "straddle", "dte_min": 2, "dte_max": 5, "target_pct": 20, "sl_pct": 30, "exit_dte": 0}),
        ("No target, SL 30%, Hold to expiry", {"type": "straddle", "dte_min": 2, "dte_max": 5, "target_pct": None, "sl_pct": 30, "exit_dte": 0}),
        ("No target, No SL, Hold to expiry", {"type": "straddle", "dte_min": 2, "dte_max": 5, "target_pct": None, "sl_pct": None, "exit_dte": 0}),
        ("No target, SL 50%, Hold to expiry", {"type": "straddle", "dte_min": 2, "dte_max": 5, "target_pct": None, "sl_pct": 50, "exit_dte": 0}),
        ("Target 30%, No SL, Hold to expiry", {"type": "straddle", "dte_min": 2, "dte_max": 5, "target_pct": 30, "sl_pct": None, "exit_dte": 0}),
    ]

    for label, params in straddle_variants:
        m, periods, prof = run_all_periods(ds, short_sell_strategy, params, label)
        print(f"  {label:>35} {m['total_trades']:>7} ₹{m['total_pnl']:>+9,} {m['return_pct']:>+8.1f}% {m['win_rate']:>5.1f}% {m['max_dd_pct']:>6.1f}% {prof:>4}/7")

    # ══════════════════════════════════════════════════════════════════
    # TEST 3: Short Strangle — hold to expiry vs early exit
    # ══════════════════════════════════════════════════════════════════
    print(f"\n{'='*90}")
    print("  SHORT STRANGLE (500pt OTM) — Hold to Expiry vs Early Exit")
    print(f"{'='*90}")
    print(f"  {'Variant':>35} {'Trades':>7} {'NET P&L':>10} {'Return%':>9} {'WR%':>6} {'MaxDD':>7} {'Prof/7':>7}")
    print(f"  {'-'*85}")

    strangle_variants = [
        ("Target 30%, SL 80%, Exit DTE=1", {"type": "strangle", "otm_distance": 500, "dte_min": 4, "dte_max": 8, "target_pct": 30, "sl_pct": 80, "exit_dte": 1}),
        ("Target 30%, SL 80%, Hold to expiry", {"type": "strangle", "otm_distance": 500, "dte_min": 4, "dte_max": 8, "target_pct": 30, "sl_pct": 80, "exit_dte": 0}),
        ("No target, SL 80%, Hold to expiry", {"type": "strangle", "otm_distance": 500, "dte_min": 4, "dte_max": 8, "target_pct": None, "sl_pct": 80, "exit_dte": 0}),
        ("No target, No SL, Hold to expiry", {"type": "strangle", "otm_distance": 500, "dte_min": 4, "dte_max": 8, "target_pct": None, "sl_pct": None, "exit_dte": 0}),
        ("No target, SL 100%, Hold to expiry", {"type": "strangle", "otm_distance": 500, "dte_min": 4, "dte_max": 8, "target_pct": None, "sl_pct": 100, "exit_dte": 0}),
        ("Target 50%, No SL, Hold to expiry", {"type": "strangle", "otm_distance": 500, "dte_min": 4, "dte_max": 8, "target_pct": 50, "sl_pct": None, "exit_dte": 0}),
    ]

    for label, params in strangle_variants:
        m, periods, prof = run_all_periods(ds, short_sell_strategy, params, label)
        print(f"  {label:>35} {m['total_trades']:>7} ₹{m['total_pnl']:>+9,} {m['return_pct']:>+8.1f}% {m['win_rate']:>5.1f}% {m['max_dd_pct']:>6.1f}% {prof:>4}/7")

    print(f"\n{'='*90}")
    print("  DONE!")
    print(f"{'='*90}")

if __name__ == "__main__":
    main()
