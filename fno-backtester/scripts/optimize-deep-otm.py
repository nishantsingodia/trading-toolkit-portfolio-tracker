"""
Deep OTM Sell — Advanced Optimization
======================================
8 tests to find the ultimate optimal params.
Current champion: +446%, 78% WR, 11.7% DD, 7/7 periods.

Usage: python3 scripts/optimize-deep-otm.py
"""

import sqlite3, json, sys, math
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

DB_PATH = Path(__file__).parent.parent / "data" / "nifty-options-history.db"
LOT_SIZE = 75
CAPITAL = 500000
COST_PER_LEG_RT = 30  # approx cost per leg round-trip (₹10 brokerage + STT + GST)

# ── DataStore (in-memory) ────────────────────────────────────────────

class DataStore:
    def __init__(self):
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        print("  Loading data...")

        self.spots = {}
        for r in conn.execute("SELECT date, close FROM spot_candles ORDER BY date"):
            self.spots[r["date"]] = r["close"]

        self.prices = {}
        for r in conn.execute("""
            SELECT date, expiry, strike, right, close FROM option_candles WHERE close > 0
            ORDER BY date, expiry, strike, right,
                     CASE WHEN time='10:45' THEN 0 WHEN time='10:30' THEN 1 ELSE 2 END, time DESC
        """):
            key = (r["date"], r["expiry"], r["strike"], r["right"])
            if key not in self.prices:
                self.prices[key] = r["close"]

        self.metrics = {}
        for r in conn.execute("SELECT date, expiry, atm_iv FROM chain_metrics"):
            self.metrics[(r["date"], r["expiry"])] = r["atm_iv"] or 0

        self.all_expiries = sorted(set(k[1] for k in self.prices))
        self.trading_dates = sorted(self.spots.keys())

        # Precompute EMA50 + RSI14
        dates = self.trading_dates
        closes = [self.spots[d] for d in dates]
        self.ema50 = {}
        self.rsi14 = {}
        if len(closes) >= 50:
            s = sum(closes[:50]) / 50
            self.ema50[dates[49]] = s
            k = 2 / 51
            for i in range(50, len(closes)):
                s = closes[i] * k + s * (1 - k)
                self.ema50[dates[i]] = s
        if len(closes) >= 15:
            ag = al = 0
            for i in range(1, 15):
                c = closes[i] - closes[i-1]
                if c > 0: ag += c
                else: al += abs(c)
            ag /= 14; al /= 14
            self.rsi14[dates[14]] = 100 - 100/(1+ag/al) if al > 0 else 100
            for i in range(15, len(closes)):
                c = closes[i] - closes[i-1]
                ag = (ag*13 + max(c,0))/14
                al = (al*13 + abs(min(c,0)))/14
                self.rsi14[dates[i]] = 100 - 100/(1+ag/al) if al > 0 else 100

        conn.close()
        print(f"  Loaded {len(self.prices):,} prices, {len(self.spots)} days")

    def p(self, date, expiry, strike, right):
        return self.prices.get((date, expiry, strike, right))

    def dte(self, date, expiry):
        return max(0, (datetime.strptime(expiry, "%Y-%m-%d") - datetime.strptime(date, "%Y-%m-%d")).days)

    def vix(self, date, expiry):
        return self.metrics.get((date, expiry), 0)

PERIODS = [
    ("2016-2018", "2016-01-01", "2018-12-31"),
    ("2019", "2019-01-01", "2019-12-31"),
    ("2020", "2020-01-01", "2020-12-31"),
    ("2021", "2021-01-01", "2021-12-31"),
    ("2022", "2022-01-01", "2022-12-31"),
    ("2023", "2023-01-01", "2023-12-31"),
    ("2024-2025", "2024-01-01", "2025-12-31"),
]

# ── Basic Deep OTM engine (for tests 1-4, 6-8) ──────────────────────

def run_basic(ds, from_d, to_d, otm_ce, otm_pe, target_pct, sl_pct, exit_dte, dte_min, dte_max, min_prem, lots=1):
    trades = []
    dates = [d for d in ds.trading_dates if from_d <= d <= to_d]
    expiries = [e for e in ds.all_expiries if from_d <= e <= to_d]
    pos = None

    for date in dates:
        spot = ds.spots.get(date)
        if not spot: continue

        if pos:
            dte = ds.dte(date, pos["expiry"])
            ce = ds.p(date, pos["expiry"], pos["ce_s"], "CE")
            pe = ds.p(date, pos["expiry"], pos["pe_s"], "PE")
            if ce is not None and pe is not None:
                cur = ce + pe
                entry = pos["entry"]
                decay = (entry - cur) / entry * 100 if entry > 0 else 0
                rise = (cur - entry) / entry * 100 if entry > 0 else 0
                reason = None
                if decay >= target_pct: reason = "target"
                elif rise >= sl_pct: reason = "sl"
                elif dte <= exit_dte: reason = "time"
                elif dte <= 0: reason = "expiry"
                if reason:
                    pnl = (entry - cur) * LOT_SIZE * lots - COST_PER_LEG_RT * 2 * lots
                    trades.append({"pnl": round(pnl, 2), "reason": reason})
                    pos = None

        if not pos:
            for exp in expiries:
                dte = ds.dte(date, exp)
                if dte < dte_min or dte > dte_max: continue
                atm = round(spot / 50) * 50
                ce_s = atm + otm_ce
                pe_s = atm - otm_pe
                ce_p = ds.p(date, exp, ce_s, "CE")
                pe_p = ds.p(date, exp, pe_s, "PE")
                if not ce_p or not pe_p: continue
                if ce_p < min_prem and pe_p < min_prem: continue
                pos = {"ce_s": ce_s, "pe_s": pe_s, "entry": ce_p + pe_p, "expiry": exp}
                break

    if pos and dates:
        last = dates[-1]
        ce = ds.p(last, pos["expiry"], pos["ce_s"], "CE") or 0
        pe = ds.p(last, pos["expiry"], pos["pe_s"], "PE") or 0
        pnl = (pos["entry"] - (ce+pe)) * LOT_SIZE * lots - COST_PER_LEG_RT * 2 * lots
        trades.append({"pnl": round(pnl, 2), "reason": "end"})

    return trades

# ── Per-leg Roll engine (Test 5) ─────────────────────────────────────

def run_per_leg_roll(ds, from_d, to_d, otm_dist, roll_dist, leg_sl_pct, book_below, dte_min, dte_max, exit_dte, min_prem, max_rolls):
    trades = []
    dates = [d for d in ds.trading_dates if from_d <= d <= to_d]
    expiries = [e for e in ds.all_expiries if from_d <= e <= to_d]
    legs = []  # [{strike, right, entry_price, entry_date, expiry, rolls_done}]

    for date in dates:
        spot = ds.spots.get(date)
        if not spot: continue

        # Check each leg
        new_legs = []
        for leg in legs:
            dte = ds.dte(date, leg["expiry"])
            price = ds.p(date, leg["expiry"], leg["strike"], leg["right"])
            if price is None:
                new_legs.append(leg)
                continue

            reason = None
            if dte <= exit_dte: reason = "time"
            elif dte <= 0: reason = "expiry"
            elif price <= book_below: reason = "book"
            elif price > leg["entry_price"] * (1 + leg_sl_pct / 100): reason = "sl_roll"

            if reason:
                pnl = (leg["entry_price"] - price) * LOT_SIZE - COST_PER_LEG_RT
                trades.append({"pnl": round(pnl, 2), "reason": reason})

                # Roll deeper if SL and haven't maxed rolls
                if reason == "sl_roll" and leg["rolls_done"] < max_rolls and dte > exit_dte + 1:
                    new_strike = leg["strike"] + roll_dist if leg["right"] == "CE" else leg["strike"] - roll_dist
                    new_price = ds.p(date, leg["expiry"], new_strike, leg["right"])
                    if new_price and new_price >= 3:
                        new_legs.append({"strike": new_strike, "right": leg["right"], "entry_price": new_price,
                                        "entry_date": date, "expiry": leg["expiry"], "rolls_done": leg["rolls_done"] + 1})
            else:
                new_legs.append(leg)

        legs = new_legs

        # Enter if no legs
        if len(legs) == 0:
            for exp in expiries:
                dte = ds.dte(date, exp)
                if dte < dte_min or dte > dte_max: continue
                atm = round(spot / 50) * 50
                ce_s = atm + otm_dist
                pe_s = atm - otm_dist
                ce_p = ds.p(date, exp, ce_s, "CE")
                pe_p = ds.p(date, exp, pe_s, "PE")
                if not ce_p or not pe_p: continue
                if ce_p < min_prem and pe_p < min_prem: continue
                legs.append({"strike": ce_s, "right": "CE", "entry_price": ce_p, "entry_date": date, "expiry": exp, "rolls_done": 0})
                legs.append({"strike": pe_s, "right": "PE", "entry_price": pe_p, "entry_date": date, "expiry": exp, "rolls_done": 0})
                break

    # Force close
    if legs and dates:
        last = dates[-1]
        for leg in legs:
            price = ds.p(last, leg["expiry"], leg["strike"], leg["right"]) or 0
            pnl = (leg["entry_price"] - price) * LOT_SIZE - COST_PER_LEG_RT
            trades.append({"pnl": round(pnl, 2), "reason": "end"})

    return trades

# ── Metrics ──────────────────────────────────────────────────────────

def metrics(trades):
    if not trades: return {"n": 0, "ret": 0, "wr": 0, "dd": 0, "pnl": 0}
    pnl = sum(t["pnl"] for t in trades)
    wins = sum(1 for t in trades if t["pnl"] > 0)
    cum = peak = dd = 0
    for t in trades:
        cum += t["pnl"]; peak = max(peak, cum); dd = max(dd, peak - cum)
    exits = defaultdict(int)
    for t in trades: exits[t["reason"]] += 1
    return {"n": len(trades), "ret": round(pnl/CAPITAL*100, 1), "wr": round(wins/len(trades)*100, 1), "dd": round(dd/CAPITAL*100, 1), "pnl": round(pnl), "exits": dict(exits)}

def run_all_periods(fn, *args):
    all_trades = []
    prof = 0
    for _, f, t in PERIODS:
        trades = fn(*args, f, t) if callable(args[0]) else fn(*args)
        m = metrics(trades)
        if m["pnl"] > 0: prof += 1
        all_trades.extend(trades)
    total = metrics(all_trades)
    total["prof"] = prof
    return total

def test_across_periods(ds, run_fn, **kwargs):
    all_trades = []
    prof = 0
    for _, f, t in PERIODS:
        trades = run_fn(ds, f, t, **kwargs)
        m = metrics(trades)
        if m["pnl"] > 0: prof += 1
        all_trades.extend(trades)
    total = metrics(all_trades)
    total["prof"] = prof
    return total

# ── Main ─────────────────────────────────────────────────────────────

def main():
    ds = DataStore()

    CHAMP = {"ret": 445.9, "wr": 78.2, "dd": 11.7}  # current best

    print(f"\n{'╔' + '═'*78 + '╗'}")
    print(f"║  DEEP OTM SELL — ADVANCED OPTIMIZATION                                      ║")
    print(f"║  Current Champion: +446%, 78% WR, 11.7% DD, 7/7 periods                     ║")
    print(f"{'╚' + '═'*78 + '╝'}")

    # ══════════════════════════════════════════════════════════════════
    # TEST 1: Fine-tune OTM Distance
    # ══════════════════════════════════════════════════════════════════
    print(f"\n{'='*80}\n  TEST 1: OTM Distance Fine-Tuning\n{'='*80}")
    print(f"  {'OTM':>6} {'Trades':>7} {'Return%':>9} {'WR%':>6} {'MaxDD':>7} {'P/7':>5} {'vs Champ':>10}")
    print(f"  {'-'*55}")

    for otm in [350, 400, 450, 500, 550, 600, 650, 700, 800]:
        m = test_across_periods(ds, run_basic, otm_ce=otm, otm_pe=otm, target_pct=40, sl_pct=50, exit_dte=2, dte_min=7, dte_max=14, min_prem=20)
        tag = "🏆" if m["ret"] > CHAMP["ret"] else "  "
        diff = m["ret"] - CHAMP["ret"]
        print(f"  {tag}{otm:>4}pt {m['n']:>7} {m['ret']:>+8.1f}% {m['wr']:>5.1f}% {m['dd']:>6.1f}% {m['prof']:>3}/7 {diff:>+9.1f}%")

    # ══════════════════════════════════════════════════════════════════
    # TEST 2: Asymmetric Legs Based on Trend
    # ══════════════════════════════════════════════════════════════════
    print(f"\n{'='*80}\n  TEST 2: Asymmetric Legs (trend-based)\n{'='*80}")

    def run_asymmetric(ds, from_d, to_d, close_otm, far_otm):
        trades = []
        dates = [d for d in ds.trading_dates if from_d <= d <= to_d]
        expiries = [e for e in ds.all_expiries if from_d <= e <= to_d]
        pos = None
        for date in dates:
            spot = ds.spots.get(date)
            if not spot: continue
            if pos:
                dte = ds.dte(date, pos["expiry"])
                ce = ds.p(date, pos["expiry"], pos["ce_s"], "CE")
                pe = ds.p(date, pos["expiry"], pos["pe_s"], "PE")
                if ce is not None and pe is not None:
                    cur = ce + pe; entry = pos["entry"]
                    decay = (entry-cur)/entry*100 if entry>0 else 0
                    rise = (cur-entry)/entry*100 if entry>0 else 0
                    reason = None
                    if decay >= 40: reason = "target"
                    elif rise >= 50: reason = "sl"
                    elif dte <= 2: reason = "time"
                    if reason:
                        pnl = (entry-cur)*LOT_SIZE - COST_PER_LEG_RT*2
                        trades.append({"pnl": round(pnl,2), "reason": reason}); pos = None
            if not pos:
                for exp in expiries:
                    dte = ds.dte(date, exp)
                    if dte < 7 or dte > 14: continue
                    atm = round(spot/50)*50
                    ema = ds.ema50.get(date)
                    rsi = ds.rsi14.get(date)
                    # Asymmetric: if bullish, PE closer (safer), CE wider (more exposed)
                    if ema and spot > ema:
                        ce_otm, pe_otm = far_otm, close_otm
                    elif ema and spot < ema:
                        ce_otm, pe_otm = close_otm, far_otm
                    else:
                        ce_otm = pe_otm = 500
                    ce_s = atm + ce_otm; pe_s = atm - pe_otm
                    ce_p = ds.p(date, exp, ce_s, "CE"); pe_p = ds.p(date, exp, pe_s, "PE")
                    if not ce_p or not pe_p: continue
                    if ce_p < 20 and pe_p < 20: continue
                    pos = {"ce_s": ce_s, "pe_s": pe_s, "entry": ce_p+pe_p, "expiry": exp}; break
        if pos and dates:
            last = dates[-1]
            ce = ds.p(last, pos["expiry"], pos["ce_s"], "CE") or 0
            pe = ds.p(last, pos["expiry"], pos["pe_s"], "PE") or 0
            trades.append({"pnl": round((pos["entry"]-(ce+pe))*LOT_SIZE - COST_PER_LEG_RT*2, 2), "reason": "end"})
        return trades

    print(f"  {'Close/Far':>12} {'Trades':>7} {'Return%':>9} {'WR%':>6} {'MaxDD':>7} {'P/7':>5}")
    print(f"  {'-'*50}")
    for close, far in [(400,600), (350,650), (450,550), (400,700), (500,500)]:
        all_t = []
        prof = 0
        for _, f, t in PERIODS:
            trades = run_asymmetric(ds, f, t, close, far)
            if metrics(trades)["pnl"] > 0: prof += 1
            all_t.extend(trades)
        m = metrics(all_t); m["prof"] = prof
        tag = "🏆" if m["ret"] > CHAMP["ret"] else "  "
        print(f"  {tag}{close}/{far}pt {m['n']:>7} {m['ret']:>+8.1f}% {m['wr']:>5.1f}% {m['dd']:>6.1f}% {m['prof']:>3}/7")

    # ══════════════════════════════════════════════════════════════════
    # TEST 3: VIX-Adaptive OTM Distance
    # ══════════════════════════════════════════════════════════════════
    print(f"\n{'='*80}\n  TEST 3: VIX-Adaptive OTM Distance\n{'='*80}")

    def run_vix_adaptive(ds, from_d, to_d, vix_map):
        trades = []
        dates = [d for d in ds.trading_dates if from_d <= d <= to_d]
        expiries = [e for e in ds.all_expiries if from_d <= e <= to_d]
        pos = None
        for date in dates:
            spot = ds.spots.get(date)
            if not spot: continue
            if pos:
                dte = ds.dte(date, pos["expiry"])
                ce = ds.p(date, pos["expiry"], pos["ce_s"], "CE")
                pe = ds.p(date, pos["expiry"], pos["pe_s"], "PE")
                if ce is not None and pe is not None:
                    cur = ce+pe; entry = pos["entry"]
                    decay = (entry-cur)/entry*100 if entry>0 else 0
                    rise = (cur-entry)/entry*100 if entry>0 else 0
                    reason = None
                    if decay >= 40: reason = "target"
                    elif rise >= 50: reason = "sl"
                    elif dte <= 2: reason = "time"
                    if reason:
                        trades.append({"pnl": round((entry-cur)*LOT_SIZE - COST_PER_LEG_RT*2, 2), "reason": reason}); pos = None
            if not pos:
                for exp in expiries:
                    dte = ds.dte(date, exp)
                    if dte < 7 or dte > 14: continue
                    atm = round(spot/50)*50
                    v = ds.vix(date, exp) * 100  # as percentage
                    otm = 500  # default
                    for threshold, dist in sorted(vix_map.items()):
                        if v <= threshold: otm = dist; break
                    else:
                        otm = list(vix_map.values())[-1]
                    ce_s = atm+otm; pe_s = atm-otm
                    ce_p = ds.p(date, exp, ce_s, "CE"); pe_p = ds.p(date, exp, pe_s, "PE")
                    if not ce_p or not pe_p: continue
                    if ce_p < 20 and pe_p < 20: continue
                    pos = {"ce_s": ce_s, "pe_s": pe_s, "entry": ce_p+pe_p, "expiry": exp}; break
        if pos and dates:
            last = dates[-1]
            ce = ds.p(last, pos["expiry"], pos["ce_s"], "CE") or 0
            pe = ds.p(last, pos["expiry"], pos["pe_s"], "PE") or 0
            trades.append({"pnl": round((pos["entry"]-(ce+pe))*LOT_SIZE - COST_PER_LEG_RT*2, 2), "reason": "end"})
        return trades

    vix_configs = [
        ("Conservative", {13: 400, 18: 500, 25: 700, 100: 1000}),
        ("Aggressive", {13: 350, 18: 450, 25: 600, 100: 800}),
        ("Wide", {13: 500, 18: 600, 25: 800, 100: 1200}),
        ("Flat 500pt", {100: 500}),
    ]
    print(f"  {'Config':>15} {'Trades':>7} {'Return%':>9} {'WR%':>6} {'MaxDD':>7} {'P/7':>5}")
    print(f"  {'-'*50}")
    for name, vmap in vix_configs:
        all_t = []; prof = 0
        for _, f, t in PERIODS:
            trades = run_vix_adaptive(ds, f, t, vmap)
            if metrics(trades)["pnl"] > 0: prof += 1
            all_t.extend(trades)
        m = metrics(all_t); m["prof"] = prof
        print(f"  {'🏆' if m['ret']>CHAMP['ret'] else '  '}{name:>13} {m['n']:>7} {m['ret']:>+8.1f}% {m['wr']:>5.1f}% {m['dd']:>6.1f}% {m['prof']:>3}/7")

    # ══════════════════════════════════════════════════════════════════
    # TEST 4: Add Protective Wings
    # ══════════════════════════════════════════════════════════════════
    print(f"\n{'='*80}\n  TEST 4: Add Protective Wings (Wide Iron Condor)\n{'='*80}")

    def run_with_wings(ds, from_d, to_d, wing_width):
        trades = []
        dates = [d for d in ds.trading_dates if from_d <= d <= to_d]
        expiries = [e for e in ds.all_expiries if from_d <= e <= to_d]
        pos = None
        for date in dates:
            spot = ds.spots.get(date)
            if not spot: continue
            if pos:
                dte = ds.dte(date, pos["expiry"])
                ce_s = ds.p(date, pos["expiry"], pos["ce_short"], "CE")
                ce_l = ds.p(date, pos["expiry"], pos["ce_long"], "CE")
                pe_s = ds.p(date, pos["expiry"], pos["pe_short"], "PE")
                pe_l = ds.p(date, pos["expiry"], pos["pe_long"], "PE")
                if all(x is not None for x in [ce_s, ce_l, pe_s, pe_l]):
                    cur = (ce_s - ce_l) + (pe_s - pe_l)
                    entry = pos["entry"]
                    decay = (entry-cur)/entry*100 if entry>0 else 0
                    rise = (cur-entry)/entry*100 if entry>0 else 0
                    reason = None
                    if decay >= 40: reason = "target"
                    elif rise >= 50: reason = "sl"
                    elif dte <= 2: reason = "time"
                    if reason:
                        trades.append({"pnl": round((entry-cur)*LOT_SIZE - COST_PER_LEG_RT*4, 2), "reason": reason}); pos = None
            if not pos:
                for exp in expiries:
                    dte = ds.dte(date, exp)
                    if dte < 7 or dte > 14: continue
                    atm = round(spot/50)*50
                    ce_short = atm+500; ce_long = atm+500+wing_width
                    pe_short = atm-500; pe_long = atm-500-wing_width
                    cs = ds.p(date, exp, ce_short, "CE"); cl = ds.p(date, exp, ce_long, "CE")
                    ps = ds.p(date, exp, pe_short, "PE"); pl = ds.p(date, exp, pe_long, "PE")
                    if not all([cs, cl, ps, pl]): continue
                    credit = (cs-cl) + (ps-pl)
                    if credit <= 0: continue
                    pos = {"ce_short": ce_short, "ce_long": ce_long, "pe_short": pe_short, "pe_long": pe_long, "entry": credit, "expiry": exp}; break
        if pos and dates:
            last = dates[-1]
            cs = ds.p(last, pos["expiry"], pos["ce_short"], "CE") or 0
            cl = ds.p(last, pos["expiry"], pos["ce_long"], "CE") or 0
            ps = ds.p(last, pos["expiry"], pos["pe_short"], "PE") or 0
            pl = ds.p(last, pos["expiry"], pos["pe_long"], "PE") or 0
            trades.append({"pnl": round((pos["entry"]-((cs-cl)+(ps-pl)))*LOT_SIZE - COST_PER_LEG_RT*4, 2), "reason": "end"})
        return trades

    print(f"  {'Wings':>8} {'Trades':>7} {'Return%':>9} {'WR%':>6} {'MaxDD':>7} {'P/7':>5}")
    print(f"  {'-'*45}")
    for wing in [0, 150, 200, 300]:
        all_t = []; prof = 0
        for _, f, t in PERIODS:
            if wing == 0:
                trades = run_basic(ds, f, t, otm_ce=500, otm_pe=500, target_pct=40, sl_pct=50, exit_dte=2, dte_min=7, dte_max=14, min_prem=20)
            else:
                trades = run_with_wings(ds, f, t, wing)
            if metrics(trades)["pnl"] > 0: prof += 1
            all_t.extend(trades)
        m = metrics(all_t); m["prof"] = prof
        lbl = "Naked" if wing == 0 else f"{wing}pt"
        print(f"  {'🏆' if m['ret']>CHAMP['ret'] else '  '}{lbl:>6} {m['n']:>7} {m['ret']:>+8.1f}% {m['wr']:>5.1f}% {m['dd']:>6.1f}% {m['prof']:>3}/7")

    # ══════════════════════════════════════════════════════════════════
    # TEST 5: Per-Leg Roll (the big one)
    # ══════════════════════════════════════════════════════════════════
    print(f"\n{'='*80}\n  TEST 5: Per-Leg Roll — Close Loser, Roll Deeper, Hold Winner\n{'='*80}")
    print(f"  {'Roll':>6} {'LegSL':>6} {'Book<':>6} {'MaxR':>5} {'Trades':>7} {'Ret%':>8} {'WR%':>6} {'DD':>6} {'P/7':>5}")
    print(f"  {'-'*65}")

    best_roll = None
    combos = 0
    for roll_dist in [200, 300, 500]:
        for leg_sl in [25, 50, 100]:
            for book in [10, 15, 20, 25]:
                for max_r in [1, 2]:
                    all_t = []; prof = 0
                    for _, f, t in PERIODS:
                        trades = run_per_leg_roll(ds, f, t, otm_dist=500, roll_dist=roll_dist, leg_sl_pct=leg_sl, book_below=book, dte_min=7, dte_max=14, exit_dte=2, min_prem=20, max_rolls=max_r)
                        if metrics(trades)["pnl"] > 0: prof += 1
                        all_t.extend(trades)
                    m = metrics(all_t); m["prof"] = prof
                    combos += 1
                    if not best_roll or m["ret"] > best_roll["ret"]:
                        best_roll = {**m, "roll": roll_dist, "sl": leg_sl, "book": book, "maxr": max_r}
                        print(f"  🏆{roll_dist:>4}pt {leg_sl:>5}% ₹{book:>4} {max_r:>4} {m['n']:>7} {m['ret']:>+7.1f}% {m['wr']:>5.1f}% {m['dd']:>5.1f}% {m['prof']:>3}/7")

    print(f"  Tested {combos} combos")
    if best_roll:
        print(f"  Best Roll: +{best_roll['ret']}% | roll {best_roll['roll']}pt, SL {best_roll['sl']}%, book<₹{best_roll['book']}, maxRolls={best_roll['maxr']}")

    # ══════════════════════════════════════════════════════════════════
    # TEST 6: Entry DTE Precision
    # ══════════════════════════════════════════════════════════════════
    print(f"\n{'='*80}\n  TEST 6: Entry DTE Precision\n{'='*80}")
    print(f"  {'DTE':>6} {'Trades':>7} {'Return%':>9} {'WR%':>6} {'MaxDD':>7} {'P/7':>5}")
    print(f"  {'-'*45}")
    for dte_exact in [7, 8, 10, 12, 14]:
        m = test_across_periods(ds, run_basic, otm_ce=500, otm_pe=500, target_pct=40, sl_pct=50, exit_dte=2, dte_min=dte_exact, dte_max=dte_exact, min_prem=20)
        print(f"  {'🏆' if m['ret']>CHAMP['ret'] else '  '} DTE={dte_exact:>2} {m['n']:>7} {m['ret']:>+8.1f}% {m['wr']:>5.1f}% {m['dd']:>6.1f}% {m['prof']:>3}/7")

    # ══════════════════════════════════════════════════════════════════
    # TEST 7: Dynamic Position Sizing
    # ══════════════════════════════════════════════════════════════════
    print(f"\n{'='*80}\n  TEST 7: Dynamic Position Sizing by VIX\n{'='*80}")
    # Can't easily do multi-lot in the basic engine. Approximate by running separately and scaling.
    print(f"  (Approximated by running high-VIX periods at 2x)")

    all_t = []; prof = 0
    for _, f, t in PERIODS:
        trades = run_basic(ds, f, t, otm_ce=500, otm_pe=500, target_pct=40, sl_pct=50, exit_dte=2, dte_min=7, dte_max=14, min_prem=20)
        # REMOVED: this previously multiplied 2019/2020 P&L by 1.5x — a hindsight fabrication that
        # inflated the two known-best years with no matching margin or risk. Report unscaled actuals only.
        if metrics(trades)["pnl"] > 0: prof += 1
        all_t.extend(trades)
    m = metrics(all_t); m["prof"] = prof
    print(f"  Fixed 1-lot (no hindsight VIX scaling): {m['n']} trades, +{m['ret']}%, {m['wr']}% WR, {m['dd']}% DD, {m['prof']}/7")

    # ══════════════════════════════════════════════════════════════════
    # TEST 8: Minimum Premium Filter
    # ══════════════════════════════════════════════════════════════════
    print(f"\n{'='*80}\n  TEST 8: Minimum Premium Filter\n{'='*80}")
    print(f"  {'MinPrem':>8} {'Trades':>7} {'Return%':>9} {'WR%':>6} {'MaxDD':>7} {'P/7':>5}")
    print(f"  {'-'*45}")
    for mp in [5, 10, 15, 20, 30, 50]:
        m = test_across_periods(ds, run_basic, otm_ce=500, otm_pe=500, target_pct=40, sl_pct=50, exit_dte=2, dte_min=7, dte_max=14, min_prem=mp)
        print(f"  {'🏆' if m['ret']>CHAMP['ret'] else '  '} ₹{mp:>5} {m['n']:>7} {m['ret']:>+8.1f}% {m['wr']:>5.1f}% {m['dd']:>6.1f}% {m['prof']:>3}/7")

    print(f"\n{'='*80}\n  ALL TESTS COMPLETE!\n{'='*80}")

if __name__ == "__main__":
    main()
