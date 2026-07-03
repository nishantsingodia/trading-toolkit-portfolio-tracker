import { z } from "zod";
import { ToolResponse, Env, SqlAgent } from "../types";
import { UPSTOX_API_BASE_URL, HEADERS } from "../constants";

// ─── record-trade ─────────────────────────────────────────────────────────────

export const recordTradeSchema = {
  symbol: z.string().min(1, "Stock symbol is required"),
  action: z.enum(["BUY", "SELL"]).describe("Trade action"),
  price: z.number().positive("Price must be positive"),
  quantity: z.number().int().positive("Quantity must be a positive integer"),
  trade_date: z.string().optional().describe("Trade date (YYYY-MM-DD, defaults to today)"),
  signal_strategy: z.enum(["BB_RSI", "STOCH_RSI", "RSI_OBOS", "CANSLIM", "DUAL_MOM", "SUPERTREND"]).optional().describe("Strategy that generated the signal (e.g. BB_RSI, SUPERTREND). MUST be set for BUY trades so we know which strategy to attribute the position to."),
  portfolio: z.enum(["LEGACY", "STRATEGY"]).optional().describe("Portfolio bucket (defaults to STRATEGY when signal_strategy is set, else LEGACY)"),
  broker: z.enum(["UPSTOX", "GROWW", "MANUAL"]).optional().describe("Broker used (defaults to MANUAL)"),
};

export interface RecordTradeArgs {
  symbol: string;
  action: string;
  price: number;
  quantity: number;
  trade_date?: string;
  signal_strategy?: string;
  portfolio?: string;
  broker?: string;
}

/**
 * Which strategies actually fired a BUY (FRESH_BUY or RECENT_BUY) at ENTRY, read from the buy-date
 * signal_fingerprint (format "BB_RSI:FRESH_BUY* | STOCH_RSI:BULLISH | ..."). A trailing "*" marks a buy
 * signal; a bare BULLISH/BEARISH/NEUTRAL is a holding state, not an entry trigger, so it is NOT credited.
 * This is the buy-date-accurate answer to "which strategy bought this", replacing the old attribution
 * that matched a months-old holding against the live (today's) scan.
 */
export function strategiesFromFingerprint(fp: string | null | undefined): string[] {
  if (!fp) return [];
  const set = new Set<string>();
  for (const entry of fp.split(" || ")) {      // a multi-buy position joins entries with " || "
    for (const part of entry.split(" | ")) {    // each part is "NAME:SIGNAL" with "*" appended on a buy
      if (part.includes("*")) {
        const name = part.split(":")[0].trim();
        if (name) set.add(name);
      }
    }
  }
  return [...set];
}

export async function recordTradeHandler(
  args: RecordTradeArgs,
  env: Env,
  agent: SqlAgent
): Promise<ToolResponse> {
  const tradeDate = args.trade_date || new Date().toISOString().slice(0, 10);

  // Validate: can't sell more than held
  if (args.action === "SELL") {
    const posRows = [...agent.sql`SELECT SUM(CASE WHEN action='BUY' THEN quantity ELSE -quantity END) as net_qty FROM positions WHERE symbol = ${args.symbol}`];
    const netQty = (posRows[0] as any)?.net_qty || 0;
    if (args.quantity > netQty) {
      return {
        content: [{ type: "text", text: `Cannot sell ${args.quantity} of ${args.symbol} — you only hold ${netQty} shares.` }],
        isError: true,
      };
    }
  }

  const broker = args.broker || 'MANUAL';
  const signalStrategy = args.signal_strategy || null;
  const portfolio = args.portfolio || (signalStrategy ? 'STRATEGY' : 'LEGACY');

  agent.sql`INSERT INTO positions (symbol, action, price, quantity, trade_date, broker, portfolio, signal_strategy)
    VALUES (${args.symbol}, ${args.action}, ${args.price}, ${args.quantity}, ${tradeDate}, ${broker}, ${portfolio}, ${signalStrategy})`;

  // Auto-stamp fingerprint from nearest scan snapshot for BUY trades
  let fingerprint: string | null = null;
  if (args.action === "BUY") {
    const snapRows = [...agent.sql`SELECT fingerprint FROM scan_snapshots
      WHERE symbol = ${args.symbol} AND scan_date <= ${tradeDate}
      ORDER BY scan_date DESC, scan_time DESC LIMIT 1`];
    if (snapRows.length > 0) {
      fingerprint = (snapRows[0] as any).fingerprint;
      agent.sql`UPDATE positions SET signal_fingerprint = ${fingerprint}
        WHERE symbol = ${args.symbol} AND action = 'BUY' AND trade_date = ${tradeDate} AND signal_fingerprint IS NULL`;
    }
  }

  // Show updated position
  const posRows = [...agent.sql`SELECT SUM(CASE WHEN action='BUY' THEN quantity ELSE -quantity END) as net_qty, SUM(CASE WHEN action='BUY' THEN price*quantity ELSE 0 END) as total_invested, SUM(CASE WHEN action='SELL' THEN price*quantity ELSE 0 END) as total_sold FROM positions WHERE symbol = ${args.symbol}`];
  const pos = posRows[0] as any;

  // For SELL trades, look up the original BUY's strategy + fingerprint
  let buyStrategy: string | null = null;
  let buyFingerprint: string | null = null;
  if (args.action === "SELL") {
    const buyRows = [...agent.sql`SELECT signal_strategy, signal_fingerprint FROM positions WHERE symbol = ${args.symbol} AND action = 'BUY' AND (signal_strategy IS NOT NULL OR signal_fingerprint IS NOT NULL) ORDER BY id DESC LIMIT 1`];
    if (buyRows.length > 0) {
      buyStrategy = (buyRows[0] as any).signal_strategy;
      buyFingerprint = (buyRows[0] as any).signal_fingerprint;
    }
  }

  const result: any = {
    recorded: {
      symbol: args.symbol,
      action: args.action,
      price: args.price,
      quantity: args.quantity,
      date: tradeDate,
      strategy: signalStrategy,
      portfolio,
      broker,
      ...(fingerprint ? { signal_fingerprint: fingerprint } : {}),
    },
    current_position: {
      net_quantity: pos.net_qty || 0,
      total_invested: Math.round((pos.total_invested || 0) * 100) / 100,
      total_sold: Math.round((pos.total_sold || 0) * 100) / 100,
    },
  };

  if (buyStrategy) result.original_buy_strategy = buyStrategy;
  if (buyFingerprint) result.original_buy_fingerprint = buyFingerprint;

  return {
    content: [{
      type: "text",
      text: JSON.stringify(result, null, 2),
    }],
  };
}

// ─── show-positions ───────────────────────────────────────────────────────────

export const showPositionsSchema = {
  show_closed: z.boolean().optional().describe("Include closed positions (default: false)"),
};

interface ShowPositionsArgs {
  show_closed?: boolean;
  portfolio?: string;
}

/** Normalize symbol: strip -EQ/INE..., -SYMBOL suffixes to get bare ticker */
function normalizeSymbol(sym: string): string {
  // "HDFCBANK-EQ/INE040A01034" → "HDFCBANK"
  // "BSE-BSE" → "BSE"
  // "SILVERBEES-NIPPON" → "SILVERBEES"
  // "SILVERBEES-EQ/INF204KC1402" → "SILVERBEES"
  const dash = sym.indexOf('-');
  if (dash > 0) return sym.substring(0, dash);
  return sym;
}

export async function showPositionsHandler(
  args: ShowPositionsArgs,
  env: Env,
  agent: SqlAgent
): Promise<ToolResponse> {
  // Get all trade records, optionally filtered by portfolio
  let tradeRows: any[];
  if (args.portfolio) {
    tradeRows = [...agent.sql`SELECT symbol, action, price, quantity, trade_date, portfolio, signal_strategy, signal_fingerprint, broker FROM positions WHERE portfolio = ${args.portfolio} ORDER BY symbol, trade_date, id`];
  } else {
    tradeRows = [...agent.sql`SELECT symbol, action, price, quantity, trade_date, portfolio, signal_strategy, signal_fingerprint, broker FROM positions ORDER BY symbol, trade_date, id`];
  }

  // Aggregate by raw symbol — keep broker variants separate (SILVERBEES vs SILVERBEES-E)
  // Only normalize for SELL matching: if a SELL comes as "ONGC-EQ/INE..." but BUY was "ONGC", match them
  const symbolMap: Record<string, { buys: Array<{price: number; qty: number; date: string; broker: string; fingerprint: string | null}>; sells: Array<{price: number; qty: number; date: string; broker: string}>; portfolio: string; signal_strategy: string | null; signal_fingerprints: string[] }> = {};

  // First pass: collect all raw symbols
  const rawSymbols = new Set<string>();
  for (const row of tradeRows as any[]) { rawSymbols.add(row.symbol); }

  // For each trade, find the best matching key: exact match first, then normalized
  for (const row of tradeRows as any[]) {
    let sym = row.symbol;
    // If this exact symbol already has entries, use it
    // If not, check if a normalized version exists (for SELL matching against BUY)
    if (!symbolMap[sym]) {
      const normalized = normalizeSymbol(sym);
      // Only merge if the normalized form already exists AND this is a SELL
      // (BUYs create new entries, SELLs try to match existing)
      if (row.action === "SELL" && symbolMap[normalized]) {
        sym = normalized;
      } else if (row.action === "SELL") {
        // Check if any existing key normalizes to the same
        for (const existing of Object.keys(symbolMap)) {
          if (normalizeSymbol(existing) === normalized) {
            sym = existing;
            break;
          }
        }
      }
    }
    if (!symbolMap[sym]) {
      symbolMap[sym] = { buys: [], sells: [], portfolio: row.portfolio || "LEGACY", signal_strategy: null, signal_fingerprints: [] };
    }
    const broker = row.broker || 'MANUAL';
    if (row.action === "BUY") {
      symbolMap[sym].buys.push({ price: row.price, qty: row.quantity, date: row.trade_date, broker, fingerprint: row.signal_fingerprint || null });
      // Keep the latest BUY's strategy info
      if (row.signal_strategy) symbolMap[sym].signal_strategy = row.signal_strategy;
      if (row.signal_fingerprint) symbolMap[sym].signal_fingerprints.push(row.signal_fingerprint);
      if (row.portfolio) symbolMap[sym].portfolio = row.portfolio;
    } else {
      symbolMap[sym].sells.push({ price: row.price, qty: row.quantity, date: row.trade_date, broker });
    }
  }

  const openPositions: any[] = [];
  const closedPositions: any[] = [];

  for (const [symbol, data] of Object.entries(symbolMap)) {
    const totalBuyQty = data.buys.reduce((s, b) => s + b.qty, 0);
    const totalSellQty = data.sells.reduce((s, b) => s + b.qty, 0);
    const totalBuyCost = data.buys.reduce((s, b) => s + b.price * b.qty, 0);
    const totalSellRevenue = data.sells.reduce((s, b) => s + b.price * b.qty, 0);

    const netQty = totalBuyQty - totalSellQty;
    const avgBuyPrice = totalBuyQty > 0 ? totalBuyCost / totalBuyQty : 0;
    // Realized P&L is booked ONLY on the matched (closed) round-trip quantity, so a phantom/duplicate
    // sell can never add revenue with no offsetting buy cost. Identical to the old math for cleanly-closed
    // positions (matchedQty === buyQty === sellQty there); only the over-sold cases change.
    const avgSellPrice = totalSellQty > 0 ? totalSellRevenue / totalSellQty : 0;
    const matchedQty = Math.min(totalBuyQty, totalSellQty);
    const matchedCost = avgBuyPrice * matchedQty;
    const cappedRealizedPnl = totalBuyQty > 0 ? matchedQty * (avgSellPrice - avgBuyPrice) : null;
    const cappedPnlPct = (cappedRealizedPnl != null && matchedCost > 0) ? (cappedRealizedPnl / matchedCost) * 100 : null;

    if (netQty > 0) {
      // Broker breakdown: qty held per broker (buys minus sells, attributed per broker)
      const brokerQty: Record<string, number> = {};
      for (const b of data.buys) brokerQty[b.broker] = (brokerQty[b.broker] || 0) + b.qty;
      for (const s of data.sells) {
        // Attribute sells to brokers proportionally (or just show buy-side brokers)
        // For simplicity, track which brokers have buys
      }
      const brokers = Object.entries(brokerQty).map(([broker, qty]) => ({ broker, qty }));

      // Format fingerprints: join multiple buys with " || "
      const fingerprints = data.signal_fingerprints.length > 0
        ? data.signal_fingerprints.join(" || ")
        : null;

      openPositions.push({
        symbol,
        net_quantity: netQty,
        avg_buy_price: Math.round(avgBuyPrice * 100) / 100,
        total_invested: Math.round(avgBuyPrice * netQty * 100) / 100,
        partial_realized_pnl: totalSellQty > 0
          ? Math.round((totalSellRevenue - avgBuyPrice * totalSellQty) * 100) / 100
          : 0,
        portfolio: data.portfolio,
        signal_strategy: data.signal_strategy,
        signal_fingerprint: fingerprints,
        brokers,
      });
    } else if (netQty === 0 && totalBuyQty > 0) {
      const fingerprints = data.signal_fingerprints.length > 0
        ? data.signal_fingerprints.join(" || ")
        : null;
      // Fully closed — buy qty matches sell qty
      closedPositions.push({
        symbol,
        total_buy_cost: Math.round(totalBuyCost * 100) / 100,
        total_sell_revenue: Math.round(totalSellRevenue * 100) / 100,
        realized_pnl: cappedRealizedPnl != null ? Math.round(cappedRealizedPnl * 100) / 100 : null,
        pnl_pct: cappedPnlPct != null ? Math.round(cappedPnlPct * 100) / 100 : 0,
        portfolio: data.portfolio,
        signal_strategy: data.signal_strategy,
        signal_fingerprint: fingerprints,
      });
    } else if (netQty <= 0 && totalSellQty > 0) {
      const fingerprints = data.signal_fingerprints.length > 0
        ? data.signal_fingerprints.join(" || ")
        : null;
      // Sell-only or more sells than buys — old holding sold, buy not in DB
      // Show as closed with "unknown buy cost" or partial data
      closedPositions.push({
        symbol,
        total_buy_cost: Math.round(totalBuyCost * 100) / 100,
        total_sell_revenue: Math.round(totalSellRevenue * 100) / 100,
        realized_pnl: cappedRealizedPnl != null ? Math.round(cappedRealizedPnl * 100) / 100 : null, // capped at matched qty; null when buy cost unknown
        pnl_pct: cappedPnlPct != null ? Math.round(cappedPnlPct * 100) / 100 : null,
        portfolio: data.portfolio,
        signal_strategy: data.signal_strategy,
        signal_fingerprint: fingerprints,
        note: totalBuyQty === 0 ? "Buy cost unknown (pre-sync holding)" : "More sells than buys in records",
      });
    }
  }

  // Summary
  const totalInvested = openPositions.reduce((s, p) => s + p.total_invested, 0);
  const totalRealizedPnl = closedPositions.reduce((s, p) => s + (p.realized_pnl || 0), 0)
    + openPositions.reduce((s, p) => s + p.partial_realized_pnl, 0);

  const result: any = {
    summary: {
      open_positions: openPositions.length,
      closed_positions: closedPositions.length,
      total_invested: Math.round(totalInvested * 100) / 100,
      total_realized_pnl: Math.round(totalRealizedPnl * 100) / 100,
      wins: closedPositions.filter(p => p.realized_pnl != null && p.realized_pnl > 0).length,
      losses: closedPositions.filter(p => p.realized_pnl != null && p.realized_pnl <= 0).length,
      unknown_pnl: closedPositions.filter(p => p.realized_pnl == null).length,
    },
    open_positions: openPositions,
  };

  if (args.show_closed) {
    result.closed_positions = closedPositions;
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

// ─── list-trades (raw trade log) ──────────────────────────────────────────────

export const listTradesSchema = {
  symbol: z.string().optional().describe("Filter by symbol"),
};

interface ListTradesArgs {
  symbol?: string;
}

export async function listTradesHandler(
  args: ListTradesArgs,
  env: Env,
  agent: SqlAgent
): Promise<ToolResponse> {
  let rows: any[];
  if (args.symbol) {
    rows = [...agent.sql`SELECT id, symbol, action, price, quantity, trade_date, broker, portfolio, signal_strategy FROM positions WHERE symbol = ${args.symbol} ORDER BY trade_date DESC, id DESC`];
  } else {
    rows = [...agent.sql`SELECT id, symbol, action, price, quantity, trade_date, broker, portfolio, signal_strategy FROM positions ORDER BY trade_date DESC, id DESC`];
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ trades: rows }, null, 2) }],
  };
}

// ─── update-trade ─────────────────────────────────────────────────────────────

export const updateTradeSchema = {
  id: z.number().int().positive("Trade ID is required"),
  price: z.number().positive().optional(),
  quantity: z.number().int().positive().optional(),
  trade_date: z.string().optional(),
  action: z.enum(["BUY", "SELL"]).optional(),
};

interface UpdateTradeArgs {
  id: number;
  price?: number;
  quantity?: number;
  trade_date?: string;
  action?: string;
  portfolio?: string;
  signal_strategy?: string | null;
}

export async function updateTradeHandler(
  args: UpdateTradeArgs,
  env: Env,
  agent: SqlAgent
): Promise<ToolResponse> {
  // Check trade exists
  const existing = [...agent.sql`SELECT id FROM positions WHERE id = ${args.id}`];
  if (existing.length === 0) {
    return {
      content: [{ type: "text", text: `Trade #${args.id} not found.` }],
      isError: true,
    };
  }

  if (args.price != null) {
    agent.sql`UPDATE positions SET price = ${args.price} WHERE id = ${args.id}`;
  }
  if (args.quantity != null) {
    agent.sql`UPDATE positions SET quantity = ${args.quantity} WHERE id = ${args.id}`;
  }
  if (args.trade_date) {
    agent.sql`UPDATE positions SET trade_date = ${args.trade_date} WHERE id = ${args.id}`;
  }
  if (args.action) {
    agent.sql`UPDATE positions SET action = ${args.action} WHERE id = ${args.id}`;
  }
  if (args.portfolio) {
    agent.sql`UPDATE positions SET portfolio = ${args.portfolio} WHERE id = ${args.id}`;
  }
  if (args.signal_strategy !== undefined) {
    const strat = args.signal_strategy || null;
    agent.sql`UPDATE positions SET signal_strategy = ${strat} WHERE id = ${args.id}`;
  }

  const updated = [...agent.sql`SELECT id, symbol, action, price, quantity, trade_date, portfolio, signal_strategy FROM positions WHERE id = ${args.id}`];
  return {
    content: [{ type: "text", text: JSON.stringify({ updated: updated[0] }, null, 2) }],
  };
}

// ─── delete-trade ─────────────────────────────────────────────────────────────

export const deleteTradeSchema = {
  id: z.number().int().positive("Trade ID is required"),
};

interface DeleteTradeArgs {
  id: number;
}

export async function deleteTradeHandler(
  args: DeleteTradeArgs,
  env: Env,
  agent: SqlAgent
): Promise<ToolResponse> {
  const existing = [...agent.sql`SELECT id, symbol, action, price, quantity FROM positions WHERE id = ${args.id}`];
  if (existing.length === 0) {
    return {
      content: [{ type: "text", text: `Trade #${args.id} not found.` }],
      isError: true,
    };
  }
  agent.sql`DELETE FROM positions WHERE id = ${args.id}`;
  return {
    content: [{ type: "text", text: JSON.stringify({ deleted: existing[0] }, null, 2) }],
  };
}

// ─── import-trades (bulk) ─────────────────────────────────────────────────────

interface ImportTrade {
  symbol: string;
  action: string;
  price: number;
  quantity: number;
  trade_date: string;
  broker?: string;
  portfolio?: string;
  source?: string;
  signal_strategy?: string;
}

export async function importTradesHandler(
  args: { trades: ImportTrade[] },
  env: Env,
  agent: SqlAgent
): Promise<ToolResponse> {
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const t of args.trades) {
    try {
      // Skip F&O trades — they belong in fno_positions, not equity positions
      const sym = t.symbol.toUpperCase();
      if (sym.startsWith('OPTIDX') || sym.startsWith('FUTIDX') ||
          /NIFTY\d{2}/.test(sym) || /BANKNIFTY\d{2}/.test(sym) ||
          (sym.endsWith('CE') && /\d/.test(sym)) || (sym.endsWith('PE') && /\d/.test(sym))) {
        skipped++;
        continue;
      }

      // Duplicate detection: same symbol + action + price + quantity within a ±3-day window.
      // The same fill arrives from the contract note and the API stamped with dates ~1 day apart;
      // matching on an exact trade_date let both insert. The window stops that double-count while still
      // allowing genuinely separate same-price/qty trades that are more than 3 days apart.
      const existing = [...agent.sql`SELECT id FROM positions WHERE symbol = ${t.symbol} AND action = ${t.action.toUpperCase()} AND price = ${t.price} AND quantity = ${t.quantity} AND ABS(julianday(trade_date) - julianday(${t.trade_date})) <= 3`];
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const broker = t.broker || 'MANUAL';
      const portfolio = t.portfolio || 'LEGACY';
      const source = t.source || 'CSV';
      const signalStrategy = t.signal_strategy || null;

      agent.sql`INSERT INTO positions (symbol, action, price, quantity, trade_date, broker, portfolio, source, signal_strategy)
        VALUES (${t.symbol}, ${t.action.toUpperCase()}, ${t.price}, ${t.quantity}, ${t.trade_date}, ${broker}, ${portfolio}, ${source}, ${signalStrategy})`;

      // Auto-stamp fingerprint from nearest scan snapshot for BUY trades
      if (t.action.toUpperCase() === 'BUY') {
        const snapRows = [...agent.sql`SELECT fingerprint FROM scan_snapshots
          WHERE symbol = ${t.symbol} AND scan_date <= ${t.trade_date}
          ORDER BY scan_date DESC, scan_time DESC LIMIT 1`];
        if (snapRows.length > 0) {
          agent.sql`UPDATE positions SET signal_fingerprint = ${(snapRows[0] as any).fingerprint}
            WHERE symbol = ${t.symbol} AND action = 'BUY' AND trade_date = ${t.trade_date} AND signal_fingerprint IS NULL`;
        }
      }

      imported++;
    } catch (error) {
      errors.push(`${t.symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ imported, skipped, errors: errors.length > 0 ? errors : undefined }, null, 2),
    }],
  };
}

// ─── strategy-portfolio ───────────────────────────────────────────────────────

export async function strategyPortfolioHandler(
  args: Record<string, never>,
  env: Env,
  agent: SqlAgent
): Promise<ToolResponse> {
  // Get all strategy trades
  const trades = [...agent.sql`SELECT id, symbol, action, price, quantity, trade_date, broker, signal_strategy, signal_fingerprint FROM positions WHERE portfolio = 'STRATEGY' ORDER BY trade_date, id`] as any[];

  // Aggregate by symbol
  const symbolMap: Record<string, { buys: any[]; sells: any[] }> = {};
  for (const t of trades) {
    if (!symbolMap[t.symbol]) symbolMap[t.symbol] = { buys: [], sells: [] };
    if (t.action === 'BUY') symbolMap[t.symbol].buys.push(t);
    else symbolMap[t.symbol].sells.push(t);
  }

  const openPositions: any[] = [];
  const closedPositions: any[] = [];

  for (const [symbol, data] of Object.entries(symbolMap)) {
    const totalBuyQty = data.buys.reduce((s: number, b: any) => s + b.quantity, 0);
    const totalSellQty = data.sells.reduce((s: number, b: any) => s + b.quantity, 0);
    const totalBuyCost = data.buys.reduce((s: number, b: any) => s + b.price * b.quantity, 0);
    const totalSellRevenue = data.sells.reduce((s: number, b: any) => s + b.price * b.quantity, 0);
    const netQty = totalBuyQty - totalSellQty;
    const avgBuyPrice = totalBuyQty > 0 ? totalBuyCost / totalBuyQty : 0;

    if (netQty > 0) {
      openPositions.push({
        symbol, net_quantity: netQty,
        avg_buy_price: Math.round(avgBuyPrice * 100) / 100,
        total_invested: Math.round(avgBuyPrice * netQty * 100) / 100,
        strategies: [...new Set(data.buys.flatMap((b: any) => strategiesFromFingerprint(b.signal_fingerprint)))],
        brokers: [...new Set(data.buys.map((b: any) => b.broker))],
      });
    } else {
      // Cap realized P&L at the matched round-trip quantity so duplicate/phantom sells can't inflate it.
      const avgSellPrice = totalSellQty > 0 ? totalSellRevenue / totalSellQty : 0;
      const matchedQty = Math.min(totalBuyQty, totalSellQty);
      const matchedCost = avgBuyPrice * matchedQty;
      const pnl = totalBuyQty > 0 ? matchedQty * (avgSellPrice - avgBuyPrice) : null;
      closedPositions.push({
        symbol,
        total_buy_cost: Math.round(totalBuyCost * 100) / 100,
        total_sell_revenue: Math.round(totalSellRevenue * 100) / 100,
        realized_pnl: pnl != null ? Math.round(pnl * 100) / 100 : null,
        pnl_pct: (pnl != null && matchedCost > 0) ? Math.round((pnl / matchedCost) * 10000) / 100 : 0,
        strategies: [...new Set(data.buys.flatMap((b: any) => strategiesFromFingerprint(b.signal_fingerprint)))],
      });
    }
  }

  // Per-strategy breakdown
  const strategyStats: Record<string, { trades: number; wins: number; pnl: number }> = {};
  for (const cp of closedPositions) {
    for (const strat of cp.strategies) {
      if (!strategyStats[strat]) strategyStats[strat] = { trades: 0, wins: 0, pnl: 0 };
      strategyStats[strat].trades++;
      strategyStats[strat].pnl += (cp.realized_pnl || 0);
      if (cp.realized_pnl != null && cp.realized_pnl > 0) strategyStats[strat].wins++;
    }
  }

  const totalInvested = openPositions.reduce((s, p) => s + p.total_invested, 0);
  const totalRealizedPnl = closedPositions.reduce((s, p) => s + (p.realized_pnl || 0), 0);
  // Closed positions whose buys carry no buy-date fingerprint (e.g. bought before scan-snapshot history)
  // can't be attributed and are intentionally excluded from strategy_breakdown rather than guessed.
  const unattributedClosed = closedPositions.filter((cp: any) => cp.strategies.length === 0).length;

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        summary: {
          open_positions: openPositions.length,
          closed_positions: closedPositions.length,
          total_invested: Math.round(totalInvested * 100) / 100,
          total_realized_pnl: Math.round(totalRealizedPnl * 100) / 100,
          total_trades: trades.length,
          unattributed_closed: unattributedClosed,
        },
        attribution_note: "Per-strategy P&L is CREDIT-ALL: each trade is credited to every strategy that fired a fresh/recent BUY on its entry date (derived from signal_fingerprint). Strategies overlap, so strategy_breakdown P&L will NOT sum to total_realized_pnl — read it as a per-strategy hit-rate lens, not a ledger. Trades with no buy-date snapshot are unattributed (see unattributed_closed) and excluded.",
        strategy_breakdown: strategyStats,
        open_positions: openPositions,
        closed_positions: closedPositions,
      }, null, 2),
    }],
  };
}

// ─── auto-tag strategy trades ─────────────────────────────────────────────────

export async function autoTagStrategyHandler(
  args: { scan_results: any[] },
  env: Env,
  agent: SqlAgent
): Promise<ToolResponse> {
  // Promote LEGACY holdings to STRATEGY based on the ACTUAL buy-date signal (the stored fingerprint),
  // NOT today's live scan — a months-old holding must be judged by the conditions on its entry date.
  // Only BUY rows; skip anything the user hand-tagged (manual_tag=1) so manual moves are never reverted.
  const trades = [...agent.sql`SELECT id, symbol, signal_fingerprint FROM positions WHERE portfolio = 'LEGACY' AND manual_tag = 0 AND action = 'BUY'`] as any[];

  let tagged = 0;
  const taggedList: any[] = [];

  for (const trade of trades) {
    // Skip F&O trades (options, futures)
    const sym = trade.symbol.toUpperCase();
    if (sym.includes('OPTIDX') || sym.includes('NIFTY') || sym.includes('BANKNIFTY') ||
        sym.includes('PE') || sym.includes('CE') || sym.includes('FUT')) {
      continue;
    }

    // Which strategies fired a FRESH/RECENT buy on this trade's OWN buy date?
    const fired = strategiesFromFingerprint(trade.signal_fingerprint);
    if (fired.length === 0) continue; // not bought on a signal (or no snapshot at entry) → stays LEGACY

    // Credit every strategy that fired at entry (comma-joined). The P&L breakdown re-derives the same
    // set from the fingerprint, so this flat field is now just for display/consistency.
    agent.sql`UPDATE positions SET portfolio = 'STRATEGY', signal_strategy = ${fired.join(',')} WHERE id = ${trade.id}`;
    tagged++;
    taggedList.push({ id: trade.id, symbol: sym, strategies: fired });
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ tagged, trades: taggedList }, null, 2),
    }],
  };
}

// ─── check-auth ───────────────────────────────────────────────────────────────

export const checkAuthSchema = {};

export async function checkAuthHandler(
  args: Record<string, never>,
  env: Env,
): Promise<ToolResponse> {
  try {
    const response = await fetch(`${UPSTOX_API_BASE_URL}/v2/user/profile`, {
      headers: {
        Accept: HEADERS.ACCEPT,
        Authorization: `Bearer ${env.UPSTOX_ACCESS_TOKEN}`,
      },
    });

    if (response.ok) {
      const json = (await response.json()) as { data?: { user_name?: string; email?: string } };
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "VALID",
            message: "Token is active (expires 11:59 PM IST today)",
            user: json.data?.user_name || "Unknown",
            email: json.data?.email || "Unknown",
          }, null, 2),
        }],
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "EXPIRED",
          message: "Token expired. Run get_token.py to re-authenticate.",
        }, null, 2),
      }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "ERROR",
          message: `Could not verify token: ${error instanceof Error ? error.message : String(error)}`,
        }, null, 2),
      }],
      isError: true,
    };
  }
}
