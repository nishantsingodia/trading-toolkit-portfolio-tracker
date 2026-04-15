"""
Compute Derived Data: IV, Greeks, PCR, Max Pain, VIX
=====================================================
Reads raw option_candles + spot_candles from SQLite.
Computes IV (BS inverse), Greeks, and chain-level metrics.
Stores in option_greeks and chain_metrics tables.

Usage: python3 scripts/compute-derived-data.py
"""

import sqlite3, math, sys, time
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "nifty-options-history.db"
RISK_FREE_RATE = 0.065  # 6.5% RBI repo rate

# ── Black-Scholes Math (ported from pricing.ts) ─────────────────────

def normal_cdf(x):
    """Standard normal CDF — Hart approximation."""
    if x < -8: return 0.0
    if x > 8: return 1.0
    a1, a2, a3, a4, a5 = 0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429
    k = 1.0 / (1.0 + 0.2316419 * abs(x))
    cnd = (1.0 / math.sqrt(2 * math.pi)) * math.exp(-0.5 * x * x) * \
          (a1*k + a2*k**2 + a3*k**3 + a4*k**4 + a5*k**5)
    return 1.0 - cnd if x >= 0 else cnd

def normal_pdf(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)

def bs_price(spot, strike, tte, rf, iv, right):
    """Black-Scholes option price."""
    if tte <= 0:
        if right == "CE": return max(spot - strike, 0)
        else: return max(strike - spot, 0)
    if iv <= 0: return 0.0

    sqrt_t = math.sqrt(tte)
    d1 = (math.log(spot / strike) + (rf + iv*iv/2) * tte) / (iv * sqrt_t)
    d2 = d1 - iv * sqrt_t
    disc = math.exp(-rf * tte)

    if right == "CE":
        return spot * normal_cdf(d1) - strike * disc * normal_cdf(d2)
    else:
        return strike * disc * normal_cdf(-d2) - spot * normal_cdf(-d1)

def implied_volatility(market_price, spot, strike, tte, rf, right, max_iter=50):
    """Newton-Raphson IV solver."""
    if tte <= 0 or market_price <= 0 or spot <= 0 or strike <= 0:
        return 0.0

    # Initial guess
    iv = math.sqrt(2 * math.pi / tte) * (market_price / spot)
    iv = max(0.01, min(5.0, iv))

    for _ in range(max_iter):
        price = bs_price(spot, strike, tte, rf, iv, right)
        diff = price - market_price
        if abs(diff) < 0.01:
            return iv

        sqrt_t = math.sqrt(tte)
        d1 = (math.log(spot / strike) + (rf + iv*iv/2) * tte) / (iv * sqrt_t)
        vega = spot * sqrt_t * normal_pdf(d1)

        if vega < 1e-10:
            break

        iv -= diff / vega
        iv = max(0.01, min(5.0, iv))

    return iv

def calculate_greeks(spot, strike, tte, rf, iv, right):
    """Compute delta, gamma, theta, vega."""
    if tte <= 0 or iv <= 0:
        itm = (spot > strike) if right == "CE" else (spot < strike)
        return (1.0 if itm and right == "CE" else -1.0 if itm and right == "PE" else 0.0), 0, 0, 0

    sqrt_t = math.sqrt(tte)
    d1 = (math.log(spot / strike) + (rf + iv*iv/2) * tte) / (iv * sqrt_t)
    d2 = d1 - iv * sqrt_t
    nd1 = normal_pdf(d1)
    disc = math.exp(-rf * tte)

    # Delta
    delta = normal_cdf(d1) if right == "CE" else normal_cdf(d1) - 1

    # Gamma
    gamma = nd1 / (spot * iv * sqrt_t)

    # Theta (per calendar day)
    common = -(spot * nd1 * iv) / (2 * sqrt_t)
    if right == "CE":
        theta = common - rf * strike * disc * normal_cdf(d2)
    else:
        theta = common + rf * strike * disc * normal_cdf(-d2)
    theta /= 365

    # Vega (per 1% IV change)
    vega = spot * sqrt_t * nd1 / 100

    return delta, gamma, theta, vega

# ── Main ─────────────────────────────────────────────────────────────

def main():
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")

    # Create tables
    conn.execute("""CREATE TABLE IF NOT EXISTS option_greeks (
        date TEXT NOT NULL, expiry TEXT NOT NULL, strike INTEGER NOT NULL, right TEXT NOT NULL,
        iv REAL, delta REAL, gamma REAL, theta REAL, vega REAL,
        UNIQUE(date, expiry, strike, right)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS chain_metrics (
        date TEXT NOT NULL, expiry TEXT NOT NULL,
        pcr REAL, max_pain INTEGER, atm_iv REAL, total_call_oi INTEGER, total_put_oi INTEGER,
        UNIQUE(date, expiry)
    )""")
    conn.commit()

    # Check if already computed
    existing_greeks = conn.execute("SELECT COUNT(*) FROM option_greeks").fetchone()[0]
    existing_metrics = conn.execute("SELECT COUNT(*) FROM chain_metrics").fetchone()[0]
    print(f"Existing: {existing_greeks:,} greeks, {existing_metrics:,} chain metrics")

    # Load spot prices
    spots = {}
    for row in conn.execute("SELECT date, close FROM spot_candles"):
        spots[row[0]] = row[1]
    print(f"Spot prices: {len(spots)} days")

    # Get unique (date, expiry, strike, right) combos that need greeks
    # Use EOD close (15:30 bar or max time per day) for greeks computation
    print("\nComputing Greeks...")

    # Get all unique date-expiry pairs
    date_expiry_pairs = conn.execute("""
        SELECT DISTINCT date, expiry FROM option_candles
        WHERE date NOT IN (SELECT DISTINCT date FROM option_greeks WHERE expiry = option_candles.expiry)
        ORDER BY date
    """).fetchall()

    print(f"Date-expiry pairs to process: {len(date_expiry_pairs)}")

    total_greeks = 0
    total_metrics = 0
    batch_size = 50  # commit every 50 date-expiry pairs

    for idx, (date, expiry) in enumerate(date_expiry_pairs):
        spot = spots.get(date)
        if not spot:
            # Try nearest spot
            for offset in range(1, 10):
                for d_try in [date[:8] + str(int(date[8:10]) - offset).zfill(2),
                              date[:8] + str(int(date[8:10]) + offset).zfill(2)]:
                    if d_try in spots:
                        spot = spots[d_try]
                        break
                if spot:
                    break
        if not spot:
            continue

        # DTE
        try:
            exp_dt = datetime.strptime(expiry, "%Y-%m-%d")
            cur_dt = datetime.strptime(date, "%Y-%m-%d")
            dte = max(0, (exp_dt - cur_dt).days)
        except:
            continue
        tte = dte / 365.0

        # Get all strikes for this date-expiry (use latest time bar per day)
        rows = conn.execute("""
            SELECT strike, right, close, open_interest,
                   MAX(time) as latest_time
            FROM option_candles
            WHERE date = ? AND expiry = ?
            GROUP BY strike, right
        """, (date, expiry)).fetchall()

        atm_strike = round(spot / 50) * 50
        total_call_oi = 0
        total_put_oi = 0
        atm_iv = None
        strikes_for_max_pain = []

        for strike, right, close_price, oi, _ in rows:
            if close_price is None or close_price <= 0:
                continue

            # Compute IV
            iv = implied_volatility(close_price, spot, strike, tte, RISK_FREE_RATE, right)

            # Compute Greeks
            delta, gamma, theta, vega = calculate_greeks(spot, strike, tte, RISK_FREE_RATE, iv, right)

            # Insert greeks
            conn.execute(
                "INSERT OR IGNORE INTO option_greeks (date, expiry, strike, right, iv, delta, gamma, theta, vega) VALUES (?,?,?,?,?,?,?,?,?)",
                (date, expiry, strike, right, iv, delta, gamma, theta, vega)
            )
            total_greeks += 1

            # Accumulate for chain metrics
            oi = oi or 0
            if right == "CE":
                total_call_oi += oi
            else:
                total_put_oi += oi

            strikes_for_max_pain.append((strike, right, oi))

            # ATM IV
            if strike == atm_strike and right == "CE":
                atm_iv = iv

        # Compute chain metrics
        pcr = total_put_oi / total_call_oi if total_call_oi > 0 else 0

        # Max pain
        all_strikes = set(s[0] for s in strikes_for_max_pain)
        max_pain_strike = atm_strike
        min_pain = float('inf')
        for target in all_strikes:
            pain = 0
            for s, r, oi in strikes_for_max_pain:
                if target > s and r == "CE":
                    pain += (target - s) * oi
                if target < s and r == "PE":
                    pain += (s - target) * oi
            if pain < min_pain:
                min_pain = pain
                max_pain_strike = target

        conn.execute(
            "INSERT OR IGNORE INTO chain_metrics (date, expiry, pcr, max_pain, atm_iv, total_call_oi, total_put_oi) VALUES (?,?,?,?,?,?,?)",
            (date, expiry, pcr, max_pain_strike, atm_iv, total_call_oi, total_put_oi)
        )
        total_metrics += 1

        if (idx + 1) % batch_size == 0:
            conn.commit()
            pct = (idx + 1) / len(date_expiry_pairs) * 100
            sys.stdout.write(f"\r  {idx+1}/{len(date_expiry_pairs)} ({pct:.0f}%) | {total_greeks:,} greeks, {total_metrics:,} metrics")
            sys.stdout.flush()

    conn.commit()

    print(f"\r  Done! {total_greeks:,} greeks, {total_metrics:,} chain metrics computed")

    # Summary
    g_count = conn.execute("SELECT COUNT(*) FROM option_greeks").fetchone()[0]
    m_count = conn.execute("SELECT COUNT(*) FROM chain_metrics").fetchone()[0]

    # Spot check: ATM IV by year
    print(f"\nTotal greeks: {g_count:,}")
    print(f"Total chain metrics: {m_count:,}")

    print("\nATM IV (VIX proxy) by year:")
    for row in conn.execute("""
        SELECT substr(date,1,4) as year,
               ROUND(AVG(atm_iv)*100, 1) as avg_iv,
               ROUND(MAX(atm_iv)*100, 1) as max_iv,
               ROUND(MIN(CASE WHEN atm_iv > 0 THEN atm_iv END)*100, 1) as min_iv,
               COUNT(*) as days
        FROM chain_metrics
        WHERE atm_iv > 0
        GROUP BY year ORDER BY year
    """):
        print(f"  {row[0]}: avg {row[1]}%, max {row[2]}%, min {row[3]}%, {row[4]} days")

    print("\nPCR by year:")
    for row in conn.execute("""
        SELECT substr(date,1,4) as year,
               ROUND(AVG(pcr), 2) as avg_pcr,
               COUNT(*) as days
        FROM chain_metrics
        WHERE pcr > 0
        GROUP BY year ORDER BY year
    """):
        print(f"  {row[0]}: avg PCR {row[1]}, {row[2]} days")

    conn.close()

if __name__ == "__main__":
    main()
