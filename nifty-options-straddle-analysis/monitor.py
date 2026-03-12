"""
Position Monitoring & Alert System
====================================
Daily monitoring checklist and alert level tracker for:
1. NIFTY Iron Butterfly (23,350 / 23,850 / 24,350)
2. BANKNIFTY Long Straddle (56,000 CE + PE)

Date: March 12, 2026
"""

from dataclasses import dataclass
from enum import Enum


class AlertLevel(Enum):
    GREEN = "GREEN - All clear"
    YELLOW = "YELLOW - Watch closely"
    ORANGE = "ORANGE - Prepare to act"
    RED = "RED - ACT NOW"


@dataclass
class MarketState:
    nifty_spot: float
    banknifty_spot: float
    india_vix: float
    nifty_pcr: float
    banknifty_pcr: float
    brent_crude: float
    usd_inr: float
    fii_net_cr: float  # negative = selling


# Strategy parameters
NIFTY_ATM = 23850
NIFTY_UPPER_WING = 24350
NIFTY_LOWER_WING = 23350
NIFTY_PREMIUM_COLLECTED = 380  # pts
NIFTY_UPPER_BE = NIFTY_ATM + NIFTY_PREMIUM_COLLECTED  # 24,230
NIFTY_LOWER_BE = NIFTY_ATM - NIFTY_PREMIUM_COLLECTED  # 23,470
NIFTY_LOT = 65
NIFTY_MAX_PROFIT = NIFTY_PREMIUM_COLLECTED * NIFTY_LOT  # 24,700
NIFTY_MAX_LOSS = (500 - NIFTY_PREMIUM_COLLECTED) * NIFTY_LOT  # 7,800

BN_ATM = 56000
BN_PREMIUM_PAID = 1250  # pts
BN_UPPER_BE = BN_ATM + BN_PREMIUM_PAID  # 57,250
BN_LOWER_BE = BN_ATM - BN_PREMIUM_PAID  # 54,750
BN_LOT = 30
BN_MAX_LOSS = BN_PREMIUM_PAID * BN_LOT  # 37,500


def check_nifty_alerts(state: MarketState) -> list[tuple[AlertLevel, str]]:
    alerts = []
    spot = state.nifty_spot

    # Price-based alerts
    if spot > NIFTY_UPPER_WING or spot < NIFTY_LOWER_WING:
        alerts.append((AlertLevel.RED, f"NIFTY at {spot:.0f} — BEYOND WINGS. Max loss zone. EXIT."))
    elif spot > NIFTY_UPPER_BE:
        alerts.append((AlertLevel.RED, f"NIFTY at {spot:.0f} — ABOVE upper breakeven ({NIFTY_UPPER_BE}). EXIT."))
    elif spot < NIFTY_LOWER_BE:
        alerts.append((AlertLevel.RED, f"NIFTY at {spot:.0f} — BELOW lower breakeven ({NIFTY_LOWER_BE}). EXIT."))
    elif spot > NIFTY_UPPER_BE - 100:
        alerts.append((AlertLevel.ORANGE, f"NIFTY at {spot:.0f} — approaching upper BE ({NIFTY_UPPER_BE}). Prepare exit."))
    elif spot < NIFTY_LOWER_BE + 100:
        alerts.append((AlertLevel.ORANGE, f"NIFTY at {spot:.0f} — approaching lower BE ({NIFTY_LOWER_BE}). Prepare exit."))
    elif abs(spot - NIFTY_ATM) < 100:
        alerts.append((AlertLevel.GREEN, f"NIFTY at {spot:.0f} — near ATM ({NIFTY_ATM}). Max profit zone."))
    else:
        alerts.append((AlertLevel.YELLOW, f"NIFTY at {spot:.0f} — inside profit zone but drifting."))

    return alerts


def check_banknifty_alerts(state: MarketState) -> list[tuple[AlertLevel, str]]:
    alerts = []
    spot = state.banknifty_spot

    if spot > BN_UPPER_BE + 500:
        alerts.append((AlertLevel.GREEN, f"BANKNIFTY at {spot:.0f} — well above BE ({BN_UPPER_BE}). PROFITABLE. Trail stop."))
    elif spot < BN_LOWER_BE - 500:
        alerts.append((AlertLevel.GREEN, f"BANKNIFTY at {spot:.0f} — well below BE ({BN_LOWER_BE}). PROFITABLE. Trail stop."))
    elif spot > BN_UPPER_BE:
        alerts.append((AlertLevel.YELLOW, f"BANKNIFTY at {spot:.0f} — above upper BE ({BN_UPPER_BE}). Turning profitable. Hold."))
    elif spot < BN_LOWER_BE:
        alerts.append((AlertLevel.YELLOW, f"BANKNIFTY at {spot:.0f} — below lower BE ({BN_LOWER_BE}). Turning profitable. Hold."))
    elif abs(spot - BN_ATM) < 300:
        alerts.append((AlertLevel.ORANGE, f"BANKNIFTY at {spot:.0f} — near ATM ({BN_ATM}). Max loss zone. Monitor theta."))
    else:
        alerts.append((AlertLevel.YELLOW, f"BANKNIFTY at {spot:.0f} — between ATM and BE. Wait for move."))

    return alerts


def check_vix_alerts(state: MarketState) -> list[tuple[AlertLevel, str]]:
    alerts = []
    vix = state.india_vix

    if vix > 28:
        alerts.append((AlertLevel.RED,
            f"VIX at {vix:.1f} — EXTREME FEAR. "
            "Iron Butterfly: wings protect you, hold. "
            "Long Straddle: TAKE PROFITS from vega expansion."))
    elif vix > 24:
        alerts.append((AlertLevel.ORANGE,
            f"VIX at {vix:.1f} — elevated. Monitor for spike or reversal."))
    elif vix < 15:
        alerts.append((AlertLevel.RED,
            f"VIX at {vix:.1f} — IV CRUSH territory. "
            "Iron Butterfly: EXIT for profit. "
            "Long Straddle: EXIT to cut losses."))
    elif vix < 18:
        alerts.append((AlertLevel.YELLOW,
            f"VIX at {vix:.1f} — normalizing. Good for Iron Butterfly, bad for Long Straddle."))
    else:
        alerts.append((AlertLevel.GREEN, f"VIX at {vix:.1f} — in expected range (18-24)."))

    return alerts


def check_macro_alerts(state: MarketState) -> list[tuple[AlertLevel, str]]:
    alerts = []

    if state.brent_crude > 115:
        alerts.append((AlertLevel.RED, f"Crude at ${state.brent_crude:.1f} — danger zone for India. Expect more selling."))
    elif state.brent_crude > 105:
        alerts.append((AlertLevel.ORANGE, f"Crude at ${state.brent_crude:.1f} — elevated but manageable."))
    elif state.brent_crude < 90:
        alerts.append((AlertLevel.GREEN, f"Crude at ${state.brent_crude:.1f} — war premium easing. Bullish for India."))

    if state.fii_net_cr < -8000:
        alerts.append((AlertLevel.RED, f"FII selling at Rs {state.fii_net_cr:,.0f} Cr — heavy outflow."))
    elif state.fii_net_cr < -4000:
        alerts.append((AlertLevel.ORANGE, f"FII selling at Rs {state.fii_net_cr:,.0f} Cr — persistent outflow."))
    elif state.fii_net_cr > 0:
        alerts.append((AlertLevel.GREEN, f"FII buying at Rs {state.fii_net_cr:,.0f} Cr — sentiment turning."))

    return alerts


def run_full_check(state: MarketState):
    print("=" * 75)
    print("  POSITION MONITORING DASHBOARD")
    print(f"  NIFTY: {state.nifty_spot:,.0f} | BANKNIFTY: {state.banknifty_spot:,.0f} | VIX: {state.india_vix:.1f}")
    print("=" * 75)

    sections = [
        ("NIFTY Iron Butterfly", check_nifty_alerts(state)),
        ("BANKNIFTY Long Straddle", check_banknifty_alerts(state)),
        ("Volatility (VIX)", check_vix_alerts(state)),
        ("Macro / Flows", check_macro_alerts(state)),
    ]

    overall_worst = AlertLevel.GREEN

    for title, alerts in sections:
        print(f"\n  --- {title} ---")
        for level, msg in alerts:
            icon = {"GREEN": "[OK]", "YELLOW": "[!!]", "ORANGE": "[!!]", "RED": "[XX]"}
            print(f"    {icon[level.name]} {level.value}: {msg}")
            if list(AlertLevel).index(level) > list(AlertLevel).index(overall_worst):
                overall_worst = level

    print(f"\n{'=' * 75}")
    print(f"  OVERALL STATUS: {overall_worst.value}")
    print("=" * 75)

    # Print checklist
    print("\n  DAILY CHECKLIST:")
    checklist = [
        "GIFT NIFTY / SGX NIFTY pre-market level",
        "India VIX opening level and direction",
        "Crude Oil (Brent) — $100 is the line",
        "NIFTY PCR — watch for shift from 1.06",
        "FII/DII provisional data (prev day)",
        "US-Iran conflict status update",
        "US market overnight close (S&P 500)",
        "RBI announcements or scheduled events",
        "Option chain — any OI shift at key strikes",
        "Position MTM — compare to entry",
    ]
    for i, item in enumerate(checklist, 1):
        print(f"    [ ] {i:2d}. {item}")
    print()


def main():
    # Current market state as of March 12, 2026
    current_state = MarketState(
        nifty_spot=23867,
        banknifty_spot=56061,
        india_vix=21.06,
        nifty_pcr=1.08,
        banknifty_pcr=1.44,
        brent_crude=107.97,
        usd_inr=86.50,
        fii_net_cr=-6267,
    )

    run_full_check(current_state)

    # Scenario analysis
    print("\n" + "=" * 75)
    print("  SCENARIO ANALYSIS — What If?")
    print("=" * 75)

    scenarios = [
        ("Ceasefire announced — crude drops, VIX crashes",
         MarketState(24200, 57500, 14.5, 1.2, 1.5, 85, 85.5, 2000)),
        ("Escalation — crude $120, VIX spikes",
         MarketState(23200, 54000, 30, 0.7, 0.9, 120, 88, -12000)),
        ("Status quo — range-bound, slow IV decline",
         MarketState(23900, 56200, 19, 1.1, 1.3, 102, 86, -3000)),
        ("Flash crash — sudden liquidity event",
         MarketState(22800, 52000, 35, 0.5, 0.6, 115, 89, -15000)),
    ]

    for name, state in scenarios:
        print(f"\n  SCENARIO: {name}")
        print(f"  {'─' * 65}")

        nifty_alerts = check_nifty_alerts(state)
        bn_alerts = check_banknifty_alerts(state)
        vix_alerts = check_vix_alerts(state)

        for alerts in [nifty_alerts, bn_alerts, vix_alerts]:
            for level, msg in alerts:
                icon = {"GREEN": "[OK]", "YELLOW": "[!!]", "ORANGE": "[!!]", "RED": "[XX]"}
                print(f"    {icon[level.name]} {msg}")


if __name__ == "__main__":
    main()
