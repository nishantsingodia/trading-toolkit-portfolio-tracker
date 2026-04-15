"""Scan ALL weekdays 2016-2022 for Nifty option expiry data — 100 threads."""
import os, concurrent.futures
from datetime import datetime, timedelta
from pathlib import Path

with open(Path(__file__).parent.parent / ".env.breeze") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ[k.strip()] = v.strip()

from breeze_connect import BreezeConnect

breeze = BreezeConnect(api_key=os.environ["ICICI_API_KEY"])
breeze.generate_session(api_secret=os.environ["ICICI_API_SECRET"], session_token=os.environ["ICICI_SESSION_TOKEN"])

atm_by_year = {2016:8000, 2017:9500, 2018:10500, 2019:11500, 2020:11000, 2021:15000, 2022:17000}

def test_date(d):
    ds = d.strftime("%Y-%m-%d")
    atm = atm_by_year.get(d.year, 12000)
    exp = d.strftime("%Y-%m-%dT07:00:00.000Z")
    from_d = (d - timedelta(days=5)).strftime("%Y-%m-%dT00:00:00.000Z")
    to_d = d.strftime("%Y-%m-%dT23:59:59.000Z")
    try:
        data = breeze.get_historical_data_v2(
            interval="1day", from_date=from_d, to_date=to_d,
            stock_code="NIFTY", exchange_code="NFO", product_type="options",
            expiry_date=exp, right="call", strike_price=str(atm)
        )
        n = len(data.get("Success", []))
        if n > 0:
            return (ds, d.strftime("%A"), n)
    except:
        pass
    return None

# ALL weekdays 2016-2022
all_days = []
d = datetime(2016, 1, 1)
end = datetime(2022, 12, 31)
while d <= end:
    if d.weekday() < 5:
        all_days.append(d)
    d += timedelta(days=1)

print(f"Scanning {len(all_days)} weekdays from 2016-2022 (100 threads)...")

found = []
with concurrent.futures.ThreadPoolExecutor(max_workers=100) as ex:
    results = list(ex.map(test_date, all_days))

for r in results:
    if r:
        found.append(r)

print(f"\nFound {len(found)} expiry dates!")
from collections import Counter
years = Counter(d[0][:4] for d in found)
for y in sorted(years):
    print(f"  {y}: {years[y]} expiries")

print(f"\nAll dates:")
for ds, day, n in found:
    print(f"  {ds} ({day}) — {n} rows")
