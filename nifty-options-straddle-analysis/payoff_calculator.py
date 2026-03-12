"""
NIFTY & BANKNIFTY Options Straddle Payoff Calculator
=====================================================
Generates payoff tables and ASCII charts for:
1. NIFTY Iron Butterfly (23,350 / 23,850 / 24,350)
2. BANKNIFTY Long Straddle (56,000 CE + PE)

Date: March 12, 2026
"""

import math
from dataclasses import dataclass


@dataclass
class OptionLeg:
    strike: float
    option_type: str  # 'CE' or 'PE'
    action: str  # 'BUY' or 'SELL'
    premium: float
    lot_size: int


def calculate_leg_pnl(leg: OptionLeg, spot_at_expiry: float) -> float:
    if leg.option_type == "CE":
        intrinsic = max(0, spot_at_expiry - leg.strike)
    else:
        intrinsic = max(0, leg.strike - spot_at_expiry)

    if leg.action == "BUY":
        return (intrinsic - leg.premium) * leg.lot_size
    else:
        return (leg.premium - intrinsic) * leg.lot_size


def calculate_strategy_pnl(legs: list[OptionLeg], spot_at_expiry: float) -> float:
    return sum(calculate_leg_pnl(leg, spot_at_expiry) for leg in legs)


def generate_payoff_table(
    legs: list[OptionLeg],
    spot: float,
    range_pct: float = 3.0,
    step_pct: float = 0.5,
) -> list[dict]:
    rows = []
    lower = spot * (1 - range_pct / 100)
    upper = spot * (1 + range_pct / 100)
    step = spot * step_pct / 100

    price = lower
    while price <= upper + 0.01:
        pnl = calculate_strategy_pnl(legs, price)
        rows.append(
            {
                "spot_at_expiry": round(price, 0),
                "pct_from_atm": round((price - spot) / spot * 100, 1),
                "pnl_pts": round(pnl / legs[0].lot_size, 0),
                "pnl_rs": round(pnl, 0),
            }
        )
        price += step

    return rows


def find_breakevens(legs: list[OptionLeg], spot: float) -> list[float]:
    breakevens = []
    lower = spot * 0.9
    upper = spot * 1.1
    step = 1.0
    prev_pnl = calculate_strategy_pnl(legs, lower)

    price = lower + step
    while price <= upper:
        curr_pnl = calculate_strategy_pnl(legs, price)
        if prev_pnl * curr_pnl < 0:
            # Linear interpolation
            be = price - step * curr_pnl / (curr_pnl - prev_pnl)
            breakevens.append(round(be, 0))
        prev_pnl = curr_pnl
        price += step

    return breakevens


def print_ascii_chart(
    legs: list[OptionLeg],
    spot: float,
    title: str,
    range_pct: float = 3.5,
    width: int = 70,
    height: int = 20,
):
    lower = spot * (1 - range_pct / 100)
    upper = spot * (1 + range_pct / 100)
    num_points = width

    prices = [lower + (upper - lower) * i / (num_points - 1) for i in range(num_points)]
    pnls = [calculate_strategy_pnl(legs, p) for p in prices]

    max_pnl = max(pnls)
    min_pnl = min(pnls)
    pnl_range = max_pnl - min_pnl
    if pnl_range == 0:
        pnl_range = 1

    breakevens = find_breakevens(legs, spot)

    print(f"\n{'=' * (width + 15)}")
    print(f"  {title}")
    print(f"{'=' * (width + 15)}")
    print(f"  Max Profit: Rs {max_pnl:+,.0f} | Max Loss: Rs {min_pnl:+,.0f}")
    print(f"  Breakevens: {', '.join(str(int(b)) for b in breakevens)}")
    print(f"  Current Spot: {spot:,.0f}")
    print(f"{'─' * (width + 15)}")

    grid = [[" " for _ in range(num_points)] for _ in range(height)]

    zero_row = None
    for row in range(height):
        pnl_at_row = max_pnl - (max_pnl - min_pnl) * row / (height - 1)
        if zero_row is None and pnl_at_row <= 0:
            zero_row = row

    for col, pnl in enumerate(pnls):
        row = int((max_pnl - pnl) / pnl_range * (height - 1))
        row = max(0, min(height - 1, row))
        grid[row][col] = "*"

    for row in range(height):
        pnl_at_row = max_pnl - pnl_range * row / (height - 1)
        label = f"  {pnl_at_row:>+10,.0f} |"

        line = ""
        for col in range(num_points):
            if grid[row][col] == "*":
                line += "*"
            elif zero_row is not None and row == zero_row:
                line += "-"
            else:
                line += " "
        print(f"{label}{line}")

    price_labels = f"{'':>14}"
    price_labels += f"{lower:>8,.0f}"
    mid_pos = num_points // 2
    price_labels += f"{spot:>{mid_pos},.0f}"
    price_labels += f"{upper:>{num_points - mid_pos - 1},.0f}"
    print(f"{'':>14}{'─' * num_points}")
    print(price_labels)
    print(f"{'':>14}{'':>{mid_pos}}  ^ SPOT")


def print_payoff_table(rows: list[dict], title: str):
    print(f"\n{'=' * 70}")
    print(f"  {title}")
    print(f"{'=' * 70}")
    print(f"  {'Spot at Expiry':>15} | {'% from ATM':>10} | {'P&L (pts)':>10} | {'P&L (Rs)':>12}")
    print(f"  {'─' * 15}─┼─{'─' * 10}─┼─{'─' * 10}─┼─{'─' * 12}")

    for row in rows:
        marker = ""
        if row["pnl_rs"] == 0:
            marker = " <-- BE"
        elif abs(row["pct_from_atm"]) < 0.05:
            marker = " <-- ATM"

        print(
            f"  {row['spot_at_expiry']:>15,.0f} | {row['pct_from_atm']:>+10.1f}% | "
            f"{row['pnl_pts']:>+10,.0f} | {row['pnl_rs']:>+12,.0f}{marker}"
        )


def main():
    # ═══════════════════════════════════════════════════════════════
    # STRATEGY 1: NIFTY Iron Butterfly
    # ═══════════════════════════════════════════════════════════════
    nifty_spot = 23867
    nifty_lot = 65

    nifty_iron_butterfly = [
        OptionLeg(strike=23850, option_type="CE", action="SELL", premium=280, lot_size=nifty_lot),
        OptionLeg(strike=23850, option_type="PE", action="SELL", premium=265, lot_size=nifty_lot),
        OptionLeg(strike=24350, option_type="CE", action="BUY", premium=85, lot_size=nifty_lot),
        OptionLeg(strike=23350, option_type="PE", action="BUY", premium=80, lot_size=nifty_lot),
    ]

    print("\n" + "█" * 75)
    print("  NIFTY & BANKNIFTY STRADDLE ANALYSIS — PAYOFF CALCULATOR")
    print("  Date: March 12, 2026")
    print("█" * 75)

    rows = generate_payoff_table(nifty_iron_butterfly, nifty_spot)
    print_payoff_table(rows, "NIFTY Iron Butterfly (23,350 / 23,850 / 24,350) — Mar 17 Expiry")
    print_ascii_chart(
        nifty_iron_butterfly,
        nifty_spot,
        "NIFTY Iron Butterfly — Payoff at Expiry",
    )

    # ═══════════════════════════════════════════════════════════════
    # STRATEGY 2: BANKNIFTY Long Straddle
    # ═══════════════════════════════════════════════════════════════
    bn_spot = 56061
    bn_lot = 30

    bn_long_straddle = [
        OptionLeg(strike=56000, option_type="CE", action="BUY", premium=650, lot_size=bn_lot),
        OptionLeg(strike=56000, option_type="PE", action="BUY", premium=600, lot_size=bn_lot),
    ]

    rows = generate_payoff_table(bn_long_straddle, bn_spot)
    print_payoff_table(rows, "BANKNIFTY Long Straddle (56,000 CE + PE) — Mar 26 Expiry")
    print_ascii_chart(
        bn_long_straddle,
        bn_spot,
        "BANKNIFTY Long Straddle — Payoff at Expiry",
    )

    # Summary
    print("\n" + "═" * 75)
    print("  COMBINED POSITION SUMMARY")
    print("═" * 75)

    nifty_be = find_breakevens(nifty_iron_butterfly, nifty_spot)
    bn_be = find_breakevens(bn_long_straddle, bn_spot)

    nifty_max_profit = max(
        calculate_strategy_pnl(nifty_iron_butterfly, p)
        for p in range(int(nifty_spot * 0.95), int(nifty_spot * 1.05))
    )
    nifty_max_loss = min(
        calculate_strategy_pnl(nifty_iron_butterfly, p)
        for p in range(int(nifty_spot * 0.9), int(nifty_spot * 1.1))
    )

    print(f"\n  Strategy 1: NIFTY Iron Butterfly")
    print(f"    Max Profit:  Rs {nifty_max_profit:>+10,.0f}")
    print(f"    Max Loss:    Rs {nifty_max_loss:>+10,.0f}")
    print(f"    Breakevens:  {', '.join(str(int(b)) for b in nifty_be)}")
    print(f"    R:R Ratio:   1:{abs(nifty_max_profit/nifty_max_loss):.1f}")

    bn_max_loss = calculate_strategy_pnl(bn_long_straddle, 56000)
    print(f"\n  Strategy 2: BANKNIFTY Long Straddle")
    print(f"    Max Profit:  Unlimited")
    print(f"    Max Loss:    Rs {bn_max_loss:>+10,.0f}")
    print(f"    Breakevens:  {', '.join(str(int(b)) for b in bn_be)}")
    print(f"    R:R Ratio:   Unlimited upside")

    print(f"\n  Combined Capital Required: ~Rs 87,500")
    print(f"  Combined Max Loss:         Rs {nifty_max_loss + bn_max_loss:>+10,.0f}")
    print(f"  Combined Strategy:         IV-neutral hedge")
    print(f"    Iron Butterfly = short vega (profits from IV drop)")
    print(f"    Long Straddle  = long vega (profits from IV spike)")
    print(f"    Net Effect     = partial vega hedge across indices")
    print()


if __name__ == "__main__":
    main()
