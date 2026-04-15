#!/usr/bin/env python3
"""
Local Sync Server — runs alongside wrangler dev.
Listens on port 9876 for sync trigger from the panel.
Start: python3 scripts/sync_server.py
"""

import http.server
import subprocess
import json
import os
import sys

PORT = 9876
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SYNC_SCRIPT = os.path.join(SCRIPT_DIR, "sync_trades.py")

class SyncHandler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        if self.path == "/sync":
            try:
                self.wfile.write(json.dumps({"status": "running"}).encode())
                self.wfile.flush()

                result = subprocess.run(
                    [sys.executable, SYNC_SCRIPT, "--days", "3"],
                    capture_output=True, text=True, timeout=300,
                    cwd=os.path.dirname(SCRIPT_DIR),
                )

                # Log output
                if result.stdout:
                    print(result.stdout)
                if result.stderr:
                    # Filter out warnings
                    for line in result.stderr.split('\n'):
                        if line and 'Warning' not in line and 'warning' not in line:
                            print(line)

            except Exception as e:
                print(f"Sync error: {e}")
        else:
            self.wfile.write(json.dumps({"error": "Unknown endpoint"}).encode())

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        if self.path == "/status":
            sync_state = os.path.join(SCRIPT_DIR, ".sync_state.json")
            if os.path.exists(sync_state):
                with open(sync_state) as f:
                    state = json.load(f)
                self.wfile.write(json.dumps(state).encode())
            else:
                self.wfile.write(json.dumps({"last_sync": "never"}).encode())
        else:
            self.wfile.write(json.dumps({"status": "ok", "port": PORT}).encode())

    def log_message(self, format, *args):
        # Suppress default logging
        pass

if __name__ == "__main__":
    print(f"Sync server running on http://localhost:{PORT}")
    print(f"  POST /sync — trigger trade sync")
    print(f"  GET /status — last sync time")
    server = http.server.HTTPServer(("", PORT), SyncHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nSync server stopped")
