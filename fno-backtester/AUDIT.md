# F&O Backtester — Honest Audit Report

## What was tested
- 12 years of **real** Nifty spot data (2013-2025, 3,033 trading days from Upstox API)
- 10 positional strategies + 2 intraday (not tested — need 1-min data)
- ₹5L capital, max 3 positions, 3% per-trade SL, 5% daily loss limit

## Square-Off Conditions (what triggers an exit)

| Condition | How it works in code |
|-----------|---------------------|
| **Target Hit** | Combined premium decays X% from entry (strategy-specific: 20-60%) |
| **Stop Loss** | Combined premium rises X% from entry (strategy-specific: 20-80%) |
| **Time Exit** | DTE drops to `exitDte` param (set to 2 = square off 2 days before expiry) |
| **Danger Exit** | For deep OTM: spot moves within `dangerBufferPts` of strike |
| **Risk Breach** | Portfolio delta/gamma/vega exceeds limits → force close |
| **Daily Loss** | Day's total loss > 5% of capital → close everything |
| **Expiry Settlement** | If somehow still open at expiry → ITM settles at intrinsic, OTM = 0 |
| **Backtest End** | Force close everything on last day of data |

---

## CRITICAL FLAWS (things that make results UNRELIABLE)

### 1. SYNTHETIC OPTION PRICES (Severity: CRITICAL)

**The problem:** We don't have real historical option chain data. All option premiums are computed using Black-Scholes formula from spot price + estimated IV.

**What BS gets wrong:**
- BS assumes flat volatility across all strikes → reality has volatility smile/skew
- BS systematically overprices options by 4-46% depending on conditions
- BS doesn't capture: jump risk, supply/demand imbalances, liquidity
- BS doesn't capture event-driven IV spikes (RBI, Budget, elections)
- Far OTM options in real markets have HIGHER premiums than BS predicts (tail risk pricing)

**Impact on our results:**
- **Long Straddle (+441%)** — likely INFLATED. BS overprices what we're buying, so the backtest overpays on entry. But the 20% target/SL exits are based on BS prices changing, which may be internally consistent. Still, the absolute P&L numbers are unreliable.
- **Short Straddle/Strangle** — BS underprices the tail risk. Real crashes cause bigger losses than BS predicts.
- **Deep OTM Sell** — BS gives near-zero premiums for 500pt OTM options. In reality, these trade at ₹30-80 due to tail risk premium. Our backtest can't capture this edge.

**Verdict: ALL absolute P&L numbers should be treated as directional indicators, NOT precise forecasts.**

### 2. NO BID-ASK SPREAD (Severity: HIGH)

**The problem:** We assume you can buy/sell at the BS mid-price. Reality:
- ATM Nifty options: ₹0.50-1.00 spread per trade
- Near OTM: ₹1-2 spread
- Far OTM: ₹2-3.50 spread (50%+ of premium for cheap options!)

**Impact:** Each trade loses ₹0.50-3.50 per lot more than the backtest shows.
- Over 636 iron condor trades (4 legs each): 636 × 4 legs × ₹1 spread × 75 lot = **₹1.9L** in hidden costs
- Over 989 long straddle trades (2 legs): 989 × 2 × ₹1 × 75 = **₹1.5L**

**Our mitigation:** We have a `slippageBps: 5` setting (0.05% slippage), but this is too low for real options. Should be 0.5-1%.

### 3. NO TRANSACTION COSTS (Severity: MEDIUM-HIGH)

**Missing costs per trade:**
- Brokerage: ~₹20/order (discount broker)
- STT: 0.05% of premium on sell side
- Exchange fees: 0.05%
- GST: 18% on brokerage

**Per round-trip (buy + sell):** ~₹40-80 per lot
- Over 989 trades: **₹40K-80K** in missing costs
- This is 8-16% of capital — significant

### 4. MARK-TO-MARKET USES BS THEORETICAL (Severity: HIGH)

**The problem:** During the backtest, we recalculate option prices using `blackScholesPrice()` every day. This means:
- The equity curve is based on theoretical prices, not what you'd actually get
- Drawdowns may be understated (BS smooths out jumps)
- Target/SL triggers are based on BS price changes, not real premium movements

**Why this matters:** A real ₹100 premium option might move to ₹70 in reality (30% drop) but BS says it's still ₹85 (15% drop). Your target wouldn't trigger when it should.

### 5. IV ESTIMATION IS BACKWARDS-LOOKING (Severity: MEDIUM)

**The problem:** We estimate IV from the last 20 days of realized volatility:
```
returns over 20 days → std dev → annualize → use as IV
```

This is **realized vol**, not **implied vol**. In reality:
- IV is FORWARD-looking (what the market expects)
- IV is typically 2-5% higher than realized vol (volatility risk premium)
- IV spikes BEFORE events (RBI, Budget) — our model doesn't capture this

### 6. SINGLE EXPIRY CHAIN (Severity: MEDIUM)

**The problem:** Each day, we build a chain for the nearest weekly expiry only. Calendar spread needs TWO expiry series — our model fakes the far expiry. This is why calendar spread shows -1.4% with 0.1% win rate.

### 7. NO MARGIN CALL SIMULATION (Severity: MEDIUM)

**The problem:** We check margin at entry but don't simulate intraday SPAN margin changes. In reality:
- Short option margin spikes when spot moves against you
- Broker may issue margin call → forced liquidation at worst price
- Our backtest assumes you always have enough margin

### 8. OVERFITTING RISK (Severity: MEDIUM)

**What we did:** Tested 10+ strategies with 5-10 params each, tried multiple exit combinations. Over the same 12-year dataset.

**The risk:** With 100+ backtests on the same data, there's ~60-80% probability that the "best" result is due to overfitting, not genuine edge.

**What we didn't do:** No out-of-sample testing. No walk-forward validation. No train/test split.

---

## THINGS WE GOT RIGHT

| Feature | Status | Details |
|---------|--------|---------|
| Real spot data | ✅ | 3,033 days of actual Nifty OHLCV from Upstox |
| 12-year span | ✅ | Covers bull, bear, crash, recovery, sideways |
| Smart expiry | ✅ | Skip to next week if DTE < 2 |
| Exit discipline | ✅ | Target, SL, time exit, danger exit all coded |
| Risk limits | ✅ | Greeks limits, daily loss cap, max positions |
| No look-ahead | ✅ | Each day only uses data available up to that day |
| Sequential processing | ✅ | Candles processed in chronological order |
| Multiple strategies | ✅ | 12 diverse strategies tested identically |

---

## WHAT THE RESULTS ACTUALLY TELL YOU

### Reliable conclusions (trust these):
1. **Relative ranking** — if Strategy A beats Strategy B over 12 years, A is genuinely better
2. **Win rate patterns** — 70% WR on iron condor is directionally correct
3. **Regime behavior** — which strategies survive crashes vs which don't
4. **Exit rule impact** — tighter exits clearly outperform holding to expiry

### Unreliable conclusions (don't trust these):
1. **Absolute returns** — +441% on long straddle is NOT what you'd get in real trading
2. **Exact P&L per trade** — ₹2,229/trade on long straddle is BS-derived, not real
3. **Sharpe ratio** — inflated/deflated due to synthetic prices
4. **Max drawdown** — likely UNDERSTATED (BS smooths out real jumps)

---

## WHAT YOU NEED FOR REAL RESULTS

1. **Real historical option chain data** — Services: Opstra (₹5K/yr), TrueData (₹3K/yr), Global Datafeeds
2. **Add transaction costs** — ₹40-80 per round-trip per lot
3. **Add realistic slippage** — 0.5-1% per leg, not 0.05%
4. **Out-of-sample testing** — Use 2013-2020 for training, 2021-2025 for validation
5. **Walk-forward optimization** — Re-optimize params every quarter on rolling window
6. **Paper trade for 1 month** — Before deploying real money

---

## BOTTOM LINE

This backtester is a **strategy research tool**, not a P&L predictor. Use it to:
- ✅ Compare strategies against each other
- ✅ Validate entry/exit logic
- ✅ Test across market regimes
- ✅ Find which strategies to AVOID (anything negative over 12 years is genuinely bad)

Don't use it to:
- ❌ Predict exact returns
- ❌ Size positions based on backtest P&L
- ❌ Skip paper trading because "backtest showed profit"
