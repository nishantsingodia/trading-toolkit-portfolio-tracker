"""
NSE Bhav Copy — Fill Missing Weekly Expiries
=============================================
Downloads daily F&O bhav copies from NSE archives for dates where
Breeze didn't have weekly expiry data. Extracts NIFTY option rows.
EOD data only (not 30-min), but fills the gaps.

Usage: python3 scripts/fetch-nse-bhavcopy.py
"""

import os, csv, io, sqlite3, zipfile, urllib.request, time, sys, concurrent.futures
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

PARALLEL_WORKERS = 50

DB_PATH = Path(__file__).parent.parent / "data" / "nifty-options-history.db"

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    'Accept': 'text/html,application/xhtml+xml',
    'Referer': 'https://www.nseindia.com/'
}

def fetch_bhavcopy(date):
    """Download and parse NSE F&O bhav copy for a given date. Returns NIFTY option rows."""
    mon = date.strftime('%b').upper()
    fname = f"fo{date.strftime('%d%b%Y').upper()}bhav.csv.zip"
    url = f"https://nsearchives.nseindia.com/content/historical/DERIVATIVES/{date.year}/{mon}/{fname}"

    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()

        zf = zipfile.ZipFile(io.BytesIO(data))
        csv_data = zf.read(zf.namelist()[0]).decode('utf-8')
        reader = csv.DictReader(io.StringIO(csv_data))

        nifty_opts = []
        for row in reader:
            if row.get('SYMBOL', '').strip() == 'NIFTY' and row.get('INSTRUMENT', '').strip() == 'OPTIDX':
                nifty_opts.append(row)

        return nifty_opts
    except Exception:
        return None

def parse_nse_date(date_str):
    """Parse '15-Jun-2023' → '2023-06-15'"""
    try:
        dt = datetime.strptime(date_str.strip(), '%d-%b-%Y')
        return dt.strftime('%Y-%m-%d')
    except:
        return None

def main():
    conn = sqlite3.connect(str(DB_PATH))

    # Get what we already have from Breeze
    breeze_expiries = set()
    for row in conn.execute("SELECT DISTINCT expiry FROM option_candles"):
        breeze_expiries.add(row[0])

    print(f"Already have {len(breeze_expiries)} expiries from Breeze")

    # Determine what weekly expiries SHOULD exist (2019-2023)
    # Weekly options on NIFTY started ~2019 — every Thursday
    print("\nScanning NSE bhav copies to find missing weekly expiries...")
    print("Checking one Thursday per week from 2019-2023...\n")

    # For each week, download the bhav copy for Thursday (expiry day)
    # and extract what expiries existed that day
    all_discovered_expiries = set()
    missing_expiries = set()

    d = datetime(2019, 1, 1)
    end = datetime(2023, 12, 31)
    days_checked = 0
    days_downloaded = 0

    # Only check Thursdays (expiry days) to discover expiries efficiently
    while d <= end:
        if d.weekday() == 3:  # Thursday
            ds = d.strftime('%Y-%m-%d')
            sys.stdout.write(f"\r  Checking {ds}...")
            sys.stdout.flush()

            rows = fetch_bhavcopy(d)
            days_checked += 1

            if rows is not None:
                days_downloaded += 1
                # Extract unique expiry dates from this bhav copy
                for row in rows:
                    exp = parse_nse_date(row.get('EXPIRY_DT', ''))
                    if exp and exp >= '2019-01-01' and exp <= '2023-12-31':
                        all_discovered_expiries.add(exp)
                        if exp not in breeze_expiries:
                            missing_expiries.add(exp)

            time.sleep(0.3)  # Be nice to NSE

        d += timedelta(days=1)

    print(f"\r  Checked {days_checked} Thursdays, downloaded {days_downloaded} bhav copies")
    print(f"  Discovered {len(all_discovered_expiries)} total expiries")
    print(f"  Missing from Breeze: {len(missing_expiries)}")

    if not missing_expiries:
        print("\nNo missing expiries! We have everything.")
        conn.close()
        return

    # Sort missing
    sorted_missing = sorted(missing_expiries)
    from collections import Counter
    years = Counter(e[:4] for e in sorted_missing)
    for y in sorted(years):
        print(f"    {y}: {years[y]} missing weekly expiries")

    # Now fetch full data for each missing expiry
    # For each missing expiry, we need bhav copies from expiry-30d to expiry
    print(f"\nFetching data for {len(sorted_missing)} missing expiries...")

    total_rows_inserted = 0

    for idx, exp in enumerate(sorted_missing):
        exp_date = datetime.strptime(exp, '%Y-%m-%d')

        # Fetch bhav copies for 30 days before expiry
        dates_to_fetch = []
        for days_back in range(30, -1, -1):
            check = exp_date - timedelta(days=days_back)
            if check.weekday() < 5:  # weekdays only
                dates_to_fetch.append(check)

        rows_for_expiry = 0
        sys.stdout.write(f"\r  [{idx+1}/{len(sorted_missing)}] Expiry {exp}: fetching {len(dates_to_fetch)} bhav copies (parallel)...")
        sys.stdout.flush()

        # Parallel fetch all bhav copies for this expiry
        with concurrent.futures.ThreadPoolExecutor(max_workers=PARALLEL_WORKERS) as executor:
            future_to_date = {executor.submit(fetch_bhavcopy, d): d for d in dates_to_fetch}
            for future in concurrent.futures.as_completed(future_to_date):
                fetch_date = future_to_date[future]
                try:
                    rows = future.result()
                except:
                    continue
                if rows is None:
                    continue

                date_str = fetch_date.strftime('%Y-%m-%d')

                for row in rows:
                    row_exp = parse_nse_date(row.get('EXPIRY_DT', ''))
                    if row_exp != exp:
                        continue

                    strike = int(float(row.get('STRIKE_PR', '0').strip()))
                    right = row.get('OPTION_TYP', '').strip()
                    if right not in ('CE', 'PE'):
                        continue

                    o = float(row.get('OPEN', '0').strip() or '0')
                    h = float(row.get('HIGH', '0').strip() or '0')
                    l = float(row.get('LOW', '0').strip() or '0')
                    c = float(row.get('CLOSE', '0').strip() or '0')
                    vol = int(float(row.get('CONTRACTS', '0').strip() or '0'))
                    oi = int(float(row.get('OPEN_INT', '0').strip() or '0'))

                    dt_str = f"{date_str} 15:30:00"
                    conn.execute(
                        """INSERT OR IGNORE INTO option_candles
                        (datetime, date, time, expiry, strike, right, open, high, low, close, volume, open_interest)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (dt_str, date_str, "15:30", exp, strike, right, o, h, l, c, vol, oi)
                    )
                    rows_for_expiry += 1
                    total_rows_inserted += 1

        conn.commit()

        # Mark in progress
        conn.execute(
            "INSERT OR REPLACE INTO fetch_progress (expiry, status, strikes_fetched, total_strikes, last_updated) VALUES (?,?,?,?,?)",
            (exp, "done", rows_for_expiry, rows_for_expiry, datetime.now().isoformat())
        )
        conn.commit()

        print(f"\r  [{idx+1}/{len(sorted_missing)}] Expiry {exp}: {rows_for_expiry} rows inserted")

    print(f"\n{'='*60}")
    print(f"  DONE! Inserted {total_rows_inserted} rows from NSE bhav copies")

    # Final summary
    total = conn.execute("SELECT COUNT(*) FROM option_candles").fetchone()[0]
    expiries = conn.execute("SELECT COUNT(DISTINCT expiry) FROM option_candles").fetchone()[0]
    date_range = conn.execute("SELECT MIN(date) || ' → ' || MAX(date) FROM option_candles").fetchone()[0]
    print(f"  Total rows: {total:,}")
    print(f"  Total expiries: {expiries}")
    print(f"  Date range: {date_range}")
    print(f"{'='*60}")

    conn.close()

if __name__ == "__main__":
    main()
