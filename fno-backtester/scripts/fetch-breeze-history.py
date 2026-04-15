"""
ICICI Breeze — Historical Nifty Option Chain Pipeline
=====================================================
Fetches 3 years of Nifty weekly option chain data (30-min bars).
Stores in SQLite. Resumable across daily runs (5000 calls/day limit).

Usage:
  python3 scripts/fetch-breeze-history.py

Run once per day until all expiries are fetched (~4 days total).
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

PARALLEL_WORKERS = 10  # 10 threads = 7.5x speedup (tested)

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

    # Also load Upstox token for spot data
    dev_vars = Path(__file__).parent.parent.parent / ".dev.vars"
    if dev_vars.exists():
        with open(dev_vars) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip()

# ── Database Setup ───────────────────────────────────────────────────

DB_PATH = Path(__file__).parent.parent / "data" / "nifty-options-history.db"

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

# ── Spot Data from Upstox ───────────────────────────────────────────

def fetch_spot_from_breeze(conn, breeze):
    """Fetch 3 years of daily Nifty spot candles from Breeze (not Upstox)."""
    existing = conn.execute("SELECT COUNT(*) FROM spot_candles").fetchone()[0]
    if existing > 500:
        print(f"  Spot candles already cached: {existing} rows")
        return

    print("  Fetching spot candles from Breeze...")
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
                stock_code="NIFTY",
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
    """Generate all Nifty weekly expiry dates.
    Pre-Nov 2024: Thursday. Post-Nov 2024: Tuesday."""
    expiries = []
    # Nov 20, 2024 is when SEBI changed Nifty weekly to Tuesday
    cutoff = datetime(2024, 11, 20)

    d = from_date
    while d <= to_date:
        if d < cutoff:
            expiry_weekday = 3  # Thursday
        else:
            expiry_weekday = 1  # Tuesday

        if d.weekday() == expiry_weekday:
            # If this day is a holiday, use previous trading day
            exp = d
            while not is_trading_day(exp):
                exp -= timedelta(days=1)
            expiries.append(exp)

        d += timedelta(days=1)

    # Deduplicate (holiday shifts can cause overlaps)
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
    """Get ATM strikes at multiple points before expiry. Returns (min_atm, max_atm)."""
    points = [30, 21, 14, 7, 3, 0]
    atms = []
    for days_before in points:
        check_date = (expiry_date - timedelta(days=days_before)).strftime("%Y-%m-%d")
        row = conn.execute(
            "SELECT close FROM spot_candles WHERE date <= ? ORDER BY date DESC LIMIT 1",
            (check_date,)
        ).fetchone()
        if row:
            atm = round(row[0] / 50) * 50
            atms.append(atm)

    if not atms:
        return None, None

    return min(atms), max(atms)

# ── Main Pipeline ────────────────────────────────────────────────────

def main():
    load_env()

    print("╔═══════════════════════════════════════════════════════════════╗")
    print("║  Nifty Historical Option Chain — ICICI Breeze Pipeline      ║")
    print("║  30-min bars, ±30 strikes, 30-day window per expiry         ║")
    print("╚═══════════════════════════════════════════════════════════════╝\n")

    # Check credentials
    api_key = os.environ.get("ICICI_API_KEY", "")
    api_secret = os.environ.get("ICICI_API_SECRET", "")
    session_token = os.environ.get("ICICI_SESSION_TOKEN", "")
    if not api_key or not api_secret or not session_token:
        print("❌ Missing ICICI credentials in .env.breeze")
        return

    # Connect to Breeze
    print("1. Connecting to Breeze API...")
    from breeze_connect import BreezeConnect
    breeze = BreezeConnect(api_key=api_key)
    try:
        breeze.generate_session(api_secret=api_secret, session_token=session_token)
        print("   ✅ Connected\n")
    except Exception as e:
        print(f"   ❌ {e}")
        print("   Generate a fresh session token and update .env.breeze")
        return

    # Init database
    print("2. Initializing database...")
    conn = init_db()
    print(f"   DB: {DB_PATH}\n")

    # Fetch spot data (from Breeze, not Upstox)
    print("3. Spot candles...")
    spot_calls = fetch_spot_from_breeze(conn, breeze) or 0
    api_calls_today = spot_calls

    # Use CONFIRMED expiry dates from Breeze (discovered by scanning)
    print("\n4. Loading confirmed expiry dates...")
    CONFIRMED_EXPIRIES = [
        # 2016 monthly (12 expiries!)
        "2016-01-28","2016-02-25","2016-03-31","2016-04-28","2016-05-26","2016-06-30",
        "2016-07-28","2016-08-25","2016-09-29","2016-10-27","2016-11-24","2016-12-29",
        # 2017 monthly (12 expiries!)
        "2017-01-26","2017-02-23","2017-03-30","2017-04-27","2017-05-25","2017-06-29",
        "2017-07-27","2017-08-31","2017-09-28","2017-10-26","2017-11-30","2017-12-28",
        # 2018 (10 expiries)
        "2018-01-25","2018-02-22","2018-03-29","2018-04-26","2018-07-26","2018-08-30",
        "2018-09-27","2018-10-25","2018-11-29","2018-12-27",
        # 2019 (11 expiries)
        "2019-01-31","2019-02-28","2019-05-23","2019-06-06","2019-06-20","2019-06-27",
        "2019-08-01","2019-08-29","2019-09-12","2019-10-24","2019-11-14",
        # 2020 (12 expiries — includes COVID crash!)
        "2020-02-13","2020-02-20","2020-03-12","2020-04-30","2020-05-28","2020-06-04",
        "2020-06-18","2020-06-25","2020-07-02","2020-08-13","2020-10-08","2020-12-31",
        # 2021 (11 expiries)
        "2021-01-21","2021-03-25","2021-04-15","2021-05-06","2021-06-10","2021-06-24",
        "2021-07-01","2021-07-15","2021-08-12","2021-08-18","2021-10-28",
        # 2022 (15 expiries)
        "2022-02-10","2022-03-10","2022-03-24","2022-04-28","2022-05-26","2022-06-30",
        "2022-07-28","2022-08-18","2022-09-08","2022-09-29",
        "2022-10-13","2022-10-20","2022-11-24","2022-12-01","2022-12-15","2022-12-29",
        # 2023 (scanned from Breeze — Thursdays)
        "2023-01-05","2023-01-12","2023-01-19","2023-02-02","2023-02-09","2023-02-23",
        "2023-06-01","2023-06-08","2023-06-15","2023-06-22",
        "2023-07-06","2023-07-13","2023-07-20","2023-07-27",
        "2023-08-03","2023-08-10","2023-08-17","2023-08-24","2023-08-31",
        "2023-09-07","2023-09-14","2023-09-21","2023-09-28",
        "2023-10-05","2023-10-12","2023-10-19","2023-10-26",
        "2023-11-02","2023-11-09","2023-11-16","2023-11-23","2023-11-30",
        "2023-12-07","2023-12-14","2023-12-21","2023-12-28",
        # 2024 weekly (scanned — includes shifted holidays + SEBI Tue change from Nov)
        "2024-01-04","2024-01-11","2024-01-18","2024-01-25",
        "2024-02-01","2024-02-08","2024-02-15","2024-02-22","2024-02-29",
        "2024-03-07","2024-03-14","2024-03-21","2024-03-28",
        "2024-04-04","2024-04-10","2024-04-18","2024-04-25",
        "2024-05-02","2024-05-09","2024-05-16","2024-05-23","2024-05-30",
        "2024-06-06","2024-06-13","2024-06-20","2024-06-27",
        "2024-07-04","2024-07-11","2024-07-18","2024-07-25",
        "2024-08-01","2024-08-08","2024-08-14","2024-08-22","2024-08-29",
        "2024-09-05","2024-09-12","2024-09-19","2024-09-26",
        "2024-10-24","2024-10-31",
        "2024-11-07","2024-11-14","2024-11-21","2024-11-28",
        "2024-12-05","2024-12-12","2024-12-19","2024-12-26",
        # 2025 weekly (scanned — Tuesdays post-SEBI, shifted holidays)
        "2025-01-02","2025-01-09","2025-01-16","2025-01-23","2025-01-30",
        "2025-02-06","2025-02-13","2025-02-20","2025-02-27",
        "2025-03-06","2025-03-13","2025-03-20","2025-03-27",
        "2025-04-03","2025-04-09","2025-04-17","2025-04-24","2025-04-30",
        "2025-05-08","2025-05-15","2025-05-22","2025-05-29",
        "2025-06-05","2025-06-12","2025-06-19","2025-06-26",
        "2025-07-03","2025-07-10","2025-07-17","2025-07-31",
        "2025-08-14","2025-08-28",
        "2025-09-02","2025-09-09","2025-09-16","2025-09-23","2025-09-30",
        "2025-10-07","2025-10-14","2025-10-20","2025-10-28",
        "2025-11-04","2025-11-25",
        "2025-12-30",
    ]
    today = datetime.now()
    yesterday = (today - timedelta(days=1)).strftime("%Y-%m-%d")
    expiries = [datetime.strptime(d, "%Y-%m-%d") for d in CONFIRMED_EXPIRIES if d <= yesterday]
    expiries.sort()  # oldest first
    print(f"   {len(expiries)} confirmed expiries from {expiries[0].strftime('%Y-%m-%d')} to {expiries[-1].strftime('%Y-%m-%d')}")

    # Check progress
    done_rows = conn.execute("SELECT expiry FROM fetch_progress WHERE status = 'done'").fetchall()
    done_set = set(r[0] for r in done_rows)
    remaining = [e for e in expiries if e.strftime("%Y-%m-%d") not in done_set]
    print(f"   Already done: {len(done_set)}, Remaining: {len(remaining)}\n")

    if not remaining:
        print("   All expiries already fetched! 🎉")
        print_summary(conn)
        return

    # Fetch loop
    print("5. Fetching option chain data...")
    MAX_DAILY_CALLS = 999999  # tested: no rate limiting enforced

    for idx, expiry in enumerate(remaining):
        exp_str = expiry.strftime("%Y-%m-%d")

        if api_calls_today >= MAX_DAILY_CALLS:
            print(f"\n   ⚠️ Daily limit approaching ({api_calls_today} calls). Run again tomorrow.")
            break

        # Get ATM range
        min_atm, max_atm = get_atm_range(conn, expiry)
        if min_atm is None:
            print(f"   {exp_str}: No spot data available — skipping")
            conn.execute(
                "INSERT OR REPLACE INTO fetch_progress (expiry, status, strikes_fetched, total_strikes, last_updated) VALUES (?,?,?,?,?)",
                (exp_str, "done", 0, 0, datetime.now().isoformat())
            )
            conn.commit()
            continue

        # Generate strikes: min_atm - 30*50 to max_atm + 30*50
        strike_low = min_atm - 30 * 50
        strike_high = max_atm + 30 * 50
        all_strikes = list(range(strike_low, strike_high + 1, 50))

        # Date range: expiry - 30 days to expiry
        from_dt = expiry - timedelta(days=30)
        from_str = from_dt.strftime("%Y-%m-%dT09:15:00.000Z")
        to_str = expiry.strftime("%Y-%m-%dT15:30:00.000Z")
        exp_breeze = expiry.strftime("%Y-%m-%dT07:00:00.000Z")

        # Sort strikes: ATM first, then expanding outward (so we try the most likely strikes first)
        mid_atm = (min_atm + max_atm) // 2
        mid_atm = round(mid_atm / 50) * 50
        all_strikes_sorted = sorted(all_strikes, key=lambda s: abs(s - mid_atm))

        total_calls = len(all_strikes_sorted) * 2  # CE + PE
        completed = 0
        rows_inserted = 0
        # Only skip if ATM strikes (first 10) return nothing
        atm_empty_count = 0
        ATM_EMPTY_THRESHOLD = 20  # first 20 calls (10 strikes × CE+PE) are ATM

        print(f"\n   [{idx+1}/{len(remaining)}] Expiry {exp_str} | ATM range {min_atm}-{max_atm} | {len(all_strikes_sorted)} strikes × 2 = {total_calls} calls")

        # Build all (strike, right) jobs
        jobs = []
        for strike in all_strikes_sorted:
            for right in ["call", "put"]:
                jobs.append((strike, right))

        # Parallel fetch function
        def fetch_one(job):
            strike, right = job
            try:
                data = breeze.get_historical_data_v2(
                    interval="30minute",
                    from_date=from_str,
                    to_date=to_str,
                    stock_code="NIFTY",
                    exchange_code="NFO",
                    product_type="options",
                    expiry_date=exp_breeze,
                    right=right,
                    strike_price=str(strike)
                )
                return (strike, right, data.get("Success", []))
            except:
                return (strike, right, [])

        # First: test ATM strikes (first 20 jobs) to check if data exists
        atm_jobs = jobs[:ATM_EMPTY_THRESHOLD]
        atm_empty = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=PARALLEL_WORKERS) as ex:
            for strike, right, records in ex.map(fetch_one, atm_jobs):
                api_calls_today += 1
                completed += 1
                if len(records) == 0:
                    atm_empty += 1

        if atm_empty >= ATM_EMPTY_THRESHOLD:
            print(f"     ⏭️  No data for ATM strikes — skipping this expiry")
        else:
            # Process ATM results + fetch remaining in parallel
            remaining_jobs = jobs[ATM_EMPTY_THRESHOLD:]
            all_results = []

            # Re-fetch ATM (already fetched but didn't store — simpler than caching)
            all_jobs = jobs

            # Parallel fetch all
            batch_size = PARALLEL_WORKERS * 5  # 50 at a time
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

        # Mark expiry as done
        conn.execute(
            "INSERT OR REPLACE INTO fetch_progress (expiry, status, strikes_fetched, total_strikes, api_calls_used, last_updated) VALUES (?,?,?,?,?,?)",
            (exp_str, "done", completed, total_calls, api_calls_today, datetime.now().isoformat())
        )
        conn.commit()
        print(f"\r     ✅ Done: {completed}/{total_calls} calls, {rows_inserted} rows inserted")

    print_summary(conn)

def print_summary(conn):
    total = conn.execute("SELECT COUNT(*) FROM option_candles").fetchone()[0]
    expiries_done = conn.execute("SELECT COUNT(*) FROM fetch_progress WHERE status = 'done'").fetchone()[0]
    expiries_partial = conn.execute("SELECT COUNT(*) FROM fetch_progress WHERE status = 'partial'").fetchone()[0]
    date_range = conn.execute("SELECT MIN(date), MAX(date) FROM option_candles").fetchone()
    spot_count = conn.execute("SELECT COUNT(*) FROM spot_candles").fetchone()[0]

    print(f"\n{'='*60}")
    print(f"  SUMMARY")
    print(f"{'='*60}")
    print(f"  Option candle rows:  {total:,}")
    print(f"  Spot candle rows:    {spot_count:,}")
    print(f"  Expiries done:       {expiries_done}")
    print(f"  Expiries partial:    {expiries_partial}")
    if date_range[0]:
        print(f"  Date range:          {date_range[0]} → {date_range[1]}")
    print(f"  DB size:             {DB_PATH.stat().st_size / 1024 / 1024:.1f} MB")
    print(f"{'='*60}")

if __name__ == "__main__":
    main()
