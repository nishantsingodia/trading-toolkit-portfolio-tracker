#!/usr/bin/env python3
"""
Gmail API OAuth Setup
=====================
Run once to authorize Gmail access for contract note fetching.

Prerequisites:
1. Go to console.cloud.google.com
2. Create project → Enable Gmail API
3. Create OAuth Desktop credentials
4. Download as credentials.json to this folder

Usage:
  python3 scripts/gmail_setup.py
"""

import os, json

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CREDS_FILE = os.path.join(SCRIPT_DIR, "credentials.json")
TOKEN_FILE = os.path.join(SCRIPT_DIR, "token.json")

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

def setup():
    if not os.path.exists(CREDS_FILE):
        print(f"ERROR: {CREDS_FILE} not found!")
        print("Download OAuth credentials from Google Cloud Console and save as credentials.json in scripts/")
        return False

    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request

    creds = None

    # Check if token already exists
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            print("Refreshing expired token...")
            creds.refresh(Request())
        else:
            print("Opening browser for Gmail authorization...")
            print("  - Select your Google account")
            print("  - Allow 'Read-only' Gmail access")
            flow = InstalledAppFlow.from_client_secrets_file(CREDS_FILE, SCOPES)
            creds = flow.run_local_server(port=9999)

        # Save token
        with open(TOKEN_FILE, "w") as f:
            f.write(creds.to_json())
        print(f"Token saved to {TOKEN_FILE}")

    # Test connection
    from googleapiclient.discovery import build
    service = build("gmail", "v1", credentials=creds)
    profile = service.users().getProfile(userId="me").execute()
    print(f"\nGmail connected: {profile['emailAddress']}")
    print(f"Total messages: {profile['messagesTotal']}")

    # Test: search for Zerodha contract notes
    results = service.users().messages().list(
        userId="me",
        q="from:no-reply-contract-notes@reportsmailer.zerodha.net subject:Combined Equity Contract Note has:attachment",
        maxResults=5
    ).execute()
    messages = results.get("messages", [])
    print(f"Zerodha contract notes found: {len(messages)} (showing latest 5)")

    # Test: search for SAHI contract notes
    results2 = service.users().messages().list(
        userId="me",
        q="from:no-reply@sahi.com subject:Digital Contract Note has:attachment",
        maxResults=5
    ).execute()
    messages2 = results2.get("messages", [])
    print(f"SAHI contract notes found: {len(messages2)} (showing latest 5)")

    print("\nSetup complete! You can now run: python3 scripts/sync_trades.py")
    return True

if __name__ == "__main__":
    setup()
