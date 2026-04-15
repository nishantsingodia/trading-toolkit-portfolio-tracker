"""
F&O Strategy Backtester — REAL Option Chain Data
=================================================
Uses actual premiums, OI, and IV from Breeze + NSE bhav copy.
Tests all strategies across 7 market periods with parameter grids.

Usage: python3 scripts/backtest-real-data.py
"""

import sqlite3, json, sys, math, time as time_module
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

DB_PATH = Path(__file__).parent.parent / "data" / "nifty-options-history.db"
RESULTS_PATH = Path(__file__).parent.parent / "data" / "backtest-results.json"
LOT_SIZE = 75  # Nifty lot size (changed to 75 in 2023, was 50 before)
CAPITAL = 500000

# ── Data Access Layer ────────────────────────────────────────────────

class DataStore:
    def __init__(self):
        self.conn = sqlite3.connect(str(DB_PATH))
        self.conn.row_factory = sqlite3.Row
        self._load_spots()
        self._load_ema_rsi()
        self._preload_option_prices()
        self._preload_chain_metrics()
        self._preload_expiries()

    def _load_spots(self):
        """Load all spot prices into memory."""
        self.spots = {}
        for row in self.conn.execute("SELECT date, open, close FROM spot_candles ORDER BY date"):
            self.spots[row["date"]] = {"open": row["open"], "close": row["close"]}

    def _load_ema_rsi(self):
        """Compute daily EMA50 and RSI14 from spot data."""
        dates = sorted(self.spots.keys())
        closes = [self.spots[d]["close"] for d in dates]

        # EMA50
        ema50 = [None] * len(closes)
        if len(closes) >= 50:
            s = sum(closes[:50]) / 50
            ema50[49] = s
            k = 2 / 51
            for i in range(50, len(closes)):
                ema50[i] = closes[i] * k + ema50[i-1] * (1 - k)

        # RSI14
        rsi14 = [None] * len(closes)
        if len(closes) >= 15:
            avg_gain = avg_loss = 0
            for i in range(1, 15):
                change = closes[i] - closes[i-1]
                if change > 0: avg_gain += change
                else: avg_loss += abs(change)
            avg_gain /= 14
            avg_loss /= 14
            rsi14[14] = 100 - 100 / (1 + avg_gain / avg_loss) if avg_loss > 0 else 100
            for i in range(15, len(closes)):
                change = closes[i] - closes[i-1]
                gain = max(change, 0)
                loss = abs(min(change, 0))
                avg_gain = (avg_gain * 13 + gain) / 14
                avg_loss = (avg_loss * 13 + loss) / 14
                rsi14[i] = 100 - 100 / (1 + avg_gain / avg_loss) if avg_loss > 0 else 100

        self.indicators = {}
        for i, d in enumerate(dates):
            self.indicators[d] = {"ema50": ema50[i], "rsi14": rsi14[i]}

    def _preload_option_prices(self):
        """Preload ALL option prices into memory dict for fast lookup."""
        print("  Preloading option prices into memory...")
        self.option_prices = {}  # (date, expiry, strike, right) -> close price (best time)

        # Get the best price per (date, expiry, strike, right) — prefer 10:45, fallback to latest
        rows = self.conn.execute("""
            SELECT date, expiry, strike, right, close, time
            FROM option_candles
            WHERE close > 0
            ORDER BY date, expiry, strike, right,
                     CASE WHEN time = '10:45' THEN 0 WHEN time = '10:30' THEN 1 ELSE 2 END,
                     time DESC
        """).fetchall()

        for r in rows:
            key = (r["date"], r["expiry"], r["strike"], r["right"])
            if key not in self.option_prices:  # first match = best (due to ORDER BY)
                self.option_prices[key] = r["close"]

        print(f"  Loaded {len(self.option_prices):,} price points")

    def _preload_chain_metrics(self):
        """Preload chain metrics into memory."""
        self.chain_metrics = {}
        for row in self.conn.execute("SELECT * FROM chain_metrics"):
            self.chain_metrics[(row["date"], row["expiry"])] = dict(row)

    def _preload_expiries(self):
        """Preload expiry list."""
        self.all_expiries = sorted(set(
            r["expiry"] for r in self.conn.execute("SELECT DISTINCT expiry FROM option_candles")
        ))
        self.all_trading_dates = sorted(self.spots.keys())

    def get_spot(self, date):
        return self.spots.get(date, {}).get("close")

    def get_indicators(self, date):
        return self.indicators.get(date, {})

    def get_chain_metrics(self, date, expiry):
        return self.chain_metrics.get((date, expiry))

    def get_option_price(self, date, expiry, strike, right, prefer_time=None):
        return self.option_prices.get((date, expiry, strike, right))

    def get_atm_strike(self, spot):
        return round(spot / 50) * 50

    def get_expiries_in_range(self, from_date, to_date):
        return [e for e in self.all_expiries if from_date <= e <= to_date]

    def get_trading_dates(self, from_date, to_date):
        return [d for d in self.all_trading_dates if from_date <= d <= to_date]

    def get_dte(self, date, expiry):
        d1 = datetime.strptime(date, "%Y-%m-%d")
        d2 = datetime.strptime(expiry, "%Y-%m-%d")
        return max(0, (d2 - d1).days)

# ── Strategy Definitions ─────────────────────────────────────────────

def short_straddle_entry(ds, expiry, spot, atm, metrics, indicators, params):
    """Short Straddle: sell ATM CE + PE."""
    dte = ds.get_dte(ds._current_date, expiry)
    if dte < params.get("dte_min", 2) or dte > params.get("dte_max", 7):
        return None

    vix = (metrics or {}).get("atm_iv", 0)
    if vix and params.get("vix_max") and vix > params["vix_max"]:
        return None

    rsi = (indicators or {}).get("rsi14")
    if rsi and params.get("rsi_range"):
        lo, hi = params["rsi_range"]
        if rsi < lo or rsi > hi:
            return None

    ce_price = ds.get_option_price(ds._current_date, expiry, atm, "CE")
    pe_price = ds.get_option_price(ds._current_date, expiry, atm, "PE")
    if not ce_price or not pe_price:
        return None

    return {
        "legs": [
            {"strike": atm, "right": "CE", "side": "SELL", "entry_price": ce_price},
            {"strike": atm, "right": "PE", "side": "SELL", "entry_price": pe_price},
        ],
        "entry_premium": ce_price + pe_price,
        "expiry": expiry,
    }

def short_strangle_entry(ds, expiry, spot, atm, metrics, indicators, params):
    """Short Strangle: sell OTM CE + PE."""
    dte = ds.get_dte(ds._current_date, expiry)
    if dte < params.get("dte_min", 2) or dte > params.get("dte_max", 7):
        return None

    vix = (metrics or {}).get("atm_iv", 0)
    if vix and params.get("vix_max") and vix > params["vix_max"]:
        return None

    otm_dist = params.get("otm_distance", 300)
    ce_strike = atm + otm_dist
    pe_strike = atm - otm_dist

    ce_price = ds.get_option_price(ds._current_date, expiry, ce_strike, "CE")
    pe_price = ds.get_option_price(ds._current_date, expiry, pe_strike, "PE")
    if not ce_price or not pe_price:
        return None

    return {
        "legs": [
            {"strike": ce_strike, "right": "CE", "side": "SELL", "entry_price": ce_price},
            {"strike": pe_strike, "right": "PE", "side": "SELL", "entry_price": pe_price},
        ],
        "entry_premium": ce_price + pe_price,
        "expiry": expiry,
    }

def iron_condor_entry(ds, expiry, spot, atm, metrics, indicators, params):
    """Iron Condor: sell OTM strangle + buy wings."""
    dte = ds.get_dte(ds._current_date, expiry)
    if dte < params.get("dte_min", 3) or dte > params.get("dte_max", 7):
        return None

    vix = (metrics or {}).get("atm_iv", 0)
    if vix and params.get("vix_max") and vix > params["vix_max"]:
        return None

    otm = params.get("otm_distance", 300)
    wing = params.get("wing_width", 200)

    ce_short = atm + otm
    ce_long = atm + otm + wing
    pe_short = atm - otm
    pe_long = atm - otm - wing

    ce_s = ds.get_option_price(ds._current_date, expiry, ce_short, "CE")
    ce_l = ds.get_option_price(ds._current_date, expiry, ce_long, "CE")
    pe_s = ds.get_option_price(ds._current_date, expiry, pe_short, "PE")
    pe_l = ds.get_option_price(ds._current_date, expiry, pe_long, "PE")

    if not all([ce_s, ce_l, pe_s, pe_l]):
        return None

    net_credit = (ce_s - ce_l) + (pe_s - pe_l)
    if net_credit <= 0:
        return None

    return {
        "legs": [
            {"strike": ce_short, "right": "CE", "side": "SELL", "entry_price": ce_s},
            {"strike": ce_long, "right": "CE", "side": "BUY", "entry_price": ce_l},
            {"strike": pe_short, "right": "PE", "side": "SELL", "entry_price": pe_s},
            {"strike": pe_long, "right": "PE", "side": "BUY", "entry_price": pe_l},
        ],
        "entry_premium": net_credit,
        "expiry": expiry,
    }

def bull_call_spread_entry(ds, expiry, spot, atm, metrics, indicators, params):
    """Bull Call Spread: buy ATM CE + sell OTM CE."""
    dte = ds.get_dte(ds._current_date, expiry)
    if dte < params.get("dte_min", 2) or dte > params.get("dte_max", 7):
        return None

    # Direction: need bullish (spot > EMA50, RSI > 50)
    ema50 = (indicators or {}).get("ema50")
    rsi = (indicators or {}).get("rsi14")
    if ema50 and spot < ema50:
        return None
    if rsi and rsi < params.get("rsi_min", 50):
        return None

    width = params.get("spread_width", 100)
    buy_strike = atm
    sell_strike = atm + width

    buy_price = ds.get_option_price(ds._current_date, expiry, buy_strike, "CE")
    sell_price = ds.get_option_price(ds._current_date, expiry, sell_strike, "CE")
    if not buy_price or not sell_price:
        return None

    net_debit = buy_price - sell_price
    if net_debit <= 0:
        return None

    return {
        "legs": [
            {"strike": buy_strike, "right": "CE", "side": "BUY", "entry_price": buy_price},
            {"strike": sell_strike, "right": "CE", "side": "SELL", "entry_price": sell_price},
        ],
        "entry_premium": -net_debit,  # negative = debit
        "expiry": expiry,
    }

def bear_put_spread_entry(ds, expiry, spot, atm, metrics, indicators, params):
    """Bear Put Spread: buy ATM PE + sell OTM PE."""
    dte = ds.get_dte(ds._current_date, expiry)
    if dte < params.get("dte_min", 2) or dte > params.get("dte_max", 7):
        return None

    ema50 = (indicators or {}).get("ema50")
    rsi = (indicators or {}).get("rsi14")
    if ema50 and spot > ema50:
        return None
    if rsi and rsi > params.get("rsi_max", 50):
        return None

    width = params.get("spread_width", 100)
    buy_strike = atm
    sell_strike = atm - width

    buy_price = ds.get_option_price(ds._current_date, expiry, buy_strike, "PE")
    sell_price = ds.get_option_price(ds._current_date, expiry, sell_strike, "PE")
    if not buy_price or not sell_price:
        return None

    net_debit = buy_price - sell_price
    if net_debit <= 0:
        return None

    return {
        "legs": [
            {"strike": buy_strike, "right": "PE", "side": "BUY", "entry_price": buy_price},
            {"strike": sell_strike, "right": "PE", "side": "SELL", "entry_price": sell_price},
        ],
        "entry_premium": -net_debit,
        "expiry": expiry,
    }

def deep_otm_sell_entry(ds, expiry, spot, atm, metrics, indicators, params):
    """Deep OTM Sell: sell far OTM CE + PE."""
    dte = ds.get_dte(ds._current_date, expiry)
    if dte < params.get("dte_min", 7) or dte > params.get("dte_max", 14):
        return None

    vix = (metrics or {}).get("atm_iv", 0)
    if vix and params.get("vix_max") and vix > params["vix_max"]:
        return None

    otm = params.get("otm_distance", 500)
    ce_strike = atm + otm
    pe_strike = atm - otm

    ce_price = ds.get_option_price(ds._current_date, expiry, ce_strike, "CE")
    pe_price = ds.get_option_price(ds._current_date, expiry, pe_strike, "PE")
    if not ce_price or not pe_price:
        return None

    min_prem = params.get("min_premium", 10)
    if ce_price < min_prem and pe_price < min_prem:
        return None

    return {
        "legs": [
            {"strike": ce_strike, "right": "CE", "side": "SELL", "entry_price": ce_price},
            {"strike": pe_strike, "right": "PE", "side": "SELL", "entry_price": pe_price},
        ],
        "entry_premium": ce_price + pe_price,
        "expiry": expiry,
    }

STRATEGIES = {
    "short_straddle": short_straddle_entry,
    "short_strangle": short_strangle_entry,
    "iron_condor": iron_condor_entry,
    "bull_call_spread": bull_call_spread_entry,
    "bear_put_spread": bear_put_spread_entry,
    "deep_otm_sell": deep_otm_sell_entry,
}

# ── Backtester Engine ────────────────────────────────────────────────

def run_backtest(ds, strategy_name, entry_fn, params, from_date, to_date):
    """Run a single strategy backtest on real data."""
    trades = []
    expiries = ds.get_expiries_in_range(from_date, to_date)
    trading_dates = ds.get_trading_dates(from_date, to_date)

    target_pct = params.get("target_pct", 20)
    sl_pct = params.get("sl_pct", 40)
    exit_dte = params.get("exit_dte", 2)

    open_position = None

    for date in trading_dates:
        ds._current_date = date
        spot = ds.get_spot(date)
        if not spot:
            continue

        # Check exit for open position
        if open_position:
            pos = open_position
            dte = ds.get_dte(date, pos["expiry"])

            # Get current premium for all legs
            current_premium = 0
            all_prices_available = True
            for leg in pos["legs"]:
                price = ds.get_option_price(date, pos["expiry"], leg["strike"], leg["right"])
                if price is None:
                    all_prices_available = False
                    break
                if leg["side"] == "SELL":
                    current_premium += price
                else:
                    current_premium -= price  # bought legs reduce premium

            if not all_prices_available:
                continue

            entry_prem = abs(pos["entry_premium"])
            exit_reason = None

            if entry_prem > 0:
                if pos["entry_premium"] > 0:
                    # Credit strategy (selling): premium decay = profit
                    decay_pct = (entry_prem - current_premium) / entry_prem * 100
                    rise_pct = (current_premium - entry_prem) / entry_prem * 100

                    if decay_pct >= target_pct:
                        exit_reason = "target_hit"
                    elif rise_pct >= sl_pct:
                        exit_reason = "stop_loss"
                else:
                    # Debit strategy (buying): premium rise = profit
                    gain_pct = (current_premium - entry_prem) / entry_prem * 100
                    loss_pct = (entry_prem - current_premium) / entry_prem * 100

                    if gain_pct >= target_pct:
                        exit_reason = "target_hit"
                    elif loss_pct >= sl_pct:
                        exit_reason = "stop_loss"

            # Time exit
            if dte <= exit_dte:
                exit_reason = exit_reason or "time_exit"

            # Expiry
            if dte <= 0:
                exit_reason = exit_reason or "expiry"

            if exit_reason:
                # Calculate P&L
                pnl = 0
                for leg in pos["legs"]:
                    price = ds.get_option_price(date, pos["expiry"], leg["strike"], leg["right"])
                    if price is None:
                        price = 0
                    if leg["side"] == "SELL":
                        pnl += (leg["entry_price"] - price) * LOT_SIZE
                    else:
                        pnl += (price - leg["entry_price"]) * LOT_SIZE

                trades.append({
                    "entry_date": pos["entry_date"],
                    "exit_date": date,
                    "expiry": pos["expiry"],
                    "entry_premium": pos["entry_premium"],
                    "exit_premium": current_premium,
                    "pnl": round(pnl, 2),
                    "exit_reason": exit_reason,
                    "dte_entry": pos["dte_entry"],
                    "dte_exit": dte,
                })
                open_position = None

        # Try to enter if no open position
        if not open_position:
            # Find the right expiry to trade
            for expiry in expiries:
                dte = ds.get_dte(date, expiry)
                if dte < params.get("dte_min", 2):
                    continue  # Too close — skip to next expiry

                atm = ds.get_atm_strike(spot)
                metrics = ds.get_chain_metrics(date, expiry)
                indicators = ds.get_indicators(date)

                position = entry_fn(ds, expiry, spot, atm, metrics, indicators, params)
                if position:
                    position["entry_date"] = date
                    position["dte_entry"] = dte
                    open_position = position
                    break

    # Force close any open position
    if open_position and trading_dates:
        last_date = trading_dates[-1]
        pnl = 0
        for leg in open_position["legs"]:
            price = ds.get_option_price(last_date, open_position["expiry"], leg["strike"], leg["right"])
            if price is None:
                price = 0
            if leg["side"] == "SELL":
                pnl += (leg["entry_price"] - price) * LOT_SIZE
            else:
                pnl += (price - leg["entry_price"]) * LOT_SIZE
        trades.append({
            "entry_date": open_position["entry_date"],
            "exit_date": last_date,
            "expiry": open_position["expiry"],
            "entry_premium": open_position["entry_premium"],
            "exit_premium": 0,
            "pnl": round(pnl, 2),
            "exit_reason": "period_end",
            "dte_entry": open_position.get("dte_entry", 0),
            "dte_exit": 0,
        })

    return compute_metrics(trades)

def compute_metrics(trades):
    """Compute performance metrics from trade list."""
    if not trades:
        return {"total_trades": 0, "trades": [], "winning_trades": 0, "losing_trades": 0,
                "win_rate": 0, "total_return": 0, "total_return_pct": 0, "avg_pnl_per_trade": 0,
                "sharpe": 0, "max_drawdown": 0, "max_drawdown_pct": 0, "profit_factor": 0,
                "avg_win": 0, "avg_loss": 0, "exit_breakdown": {}}

    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] <= 0]
    total_pnl = sum(t["pnl"] for t in trades)

    # Exit breakdown
    exit_reasons = defaultdict(int)
    for t in trades:
        exit_reasons[t["exit_reason"]] += 1

    # Sharpe (approximate — daily returns not available, use per-trade)
    pnls = [t["pnl"] for t in trades]
    avg_pnl = total_pnl / len(trades)
    if len(pnls) > 1:
        var = sum((p - avg_pnl)**2 for p in pnls) / (len(pnls) - 1)
        std = math.sqrt(var) if var > 0 else 1
        sharpe = (avg_pnl / std) * math.sqrt(52)  # annualize assuming weekly trades
    else:
        sharpe = 0

    # Max drawdown
    cumulative = 0
    peak = 0
    max_dd = 0
    for t in trades:
        cumulative += t["pnl"]
        peak = max(peak, cumulative)
        dd = peak - cumulative
        max_dd = max(max_dd, dd)

    gross_profit = sum(t["pnl"] for t in wins) if wins else 0
    gross_loss = sum(abs(t["pnl"]) for t in losses) if losses else 0

    return {
        "total_trades": len(trades),
        "winning_trades": len(wins),
        "losing_trades": len(losses),
        "win_rate": round(len(wins) / len(trades) * 100, 1) if trades else 0,
        "total_return": round(total_pnl),
        "total_return_pct": round(total_pnl / CAPITAL * 100, 2),
        "avg_pnl_per_trade": round(avg_pnl),
        "sharpe": round(sharpe, 2),
        "max_drawdown": round(max_dd),
        "max_drawdown_pct": round(max_dd / CAPITAL * 100, 2),
        "profit_factor": round(gross_profit / gross_loss, 2) if gross_loss > 0 else float('inf'),
        "avg_win": round(gross_profit / len(wins)) if wins else 0,
        "avg_loss": round(gross_loss / len(losses)) if losses else 0,
        "exit_breakdown": dict(exit_reasons),
        "trades": trades,
    }

# ── Time Periods ─────────────────────────────────────────────────────

PERIODS = [
    ("2016-2018", "PRE_WEEKLY", "2016-01-01", "2018-12-31", "Monthly only, Demonetization/IL&FS"),
    ("2019", "WEEKLY_START", "2019-01-01", "2019-12-31", "Weekly starts, Trade war"),
    ("2020", "COVID", "2020-01-01", "2020-12-31", "COVID crash + V-recovery"),
    ("2021", "BULL_RUN", "2021-01-01", "2021-12-31", "Massive bull run"),
    ("2022", "RATE_HIKE", "2022-01-01", "2022-12-31", "Rate hike bear market"),
    ("2023", "RECOVERY", "2023-01-01", "2023-12-31", "Recovery, range-bound"),
    ("2024-2025", "CURRENT", "2024-01-01", "2025-12-31", "Recent + SEBI changes"),
]

# ── Parameter Grids ──────────────────────────────────────────────────

PARAM_GRIDS = {
    "short_straddle": [
        {"dte_min": d[0], "dte_max": d[1], "target_pct": t, "sl_pct": s, "exit_dte": e, "vix_max": v, "rsi_range": r}
        for d in [(2, 5), (3, 7), (4, 8)]
        for t in [20, 30]
        for s in [30, 40, 50]
        for e in [1, 2]
        for v in [None, 0.18, 0.25]
        for r in [None, (40, 60)]
    ],
    "short_strangle": [
        {"dte_min": d[0], "dte_max": d[1], "target_pct": t, "sl_pct": s, "exit_dte": e, "vix_max": v, "otm_distance": otm}
        for d in [(3, 7), (4, 8)]
        for t in [30, 40]
        for s in [40, 50, 80]
        for e in [1, 2]
        for v in [None, 0.20]
        for otm in [200, 300, 500]
    ],
    "iron_condor": [
        {"dte_min": d[0], "dte_max": d[1], "target_pct": t, "sl_pct": s, "exit_dte": e, "vix_max": v, "otm_distance": otm, "wing_width": w}
        for d in [(3, 7), (5, 8)]
        for t in [20, 30]
        for s in [50, 80]
        for e in [2]
        for v in [None, 0.18]
        for otm in [200, 300]
        for w in [150, 200]
    ],
    "bull_call_spread": [
        {"dte_min": d[0], "dte_max": d[1], "target_pct": t, "sl_pct": s, "exit_dte": e, "spread_width": w, "rsi_min": r}
        for d in [(2, 5), (3, 7)]
        for t in [30, 50, 70]
        for s in [30, 50]
        for e in [1, 2]
        for w in [100, 150]
        for r in [50, 55]
    ],
    "bear_put_spread": [
        {"dte_min": d[0], "dte_max": d[1], "target_pct": t, "sl_pct": s, "exit_dte": e, "spread_width": w, "rsi_max": r}
        for d in [(2, 5), (3, 7)]
        for t in [30, 50, 70]
        for s in [30, 50]
        for e in [1, 2]
        for w in [100, 150]
        for r in [45, 50]
    ],
    "deep_otm_sell": [
        {"dte_min": d[0], "dte_max": d[1], "target_pct": t, "sl_pct": s, "exit_dte": e, "vix_max": v, "otm_distance": otm, "min_premium": mp}
        for d in [(7, 14), (7, 10)]
        for t in [40, 60, 80]
        for s in [50, 80, 100]
        for e in [2]
        for v in [None, 0.18, 0.25]
        for otm in [300, 500, 700]
        for mp in [10, 20]
    ],
}

# ── Main ─────────────────────────────────────────────────────────────

def main():
    print("╔═══════════════════════════════════════════════════════════════════╗")
    print("║  F&O BACKTESTER — REAL Option Data (Breeze + NSE Bhav Copy)     ║")
    print("╚═══════════════════════════════════════════════════════════════════╝\n")

    ds = DataStore()
    print(f"Loaded {len(ds.spots)} spot days, {len(ds.indicators)} indicator days\n")

    all_results = {}

    for strat_name, entry_fn in STRATEGIES.items():
        grids = PARAM_GRIDS.get(strat_name, [{}])
        print(f"{'='*80}")
        print(f"  {strat_name.upper()} — {len(grids)} param combos × {len(PERIODS)} periods")
        print(f"{'='*80}")

        best_score = -float('inf')
        best_params = None
        best_result = None
        strat_results = []

        for pidx, params in enumerate(grids):
            # Run across all periods
            period_results = {}
            total_trades = 0
            total_pnl = 0
            total_wins = 0
            periods_profitable = 0

            for period_name, label, from_d, to_d, desc in PERIODS:
                result = run_backtest(ds, strat_name, entry_fn, params, from_d, to_d)
                period_results[period_name] = {
                    k: v for k, v in result.items() if k != "trades"
                }
                total_trades += result["total_trades"]
                total_pnl += result["total_return"]
                total_wins += result["winning_trades"]
                if result["total_return"] > 0:
                    periods_profitable += 1

            # Aggregate score
            win_rate = total_wins / total_trades * 100 if total_trades > 0 else 0
            return_pct = total_pnl / CAPITAL * 100
            max_dd = max((pr.get("max_drawdown_pct", 0) for pr in period_results.values()), default=0)

            score = return_pct * 0.3 + win_rate * 0.2 - max_dd * 0.2
            if periods_profitable >= len(PERIODS):
                score *= 1.2  # consistency bonus

            combo_result = {
                "params": params,
                "total_trades": total_trades,
                "total_pnl": round(total_pnl),
                "return_pct": round(return_pct, 2),
                "win_rate": round(win_rate, 1),
                "max_dd_pct": round(max_dd, 2),
                "periods_profitable": periods_profitable,
                "score": round(score, 2),
                "by_period": period_results,
            }
            strat_results.append(combo_result)

            if score > best_score:
                best_score = score
                best_params = params
                best_result = combo_result

            if (pidx + 1) % 10 == 0:
                sys.stdout.write(f"\r  {pidx+1}/{len(grids)} combos tested | Best so far: {best_score:.1f} score, {best_result['return_pct']:.1f}% return")
                sys.stdout.flush()

        print(f"\r  {len(grids)} combos tested")

        # Show best
        if best_result:
            print(f"\n  🏆 BEST: score={best_result['score']}, return={best_result['return_pct']}%, "
                  f"WR={best_result['win_rate']}%, DD={best_result['max_dd_pct']}%, "
                  f"trades={best_result['total_trades']}, profitable in {best_result['periods_profitable']}/{len(PERIODS)} periods")
            print(f"     Params: {best_params}")

            print(f"\n     Per-period breakdown:")
            for pname, label, _, _, desc in PERIODS:
                pr = best_result["by_period"].get(pname, {})
                tag = "✅" if pr.get("total_return", 0) > 0 else "❌"
                print(f"       {tag} {pname:12} ({desc:30}) | {pr.get('total_trades',0):3} trades | "
                      f"WR {pr.get('win_rate',0):5.1f}% | Return {pr.get('total_return_pct',0):7.2f}% | DD {pr.get('max_drawdown_pct',0):5.2f}%")

        # Sort and keep top 5
        strat_results.sort(key=lambda x: x["score"], reverse=True)
        all_results[strat_name] = {
            "best": strat_results[0] if strat_results else None,
            "top5": strat_results[:5],
            "total_combos_tested": len(grids),
        }

        print()

    # Save results
    with open(str(RESULTS_PATH), "w") as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"\nResults saved to {RESULTS_PATH}")

    # Final summary
    print(f"\n{'='*80}")
    print(f"  FINAL RANKING — Best param combo per strategy")
    print(f"{'='*80}")
    print(f"{'Strategy':22} {'Score':>7} {'Return%':>9} {'WR%':>6} {'MaxDD%':>8} {'Trades':>7} {'Consistent':>11}")
    print("-" * 80)

    ranked = sorted(all_results.items(), key=lambda x: x[1]["best"]["score"] if x[1]["best"] else -999, reverse=True)
    for strat, data in ranked:
        b = data["best"]
        if not b:
            continue
        consistent = f"{b['periods_profitable']}/{len(PERIODS)}"
        print(f"{strat:22} {b['score']:7.1f} {b['return_pct']:8.2f}% {b['win_rate']:5.1f}% {b['max_dd_pct']:7.2f}% {b['total_trades']:7} {consistent:>11}")

if __name__ == "__main__":
    main()
