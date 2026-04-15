"""
ICICI Breeze — Historical BANKNIFTY Option Chain Pipeline
=========================================================
Fetches 3 years of BANKNIFTY weekly option chain data (30-min bars).
Stores in SQLite. Resumable across daily runs.

BANKNIFTY specifics vs NIFTY:
  - Strike interval: 100 (vs 50)
  - Weekly expiry: Wednesday (pre-Nov 2024), then monthly only
  - Stock code: CNXBAN (on Breeze)

Usage:
  python3 scripts/fetch-banknifty-history.py

Session token must be refreshed daily before running.
"""

import os
import sys
import sqlite3
import time
import json
import concurrent.futures
from datetime import datetime, timedelta
from pathlib import Path

PARALLEL_WORKERS = 10
STRIKE_INTERVAL = 100  # BANKNIFTY uses 100-pt strikes

# ── Load Credentials ─────────────────────────────────────────────────

def load_env():
    env_path = Path(__file__).parent.parent / ".env.breeze"
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip()

    dev_vars = Path(__file__).parent.parent.parent / ".dev.vars"
    if dev_vars.exists():
        with open(dev_vars) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip()

# ── Database Setup ───────────────────────────────────────────────────

DB_PATH = Path(__file__).parent.parent / "data" / "banknifty-options-history.db"

def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS option_candles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        datetime TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        expiry TEXT NOT NULL,
        strike INTEGER NOT NULL,
        right TEXT NOT NULL,
        open REAL, high REAL, low REAL, close REAL,
        volume INTEGER,
        open_interest INTEGER,
        UNIQUE(datetime, expiry, strike, right)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS spot_candles (
        date TEXT PRIMARY KEY,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS fetch_progress (
        expiry TEXT PRIMARY KEY,
        status TEXT,
        strikes_fetched INTEGER,
        total_strikes INTEGER,
        api_calls_used INTEGER DEFAULT 0,
        last_updated TEXT
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_opt_date_expiry ON option_candles(date, expiry)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_opt_expiry_strike ON option_candles(expiry, strike, right)")
    conn.commit()
    return conn

# ── Spot Data from Breeze ───────────────────────────────────────────

def fetch_spot_from_breeze(conn, breeze):
    """Fetch 3 years of daily BANKNIFTY spot candles from Breeze."""
    existing = conn.execute("SELECT COUNT(*) FROM spot_candles").fetchone()[0]
    if existing > 500:
        print(f"  Spot candles already cached: {existing} rows")
        return 0

    print("  Fetching BANKNIFTY spot candles from Breeze...")
    total = 0
    api_calls = 0

    for year in range(2023, 2027):
        from_d = f"{year}-01-01T00:00:00.000Z"
        to_d = f"{year}-12-31T23:59:59.000Z" if year < 2026 else "2026-03-31T23:59:59.000Z"
        try:
            data = breeze.get_historical_data_v2(
                interval="1day",
                from_date=from_d,
                to_date=to_d,
                stock_code="CNXBAN",
                exchange_code="NSE",
                product_type="cash"
            )
            api_calls += 1
            records = data.get("Success", [])
            for r in records:
                date_str = r.get("datetime", "")[:10]
                conn.execute(
                    "INSERT OR IGNORE INTO spot_candles (date, open, high, low, close, volume) VALUES (?,?,?,?,?,?)",
                    (date_str, r.get("open"), r.get("high"), r.get("low"), r.get("close"), r.get("volume", 0))
                )
            total += len(records)
            print(f"    {year}: {len(records)} candles")
        except Exception as e:
            print(f"    {year}: error — {e}")
        time.sleep(0.6)

    conn.commit()
    print(f"  Total spot candles: {total} ({api_calls} API calls)")
    return api_calls

# ── Expiry Date Generation ───────────────────────────────────────────

NSE_HOLIDAYS = {
    "2023-01-26","2023-03-07","2023-03-30","2023-04-04","2023-04-07","2023-04-14","2023-04-22",
    "2023-05-01","2023-06-28","2023-06-29","2023-08-15","2023-09-19","2023-10-02","2023-10-24",
    "2023-11-14","2023-11-27","2023-12-25",
    "2024-01-26","2024-03-08","2024-03-25","2024-03-29","2024-04-11","2024-04-14","2024-04-17",
    "2024-04-21","2024-05-01","2024-05-23","2024-06-17","2024-07-17","2024-08-15","2024-09-16",
    "2024-10-02","2024-10-12","2024-11-01","2024-11-15","2024-11-20","2024-12-25",
    "2025-02-26","2025-03-14","2025-03-31","2025-04-10","2025-04-14","2025-04-18","2025-05-01",
    "2025-05-12","2025-06-26","2025-08-15","2025-08-16","2025-08-27","2025-10-02","2025-10-21",
    "2025-10-22","2025-11-05","2025-11-26","2025-12-25",
    "2026-01-26","2026-02-17","2026-03-10","2026-03-20","2026-04-03","2026-04-14","2026-05-01",
    "2026-05-25","2026-07-10","2026-08-15","2026-08-17","2026-10-02","2026-10-20","2026-10-21",
    "2026-11-09","2026-11-16","2026-12-25",
}

def is_trading_day(d):
    ds = d.strftime("%Y-%m-%d")
    return d.weekday() < 5 and ds not in NSE_HOLIDAYS

def get_weekly_expiries(from_date, to_date):
    """Generate all BANKNIFTY weekly expiry dates.
    Pre-Nov 2024: Wednesday. Post-Nov 2024: monthly only (last Thursday)."""
    expiries = []
    cutoff = datetime(2024, 11, 20)  # SEBI change

    d = from_date
    while d <= min(to_date, cutoff - timedelta(days=1)):
        if d.weekday() == 2:  # Wednesday
            exp = d
            while not is_trading_day(exp):
                exp -= timedelta(days=1)
            expiries.append(exp)
        d += timedelta(days=1)

    # Post-SEBI: only monthly expiry (last Thursday of each month)
    if to_date >= cutoff:
        start_month = cutoff.replace(day=1)
        while start_month <= to_date:
            # Find last Thursday of this month
            if start_month.month == 12:
                next_month = start_month.replace(year=start_month.year + 1, month=1)
            else:
                next_month = start_month.replace(month=start_month.month + 1)
            last_day = next_month - timedelta(days=1)
            # Walk back to Thursday
            while last_day.weekday() != 3:  # Thursday
                last_day -= timedelta(days=1)
            # Resolve holidays
            exp = last_day
            while not is_trading_day(exp):
                exp -= timedelta(days=1)
            if from_date <= exp <= to_date:
                expiries.append(exp)
            start_month = next_month

    # Deduplicate
    seen = set()
    unique = []
    for e in expiries:
        key = e.strftime("%Y-%m-%d")
        if key not in seen:
            seen.add(key)
            unique.append(e)
    return sorted(unique, reverse=True)  # newest first

# ── ATM Calculation ──────────────────────────────────────────────────

def get_atm_range(conn, expiry_date):
    """Get ATM strikes at multiple points before expiry."""
    points = [30, 21, 14, 7, 3, 0]
    atms = []
    for days_before in points:
        check_date = (expiry_date - timedelta(days=days_before)).strftime("%Y-%m-%d")
        row = conn.execute(
            "SELECT close FROM spot_candles WHERE date <= ? ORDER BY date DESC LIMIT 1",
            (check_date,)
        ).fetchone()
        if row:
            atm = round(row[0] / STRIKE_INTERVAL) * STRIKE_INTERVAL
            atms.append(atm)

    if not atms:
        return None, None
    return min(atms), max(atms)

# ── Main Pipeline ────────────────────────────────────────────────────

def main():
    load_env()

    print("╔═══════════════════════════════════════════════════════════════╗")
    print("║  BANKNIFTY Historical Option Chain — ICICI Breeze Pipeline   ║")
    print("║  30-min bars, ±30 strikes (100-pt interval), 30-day window   ║")
    print("╚═══════════════════════════════════════════════════════════════╝\n")

    api_key = os.environ.get("ICICI_API_KEY", "")
    api_secret = os.environ.get("ICICI_API_SECRET", "")
    session_token = os.environ.get("ICICI_SESSION_TOKEN", "")
    if not api_key or not api_secret or not session_token:
        print("Missing ICICI credentials in .env.breeze")
        return

    print("1. Connecting to Breeze API...")
    from breeze_connect import BreezeConnect
    breeze = BreezeConnect(api_key=api_key)
    try:
        breeze.generate_session(api_secret=api_secret, session_token=session_token)
        print("   Connected\n")
    except Exception as e:
        print(f"   {e}")
        print("   Generate a fresh session token and update .env.breeze")
        return

    print("2. Initializing database...")
    conn = init_db()
    print(f"   DB: {DB_PATH}\n")

    print("3. Spot candles...")
    spot_calls = fetch_spot_from_breeze(conn, breeze) or 0
    api_calls_today = spot_calls

    print("\n4. Generating BANKNIFTY expiry dates...")
    from_date = datetime(2023, 1, 1)
    today = datetime.now()
    yesterday = today - timedelta(days=1)
    all_expiries = get_weekly_expiries(from_date, yesterday)
    print(f"   {len(all_expiries)} expiries from {all_expiries[-1].strftime('%Y-%m-%d')} to {all_expiries[0].strftime('%Y-%m-%d')}")

    # Check progress
    done_rows = conn.execute("SELECT expiry FROM fetch_progress WHERE status = 'done'").fetchall()
    done_set = set(r[0] for r in done_rows)
    remaining = [e for e in all_expiries if e.strftime("%Y-%m-%d") not in done_set]
    remaining.sort()  # oldest first
    print(f"   Already done: {len(done_set)}, Remaining: {len(remaining)}\n")

    if not remaining:
        print("   All expiries already fetched!")
        print_summary(conn)
        return

    print("5. Fetching option chain data...")
    MAX_DAILY_CALLS = 999999

    for idx, expiry in enumerate(remaining):
        exp_str = expiry.strftime("%Y-%m-%d")

        if api_calls_today >= MAX_DAILY_CALLS:
            print(f"\n   Daily limit approaching ({api_calls_today} calls). Run again tomorrow.")
            break

        min_atm, max_atm = get_atm_range(conn, expiry)
        if min_atm is None:
            print(f"   {exp_str}: No spot data available — skipping")
            conn.execute(
                "INSERT OR REPLACE INTO fetch_progress (expiry, status, strikes_fetched, total_strikes, last_updated) VALUES (?,?,?,?,?)",
                (exp_str, "done", 0, 0, datetime.now().isoformat())
            )
            conn.commit()
            continue

        # Generate strikes: ATM ± 30 strikes at 100-pt intervals
        strike_low = min_atm - 30 * STRIKE_INTERVAL
        strike_high = max_atm + 30 * STRIKE_INTERVAL
        all_strikes = list(range(strike_low, strike_high + 1, STRIKE_INTERVAL))

        from_dt = expiry - timedelta(days=30)
        from_str = from_dt.strftime("%Y-%m-%dT09:15:00.000Z")
        to_str = expiry.strftime("%Y-%m-%dT15:30:00.000Z")
        exp_breeze = expiry.strftime("%Y-%m-%dT07:00:00.000Z")

        mid_atm = (min_atm + max_atm) // 2
        mid_atm = round(mid_atm / STRIKE_INTERVAL) * STRIKE_INTERVAL
        all_strikes_sorted = sorted(all_strikes, key=lambda s: abs(s - mid_atm))

        total_calls = len(all_strikes_sorted) * 2
        completed = 0
        rows_inserted = 0
        ATM_EMPTY_THRESHOLD = 20

        print(f"\n   [{idx+1}/{len(remaining)}] Expiry {exp_str} | ATM range {min_atm}-{max_atm} | {len(all_strikes_sorted)} strikes x 2 = {total_calls} calls")

        jobs = []
        for strike in all_strikes_sorted:
            for right in ["call", "put"]:
                jobs.append((strike, right))

        def fetch_one(job):
            strike, right = job
            try:
                data = breeze.get_historical_data_v2(
                    interval="30minute",
                    from_date=from_str,
                    to_date=to_str,
                    stock_code="CNXBAN",
                    exchange_code="NFO",
                    product_type="options",
                    expiry_date=exp_breeze,
                    right=right,
                    strike_price=str(strike)
                )
                return (strike, right, data.get("Success", []))
            except:
                return (strike, right, [])

        # Test ATM strikes first
        atm_jobs = jobs[:ATM_EMPTY_THRESHOLD]
        atm_empty = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=PARALLEL_WORKERS) as ex:
            for strike, right, records in ex.map(fetch_one, atm_jobs):
                api_calls_today += 1
                completed += 1
                if len(records) == 0:
                    atm_empty += 1

        if atm_empty >= ATM_EMPTY_THRESHOLD:
            print(f"     No data for ATM strikes — skipping this expiry")
        else:
            all_jobs = jobs
            batch_size = PARALLEL_WORKERS * 5
            for batch_start in range(0, len(all_jobs), batch_size):
                batch = all_jobs[batch_start:batch_start + batch_size]
                with concurrent.futures.ThreadPoolExecutor(max_workers=PARALLEL_WORKERS) as ex:
                    results = list(ex.map(fetch_one, batch))

                for strike, right, records in results:
                    api_calls_today += 1
                    completed += 1
                    right_code = "CE" if right == "call" else "PE"

                    for r in records:
                        dt_str = r.get("datetime", "")
                        date_part = dt_str[:10] if dt_str else ""
                        time_part = dt_str[11:16] if len(dt_str) > 16 else ""
                        conn.execute(
                            """INSERT OR IGNORE INTO option_candles
                            (datetime, date, time, expiry, strike, right, open, high, low, close, volume, open_interest)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                            (dt_str, date_part, time_part, exp_str, strike, right_code,
                             r.get("open"), r.get("high"), r.get("low"), r.get("close"),
                             r.get("volume"), r.get("open_interest"))
                        )
                        rows_inserted += 1

                pct = min(completed, total_calls) / total_calls * 100
                sys.stdout.write(f"\r     {min(completed, total_calls)}/{total_calls} ({pct:.0f}%) | {rows_inserted} rows | {api_calls_today} API calls today")
                sys.stdout.flush()

        conn.execute(
            "INSERT OR REPLACE INTO fetch_progress (expiry, status, strikes_fetched, total_strikes, api_calls_used, last_updated) VALUES (?,?,?,?,?,?)",
            (exp_str, "done", completed, total_calls, api_calls_today, datetime.now().isoformat())
        )
        conn.commit()
        print(f"\r     Done: {completed}/{total_calls} calls, {rows_inserted} rows inserted")

    print_summary(conn)

def print_summary(conn):
    total = conn.execute("SELECT COUNT(*) FROM option_candles").fetchone()[0]
    expiries_done = conn.execute("SELECT COUNT(*) FROM fetch_progress WHERE status = 'done'").fetchone()[0]
    expiries_partial = conn.execute("SELECT COUNT(*) FROM fetch_progress WHERE status = 'partial'").fetchone()[0]
    date_range = conn.execute("SELECT MIN(date), MAX(date) FROM option_candles").fetchone()
    spot_count = conn.execute("SELECT COUNT(*) FROM spot_candles").fetchone()[0]

    print(f"\n{'='*60}")
    print(f"  BANKNIFTY SUMMARY")
    print(f"{'='*60}")
    print(f"  Option candle rows:  {total:,}")
    print(f"  Spot candle rows:    {spot_count:,}")
    print(f"  Expiries done:       {expiries_done}")
    print(f"  Expiries partial:    {expiries_partial}")
    if date_range[0]:
        print(f"  Date range:          {date_range[0]} -> {date_range[1]}")
    print(f"  DB size:             {DB_PATH.stat().st_size / 1024 / 1024:.1f} MB")
    print(f"{'='*60}")

if __name__ == "__main__":
    main()
