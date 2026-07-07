#!/usr/bin/env python3
"""
Contract Note PDF Parsers — Zerodha + SAHI
============================================
Extracts equity + F&O trades from broker contract note PDFs.
Uses header-based column detection for robust parsing.

Zerodha: Summary tables on Page 2 (equity 14-col + derivatives 9-col)
SAHI: Summary tables on Page 1 (same format)
"""

import pdfplumber
import re
import os
import json
from typing import List, Dict, Optional, Union
from datetime import datetime

# ── ISIN → canonical NSE ticker (from src/data/stock-master.ts, the 250-stock universe) ──
# Broker notes print inconsistent company names ("TATA STL", "Jio Financial Services Limited") but carry
# a stable ISIN in column 0. Resolving by ISIN is unambiguous and fixes name-fragmentation at the source.
_ISIN_MAP: Dict[str, str] = {}
try:
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "isin_to_symbol.json")) as _f:
        _ISIN_MAP = json.load(_f)
except Exception:
    _ISIN_MAP = {}

def resolve_symbol(isin: str, name: str) -> str:
    """Prefer the canonical ticker resolved from the ISIN; fall back to the printed name if unknown."""
    return _ISIN_MAP.get((isin or "").strip()) or (name or "").strip()


# ── Trade Classes ────────────────────────────────────────────────────

class Trade:
    def __init__(self, symbol: str, action: str, quantity: int, price: float, trade_date: str, broker: str):
        self.symbol = symbol
        self.action = action
        self.quantity = quantity
        self.price = price
        self.trade_date = trade_date
        self.broker = broker
        self.is_fno = False

    def to_dict(self):
        return {"symbol": self.symbol, "action": self.action, "quantity": self.quantity,
                "price": round(self.price, 2), "trade_date": self.trade_date, "broker": self.broker}

    def __repr__(self):
        return f"{self.action} {self.quantity}x {self.symbol} @ ₹{self.price:.2f} on {self.trade_date} [{self.broker}]"


class FnoTrade:
    def __init__(self, underlying: str, expiry: str, strike: int, option_type: str,
                 action: str, lots: int, lot_size: int, price: float, trade_date: str, broker: str):
        self.underlying = underlying
        self.expiry = expiry
        self.strike = strike
        self.option_type = option_type
        self.action = action
        self.lots = lots
        self.lot_size = lot_size
        self.price = price
        self.trade_date = trade_date
        self.broker = broker
        self.is_fno = True

    def to_dict(self):
        return {"underlying": self.underlying, "expiry": self.expiry, "strike": self.strike,
                "option_type": self.option_type, "action": self.action, "lots": self.lots,
                "lot_size": self.lot_size, "price": round(self.price, 2),
                "trade_date": self.trade_date, "broker": self.broker, "is_fno": True}

    def __repr__(self):
        return f"{self.action} {self.lots}lot {self.underlying} {self.strike}{self.option_type} {self.expiry} @ ₹{self.price:.2f} [{self.broker}]"


# ── F&O Symbol Parser ────────────────────────────────────────────────

FNO_UNDERLYINGS = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"}
LOT_SIZES = {"NIFTY": 75, "BANKNIFTY": 30, "FINNIFTY": 40, "MIDCPNIFTY": 50, "SENSEX": 20, "BANKEX": 30}
MONTHS_MAP = {"JAN":"01","FEB":"02","MAR":"03","APR":"04","MAY":"05","JUN":"06",
              "JUL":"07","AUG":"08","SEP":"09","OCT":"10","NOV":"11","DEC":"12"}


def parse_fno_symbol(symbol_str: str) -> Optional[Dict]:
    """Parse F&O symbol like 'NIFTY2640722250CE - NSE' into components."""
    symbol_str = symbol_str.strip().upper()
    # Remove exchange suffix like " - NSE"
    symbol_str = re.sub(r'\s*-\s*(NSE|BSE|NFO)\s*$', '', symbol_str)

    for und in sorted(FNO_UNDERLYINGS, key=len, reverse=True):
        if not symbol_str.startswith(und):
            continue
        rest = symbol_str[len(und):]

        # Numeric format: YY + M(1-2 digits) + DD(2) + STRIKE(4-5) + CE/PE
        # Month is SINGLE digit for Jan-Sep (1-9), DOUBLE for Oct-Dec (10-12)
        # Examples:
        #   2640722250CE → 26 + 4 + 07 + 22250 + CE (April 7, 2026, strike 22250)
        #   26111723400CE → 26 + 11 + 17 + 23400 + CE (Nov 17, 2026, strike 23400)

        # Try all valid splits by bruteforce — try different month/day/strike combos
        # and validate the resulting date
        digits = re.match(r'(\d+)(CE|PE)', rest)
        if digits:
            num_part = digits.group(1)  # e.g. "2640722250"
            opt = digits.group(2)       # "CE" or "PE"
            yy = num_part[:2]           # always 2-digit year

            # Try 1-digit month (M), 2-digit day (DD), rest is strike
            for m_len in [1, 2]:  # month length: 1 or 2 digits
                if len(num_part) < 2 + m_len + 2 + 1:
                    continue
                mm = num_part[2:2+m_len]
                dd = num_part[2+m_len:2+m_len+2]
                strike_str = num_part[2+m_len+2:]

                if not strike_str or int(mm) < 1 or int(mm) > 12 or int(dd) < 1 or int(dd) > 31:
                    continue

                try:
                    expiry = f"20{yy}-{mm.zfill(2)}-{dd}"
                    datetime.strptime(expiry, "%Y-%m-%d")  # validate
                    strike = int(strike_str)
                    if 100 <= strike <= 200000:  # reasonable strike range
                        return {"underlying": und, "expiry": expiry, "strike": strike, "option_type": opt}
                except ValueError:
                    continue

        # Try YYMONSSTRIKETYPE: 25APR22500CE
        m = re.match(r'(\d{2})([A-Z]{3})(\d+)(CE|PE)', rest)
        if m:
            yy, mon, strike, opt = m.groups()
            mm = MONTHS_MAP.get(mon, "01")
            expiry = f"20{yy}-{mm}-28"
            return {"underlying": und, "expiry": expiry, "strike": int(strike), "option_type": opt}

    # Space-separated: NIFTY 22500 CE 07 APR 2025
    m = re.match(r'(\w+)\s+(\d+)\s+(CE|PE)\s+(\d{1,2})\s+(\w{3})\s+(\d{4})', symbol_str)
    if m:
        und, strike, opt, dd, mon, yyyy = m.groups()
        if und in FNO_UNDERLYINGS:
            mm = MONTHS_MAP.get(mon, "01")
            return {"underlying": und, "expiry": f"{yyyy}-{mm}-{dd.zfill(2)}", "strike": int(strike), "option_type": opt}

    # SAHI format: "OPTIDX NIFTY 21Apr2026 21500 PE-NSE" or "OPTIDX NIFTY 21Apr2026 21500 PE"
    m = re.match(r'OPTIDX\s+(\w+)\s+(\d{1,2})(\w{3})(\d{4})\s+(\d+)\s+(CE|PE)', symbol_str)
    if m:
        und, dd, mon, yyyy, strike, opt = m.groups()
        if und in FNO_UNDERLYINGS:
            mm = MONTHS_MAP.get(mon.upper(), "01")
            return {"underlying": und, "expiry": f"{yyyy}-{mm}-{dd.zfill(2)}", "strike": int(strike), "option_type": opt}

    # SAHI variant: "OPTIDX NIFTY 21-Apr-2026 21500 PE"
    m = re.match(r'OPTIDX\s+(\w+)\s+(\d{1,2})-(\w{3})-(\d{4})\s+(\d+)\s+(CE|PE)', symbol_str)
    if m:
        und, dd, mon, yyyy, strike, opt = m.groups()
        if und in FNO_UNDERLYINGS:
            mm = MONTHS_MAP.get(mon.upper(), "01")
            return {"underlying": und, "expiry": f"{yyyy}-{mm}-{dd.zfill(2)}", "strike": int(strike), "option_type": opt}

    return None


def is_fno_symbol(symbol: str) -> bool:
    """Check if a symbol looks like an F&O contract."""
    return parse_fno_symbol(symbol) is not None


# ── Utility Functions ────────────────────────────────────────────────

def safe_float(val) -> float:
    """Safely parse a float from a table cell."""
    if val is None:
        return 0.0
    s = str(val).strip().replace(",", "").replace("−", "-").replace("\u2212", "-")
    if not s or s == '-':
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def safe_int(val) -> int:
    """Safely parse an int from a table cell."""
    return int(safe_float(val))


def find_column(headers: list, *keywords) -> int:
    """Find column index by matching keywords in header cells. Handles newlines in cell text."""
    for idx, cell in enumerate(headers):
        if cell is None:
            continue
        # Normalize: collapse newlines and whitespace
        cell_lower = " ".join(str(cell).lower().split())
        for kw in keywords:
            kw_lower = " ".join(kw.lower().split())
            if kw_lower in cell_lower:
                return idx
    return -1


def extract_trade_date(text: str) -> Optional[str]:
    """Extract trade date from contract note text."""
    patterns = [
        r'Trade\s*Date\s*[:\-]\s*(\d{2}[-/]\w{3}[-/]\d{4})',
        r'Trade\s*Date\s*[:\-]\s*(\d{2}[-/]\d{2}[-/]\d{4})',
        r'Trade\s*Date:\s*(\d{2}/\d{2}/\d{4})',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            date_str = match.group(1)
            for fmt in ["%d-%b-%Y", "%d/%m/%Y", "%d-%m-%Y", "%d/%b/%Y"]:
                try:
                    return datetime.strptime(date_str, fmt).strftime("%Y-%m-%d")
                except ValueError:
                    continue
    return None


# ── Equity Section Parser ────────────────────────────────────────────

def parse_equity_table(table: list, trade_date: str, broker: str) -> List[Trade]:
    """
    Parse the equity summary table (14 columns).

    Headers (Row 0-1):
      Security Description | Buy (Qty, WAP, Brokerage, WAP_After, Total) | Sell (same) | Net

    We use Row 1 sub-headers to find exact column positions.
    Key columns: Symbol (col 1), Buy Qty, Buy WAP_After, Sell Qty, Sell WAP_After
    """
    trades = []
    if len(table) < 3:  # need at least header + sub-header + 1 data row
        return trades

    # Find sub-header row (contains "ISIN", "Quantity", "WAP")
    sub_header_idx = -1
    for ri, row in enumerate(table[:4]):
        row_text = " ".join(str(c or "") for c in row).lower()
        if "isin" in row_text and "quantity" in row_text:
            sub_header_idx = ri
            break

    if sub_header_idx < 0:
        return trades

    sub_header = table[sub_header_idx]

    # Map columns — the 14-column layout is consistent:
    # Col 0: ISIN, Col 1: Symbol
    # Buy section: first "Quantity" = buy qty, "WAP...after" after that = buy price
    # Sell section: second "Quantity" = sell qty, second "WAP...after" = sell price
    symbol_idx = 1  # Always col 1

    # Use FIXED column positions — the 14-column Zerodha/SAHI format is always:
    # 0:ISIN 1:Symbol 2:BuyQty 3:BuyWAP 4:BuyBrokerage 5:BuyWAPAfter 6:BuyTotal
    # 7:SellQty 8:SellWAP 9:SellBrokerage 10:SellWAPAfter 11:SellTotal 12:NetQty 13:NetObligation
    #
    # "WAP after brokerage" columns are 5 (buy) and 10 (sell)
    # Dynamic detection is unreliable because "Total...after Brokerage" also matches
    buy_qty_idx = 2
    buy_price_idx = 5   # WAP after brokerage (buy)
    sell_qty_idx = 7
    sell_price_idx = 10  # WAP after brokerage (sell)

    # Parse data rows
    for row in table[sub_header_idx + 1:]:
        if not row or len(row) < max(sell_price_idx + 1, 8):
            continue

        # Upstox packs multiple stocks per row with newlines: "AXIS BANK\nMirae Asset"
        # Split by newlines and process each sub-row
        raw_symbol = str(row[symbol_idx] or "").strip()
        if not raw_symbol or len(raw_symbol) < 2:
            continue
        if raw_symbol.lower() in ("security name", "symbol", "total", "net", ""):
            continue

        # Split multi-value cells
        symbols = raw_symbol.split("\n")
        isins = str(row[0] or "").split("\n")   # col 0 = ISIN (stable id → resolved to canonical ticker)
        buy_qtys = str(row[buy_qty_idx] or "0").split("\n") if buy_qty_idx < len(row) else ["0"]
        buy_prices = str(row[buy_price_idx] or "0").split("\n") if buy_price_idx < len(row) else ["0"]
        sell_qtys = str(row[sell_qty_idx] or "0").split("\n") if sell_qty_idx < len(row) else ["0"]
        sell_prices = str(row[sell_price_idx] or "0").split("\n") if sell_price_idx < len(row) else ["0"]

        for i, name in enumerate(symbols):
            name = name.strip()
            if not name or len(name) < 2:
                continue
            if name.lower() in ("security name", "symbol", "total", "net"):
                continue

            # Resolve the printed company name to a canonical NSE ticker via its ISIN (col 0).
            isin = isins[i].strip() if i < len(isins) else ""
            symbol = resolve_symbol(isin, name)

            bq = safe_int(buy_qtys[i] if i < len(buy_qtys) else "0")
            bp = safe_float(buy_prices[i] if i < len(buy_prices) else "0")
            sq = abs(safe_int(sell_qtys[i] if i < len(sell_qtys) else "0"))
            sp = safe_float(sell_prices[i] if i < len(sell_prices) else "0")

            if bq > 0 and bp > 0:
                trades.append(Trade(symbol, "BUY", bq, bp, trade_date, broker))
            if sq > 0 and sp > 0:
                trades.append(Trade(symbol, "SELL", sq, sp, trade_date, broker))

    return trades


# ── Derivatives Section Parser ───────────────────────────────────────

def parse_derivatives_table(table: list, trade_date: str, broker: str) -> List[FnoTrade]:
    """
    Parse the derivatives summary table (9-10 columns).

    Headers: Contract Description | Buy/Sell/BF/CF | Quantity | WAP | Brokerage | WAP after brokerage | Closing Rate | Net Total | Remarks
    """
    trades = []
    if len(table) < 2:
        return trades

    # Find header row
    header_idx = -1
    for ri, row in enumerate(table[:3]):
        row_text = " ".join(str(c or "") for c in row).lower()
        if "contract" in row_text and ("buy" in row_text or "sell" in row_text):
            header_idx = ri
            break

    if header_idx < 0:
        return trades

    header = table[header_idx]

    # Map columns
    contract_idx = find_column(header, "contract")
    bs_idx = find_column(header, "buy(b)", "buy/sell", "buy (b)")
    qty_idx = find_column(header, "quantity")
    wap_after_idx = find_column(header, "after brokerage", "wap after", "after\nbrokerage")

    # Fallback to fixed positions if header detection fails
    if contract_idx < 0:
        contract_idx = 0
    if bs_idx < 0:
        bs_idx = 1
    if qty_idx < 0:
        qty_idx = 2
    if wap_after_idx < 0:
        wap_after_idx = 5  # typically col 5 in 9-col layout

    for row in table[header_idx + 1:]:
        if not row or len(row) < 4:
            continue

        contract = str(row[contract_idx] or "").strip()
        if not contract or len(contract) < 5:
            continue

        # Skip section markers
        if contract.upper() in ("NSEFNO", "NSECM", "BSECM", "BSEFNO", "TOTAL", ""):
            continue

        # Remove exchange suffix: "OPTIDX NIFTY 21Apr2026 21500 PE-NSE" → remove "-NSE"
        contract_clean = re.sub(r'\s*-\s*(NSE|BSE)\s*$', '', contract)
        parsed = parse_fno_symbol(contract_clean)
        if not parsed:
            continue

        # Action: B = Buy, S = Sell, BF = Brought Forward, CF = Carried Forward
        bs_cell = str(row[bs_idx] or "").strip().upper()
        raw_qty = safe_int(row[qty_idx])

        if "B" in bs_cell and "F" not in bs_cell:
            action = "BUY"
        elif "S" in bs_cell and "F" not in bs_cell:
            action = "SELL"
        elif raw_qty < 0:
            # SAHI sometimes uses negative qty for sells without explicit S
            action = "SELL"
        elif raw_qty > 0 and not bs_cell:
            action = "BUY"
        else:
            continue  # Skip BF/CF rows

        qty = abs(raw_qty)
        price = safe_float(row[wap_after_idx])

        if qty <= 0 or price <= 0:
            continue

        lot_size = LOT_SIZES.get(parsed["underlying"], 75)
        lots = max(1, qty // lot_size)

        trades.append(FnoTrade(
            underlying=parsed["underlying"],
            expiry=parsed["expiry"],
            strike=parsed["strike"],
            option_type=parsed["option_type"],
            action=action,
            lots=lots,
            lot_size=lot_size,
            price=price,
            trade_date=trade_date,
            broker=broker,
        ))

    return trades


# ── Main Parser ──────────────────────────────────────────────────────

def parse_pdf(pdf_path: str, broker: str, password: str) -> List[Union[Trade, FnoTrade]]:
    """Parse a contract note PDF. Returns list of Trade and FnoTrade objects."""
    all_trades: List[Union[Trade, FnoTrade]] = []
    trade_date = None

    try:
        with pdfplumber.open(pdf_path, password=password) as pdf:
            # Extract trade date from full text
            full_text = ""
            for page in pdf.pages[:3]:
                full_text += (page.extract_text() or "") + "\n"
            trade_date = extract_trade_date(full_text) or ""

            # Parse all tables from all pages
            for page in pdf.pages:
                tables = page.extract_tables()
                for table in tables:
                    if not table or len(table) < 2:
                        continue

                    # Detect table type from first 2 rows
                    first_rows_text = " ".join(str(c or "") for row in table[:3] for c in row).lower()

                    if "isin" in first_rows_text and "security" in first_rows_text and "order no" not in first_rows_text and "trade no" not in first_rows_text:
                        # Equity SUMMARY table (has ISIN + Security, excludes Annexure)
                        equity_trades = parse_equity_table(table, trade_date, broker.upper())
                        all_trades.extend(equity_trades)

                    elif "contract description" in first_rows_text and "quantity" in first_rows_text and "brokerage" in first_rows_text:
                        # Derivatives SUMMARY table (has "Contract Description" + "Quantity" + "Brokerage")
                        # Excludes Annexure tables which have "Order No." + "Trade No." etc.
                        if "order no" not in first_rows_text and "trade no" not in first_rows_text:
                            fno_trades = parse_derivatives_table(table, trade_date, broker.upper())
                            all_trades.extend(fno_trades)

    except Exception as e:
        print(f"  Error parsing {broker} PDF: {e}")

    return all_trades


# ── CLI ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python3 parse_contract_note.py <pdf_path> <broker> [password]")
        print("  broker: ZERODHA or SAHI")
        print("  password: PAN number (defaults to env ZERODHA_PAN)")
        sys.exit(1)

    pdf_path = sys.argv[1]
    broker = sys.argv[2]
    password = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("ZERODHA_PAN", "")

    if not password:
        print("ERROR: No password. Set ZERODHA_PAN env var or pass as argument.")
        sys.exit(1)

    trades = parse_pdf(pdf_path, broker, password)
    equity = [t for t in trades if not t.is_fno]
    fno = [t for t in trades if t.is_fno]
    print(f"\nParsed {len(equity)} equity + {len(fno)} F&O trades:")
    for t in trades:
        print(f"  {t}")
