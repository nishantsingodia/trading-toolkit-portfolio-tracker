#!/bin/bash
# Start the Upstox MCP server
# Run this BEFORE starting Claude Code each day
# Then authenticate at http://localhost:8787

cd "$(dirname "$0")"
echo "Starting Upstox MCP server..."
echo "After it starts, open http://localhost:8787 in your browser to log in with Upstox."
echo ""
npm run start
