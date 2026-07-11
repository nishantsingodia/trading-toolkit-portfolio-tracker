#!/usr/bin/env python3
"""
Trade Sync Pipeline
====================
Fetches contract notes from Gmail, parses PDFs, syncs Upstox holdings,
and imports everything into the Watchlist Panel.

Usage:
  python3 scripts/sync_trades.py              # Sync all brokers
  python3 scripts/sync_trades.py --zerodha    # Zerodha only
  python3 scripts/sync_trades.py --sahi       # SAHI only
  python3 scripts/sync_trades.py --upstox     # Upstox only
  python3 scripts/sync_trades.py --days 7     # Last 7 days of contract notes
"""

import os, sys, json, base64, tempfile, argparse
from datetime import datetime, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)

# Add scripts dir to path for imports
sys.path.insert(0, SCRIPT_DIR)
from parse_contract_note import parse_pdf, Trade, FnoTrade

# Config
PANEL_URL = "http://localhost:8787"
TOKEN_FILE = os.path.join(SCRIPT_DIR, "token.json")
SYNC_STATE_FILE = os.path.join(SCRIPT_DIR, ".sync_state.json")

# Load .dev.vars for PAN and Upstox token
def load_dev_vars():
    vars_file = os.path.join(PROJECT_DIR, ".dev.vars")
    config = {}
    if os.path.exists(vars_file):
        with open(vars_file) as f:
            for line in f:
                line = line.strip()
                if '=' in line and not line.startswith('#'):
                    key, val = line.split('=', 1)
                    config[key.strip()] = val.strip()
    return config

CONFIG = load_dev_vars()

def get_pan():
    return CONFIG.get('ZERODHA_PAN', os.environ.get('ZERODHA_PAN', ''))

def get_upstox_token():
    # Try to get live token from the panel (which may have refreshed via OAuth)
    try:
        import urllib.request
        resp = urllib.request.urlopen(f"{PANEL_URL}/api/auth")
        data = json.loads(resp.read())
        if data.get("status") == "VALID":
            # Panel has valid token — use it via proxy. Return a marker.
            return "__PANEL_PROXY__"
    except: pass
    return CONFIG.get('UPSTOX_ACCESS_TOKEN', os.environ.get('UPSTOX_ACCESS_TOKEN', ''))

# ─── Sync State ───

def load_sync_state():
    if os.path.exists(SYNC_STATE_FILE):
        with open(SYNC_STATE_FILE) as f:
            return json.load(f)
    return {"last_zerodha_id": None, "last_sahi_id": None, "last_upstox_sync": None}

def save_sync_state(state):
    with open(SYNC_STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)

# ─── Gmail Integration ───

def get_gmail_service():
    """Get authenticated Gmail API service."""
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build

    if not os.path.exists(TOKEN_FILE):
        print("ERROR: Gmail not set up. Run: python3 scripts/gmail_setup.py")
        return None

    creds = Credentials.from_authorized_user_file(TOKEN_FILE, ["https://www.googleapis.com/auth/gmail.readonly"])

    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        with open(TOKEN_FILE, 'w') as f:
            f.write(creds.to_json())

    return build("gmail", "v1", credentials=creds)

def fetch_contract_notes_from_gmail(service, broker: str, days: int = 3):
    """Fetch contract note emails from Gmail."""
    if broker == "ZERODHA":
        query = "from:no-reply-contract-notes@reportsmailer.zerodha.net subject:Combined Equity Contract Note has:attachment"
    elif broker == "SAHI":
        query = "from:no-reply@sahi.com subject:Digital Contract Note has:attachment"
    elif broker == "UPSTOX":
        query = "from:upstox subject:Digital Contract Note has:attachment"
    elif broker == "INDMONEY":
        # INDmoney (INDstocks) emails one password-protected PDF contract note per trade day.
        # Subject: "Contract Note from INDmoney for trades on DD/MM/YYYY". Exclude their MTF/margin statements.
        query = 'from:statements@transactions.indmoney.com subject:"Contract Note" has:attachment'
    else:
        return []

    # Add date filter
    after_date = (datetime.now() - timedelta(days=days)).strftime("%Y/%m/%d")
    query += f" after:{after_date}"

    print(f"  Searching Gmail: {query}")

    # Paginate through ALL matching emails in the window. Previously capped at maxResults=30 with no
    # pageToken, so only the 30 most-recent notes per broker were ever seen — older contract notes were
    # silently missed (causing both missing trades and unreachable fragmented symbols on backfill).
    messages = []
    page_token = None
    while True:
        resp = service.users().messages().list(userId="me", q=query, maxResults=100, pageToken=page_token).execute()
        messages.extend(resp.get("messages", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    print(f"  Found {len(messages)} emails")

    pdfs = []
    for msg_info in messages:
        msg = service.users().messages().get(userId="me", id=msg_info["id"]).execute()
        msg_id = msg_info["id"]

        # Get date from headers
        headers = {h["name"]: h["value"] for h in msg["payload"].get("headers", [])}
        subject = headers.get("Subject", "")
        date_str = headers.get("Date", "")

        # Find PDF attachments (recursively — Upstox nests them in multipart)
        def find_pdf_parts(payload):
            found = []
            fn = payload.get("filename", "")
            if fn.lower().endswith(".pdf") and payload.get("body", {}).get("attachmentId"):
                found.append((fn, payload["body"]["attachmentId"]))
            for sub in payload.get("parts", []):
                found.extend(find_pdf_parts(sub))
            return found

        pdf_parts = find_pdf_parts(msg["payload"])
        for filename, att_id in pdf_parts:
            att = service.users().messages().attachments().get(
                userId="me", messageId=msg_id, id=att_id
            ).execute()
            data = base64.urlsafe_b64decode(att["data"])

            tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False, dir=tempfile.gettempdir())
            tmp.write(data)
            tmp.close()

            pdfs.append({
                "path": tmp.name,
                "filename": filename,
                "msg_id": msg_id,
                "date": date_str,
                "subject": subject,
            })
            print(f"    Downloaded: {filename} ({len(data)} bytes)")

    return pdfs

# ─── Upstox Integration ───

def sync_upstox_holdings():
    """Fetch holdings from Upstox via panel proxy (uses panel's live token)."""
    import urllib.request

    url = f"{PANEL_URL}/api/upstox/holdings"

    try:
        resp = urllib.request.urlopen(url)
        data = json.loads(resp.read())

        if data.get("error"):
            print(f"  Upstox holdings error: {data['error']}")
            return []

        holdings = data.get("data", [])
        trades = []
        for h in holdings:
            symbol = h.get("tradingsymbol", h.get("trading_symbol", ""))
            qty = h.get("quantity", 0)
            avg_price = h.get("average_price", 0)

            if symbol and qty > 0 and avg_price > 0:
                trades.append({
                    "symbol": symbol,
                    "action": "BUY",
                    "price": round(avg_price, 2),
                    "quantity": qty,
                    "trade_date": "2024-01-01",
                    "broker": "UPSTOX",
                    "portfolio": "LEGACY",
                    "source": "API",
                })

        print(f"  Fetched {len(trades)} holdings from Upstox")
        return trades

    except Exception as e:
        print(f"  Upstox holdings error: {e}")
        return []

def sync_upstox_today_trades():
    """Fetch today's executed trades from Upstox."""
    import urllib.request

    token = get_upstox_token()
    if not token:
        return []

    url = "https://api.upstox.com/v2/order/trades/get-trades-for-day"
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
    })

    try:
        resp = urllib.request.urlopen(req)
        data = json.loads(resp.read())

        day_trades = data.get("data", [])
        trades = []
        today = datetime.now().strftime("%Y-%m-%d")

        for t in day_trades:
            symbol = t.get("tradingsymbol", t.get("trading_symbol", ""))
            action = t.get("transaction_type", "").upper()
            qty = t.get("quantity", 0)
            price = t.get("average_price", 0)

            if symbol and action in ("BUY", "SELL") and qty > 0 and price > 0:
                trades.append({
                    "symbol": symbol,
                    "action": action,
                    "price": round(price, 2),
                    "quantity": qty,
                    "trade_date": today,
                    "broker": "UPSTOX",
                    "portfolio": "LEGACY",  # Will be matched to STRATEGY if signal exists
                    "source": "API",
                })

        print(f"  Fetched {len(trades)} trades from Upstox today")
        return trades

    except Exception as e:
        print(f"  Upstox trades API error: {e}")
        return []

# ─── Import F&O Trades to Panel ───

def detect_fno_strategy(fno_trades: list) -> str:
    """Auto-detect strategy from F&O trade patterns."""
    if len(fno_trades) < 2:
        return "manual"

    # Group trades entered at the same time (same position_id or same trade_date)
    strikes = [t.get("strike", 0) for t in fno_trades]
    types = [t.get("option_type", "") for t in fno_trades]
    actions = [t.get("action", "") for t in fno_trades]
    underlying = fno_trades[0].get("underlying", "NIFTY")

    has_ce = "CE" in types
    has_pe = "PE" in types
    all_sell = all(a == "SELL" for a in actions)

    if has_ce and has_pe and all_sell and len(set(strikes)) == 1:
        # Same strike CE + PE sell = straddle
        return "short_straddle"

    if has_ce and has_pe and all_sell and len(set(strikes)) == 2:
        # Different strike CE + PE sell = strangle
        strike_diff = abs(max(strikes) - min(strikes))
        spot_approx = sum(strikes) / len(strikes)
        otm_pct = strike_diff / spot_approx * 100
        if otm_pct > 2:  # > 2% apart = deep OTM
            return "deep_otm_perleg"
        return "short_strangle"

    return "manual"


def import_fno_trades_to_panel(fno_trades: list):
    """Import F&O trades to panel's /api/fno/trade endpoint."""
    import urllib.request

    # Group by trade_date + underlying + expiry to detect strategy
    from collections import defaultdict
    groups = defaultdict(list)
    for t in fno_trades:
        key = f"{t.get('trade_date','')}_{t.get('underlying','')}_{t.get('expiry','')}"
        groups[key].append(t)

    imported = 0
    for key, group in groups.items():
        strategy = detect_fno_strategy(group)
        position_id = f"pos_{key.replace('-','').replace('_','')}"

        for t in group:
            payload = json.dumps({
                "underlying": t.get("underlying", "NIFTY"),
                "expiry": t.get("expiry", ""),
                "strike": t.get("strike", 0),
                "option_type": t.get("option_type", "CE"),
                "action": t.get("action", "SELL"),
                "price": t.get("price", 0),
                "lots": t.get("lots", 1),
                "trade_date": t.get("trade_date", ""),  # send the REAL trade date so the panel stops stamping the run-date (which caused daily re-import dupes)
                "lot_size": t.get("lot_size", 0),         # send the contract's real lot size if the parser has it (0 = let panel decide)
                "strategy": strategy,
                "broker": t.get("broker", "MANUAL"),
                "position_id": position_id,
                "source": "CONTRACT_NOTE",
            }).encode()

            req = urllib.request.Request(
                f"{PANEL_URL}/api/fno/trade",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )

            try:
                resp = urllib.request.urlopen(req)
                result = json.loads(resp.read())
                if result.get("success"):
                    imported += 1
            except Exception as e:
                print(f"    Error importing F&O trade: {e}")

    print(f"  Imported {imported} F&O trades (auto-detected strategies: {set(detect_fno_strategy(g) for g in groups.values())})")


# ─── Import Equity Trades to Panel ───

def import_trades_to_panel(trades: list, portfolio: str = "LEGACY"):
    """Send trades to the panel's import API."""
    import urllib.request

    if not trades:
        return {"imported": 0, "skipped": 0}

    # Set portfolio for all trades
    for t in trades:
        if "portfolio" not in t:
            t["portfolio"] = portfolio

    payload = json.dumps({"trades": trades}).encode()
    req = urllib.request.Request(
        f"{PANEL_URL}/api/trades/import",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        resp = urllib.request.urlopen(req)
        result = json.loads(resp.read())
        print(f"  Imported: {result.get('imported', 0)}, Skipped: {result.get('skipped', 0)}")
        return result
    except Exception as e:
        print(f"  Import error: {e}")
        print(f"  Is the panel running at {PANEL_URL}?")
        return {"imported": 0, "skipped": 0, "error": str(e)}

# ─── Main Sync ───

def sync_broker_from_gmail(service, broker: str, days: int = 3):
    """Sync a broker's trades from Gmail contract notes."""
    print(f"\n{'='*60}")
    print(f"  Syncing {broker} from Gmail contract notes")
    print(f"{'='*60}")

    pan = get_pan()
    if not pan:
        print(f"  ERROR: PAN not found. Add ZERODHA_PAN to .dev.vars")
        return

    # Upstox uses lowercase PAN as password
    pdf_password = pan.lower() if broker == "UPSTOX" else pan

    pdfs = fetch_contract_notes_from_gmail(service, broker, days)
    if not pdfs:
        print(f"  No new contract notes found for {broker}")
        return

    all_equity_trades = []
    all_fno_trades = []
    for pdf_info in pdfs:
        print(f"\n  Parsing: {pdf_info['filename']}")
        trades = parse_pdf(pdf_info["path"], broker, pdf_password)
        equity_count = sum(1 for t in trades if not getattr(t, 'is_fno', False))
        fno_count = sum(1 for t in trades if getattr(t, 'is_fno', False))
        print(f"  Found {equity_count} equity + {fno_count} F&O trades")
        for t in trades:
            if getattr(t, 'is_fno', False):
                trade_dict = t.to_dict()
                trade_dict["source"] = "CONTRACT_NOTE"
                all_fno_trades.append(trade_dict)
            else:
                trade_dict = t.to_dict()
                trade_dict["source"] = "CONTRACT_NOTE"
                trade_dict["portfolio"] = "LEGACY"
                all_equity_trades.append(trade_dict)

        # Cleanup temp file
        try:
            os.unlink(pdf_info["path"])
        except:
            pass

    # Import F&O trades
    if all_fno_trades:
        print(f"\n  Importing {len(all_fno_trades)} F&O trades...")
        import_fno_trades_to_panel(all_fno_trades)

    all_trades = all_equity_trades

    if all_trades:
        print(f"\n  Total trades to import: {len(all_trades)}")
        import_trades_to_panel(all_trades)
    else:
        print(f"  No trades extracted from PDFs")


def sync_upstox():
    """Sync Upstox holdings and today's trades."""
    print(f"\n{'='*60}")
    print(f"  Syncing Upstox via API")
    print(f"{'='*60}")

    # Holdings (one-time / periodic)
    holdings = sync_upstox_holdings()
    if holdings:
        import_trades_to_panel(holdings, "LEGACY")

    # Today's trades
    today_trades = sync_upstox_today_trades()
    if today_trades:
        import_trades_to_panel(today_trades, "LEGACY")


def main():
    parser = argparse.ArgumentParser(description="Sync trades from brokers to Watchlist Panel")
    parser.add_argument("--zerodha", action="store_true", help="Sync Zerodha only")
    parser.add_argument("--sahi", action="store_true", help="Sync SAHI only")
    parser.add_argument("--upstox", action="store_true", help="Sync Upstox only")
    parser.add_argument("--indmoney", action="store_true", help="Sync INDmoney only")
    parser.add_argument("--days", type=int, default=3, help="Fetch contract notes from last N days (default: 3)")
    args = parser.parse_args()

    sync_all = not (args.zerodha or args.sahi or args.upstox or args.indmoney)

    print(f"Trade Sync Pipeline")
    print(f"  Panel: {PANEL_URL}")
    print(f"  Date range: last {args.days} days")
    print(f"  PAN configured: {'Yes' if get_pan() else 'No'}")
    print(f"  Upstox token: {'Yes' if get_upstox_token() else 'No'}")

    state = load_sync_state()

    # Gmail-based syncs
    if sync_all or args.zerodha or args.sahi or args.upstox or args.indmoney:
        service = get_gmail_service()
        if not service:
            print("Gmail not available. Skipping email-based syncs.")
        else:
            if sync_all or args.zerodha:
                sync_broker_from_gmail(service, "ZERODHA", args.days)
            if sync_all or args.sahi:
                sync_broker_from_gmail(service, "SAHI", args.days)
            if sync_all or args.upstox:
                sync_broker_from_gmail(service, "UPSTOX", args.days)
            if sync_all or args.indmoney:
                sync_broker_from_gmail(service, "INDMONEY", args.days)

    # Upstox API sync (holdings + today's trades)
    if sync_all or args.upstox:
        sync_upstox()

    # Save state
    state["last_sync"] = datetime.now().isoformat()
    save_sync_state(state)

    print(f"\n{'='*60}")
    print(f"  Sync complete at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
