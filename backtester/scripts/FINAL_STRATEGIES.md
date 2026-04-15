# Final Strategy Lineup — Backtested 2012-2026

Survivorship-bias-free. Dynamic universe (NSE reconstitutions replayed).
458 stocks. Natural exits (no forced close). Close-price execution (3:20 PM scanner).

## Primary (Always On — Mean Reversion)

### 1. BB_RSI_REVERT
- **BUY:** Price ≤ Lower Bollinger Band AND RSI(14) < 30
- **SELL:** Price ≥ Middle Bollinger Band OR RSI > 70
- **Performance:** 6/6 periods positive, 14.0% Active CAGR, 16d avg hold, 2.4% spill
- **Best in:** 2024-26 (100.6%), 2015-18 (95.5%), 2022-24 (77.1%)

### 2. STOCH_RSI_DBL
- **BUY:** Stochastic %K(14) < 20 AND RSI(14) < 35 AND %K crosses above %D
- **SELL:** %K > 80 AND RSI > 65 AND %K crosses below %D
- **Performance:** 6/6 periods positive, 55.9% Active CAGR, 101d avg hold, 12.1% spill
- **Best in:** 2020-22 (140.8%), 2015-18 (62.2%), 2022-24 (60.5%)

### 3. RSI_OB_OS
- **BUY:** RSI(14) crosses above 30 from below
- **SELL:** RSI(14) crosses below 70 from above
- **Performance:** 6/6 periods positive, 46.7% Active CAGR, 98d avg hold, 10.4% spill
- **Best in:** 2020-22 (100.1%), 2022-24 (54.3%), 2012-15 (50.0%)

## Secondary (Always On — Breakout + Momentum)

### 4. CANSLIM
- **BUY:** Price > SMA(50) AND Volume > 1.5× avg(20) AND within 10% of 52W high AND RSI 50-80
- **SELL:** Price < SMA(50) OR -8% stop loss from entry
- **Performance:** 5/6 positive, 48.3% Active CAGR, 30d avg hold, 7.2% spill
- **Best in:** 2012-15 (90.4%), 2020-22 (84.2%), 2022-24 (57.8%)
- **Fails in:** 2018-20 (-12.1%) — systemic crisis, breakouts are traps

### 5. DUAL_MOMENTUM (Improved — MACD<0 exit)
- **BUY:** Price > SMA(200) AND in top 75% of 52W range AND MACD(12,26,9) > 0
- **SELL:** Price < SMA(200) OR drops below 50% of 52W range OR MACD < 0
- **Performance:** 5/6 positive, ~28% Active CAGR, 38d avg hold
- **Best in:** 2020-22 (40.5%), 2022-24 (38.8%), 2012-15 (29.8%)
- **Fails in:** 2018-20 (-11.7%) — bear rally false signals

## Conditional (Trend Markets Only)

### 6. SUPERTREND
- **BUY:** Supertrend(10, 3.0) direction flips from bearish to bullish
- **SELL:** Direction flips from bullish to bearish
- **Performance:** 4/6 positive, 18.1% Active CAGR, 44d avg hold
- **Activate when:** Nifty shows clear directional trend (ADX > 25 on index)
- **Park when:** Choppy/sideways market (like 2024-26)

## Signal Overlap (confirmed via data)
- BB_RSI × STOCH_RSI: 4.0% overlap
- BB_RSI × RSI_OB_OS: 0.0% overlap
- BB_RSI × CANSLIM: 0.0% overlap
- SUPERTREND × mean-rev: 0.0% overlap
- CANSLIM × DUAL_MOM: independent (different logic)
- When BB_RSI + STOCH_RSI fire together: 64.8% WR, 2.79% avg 20d return (conviction signal)

## Removed
- STOCHASTIC — too noisy (14K trades, weakest mean-rev)
- MINERVINI — 33% overlap with CANSLIM, CANSLIM is better
- TURTLE — redundant with Supertrend
- SMA_50_200 / EMA_50_200 — 200d+ hold, 37% spill, too slow
- EMA_12_26 / EMA_20_50 — redundant trend strategies
- BB_SQUEEZE — 196d hold, too slow
- ADX_EMA — backward-looking ADX problem
- ADX_DI_CROSS — noisy
- JHUNJHUNWALA — broken, never exits
- OBV_EMA / VWAP_CROSS / PRICE_x_EMA50 — too noisy
