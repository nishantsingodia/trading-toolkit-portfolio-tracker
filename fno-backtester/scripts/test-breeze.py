"""
ICICI Breeze API — Historical Option Chain Test
================================================
Tests if we can fetch REAL historical Nifty option chain data.

Setup:
  1. Go to https://api.icicidirect.com → register for API access
  2. Get your API Key and API Secret
  3. Generate a Session Token (daily)
  4. Set them below or in environment variables

Usage:
  python3 scripts/test-breeze.py
"""

import os
import json
from datetime import datetime, timedelta

# ── Load credentials from .env.breeze file ────────────────────────────
env_path = os.path.join(os.path.dirname(__file__), "..", ".env.breeze")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ[key.strip()] = val.strip()

API_KEY = os.environ.get("ICICI_API_KEY", "YOUR_API_KEY_HERE")
API_SECRET = os.environ.get("ICICI_API_SECRET", "YOUR_API_SECRET_HERE")
SESSION_TOKEN = os.environ.get("ICICI_SESSION_TOKEN", "YOUR_SESSION_TOKEN_HERE")

def main():
    # Check credentials
    if "YOUR_" in API_KEY or "YOUR_" in API_SECRET or "YOUR_" in SESSION_TOKEN:
        print("❌ Please set your ICICI Direct API credentials!")
        print()
        print("Option 1: Set environment variables:")
        print("  export ICICI_API_KEY='your_key'")
        print("  export ICICI_API_SECRET='your_secret'")
        print("  export ICICI_SESSION_TOKEN='your_token'")
        print()
        print("Option 2: Edit this file and replace the placeholder values")
        print()
        print("Get credentials from: https://api.icicidirect.com")
        return

    print("=" * 60)
    print("  ICICI Breeze API — Historical Option Chain Test")
    print("=" * 60)

    # Connect
    print("\n1. Connecting to Breeze API...")
    try:
        from breeze_connect import BreezeConnect
        breeze = BreezeConnect(api_key=API_KEY)
        breeze.generate_session(api_secret=API_SECRET, session_token=SESSION_TOKEN)
        print("   ✅ Connected successfully!")
    except Exception as e:
        print(f"   ❌ Connection failed: {e}")
        return

    # Test 1: Fetch recent Nifty option data (last week)
    print("\n2. Fetching recent Nifty 22000 CE (last week)...")
    try:
        today = datetime.now()
        week_ago = today - timedelta(days=7)

        # Find a recent Thursday for expiry
        expiry = today
        while expiry.weekday() != 3:  # Thursday
            expiry -= timedelta(days=1)

        data = breeze.get_historical_data_v2(
            interval="1day",
            from_date=week_ago.strftime("%Y-%m-%dT00:00:00.000Z"),
            to_date=today.strftime("%Y-%m-%dT23:59:59.000Z"),
            stock_code="NIFTY",
            exchange_code="NFO",
            product_type="options",
            expiry_date=expiry.strftime("%Y-%m-%dT00:00:00.000Z"),
            right="call",
            strike_price="22000"
        )

        if data and "Success" in str(data.get("Status", "")):
            records = data.get("Success", [])
            print(f"   ✅ Got {len(records)} records!")
            if records:
                print("\n   Sample record:")
                print(f"   {json.dumps(records[0], indent=4, default=str)}")

                # Check what fields we get
                fields = list(records[0].keys()) if records else []
                print(f"\n   Available fields: {fields}")

                has_oi = any("oi" in f.lower() or "open_interest" in f.lower() for f in fields)
                has_volume = any("volume" in f.lower() for f in fields)
                print(f"\n   Has OI: {'✅' if has_oi else '❌'}")
                print(f"   Has Volume: {'✅' if has_volume else '❌'}")
        else:
            print(f"   ⚠️ Response: {json.dumps(data, indent=2, default=str)[:500]}")
    except Exception as e:
        print(f"   ❌ Error: {e}")

    # Test 2: Try fetching EXPIRED contract (1 month ago)
    print("\n3. Fetching expired Nifty option (1 month ago)...")
    try:
        month_ago = today - timedelta(days=30)
        exp_month_ago = month_ago
        while exp_month_ago.weekday() != 3:
            exp_month_ago -= timedelta(days=1)

        # ATM strike approximate
        data2 = breeze.get_historical_data_v2(
            interval="1day",
            from_date=(exp_month_ago - timedelta(days=7)).strftime("%Y-%m-%dT00:00:00.000Z"),
            to_date=exp_month_ago.strftime("%Y-%m-%dT23:59:59.000Z"),
            stock_code="NIFTY",
            exchange_code="NFO",
            product_type="options",
            expiry_date=exp_month_ago.strftime("%Y-%m-%dT00:00:00.000Z"),
            right="call",
            strike_price="22500"
        )

        if data2 and "Success" in str(data2.get("Status", "")):
            records2 = data2.get("Success", [])
            print(f"   ✅ Got {len(records2)} records for expired contract!")
            if records2:
                print(f"   Date range: {records2[0].get('datetime', 'N/A')} to {records2[-1].get('datetime', 'N/A')}")
        else:
            print(f"   ⚠️ Response: {json.dumps(data2, indent=2, default=str)[:300]}")
    except Exception as e:
        print(f"   ❌ Error: {e}")

    # Test 3: How far back can we go?
    print("\n4. Testing how far back data goes...")
    for years_back in [1, 2, 3, 5]:
        try:
            old_date = today - timedelta(days=365 * years_back)
            old_expiry = old_date
            while old_expiry.weekday() != 3:
                old_expiry += timedelta(days=1)

            # Use a round strike number
            strike = str(round(22000 / 1000) * 1000 - years_back * 2000)  # rough ATM for that era

            data_old = breeze.get_historical_data_v2(
                interval="1day",
                from_date=old_date.strftime("%Y-%m-%dT00:00:00.000Z"),
                to_date=(old_date + timedelta(days=7)).strftime("%Y-%m-%dT23:59:59.000Z"),
                stock_code="NIFTY",
                exchange_code="NFO",
                product_type="options",
                expiry_date=old_expiry.strftime("%Y-%m-%dT00:00:00.000Z"),
                right="call",
                strike_price=strike
            )

            records_old = data_old.get("Success", []) if data_old else []
            status = "✅" if len(records_old) > 0 else "❌"
            print(f"   {status} {years_back} year(s) back ({old_date.strftime('%Y-%m-%d')}): {len(records_old)} records (strike {strike})")
        except Exception as e:
            print(f"   ❌ {years_back} year(s) back: {e}")

    # Test 4: Minute-level data
    print("\n5. Testing minute-level data...")
    try:
        yesterday = today - timedelta(days=1)
        if yesterday.weekday() >= 5:  # Skip weekends
            yesterday -= timedelta(days=yesterday.weekday() - 4)

        nearest_thu = today
        while nearest_thu.weekday() != 3:
            nearest_thu += timedelta(days=1)

        data_min = breeze.get_historical_data_v2(
            interval="1minute",
            from_date=yesterday.strftime("%Y-%m-%dT09:15:00.000Z"),
            to_date=yesterday.strftime("%Y-%m-%dT15:30:00.000Z"),
            stock_code="NIFTY",
            exchange_code="NFO",
            product_type="options",
            expiry_date=nearest_thu.strftime("%Y-%m-%dT00:00:00.000Z"),
            right="call",
            strike_price="22000"
        )

        records_min = data_min.get("Success", []) if data_min else []
        print(f"   {'✅' if len(records_min) > 0 else '❌'} Minute data: {len(records_min)} bars")
        if records_min:
            print(f"   First bar: {records_min[0].get('datetime', 'N/A')} | Close: {records_min[0].get('close', 'N/A')}")
            print(f"   Last bar:  {records_min[-1].get('datetime', 'N/A')} | Close: {records_min[-1].get('close', 'N/A')}")
    except Exception as e:
        print(f"   ❌ Error: {e}")

    print("\n" + "=" * 60)
    print("  Test complete!")
    print("=" * 60)

if __name__ == "__main__":
    main()
