import { Env, GetHoldingsArgs } from "./types";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { STOCK_MASTER } from "./data/stock-master";
import { UPSTOX_API_BASE_URL, UPSTOX_API_HOLDINGS_ENDPOINT, HEADERS } from "./constants";
import {
  getProfileSchema, getProfileHandler,
  getFundsMarginSchema, getFundsMarginHandler,
  getHoldingsSchema, getHoldingsHandler,
  getPositionsSchema, getPositionsHandler,
  getMtfPositionsSchema, getMtfPositionsHandler,
  getOrderBookSchema, getOrderBookHandler,
  getOrderDetailsSchema, getOrderDetailsHandler,
  getTradesSchema, getTradesHandler,
  getOrderTradesSchema, getOrderTradesHandler,
  getOrderHistorySchema, getOrderHistoryHandler,
  getMarketQuotesSchema, getMarketQuotesHandler,
  getLtpQuotesSchema, getLtpQuotesHandler,
  getOhlcQuotesSchema, getOhlcQuotesHandler,
  getOptionChainSchema, getOptionChainHandler,
  getOptionContractsSchema, getOptionContractsHandler,
  getMarketStatusSchema, getMarketStatusHandler,
  getHistoricalCandlesSchema, getHistoricalCandlesHandler,
  runBacktestSchema, runBacktestHandler,
  compareStrategiesSchema, compareStrategiesHandler,
  optimizeStrategySchema, optimizeStrategyHandler,
  suggestStrategiesSchema, suggestStrategiesHandler,
  // F&O Backtester
  runFnoBacktestSchema, runFnoBacktestHandler,
  compareFnoStrategiesSchema, compareFnoStrategiesHandler,
  optimizeFnoStrategySchema, optimizeFnoStrategyHandler,
  suggestFnoStrategiesSchema, suggestFnoStrategiesHandler,
  // Watchlist & Portfolio
  initWatchlistTables,
  showWatchlistSchema, showWatchlistHandler,
  addToWatchlistSchema, addToWatchlistHandler,
  removeFromWatchlistSchema, removeFromWatchlistHandler,
  scanWatchlistSchema, scanWatchlistHandler,
  backfillSnapshotsSchema, backfillSnapshotsHandler,
  recordTradeSchema, recordTradeHandler, RecordTradeArgs,
  showPositionsSchema, showPositionsHandler,
  listTradesHandler,
  updateTradeHandler,
  deleteTradeHandler,
  importTradesHandler,
  strategyPortfolioHandler,
  autoTagStrategyHandler,
  checkAuthSchema, checkAuthHandler,
} from "./tools";

const OAUTH_REDIRECT_PATH = "/api/auth/callback";

export class MyMCP extends McpAgent {
	env: Env;
	server = new McpServer({
		name: "Upstox MCP",
		version: "1.0.0",
	});
	constructor(ctx: any, env: any) {
		super(ctx, env);
		this.env = env;
	}

	/** Get the active token — DB override first, then env fallback */
	getActiveToken(): string {
		try {
			const rows = [...(this as any).sql`SELECT value FROM config WHERE key = 'access_token'`];
			if (rows.length > 0 && (rows[0] as any).value) {
				return (rows[0] as any).value;
			}
		} catch {}
		return this.env.UPSTOX_ACCESS_TOKEN;
	}

	/** Get env with the active token */
	getActiveEnv(): Env {
		return { ...this.env, UPSTOX_ACCESS_TOKEN: this.getActiveToken() };
	}

	// REST API for the web dashboard
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/api/")) {
			// Ensure tables exist
			initWatchlistTables(this as any);

			// CORS headers
			const cors = {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
			};

			if (request.method === "OPTIONS") {
				return new Response(null, { headers: cors });
			}

			try {
				const json = (result: any) =>
					new Response(JSON.stringify(result), {
						headers: { "Content-Type": "application/json", ...cors },
					});

				const extractText = (result: any) => {
					const text = result?.content?.[0]?.text;
					return text ? JSON.parse(text) : result;
				};

				const activeEnv = this.getActiveEnv();

				// GET /api/auth/login — returns OAuth URL, opens in popup
				if (url.pathname === "/api/auth/login" && request.method === "GET") {
					const redirectUri = `${url.origin}${OAUTH_REDIRECT_PATH}`;
					const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${activeEnv.UPSTOX_API_KEY}&redirect_uri=${encodeURIComponent(redirectUri)}`;
					return json({ auth_url: authUrl });
				}

				// GET /api/auth/callback?code=xxx — exchange code for token
				if (url.pathname === OAUTH_REDIRECT_PATH && request.method === "GET") {
					const code = url.searchParams.get("code");
					if (!code) {
						return new Response("<h2>Authorization failed — no code received.</h2>", {
							headers: { "Content-Type": "text/html" },
						});
					}

					const redirectUri = `${url.origin}${OAUTH_REDIRECT_PATH}`;
					const tokenResp = await fetch("https://api.upstox.com/v2/login/authorization/token", {
						method: "POST",
						headers: {
							Accept: "application/json",
							"Content-Type": "application/x-www-form-urlencoded",
						},
						body: new URLSearchParams({
							code,
							client_id: activeEnv.UPSTOX_API_KEY,
							client_secret: activeEnv.UPSTOX_API_SECRET,
							redirect_uri: redirectUri,
							grant_type: "authorization_code",
						}).toString(),
					});

					if (!tokenResp.ok) {
						const err = await tokenResp.text();
						return new Response(`<h2>Token exchange failed</h2><pre>${err}</pre>`, {
							headers: { "Content-Type": "text/html" },
						});
					}

					const tokenData = (await tokenResp.json()) as { access_token?: string };
					if (!tokenData.access_token) {
						return new Response("<h2>No access token in response</h2>", {
							headers: { "Content-Type": "text/html" },
						});
					}

					// Save token to DB for runtime use
					(this as any).sql`INSERT OR REPLACE INTO config (key, value) VALUES ('access_token', ${tokenData.access_token})`;

					return new Response(`
						<html><body style="background:#0d1117;color:#e6edf3;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
						<div style="text-align:center">
							<h2 style="color:#3fb950">Authenticated Successfully!</h2>
							<p>This window will close automatically...</p>
							<script>setTimeout(() => window.close(), 1500);</script>
						</div>
						</body></html>
					`, { headers: { "Content-Type": "text/html" } });
				}

				// GET /api/watchlist?category=ALL
				if (url.pathname === "/api/watchlist" && request.method === "GET") {
					const cat = url.searchParams.get("category") || "ALL";
					const result = await showWatchlistHandler({ category: cat }, activeEnv, this as any);
					return json(extractText(result));
				}

				// POST /api/watchlist { symbol, instrument_key, category }
				if (url.pathname === "/api/watchlist" && request.method === "POST") {
					const body = await request.json() as any;
					const result = await addToWatchlistHandler(body, activeEnv, this as any);
					return json(extractText(result));
				}

				// DELETE /api/watchlist?symbol=XYZ
				if (url.pathname === "/api/watchlist" && request.method === "DELETE") {
					const symbol = url.searchParams.get("symbol") || "";
					const result = await removeFromWatchlistHandler({ symbol }, activeEnv, this as any);
					return json(extractText(result));
				}

				// GET /api/scan?category=ALL — full scan (may be slow)
				if (url.pathname === "/api/scan" && request.method === "GET") {
					const cat = url.searchParams.get("category") || "ALL";
					const result = await scanWatchlistHandler({ category: cat }, activeEnv, this as any);
					return json(extractText(result));
				}

				// POST /api/scan/backfill — backfill historical scan snapshots from cached candles
				if (url.pathname === "/api/scan/backfill" && request.method === "POST") {
					const body = await request.json() as any;
					const result = await backfillSnapshotsHandler({ dates: body?.dates }, activeEnv, this as any);
					return json(extractText(result));
				}

				// GET /api/scan/list — get watchlist symbols (fast, no candle fetch)
				if (url.pathname === "/api/scan/list" && request.method === "GET") {
					const cat = url.searchParams.get("category") || "ALL";
					let rows: any[];
					if (cat === "ALL") {
						rows = [...(this as any).sql`SELECT symbol, instrument_key, category FROM watchlist ORDER BY category, symbol`];
					} else {
						rows = [...(this as any).sql`SELECT symbol, instrument_key, category FROM watchlist WHERE category = ${cat} ORDER BY symbol`];
					}
					const posRows = [...(this as any).sql`SELECT symbol, SUM(CASE WHEN action='BUY' THEN quantity ELSE -quantity END) as net_qty FROM positions GROUP BY symbol HAVING net_qty > 0`];
					const invested = new Set((posRows as any[]).map((r: any) => r.symbol));
					return json({
						total: rows.length,
						stocks: rows.map((r: any) => ({
							symbol: r.symbol,
							instrument_key: r.instrument_key,
							category: r.category,
							invested: invested.has(r.symbol),
						})),
					});
				}

				// GET /api/positions?show_closed=false&portfolio=STRATEGY
				if (url.pathname === "/api/positions" && request.method === "GET") {
					const showClosed = url.searchParams.get("show_closed") === "true";
					const portfolio = url.searchParams.get("portfolio") || undefined;
					const result = await showPositionsHandler({ show_closed: showClosed, portfolio }, activeEnv, this as any);
					return json(extractText(result));
				}

				// POST /api/trade { symbol, action, price, quantity, trade_date }
				if (url.pathname === "/api/trade" && request.method === "POST") {
					const body = await request.json() as any;
					const result = await recordTradeHandler(body, activeEnv, this as any);
					return json(extractText(result));
				}

				// GET /api/trades?symbol=XYZ
				if (url.pathname === "/api/trades" && request.method === "GET") {
					const symbol = url.searchParams.get("symbol") || undefined;
					const result = await listTradesHandler({ symbol }, activeEnv, this as any);
					return json(extractText(result));
				}

				// PUT /api/trade { id, price?, quantity?, trade_date?, action? }
				if (url.pathname === "/api/trade" && request.method === "PUT") {
					const body = await request.json() as any;
					const result = await updateTradeHandler(body, activeEnv, this as any);
					return json(extractText(result));
				}

				// DELETE /api/trade?id=123
				if (url.pathname === "/api/trade" && request.method === "DELETE") {
					const id = parseInt(url.searchParams.get("id") || "0");
					if (!id) return json({ error: "Missing trade id" });
					const result = await deleteTradeHandler({ id }, activeEnv, this as any);
					return json(extractText(result));
				}

				// POST /api/trades/import — bulk import
				if (url.pathname === "/api/trades/import" && request.method === "POST") {
					const body = await request.json() as any;
					const result = await importTradesHandler(body, activeEnv, this as any);
					return json(extractText(result));
				}

				// GET /api/portfolio/strategy — strategy portfolio P&L
				if (url.pathname === "/api/portfolio/strategy" && request.method === "GET") {
					const result = await strategyPortfolioHandler({} as Record<string, never>, activeEnv, this as any);
					return json(extractText(result));
				}

				// PUT /api/trades/portfolio — update portfolio tag for a trade
				if (url.pathname === "/api/trades/portfolio" && request.method === "PUT") {
					const body = await request.json() as { id: number; portfolio: string };
					if (!body.id || !body.portfolio) return json({ error: "Missing id or portfolio" });
					(this as any).sql`UPDATE positions SET portfolio = ${body.portfolio}, signal_strategy = NULL WHERE id = ${body.id}`;
					return json({ updated: body.id, portfolio: body.portfolio });
				}

				// POST /api/trades/auto-tag — match trades against scanner signals
				if (url.pathname === "/api/trades/auto-tag" && request.method === "POST") {
					// Run scanner first to get current signals
					const scanResult = await scanWatchlistHandler({ category: "ALL" }, activeEnv, this as any);
					const scanText = scanResult?.content?.[0]?.text;
					const scanData = scanText ? JSON.parse(scanText) : {};
					const stocks = scanData.stocks || [];

					const result = await autoTagStrategyHandler({ scan_results: stocks }, activeEnv, this as any);
					return json(extractText(result));
				}

				// GET /api/cache/status — candle cache status
				if (url.pathname === "/api/cache/status" && request.method === "GET") {
					const totalStocks = [...(this as any).sql`SELECT COUNT(DISTINCT symbol) as cnt FROM candle_cache`] as any[];
					const totalCandles = [...(this as any).sql`SELECT COUNT(*) as cnt FROM candle_cache`] as any[];
					const latestDate = [...(this as any).sql`SELECT MAX(trade_date) as d FROM candle_cache`] as any[];
					const watchlistCount = [...(this as any).sql`SELECT COUNT(*) as cnt FROM watchlist`] as any[];
					return json({
						cached_stocks: totalStocks[0]?.cnt || 0,
						total_watchlist: watchlistCount[0]?.cnt || 0,
						total_candles: totalCandles[0]?.cnt || 0,
						latest_date: latestDate[0]?.d || null,
					});
				}

				// DELETE /api/cache — clear candle cache (force refresh)
				if (url.pathname === "/api/cache" && request.method === "DELETE") {
					(this as any).sql`DELETE FROM candle_cache`;
					return json({ cleared: true, message: "Cache cleared. Next scan will rebuild." });
				}

				// POST /api/sync — trigger trade sync (runs Python script)
				if (url.pathname === "/api/sync" && request.method === "POST") {
					try {
						// Run sync_trades.py via shell
						const proc = await import("node:child_process").catch(() => null);
						// In Workers we can't run shell commands, so we return instructions
						// The frontend will call the sync script endpoint differently
						return json({
							message: "Sync triggered. Run: python3 scripts/sync_trades.py",
							hint: "Use the button to trigger sync via local script"
						});
					} catch {
						return json({ error: "Sync not available in Workers runtime" });
					}
				}

				// GET /api/upstox/holdings — proxy to Upstox holdings API
				if (url.pathname === "/api/upstox/holdings" && request.method === "GET") {
					try {
						const response = await fetch(`${UPSTOX_API_BASE_URL}${UPSTOX_API_HOLDINGS_ENDPOINT}`, {
							headers: { Accept: HEADERS.ACCEPT, Authorization: `Bearer ${activeEnv.UPSTOX_ACCESS_TOKEN}` },
						});
						if (!response.ok) return json({ error: "Holdings fetch failed", status: response.status });
						const data = await response.json();
						return json(data);
					} catch (e) {
						return json({ error: String(e) });
					}
				}

				// GET /api/ltp?keys=NSE_EQ|INE...,NSE_EQ|INE...
				if (url.pathname === "/api/ltp" && request.method === "GET") {
					const keys = url.searchParams.get("keys") || "";
					if (!keys) return json({ error: "Missing keys param" });
					try {
						const response = await fetch(
							`${UPSTOX_API_BASE_URL}/v2/market-quote/ltp?instrument_key=${encodeURIComponent(keys)}`,
							{
								headers: {
									Accept: HEADERS.ACCEPT,
									Authorization: `Bearer ${activeEnv.UPSTOX_ACCESS_TOKEN}`,
								},
							}
						);
						if (!response.ok) return json({ error: "LTP fetch failed" });
						const data = (await response.json()) as {
							data?: Record<string, { last_price?: number; instrument_token?: string }>;
						};
						// Return simple map: instrument_key → ltp
						const ltpMap: Record<string, number> = {};
						if (data.data) {
							for (const val of Object.values(data.data)) {
								if (val.last_price != null && val.instrument_token) {
									ltpMap[val.instrument_token] = val.last_price;
								}
							}
						}
						return json(ltpMap);
					} catch {
						return json({ error: "LTP fetch error" });
					}
				}

				// GET /api/fno/scan?underlying=NIFTY
				if (url.pathname === "/api/fno/scan" && request.method === "GET") {
					const underlying = (url.searchParams.get("underlying") || "NIFTY").toUpperCase();
					const indexKey = underlying === "BANKNIFTY" ? "NSE_INDEX|Nifty Bank" : "NSE_INDEX|Nifty 50";

					try {
						// 1. Fetch live LTP
						const ltpRes = await fetch(
							`${UPSTOX_API_BASE_URL}/v2/market-quote/ltp?instrument_key=${encodeURIComponent(indexKey)}`,
							{ headers: { Accept: HEADERS.ACCEPT, Authorization: `Bearer ${activeEnv.UPSTOX_ACCESS_TOKEN}` } }
						);
						const ltpJson = (await ltpRes.json()) as any;
						const ltpEntry = ltpJson.data ? Object.values(ltpJson.data)[0] as any : null;
						const spotPrice = ltpEntry?.last_price ?? 0;

						// 2. Fetch option chain for nearest expiry
						const today = new Date().toISOString().slice(0, 10);

						// Fetch actual expiry dates from Upstox — get MULTIPLE upcoming expiries
						let upcomingExpiries: string[] = [];
						let nearestExpiry = "";
						try {
							const contractsRes = await fetch(
								`${UPSTOX_API_BASE_URL}/v2/option/contract?instrument_key=${encodeURIComponent(indexKey)}`,
								{ headers: { Accept: HEADERS.ACCEPT, Authorization: `Bearer ${activeEnv.UPSTOX_ACCESS_TOKEN}` } }
							);
							const contractsJson = (await contractsRes.json()) as any;
							const allExpiries = new Set<string>();
							for (const c of (contractsJson.data || [])) {
								if (c.expiry) allExpiries.add(c.expiry.slice(0, 10));
							}
							const sortedExpiries = [...allExpiries].sort();
							// Get next 4 expiries with DTE >= 2
							for (const exp of sortedExpiries) {
								if (exp < today) continue;
								const dteCheck = Math.round((new Date(exp).getTime() - new Date(today).getTime()) / 86400000);
								if (dteCheck >= 2) {
									upcomingExpiries.push(exp);
									if (upcomingExpiries.length >= 4) break;
								}
							}
							nearestExpiry = upcomingExpiries[0] || today;
						} catch {
							const d = new Date();
							while (d.getDay() !== 4) d.setDate(d.getDate() + 1);
							nearestExpiry = d.toISOString().slice(0, 10);
							upcomingExpiries = [nearestExpiry];
						}

						const chainRes = await fetch(
							`${UPSTOX_API_BASE_URL}/v2/option/chain?instrument_key=${encodeURIComponent(indexKey)}&expiry_date=${encodeURIComponent(nearestExpiry)}`,
							{ headers: { Accept: HEADERS.ACCEPT, Authorization: `Bearer ${activeEnv.UPSTOX_ACCESS_TOKEN}` } }
						);
						const chainJson = (await chainRes.json()) as any;
						const chainData = chainJson.data || [];

						// 3. Analyze chain
						let totalCallOI = 0, totalPutOI = 0;
						let maxCallOI = 0, maxCallOIStrike = 0;
						let maxPutOI = 0, maxPutOIStrike = 0;
						let atmIV = 0;
						const ivs: number[] = [];
						let atmStrike = Math.round(spotPrice / 50) * 50;

						// Max pain calculation
						const strikes: Array<{ strike: number; callOI: number; putOI: number; callIV: number; putIV: number; callPrice: number; putPrice: number }> = [];

						for (const row of chainData) {
							const strike = row.strike_price ?? 0;
							const callOI = row.call_options?.market_data?.oi ?? 0;
							const putOI = row.put_options?.market_data?.oi ?? 0;
							const callIV = row.call_options?.market_data?.iv ?? 0;
							const putIV = row.put_options?.market_data?.iv ?? 0;
							const callPrice = row.call_options?.market_data?.ltp ?? 0;
							const putPrice = row.put_options?.market_data?.ltp ?? 0;

							totalCallOI += callOI;
							totalPutOI += putOI;
							if (callOI > maxCallOI) { maxCallOI = callOI; maxCallOIStrike = strike; }
							if (putOI > maxPutOI) { maxPutOI = putOI; maxPutOIStrike = strike; }

							if (callIV > 0) ivs.push(callIV);
							if (putIV > 0) ivs.push(putIV);

							if (strike === atmStrike) atmIV = ((callIV || 0) + (putIV || 0)) / 2;

							strikes.push({ strike, callOI, putOI, callIV, putIV, callPrice, putPrice });
						}

						const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;
						const avgIV = ivs.length > 0 ? ivs.reduce((a, b) => a + b, 0) / ivs.length : 15;
						const vix = avgIV; // IV ~= VIX for index ATM

						// Max pain
						let minPain = Infinity, maxPainStrike = atmStrike;
						for (const target of strikes) {
							let pain = 0;
							for (const s of strikes) {
								if (target.strike > s.strike) pain += (target.strike - s.strike) * s.callOI;
								if (target.strike < s.strike) pain += (s.strike - target.strike) * s.putOI;
							}
							if (pain < minPain) { minPain = pain; maxPainStrike = target.strike; }
						}

						// 4. DTE
						const expiryDate = new Date(nearestExpiry);
						const todayDate = new Date(today);
						const dte = Math.max(0, Math.round((expiryDate.getTime() - todayDate.getTime()) / 86400000));

						// 5. Generate signals for MULTIPLE expiries — BACKTESTED on 3yr real data
						type Signal = { strategy: string; action: string; confidence: string; reason: string; entry: string; target: string; sl: string; exitRule: string; backtest: string };
						const signals: Signal[] = [];

						// VIX-adaptive OTM distance
						let otmDist = 500;
						if (vix < 13) otmDist = 400;
						else if (vix < 18) otmDist = 500;
						else if (vix < 25) otmDist = 700;
						else otmDist = 1000;

						// Check each upcoming expiry for signals
						for (const expiry of upcomingExpiries) {
							const expiryDte = Math.max(0, Math.round((new Date(expiry).getTime() - new Date(today).getTime()) / 86400000));

							// Fetch option chain for this expiry
							let expiryChainData: any[] = chainData; // use nearest for now
							if (expiry !== nearestExpiry) {
								try {
									const ecRes = await fetch(
										`${UPSTOX_API_BASE_URL}/v2/option/chain?instrument_key=${encodeURIComponent(indexKey)}&expiry_date=${encodeURIComponent(expiry)}`,
										{ headers: { Accept: HEADERS.ACCEPT, Authorization: `Bearer ${activeEnv.UPSTOX_ACCESS_TOKEN}` } }
									);
									const ecJson = (await ecRes.json()) as any;
									expiryChainData = ecJson.data || [];
								} catch { expiryChainData = []; }
							}

							// Build strikes for this expiry
							const expiryStrikes: Array<{ strike: number; callPrice: number; putPrice: number }> = [];
							for (const row of expiryChainData) {
								expiryStrikes.push({
									strike: row.strike_price ?? 0,
									callPrice: row.call_options?.market_data?.ltp ?? 0,
									putPrice: row.put_options?.market_data?.ltp ?? 0,
								});
							}

							// ═══ STRATEGY 1: Deep OTM Per-Leg (DTE 7-14) ═══
							if (expiryDte >= 7 && expiryDte <= 14) {
								const ceS = atmStrike + otmDist;
								const peS = atmStrike - otmDist;
								const ceRow = expiryStrikes.find(s => s.strike === ceS);
								const peRow = expiryStrikes.find(s => s.strike === peS);
								const cePrem = ceRow?.callPrice ?? 0;
								const pePrem = peRow?.putPrice ?? 0;

								if (cePrem >= 20 || pePrem >= 20) {
									const totalPrem = cePrem + pePrem;
									signals.push({
										strategy: "🏆 Deep OTM Per-Leg",
										action: "SELL",
										confidence: (cePrem >= 20 && pePrem >= 20) ? "HIGH" : "MEDIUM",
										reason: `Expiry ${expiry} | VIX ${vix.toFixed(1)}% → ${otmDist}pt OTM | DTE ${expiryDte} | Combined ₹${totalPrem.toFixed(0)}`,
										entry: `Sell ${ceS} CE @ ₹${cePrem.toFixed(0)} + Sell ${peS} PE @ ₹${pePrem.toFixed(0)} (each leg managed separately)`,
										target: `Per-leg: book when premium drops 30% (CE→₹${(cePrem*0.7).toFixed(0)}, PE→₹${(pePrem*0.7).toFixed(0)})`,
										sl: `Per-leg: cut when premium rises 30% (CE→₹${(cePrem*1.3).toFixed(0)}, PE→₹${(pePrem*1.3).toFixed(0)})`,
										exitRule: `Square off ALL legs 2 days before ${expiry}. If one leg SLs, other stays open.`,
										backtest: "3yr: +64%, 71% WR, 8.7% DD, 500 trades, 11/12 quarters profitable",
									});
								}
							}

							// ═══ STRATEGY 2: Short Straddle (DTE 2-6) ═══
							if (expiryDte >= 2 && expiryDte <= 6) {
								const atmData = expiryStrikes.find(s => s.strike === atmStrike);
								const cePrem = atmData?.callPrice ?? 0;
								const pePrem = atmData?.putPrice ?? 0;

								if (cePrem > 0 && pePrem > 0) {
									const totalPrem = cePrem + pePrem;
									signals.push({
										strategy: "Short Straddle",
										action: "SELL",
										confidence: vix < 18 ? "HIGH" : "MEDIUM",
										reason: `Expiry ${expiry} | VIX ${vix.toFixed(1)}% | DTE ${expiryDte} | ATM ${atmStrike} | Combined ₹${totalPrem.toFixed(0)}`,
										entry: `Sell ${atmStrike} CE @ ₹${cePrem.toFixed(0)} + Sell ${atmStrike} PE @ ₹${pePrem.toFixed(0)}`,
										target: `Combined drops 20% → book at ₹${(totalPrem * 0.8).toFixed(0)}`,
										sl: `Combined rises 30% → exit at ₹${(totalPrem * 1.3).toFixed(0)}`,
										exitRule: `Square off 2 days before ${expiry}. Both legs as one.`,
										backtest: "3yr: +8.5%, 74% WR, 1.3% DD, OOS +12.7%",
									});
								}
							}
						}

						// Warnings
						if (signals.length === 0) {
							signals.push({
								strategy: "⏳ No Signal",
								action: "WAIT",
								confidence: "HIGH",
								reason: `No expiry matches: Deep OTM needs DTE 7-14, Straddle needs DTE 2-6. Upcoming: ${upcomingExpiries.join(", ")}`,
								entry: "-", target: "-", sl: "-",
								exitRule: "Check again tomorrow",
								backtest: "-",
							});
						}

						if (vix > 25 && signals.length > 0) {
							signals.unshift({
								strategy: "⚠️ HIGH VIX",
								action: "CAUTION",
								confidence: "HIGH",
								reason: `VIX ${vix.toFixed(1)}% > 25. Deep OTM uses 1000pt distance. Reduce position size.`,
								entry: "-", target: "-", sl: "-",
								exitRule: "Monitor every 2 hours",
								backtest: "High VIX = profitable but higher drawdown",
							});
						}

						return json({
							underlying,
							spotPrice,
							expiry: nearestExpiry,
							dte,
							vix: Math.round(vix * 10) / 10,
							pcr: Math.round(pcr * 100) / 100,
							atmStrike,
							atmIV: Math.round(atmIV * 10) / 10,
							maxPainStrike,
							support: maxPutOIStrike,
							resistance: maxCallOIStrike,
							totalCallOI,
							totalPutOI,
							marketView: pcr > 1.2 ? "BULLISH" : pcr < 0.6 ? "BEARISH" : "NEUTRAL",
							upcomingExpiries,
							signals,
							chainSummary: strikes
								.filter(s => Math.abs(s.strike - atmStrike) <= (underlying === "NIFTY" ? 500 : 1000))
								.map(s => ({ strike: s.strike, callOI: s.callOI, putOI: s.putOI, callPrice: s.callPrice, putPrice: s.putPrice, callIV: s.callIV, putIV: s.putIV })),
						});
					} catch (err: any) {
						return json({ error: "F&O scan failed: " + (err?.message || String(err)) });
					}
				}

				// ── F&O POSITION TRACKING ──

				// POST /api/fno/sync — Trigger F&O trade sync from contract notes
				if (url.pathname === "/api/fno/sync" && request.method === "POST") {
					try {
						// Call the local sync server to trigger contract note parsing
						const syncRes = await fetch("http://localhost:9876/sync", { method: "POST" });
						const syncData = (await syncRes.json()) as Record<string, unknown>;
						return json({ success: true, message: "Sync triggered", ...syncData });
					} catch {
						return json({ error: "Sync server not running. Start: python3 scripts/sync_server.py" });
					}
				}

				// POST /api/fno/trade — Record an F&O trade
				if (url.pathname === "/api/fno/trade" && request.method === "POST") {
					const body = await request.json() as any;
					const { underlying, expiry, strike, option_type, action, price, lots, broker, strategy, position_id } = body;
					if (!underlying || !expiry || !strike || !option_type || !action || !price) {
						return json({ error: "Missing required fields: underlying, expiry, strike, option_type, action, price" });
					}
					const posId = position_id || `pos_${Date.now()}`;
					const today = new Date().toISOString().slice(0, 10);
					const time = new Date().toISOString().slice(11, 16);
					// Use the REAL trade date from the contract note when supplied; fall back to today only for
					// manual entry. Stamping the sync run-date here is what let the same note re-import every day.
					const tradeDate = (typeof body.trade_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.trade_date))
						? body.trade_date
						: today;
					// Lot size: trust an explicit value from the contract note; else BANKNIFTY=35 (was wrongly 30).
					// FINNIFTY/MIDCPNIFTY/SENSEX/BANKEX still fall back to 75 — confirm those or have the parser send lot_size.
					const lotSize = Number(body.lot_size) > 0 ? Number(body.lot_size) : (underlying === "BANKNIFTY" ? 35 : 75);
					const source = body.source || "MANUAL";

					// If this is from a contract note, delete any MANUAL entries for the same contract
					// Contract note is source of truth — overrides manual entries
					if (source === "CONTRACT_NOTE" || (broker && broker !== "MANUAL")) {
						(this as any).sql`DELETE FROM fno_positions
							WHERE source = 'MANUAL' AND underlying = ${underlying} AND expiry = ${expiry}
							AND strike = ${strike} AND option_type = ${option_type} AND action = ${action}`;
					}

					// Check for duplicate: same (underlying, expiry, strike, option_type, action, entry_date, entry_price)
					const existing = [...(this as any).sql`SELECT id FROM fno_positions
						WHERE underlying = ${underlying} AND expiry = ${expiry} AND strike = ${strike}
						AND option_type = ${option_type} AND action = ${action} AND entry_price = ${price}
						AND lots = ${lots || 1} AND entry_date = ${tradeDate} LIMIT 1`] as any[];
					if (existing.length > 0) {
						return json({ success: true, position_id: posId, id: "skipped_duplicate" });
					}

					(this as any).sql`INSERT INTO fno_positions (position_id, underlying, expiry, strike, option_type, action, lots, lot_size, entry_price, entry_date, entry_time, strategy, broker, source)
						VALUES (${posId}, ${underlying}, ${expiry}, ${strike}, ${option_type}, ${action}, ${lots || 1}, ${lotSize}, ${price}, ${tradeDate}, ${time}, ${strategy || 'manual'}, ${broker || 'MANUAL'}, ${source})`;
					return json({ success: true, position_id: posId, id: "created" });
				}

				// DELETE /api/equity/positions — Wipe all equity positions
				if (url.pathname === "/api/equity/positions" && request.method === "DELETE") {
					(this as any).sql`DELETE FROM positions`;
					return json({ success: true, message: "All equity positions deleted. Re-sync to reimport." });
				}

				// POST /api/equity/cleanup — Remove F&O trades from equity table
				if (url.pathname === "/api/equity/cleanup" && request.method === "POST") {
					// Delete trades that look like F&O from the equity positions table
					(this as any).sql`DELETE FROM positions WHERE
						UPPER(symbol) LIKE 'NIFTY2%' OR UPPER(symbol) LIKE 'BANKNIFTY2%' OR
						UPPER(symbol) LIKE 'OPTIDX%' OR UPPER(symbol) LIKE 'FUTIDX%' OR
						UPPER(symbol) LIKE '%CE' OR UPPER(symbol) LIKE '%PE' OR
						UPPER(symbol) LIKE '%FUT' OR UPPER(symbol) LIKE 'NIFTY26%' OR
						UPPER(symbol) LIKE 'NIFTY25%' OR UPPER(symbol) LIKE 'NIFTY24%'`;
					const remaining = [...(this as any).sql`SELECT COUNT(*) as cnt FROM positions`] as any[];
					return json({ success: true, remaining: remaining[0]?.cnt || 0 });
				}

				// PUT /api/equity/tag — Change LEGACY/STRATEGY tag for a trade
				if (url.pathname === "/api/equity/tag" && request.method === "PUT") {
					const body = await request.json() as any;
					const { id, portfolio, signal_strategy } = body;
					if (!id || !portfolio) return json({ error: "Missing id and portfolio" });
					if (signal_strategy !== undefined) {
						(this as any).sql`UPDATE positions SET portfolio = ${portfolio}, signal_strategy = ${signal_strategy} WHERE id = ${id}`;
					} else {
						(this as any).sql`UPDATE positions SET portfolio = ${portfolio} WHERE id = ${id}`;
					}
					return json({ success: true });
				}

				// PUT /api/equity/tag-bulk — Bulk tag trades by symbol
				if (url.pathname === "/api/equity/tag-bulk" && request.method === "PUT") {
					const body = await request.json() as any;
					const { symbol, portfolio } = body;
					if (!symbol || !portfolio) return json({ error: "Missing symbol and portfolio" });
					(this as any).sql`UPDATE positions SET portfolio = ${portfolio} WHERE symbol = ${symbol}`;
					return json({ success: true });
				}

				// DELETE /api/fno/positions — Wipe all F&O positions (for re-import)
				if (url.pathname === "/api/fno/positions" && request.method === "DELETE") {
					(this as any).sql`DELETE FROM fno_positions`;
					return json({ success: true, message: "All F&O positions deleted. Re-sync to reimport." });
				}

				// POST /api/fno/cleanup — Auto-close expired + netted positions
				if (url.pathname === "/api/fno/cleanup" && request.method === "POST") {
					const today = new Date().toISOString().slice(0, 10);
					// 1. Close expired positions
					(this as any).sql`UPDATE fno_positions SET status = 'CLOSED', exit_reason = 'expired', exit_date = expiry WHERE status = 'OPEN' AND expiry < ${today}`;
					// 2. Close positions with invalid dates
					(this as any).sql`UPDATE fno_positions SET status = 'CLOSED', exit_reason = 'invalid_date', exit_date = ${today} WHERE status = 'OPEN' AND (LENGTH(expiry) != 10 OR expiry NOT LIKE '____-__-__')`;
					// 3. Net out matching BUY+SELL on same (underlying, expiry, strike, option_type)
					// For each combo: if total buy lots = total sell lots, close all
					const combos = [...(this as any).sql`
						SELECT underlying, expiry, strike, option_type,
							SUM(CASE WHEN action='BUY' THEN lots ELSE 0 END) as buy_lots,
							SUM(CASE WHEN action='SELL' THEN lots ELSE 0 END) as sell_lots
						FROM fno_positions WHERE status = 'OPEN'
						GROUP BY underlying, expiry, strike, option_type
						HAVING buy_lots > 0 AND sell_lots > 0 AND buy_lots = sell_lots
					`] as any[];
					for (const c of combos) {
						(this as any).sql`UPDATE fno_positions SET status = 'CLOSED', exit_reason = 'netted', exit_date = ${today}
							WHERE status = 'OPEN' AND underlying = ${c.underlying} AND expiry = ${c.expiry} AND strike = ${c.strike} AND option_type = ${c.option_type}`;
					}
					const remaining = [...(this as any).sql`SELECT COUNT(*) as cnt FROM fno_positions WHERE status = 'OPEN'`] as any[];
					return json({ success: true, remaining_open: remaining[0]?.cnt || 0, netted: combos.length });
				}

				// GET /api/fno/positions — Get open F&O positions with live advice
				if (url.pathname === "/api/fno/positions" && request.method === "GET") {
					// Auto-cleanup first: close expired + invalid dates
					const todayFno = new Date().toISOString().slice(0, 10);

					// 1. Close invalid dates (malformed from old parser bug)
					(this as any).sql`UPDATE fno_positions SET status = 'CLOSED', exit_reason = 'invalid_date', exit_date = ${todayFno}
						WHERE status = 'OPEN' AND (
							CAST(SUBSTR(expiry,6,2) AS INTEGER) > 12 OR CAST(SUBSTR(expiry,6,2) AS INTEGER) < 1 OR
							CAST(SUBSTR(expiry,9,2) AS INTEGER) > 31 OR CAST(SUBSTR(expiry,9,2) AS INTEGER) < 1 OR
							LENGTH(expiry) != 10
						)`;

					// 2. Close expired positions
					(this as any).sql`UPDATE fno_positions SET status = 'CLOSED', exit_reason = 'expired', exit_date = expiry
						WHERE status = 'OPEN' AND expiry < ${todayFno} AND LENGTH(expiry) = 10`;

					// 3. FIFO matching: for same (underlying, expiry, strike, option_type),
					//    match BUY against SELL chronologically. Matched pairs → both CLOSED.
					const openGroups = [...(this as any).sql`
						SELECT DISTINCT underlying, expiry, strike, option_type
						FROM fno_positions WHERE status = 'OPEN'
					`] as any[];

					for (const g of openGroups) {
						const buys = [...(this as any).sql`SELECT id, lots, entry_price, entry_date FROM fno_positions
							WHERE status='OPEN' AND action='BUY' AND underlying=${g.underlying} AND expiry=${g.expiry}
							AND strike=${g.strike} AND option_type=${g.option_type} ORDER BY entry_date, id`] as any[];
						const sells = [...(this as any).sql`SELECT id, lots, entry_price, entry_date FROM fno_positions
							WHERE status='OPEN' AND action='SELL' AND underlying=${g.underlying} AND expiry=${g.expiry}
							AND strike=${g.strike} AND option_type=${g.option_type} ORDER BY entry_date, id`] as any[];

						// FIFO: match oldest sell with oldest buy (or vice versa — the LATER one closes the EARLIER)
						let bi = 0, si = 0;
						while (bi < buys.length && si < sells.length) {
							const buy = buys[bi], sell = sells[si];
							// The later trade closes the earlier one
							if (buy.entry_date <= sell.entry_date) {
								// Buy was first (opened position), Sell closes it
								(this as any).sql`UPDATE fno_positions SET status='CLOSED', exit_price=${sell.entry_price}, exit_date=${sell.entry_date}, exit_reason='fifo_matched' WHERE id=${buy.id}`;
								(this as any).sql`UPDATE fno_positions SET status='CLOSED', exit_price=${buy.entry_price}, exit_date=${buy.entry_date}, exit_reason='fifo_matched' WHERE id=${sell.id}`;
							} else {
								// Sell was first (opened short), Buy closes it
								(this as any).sql`UPDATE fno_positions SET status='CLOSED', exit_price=${buy.entry_price}, exit_date=${buy.entry_date}, exit_reason='fifo_matched' WHERE id=${sell.id}`;
								(this as any).sql`UPDATE fno_positions SET status='CLOSED', exit_price=${sell.entry_price}, exit_date=${sell.entry_date}, exit_reason='fifo_matched' WHERE id=${buy.id}`;
							}
							bi++; si++;
						}
					}

					const showClosed = url.searchParams.get("show_closed") === "true";
					let rows: any[];
					if (showClosed) {
						rows = [...(this as any).sql`SELECT * FROM fno_positions ORDER BY entry_date DESC, id DESC`];
					} else {
						rows = [...(this as any).sql`SELECT * FROM fno_positions WHERE status = 'OPEN' ORDER BY entry_date DESC, id DESC`];
					}

					// Fetch live prices for open positions
					const openPositions = rows.filter((r: any) => r.status === "OPEN");
					const liveAdvice: any[] = [];

					// Group by position_id
					const grouped: Record<string, any[]> = {};
					for (const r of openPositions) {
						if (!grouped[r.position_id]) grouped[r.position_id] = [];
						grouped[r.position_id].push(r);
					}

					// Fetch live option chain for each unique expiry
					const expiryChains: Record<string, any[]> = {};
					const uniqueExpiries = [...new Set(openPositions.map((r: any) => r.expiry))];
					for (const exp of uniqueExpiries) {
						const underlying = openPositions.find((r: any) => r.expiry === exp)?.underlying || "NIFTY";
						const indexKey = underlying === "BANKNIFTY" ? "NSE_INDEX|Nifty Bank" : "NSE_INDEX|Nifty 50";
						try {
							const chainRes = await fetch(
								`${UPSTOX_API_BASE_URL}/v2/option/chain?instrument_key=${encodeURIComponent(indexKey)}&expiry_date=${encodeURIComponent(exp)}`,
								{ headers: { Accept: HEADERS.ACCEPT, Authorization: `Bearer ${activeEnv.UPSTOX_ACCESS_TOKEN}` } }
							);
							const chainJson = (await chainRes.json()) as any;
							expiryChains[exp] = chainJson.data || [];
						} catch { expiryChains[exp] = []; }
					}

					const today = new Date().toISOString().slice(0, 10);

					for (const [posId, legs] of Object.entries(grouped)) {
						const strategy = legs[0]?.strategy || "manual";
						const expiry = legs[0]?.expiry || "";
						const dte = Math.max(0, Math.round((new Date(expiry).getTime() - new Date(today).getTime()) / 86400000));
						const chain = expiryChains[expiry] || [];

						let combinedEntry = 0;
						let combinedCurrent = 0;
						const legDetails: any[] = [];

						for (const leg of legs) {
							// Find live price from chain
							let livePrice = 0;
							for (const row of chain) {
								if (row.strike_price === leg.strike) {
									if (leg.option_type === "CE") livePrice = row.call_options?.market_data?.ltp ?? 0;
									else livePrice = row.put_options?.market_data?.ltp ?? 0;
									break;
								}
							}

							const entryP = leg.entry_price;
							const pnlPerUnit = leg.action === "SELL" ? entryP - livePrice : livePrice - entryP;
							const pnlTotal = pnlPerUnit * leg.lot_size * leg.lots;
							const changePct = entryP > 0 ? ((livePrice - entryP) / entryP * 100) : 0;

							combinedEntry += leg.action === "SELL" ? entryP : -entryP;
							combinedCurrent += leg.action === "SELL" ? livePrice : -livePrice;

							// Per-leg advice for deep_otm_perleg
							let legAdvice = "HOLD";
							if (strategy === "deep_otm_perleg") {
								const decayPct = (entryP - livePrice) / entryP * 100;
								const risePct = (livePrice - entryP) / entryP * 100;
								if (decayPct >= 30) legAdvice = "✅ EXIT — Target hit (30% decay)";
								else if (risePct >= 30) legAdvice = "❌ EXIT — SL hit (30% rise)";
								else if (dte <= 2) legAdvice = "⏰ EXIT — Time exit (DTE ≤ 2)";
								else legAdvice = `HOLD — ${decayPct > 0 ? decayPct.toFixed(0) + "% decayed" : Math.abs(changePct).toFixed(0) + "% against"}, target at ₹${(entryP * 0.7).toFixed(0)}, SL at ₹${(entryP * 1.3).toFixed(0)}`;
							}

							legDetails.push({
								id: leg.id,
								strike: leg.strike,
								option_type: leg.option_type,
								action: leg.action,
								entry_price: entryP,
								current_price: Math.round(livePrice * 10) / 10,
								pnl: Math.round(pnlTotal),
								change_pct: Math.round(changePct * 10) / 10,
								advice: legAdvice,
							});
						}

						// Combined advice for straddle
						let positionAdvice = "HOLD";
						const combinedPnl = (combinedEntry - combinedCurrent) * (legs[0]?.lot_size || 75) * (legs[0]?.lots || 1);

						if (strategy === "short_straddle") {
							const decayPct = (combinedEntry - combinedCurrent) / combinedEntry * 100;
							const risePct = (combinedCurrent - combinedEntry) / combinedEntry * 100;
							if (combinedEntry > 0 && decayPct >= 20) positionAdvice = "✅ EXIT BOTH — Target hit (20% combined decay)";
							else if (combinedEntry > 0 && risePct >= 30) positionAdvice = "❌ EXIT BOTH — SL hit (30% combined rise)";
							else if (dte <= 2) positionAdvice = "⏰ EXIT BOTH — Time exit (DTE ≤ 2)";
							else positionAdvice = `HOLD — combined ${decayPct > 0 ? "+" + decayPct.toFixed(0) + "% decay" : risePct.toFixed(0) + "% against"}, target at ₹${(combinedEntry * 0.8).toFixed(0)}, SL at ₹${(combinedEntry * 1.3).toFixed(0)}`;
						} else if (strategy === "deep_otm_perleg") {
							// Position-level summary
							const hasExit = legDetails.some(l => l.advice.includes("EXIT"));
							if (dte <= 2) positionAdvice = "⏰ EXIT ALL — Time exit (DTE ≤ 2)";
							else if (hasExit) positionAdvice = "⚠️ ACTION NEEDED — Check individual legs";
							else positionAdvice = "HOLD — All legs within range";
						} else {
							// Manual trade — just show P&L
							if (dte <= 2) positionAdvice = "⏰ CAUTION — DTE ≤ 2, consider squaring off";
							else positionAdvice = `Manual trade — P&L ₹${Math.round(combinedPnl)}`;
						}

						liveAdvice.push({
							position_id: posId,
							strategy,
							underlying: legs[0]?.underlying,
							expiry,
							dte,
							combined_entry: Math.round(combinedEntry * 10) / 10,
							combined_current: Math.round(combinedCurrent * 10) / 10,
							combined_pnl: Math.round(combinedPnl),
							advice: positionAdvice,
							legs: legDetails,
						});
					}

					return json({
						open_count: openPositions.length,
						positions: liveAdvice,
						closed: showClosed ? rows.filter((r: any) => r.status === "CLOSED") : undefined,
					});
				}

				// POST /api/fno/close — Close an F&O position leg
				if (url.pathname === "/api/fno/close" && request.method === "POST") {
					const body = await request.json() as any;
					const { id, exit_price, exit_reason } = body;
					if (!id || !exit_price) return json({ error: "Missing id and exit_price" });
					const today = new Date().toISOString().slice(0, 10);
					(this as any).sql`UPDATE fno_positions SET status = 'CLOSED', exit_price = ${exit_price}, exit_date = ${today}, exit_reason = ${exit_reason || 'manual'} WHERE id = ${id}`;
					return json({ success: true });
				}

				// GET /api/stock-master
				if (url.pathname === "/api/stock-master" && request.method === "GET") {
					return json(STOCK_MASTER);
				}

				// GET /api/auth
				if (url.pathname === "/api/auth" && request.method === "GET") {
					const result = await checkAuthHandler({} as Record<string, never>, activeEnv);
					return json(extractText(result));
				}

				return new Response(JSON.stringify({ error: "Not found" }), {
					status: 404,
					headers: { "Content-Type": "application/json", ...cors },
				});
			} catch (error) {
				return new Response(
					JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
					{ status: 500, headers: { "Content-Type": "application/json" } }
				);
			}
		}

		// Fall through to MCP SSE handler
		return super.fetch(request);
	}

	async init() {
		// Initialize watchlist & positions tables + seed
		initWatchlistTables(this as any);

		this.server.tool("get-profile", getProfileSchema, async (args) => {
			return getProfileHandler(args as Record<string, never>, this.getActiveEnv());
		});
		this.server.tool("get-funds-margin", getFundsMarginSchema, async (args) => {
			return getFundsMarginHandler(args as { segment?: string }, this.getActiveEnv());
		});
		this.server.tool("get-holdings", getHoldingsSchema, async (args) => {
			return getHoldingsHandler(args as GetHoldingsArgs, this.getActiveEnv());
		});
		this.server.tool("get-positions", getPositionsSchema, async (args) => {
			return getPositionsHandler(args as Record<string, never>, this.getActiveEnv());
		});
		this.server.tool("get-mtf-positions", getMtfPositionsSchema, async (args) => {
			return getMtfPositionsHandler(args as Record<string, never>, this.getActiveEnv());
		});
		this.server.tool("get-order-book", getOrderBookSchema, async (args) => {
			return getOrderBookHandler(args as Record<string, never>, this.getActiveEnv());
		});
		this.server.tool("get-order-details", getOrderDetailsSchema, async (args) => {
			return getOrderDetailsHandler(args as { orderId: string }, this.getActiveEnv());
		});
		this.server.tool("get-trades", getTradesSchema, async (args) => {
			return getTradesHandler(args as Record<string, never>, this.getActiveEnv());
		});
		this.server.tool("get-order-trades", getOrderTradesSchema, async (args) => {
			return getOrderTradesHandler(args as { orderId: string }, this.getActiveEnv());
		});
		this.server.tool("get-order-history", getOrderHistorySchema, async (args) => {
			return getOrderHistoryHandler(args as { orderId?: string; tag?: string }, this.getActiveEnv());
		});

		// Market Data Tools
		this.server.tool("get-market-quotes", getMarketQuotesSchema, async (args) => {
			return getMarketQuotesHandler(args as { instrument_keys: string }, this.getActiveEnv());
		});
		this.server.tool("get-ltp-quotes", getLtpQuotesSchema, async (args) => {
			return getLtpQuotesHandler(args as { instrument_keys: string }, this.getActiveEnv());
		});
		this.server.tool("get-ohlc-quotes", getOhlcQuotesSchema, async (args) => {
			return getOhlcQuotesHandler(args as { instrument_keys: string; interval: string }, this.getActiveEnv());
		});
		this.server.tool("get-option-chain", getOptionChainSchema, async (args) => {
			return getOptionChainHandler(args as { instrument_key: string; expiry_date: string }, this.getActiveEnv());
		});
		this.server.tool("get-option-contracts", getOptionContractsSchema, async (args) => {
			return getOptionContractsHandler(args as { instrument_key: string; expiry_date?: string }, this.getActiveEnv());
		});
		this.server.tool("get-market-status", getMarketStatusSchema, async (args) => {
			return getMarketStatusHandler(args as { exchange: string }, this.getActiveEnv());
		});

		// Backtester Tools
		this.server.tool("get-historical-candles", getHistoricalCandlesSchema, async (args) => {
			return getHistoricalCandlesHandler(args as { instrument_key: string; interval: string; from_date: string; to_date: string }, this.getActiveEnv());
		});
		this.server.tool("run-backtest", runBacktestSchema, async (args) => {
			return runBacktestHandler(args as { instrument_key: string; interval: string; from_date: string; to_date: string; strategy: string; strategy_params?: string; initial_capital?: number; quantity?: number }, this.getActiveEnv());
		});
		this.server.tool("compare-strategies", compareStrategiesSchema, async (args) => {
			return compareStrategiesHandler(args as { instrument_key: string; interval: string; from_date: string; to_date: string; strategies: string; initial_capital?: number; quantity?: number }, this.getActiveEnv());
		});
		this.server.tool("optimize-strategy", optimizeStrategySchema, async (args) => {
			return optimizeStrategyHandler(args as { instrument_key: string; interval: string; from_date: string; to_date: string; strategy: string; param_ranges: string; optimize_for?: string; initial_capital?: number; quantity?: number }, this.getActiveEnv());
		});
		this.server.tool("suggest-strategies", suggestStrategiesSchema, async (args) => {
			return suggestStrategiesHandler(args as { instrument_key: string; interval?: string; lookback_days?: number }, this.getActiveEnv());
		});

		// F&O Backtester Tools
		this.server.tool("run-fno-backtest", runFnoBacktestSchema, async (args) => {
			return runFnoBacktestHandler(args as { underlying: string; from_date: string; to_date: string; strategy: string; strategy_params?: string; initial_capital?: number; num_strikes?: number }, this.getActiveEnv());
		});
		this.server.tool("compare-fno-strategies", compareFnoStrategiesSchema, async (args) => {
			return compareFnoStrategiesHandler(args as { underlying: string; from_date: string; to_date: string; strategies: string; initial_capital?: number }, this.getActiveEnv());
		});
		this.server.tool("optimize-fno-strategy", optimizeFnoStrategySchema, async (args) => {
			return optimizeFnoStrategyHandler(args as { underlying: string; from_date: string; to_date: string; strategy: string; param_ranges: string; optimize_for?: string; initial_capital?: number }, this.getActiveEnv());
		});
		this.server.tool("suggest-fno-strategies", suggestFnoStrategiesSchema, async (args) => {
			return suggestFnoStrategiesHandler(args as { underlying: string; vix_level?: number; market_view?: string; dte?: number; intraday?: boolean }, this.getActiveEnv());
		});

		// Watchlist Tools
		this.server.tool("show-watchlist", showWatchlistSchema, async (args) => {
			return showWatchlistHandler(args as { category?: string }, this.getActiveEnv(), this as any);
		});
		this.server.tool("add-to-watchlist", addToWatchlistSchema, async (args) => {
			return addToWatchlistHandler(args as { symbol: string; instrument_key: string; category: string }, this.getActiveEnv(), this as any);
		});
		this.server.tool("remove-from-watchlist", removeFromWatchlistSchema, async (args) => {
			return removeFromWatchlistHandler(args as { symbol: string }, this.getActiveEnv(), this as any);
		});
		this.server.tool("scan-watchlist", scanWatchlistSchema, async (args) => {
			return scanWatchlistHandler(args as { category?: string }, this.getActiveEnv(), this as any);
		});
		this.server.tool("backfill-snapshots", backfillSnapshotsSchema, async (args) => {
			return backfillSnapshotsHandler(args as { dates?: string[] }, this.getActiveEnv(), this as any);
		});

		// Portfolio Tools
		this.server.tool("record-trade", recordTradeSchema, async (args) => {
			return recordTradeHandler(args as RecordTradeArgs, this.getActiveEnv(), this as any);
		});
		this.server.tool("show-positions", showPositionsSchema, async (args) => {
			return showPositionsHandler(args as { show_closed?: boolean }, this.getActiveEnv(), this as any);
		});
		this.server.tool("check-auth", checkAuthSchema, async (args) => {
			return checkAuthHandler(args as Record<string, never>, this.getActiveEnv());
		});
	}
}

// Mount MCP at /sse, intercept /api/* and forward to DO
const mcpHandler = MyMCP.mount("/sse");

export default {
	async fetch(request: Request, env: any, ctx: any) {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/api/")) {
			// Forward API requests to the Durable Object (which has SQLite)
			const id = env.MCP_OBJECT.idFromName("watchlist-panel");
			const stub = env.MCP_OBJECT.get(id);
			return stub.fetch(request);
		}

		// Everything else (SSE, static assets) handled by mount
		return mcpHandler.fetch(request, env, ctx);
	},
};
