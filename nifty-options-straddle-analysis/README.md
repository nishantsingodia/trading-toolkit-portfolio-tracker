# NIFTY & BANKNIFTY Straddle Analysis

Options straddle strategy analysis for Indian derivatives markets.

**Date:** March 12, 2026

## Files

| File | Description |
|------|-------------|
| `analysis.md` | Full 6-phase analysis report (data, regime, technicals, strategies, payoffs, monitoring) |
| `payoff_calculator.py` | Payoff table and ASCII chart generator for both strategies |
| `monitor.py` | Position monitoring dashboard with alert levels and scenario analysis |

## Strategies

1. **NIFTY Iron Butterfly** (23,350 / 23,850 / 24,350) — Mar 17 expiry
2. **BANKNIFTY Long Straddle** (56,000 CE + PE) — Mar 26 expiry

## Usage

```bash
# Generate payoff tables and charts
python3 payoff_calculator.py

# Run monitoring dashboard with current market state
python3 monitor.py
```

## Data Sources

Market data sourced from: NSE India, Yahoo Finance, TradingView, Investing.com, Trendlyne, Business Standard.

**Note:** Upstox MCP server does not currently expose market data tools (option chains, index quotes, VIX).
Only account/portfolio tools are available. Market data was sourced from public web sources.
