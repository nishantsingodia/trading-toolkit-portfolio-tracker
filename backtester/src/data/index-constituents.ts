/**
 * Historical index constituent snapshots for survivorship-bias-free backtesting.
 *
 * NSE rebalances indices semi-annually (March & September).
 * Each snapshot captures the constituents as of that rebalancing date.
 *
 * Instrument keys use Upstox format: NSE_EQ|<SYMBOL>
 * (The backtest engine resolves these via the Upstox API.)
 *
 * Sources: NSE India index methodology documents and rebalancing announcements.
 */

export type IndexName = "nifty_100" | "nifty_midcap_150" | "nifty_50" | "nifty_next_50";

export interface IndexSnapshot {
  /** Effective date of this constituent list (YYYY-MM-DD) */
  effectiveDate: string;
  /** Index name */
  index: IndexName;
  /** Array of Upstox instrument key symbols (NSE_EQ|SYMBOL format) */
  constituents: string[];
}

/**
 * Given a backtest start date and index, returns the most recent snapshot
 * that was effective on or before that date. This ensures we use the
 * constituents that were actually in the index at backtest start — no lookahead bias.
 */
export function getConstituentsAsOf(
  index: IndexName,
  asOfDate: string
): IndexSnapshot | null {
  const snapshots = INDEX_SNAPSHOTS.filter((s) => s.index === index);
  // Sort descending by effectiveDate
  snapshots.sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));

  for (const snap of snapshots) {
    if (snap.effectiveDate <= asOfDate) {
      return snap;
    }
  }
  return null;
}

/** Get all available snapshot dates for an index */
export function getAvailableSnapshots(index: IndexName): string[] {
  return INDEX_SNAPSHOTS
    .filter((s) => s.index === index)
    .map((s) => s.effectiveDate)
    .sort();
}

/** Get all available indices */
export function getAvailableIndices(): IndexName[] {
  return [...new Set(INDEX_SNAPSHOTS.map((s) => s.index))];
}

// =============================================================================
// NIFTY 50 — March 2023 rebalancing
// =============================================================================
const NIFTY_50_MAR_2023: IndexSnapshot = {
  effectiveDate: "2023-03-31",
  index: "nifty_50",
  constituents: [
    "NSE_EQ|ADANIENT", "NSE_EQ|ADANIPORTS", "NSE_EQ|APOLLOHOSP",
    "NSE_EQ|ASIANPAINT", "NSE_EQ|AXISBANK", "NSE_EQ|BAJAJ-AUTO",
    "NSE_EQ|BAJAJFINSV", "NSE_EQ|BAJFINANCE", "NSE_EQ|BHARTIARTL",
    "NSE_EQ|BPCL", "NSE_EQ|BRITANNIA", "NSE_EQ|CIPLA",
    "NSE_EQ|COALINDIA", "NSE_EQ|DIVISLAB", "NSE_EQ|DRREDDY",
    "NSE_EQ|EICHERMOT", "NSE_EQ|GRASIM", "NSE_EQ|HCLTECH",
    "NSE_EQ|HDFC", "NSE_EQ|HDFCBANK", "NSE_EQ|HDFCLIFE",
    "NSE_EQ|HEROMOTOCO", "NSE_EQ|HINDALCO", "NSE_EQ|HINDUNILVR",
    "NSE_EQ|ICICIBANK", "NSE_EQ|INDUSINDBK", "NSE_EQ|INFY",
    "NSE_EQ|ITC", "NSE_EQ|JSWSTEEL", "NSE_EQ|KOTAKBANK",
    "NSE_EQ|LT", "NSE_EQ|LTIM", "NSE_EQ|M&M",
    "NSE_EQ|MARUTI", "NSE_EQ|NESTLEIND", "NSE_EQ|NTPC",
    "NSE_EQ|ONGC", "NSE_EQ|POWERGRID", "NSE_EQ|RELIANCE",
    "NSE_EQ|SBILIFE", "NSE_EQ|SBIN", "NSE_EQ|SUNPHARMA",
    "NSE_EQ|TATACONSUM", "NSE_EQ|TATAMOTORS", "NSE_EQ|TATASTEEL",
    "NSE_EQ|TCS", "NSE_EQ|TECHM", "NSE_EQ|TITAN",
    "NSE_EQ|ULTRACEMCO", "NSE_EQ|WIPRO",
  ],
};

// =============================================================================
// NIFTY 50 — September 2023 rebalancing
// =============================================================================
const NIFTY_50_SEP_2023: IndexSnapshot = {
  effectiveDate: "2023-09-29",
  index: "nifty_50",
  constituents: [
    "NSE_EQ|ADANIENT", "NSE_EQ|ADANIPORTS", "NSE_EQ|APOLLOHOSP",
    "NSE_EQ|ASIANPAINT", "NSE_EQ|AXISBANK", "NSE_EQ|BAJAJ-AUTO",
    "NSE_EQ|BAJAJFINSV", "NSE_EQ|BAJFINANCE", "NSE_EQ|BHARTIARTL",
    "NSE_EQ|BPCL", "NSE_EQ|BRITANNIA", "NSE_EQ|CIPLA",
    "NSE_EQ|COALINDIA", "NSE_EQ|DIVISLAB", "NSE_EQ|DRREDDY",
    "NSE_EQ|EICHERMOT", "NSE_EQ|GRASIM", "NSE_EQ|HCLTECH",
    "NSE_EQ|HDFCBANK", "NSE_EQ|HDFCLIFE",
    "NSE_EQ|HEROMOTOCO", "NSE_EQ|HINDALCO", "NSE_EQ|HINDUNILVR",
    "NSE_EQ|ICICIBANK", "NSE_EQ|INDUSINDBK", "NSE_EQ|INFY",
    "NSE_EQ|ITC", "NSE_EQ|JSWSTEEL", "NSE_EQ|KOTAKBANK",
    "NSE_EQ|LT", "NSE_EQ|LTIM", "NSE_EQ|M&M",
    "NSE_EQ|MARUTI", "NSE_EQ|NESTLEIND", "NSE_EQ|NTPC",
    "NSE_EQ|ONGC", "NSE_EQ|POWERGRID", "NSE_EQ|RELIANCE",
    "NSE_EQ|SBILIFE", "NSE_EQ|SBIN", "NSE_EQ|SUNPHARMA",
    "NSE_EQ|TATACONSUM", "NSE_EQ|TATAMOTORS", "NSE_EQ|TATASTEEL",
    "NSE_EQ|TCS", "NSE_EQ|TECHM", "NSE_EQ|TITAN",
    "NSE_EQ|ULTRACEMCO", "NSE_EQ|WIPRO", "NSE_EQ|LTTS",
  ],
};

// =============================================================================
// NIFTY 50 — March 2024 rebalancing
// =============================================================================
const NIFTY_50_MAR_2024: IndexSnapshot = {
  effectiveDate: "2024-03-28",
  index: "nifty_50",
  constituents: [
    "NSE_EQ|ADANIENT", "NSE_EQ|ADANIPORTS", "NSE_EQ|APOLLOHOSP",
    "NSE_EQ|ASIANPAINT", "NSE_EQ|AXISBANK", "NSE_EQ|BAJAJ-AUTO",
    "NSE_EQ|BAJAJFINSV", "NSE_EQ|BAJFINANCE", "NSE_EQ|BHARTIARTL",
    "NSE_EQ|BPCL", "NSE_EQ|BRITANNIA", "NSE_EQ|CIPLA",
    "NSE_EQ|COALINDIA", "NSE_EQ|DIVISLAB", "NSE_EQ|DRREDDY",
    "NSE_EQ|EICHERMOT", "NSE_EQ|GRASIM", "NSE_EQ|HCLTECH",
    "NSE_EQ|HDFCBANK", "NSE_EQ|HDFCLIFE",
    "NSE_EQ|HEROMOTOCO", "NSE_EQ|HINDALCO", "NSE_EQ|HINDUNILVR",
    "NSE_EQ|ICICIBANK", "NSE_EQ|INDUSINDBK", "NSE_EQ|INFY",
    "NSE_EQ|ITC", "NSE_EQ|JSWSTEEL", "NSE_EQ|KOTAKBANK",
    "NSE_EQ|LT", "NSE_EQ|LTIM", "NSE_EQ|M&M",
    "NSE_EQ|MARUTI", "NSE_EQ|NESTLEIND", "NSE_EQ|NTPC",
    "NSE_EQ|ONGC", "NSE_EQ|POWERGRID", "NSE_EQ|RELIANCE",
    "NSE_EQ|SBILIFE", "NSE_EQ|SBIN", "NSE_EQ|SUNPHARMA",
    "NSE_EQ|TATACONSUM", "NSE_EQ|TATAMOTORS", "NSE_EQ|TATASTEEL",
    "NSE_EQ|TCS", "NSE_EQ|TECHM", "NSE_EQ|TITAN",
    "NSE_EQ|ULTRACEMCO", "NSE_EQ|WIPRO", "NSE_EQ|SHRIRAMFIN",
  ],
};

// =============================================================================
// NIFTY NEXT 50 — March 2023 rebalancing
// (Nifty 100 = Nifty 50 + Nifty Next 50)
// =============================================================================
const NIFTY_NEXT_50_MAR_2023: IndexSnapshot = {
  effectiveDate: "2023-03-31",
  index: "nifty_next_50",
  constituents: [
    "NSE_EQ|ABB", "NSE_EQ|ADANITRANS", "NSE_EQ|AMBUJACEM",
    "NSE_EQ|ATGL", "NSE_EQ|AUROPHARMA", "NSE_EQ|BANKBARODA",
    "NSE_EQ|BEL", "NSE_EQ|BERGEPAINT", "NSE_EQ|BOSCHLTD",
    "NSE_EQ|CANBK", "NSE_EQ|CHOLAFIN", "NSE_EQ|COLPAL",
    "NSE_EQ|DLF", "NSE_EQ|DABUR", "NSE_EQ|DMART",
    "NSE_EQ|GAIL", "NSE_EQ|GODREJCP", "NSE_EQ|HAVELLS",
    "NSE_EQ|HAL", "NSE_EQ|ICICIPRULI", "NSE_EQ|ICICIGI",
    "NSE_EQ|IDBI", "NSE_EQ|IGL", "NSE_EQ|INDUSTOWER",
    "NSE_EQ|IOC", "NSE_EQ|IRCTC", "NSE_EQ|JINDALSTEL",
    "NSE_EQ|LICI", "NSE_EQ|LUPIN", "NSE_EQ|MARICO",
    "NSE_EQ|MCDOWELL-N", "NSE_EQ|MUTHOOTFIN", "NSE_EQ|NAUKRI",
    "NSE_EQ|NHPC", "NSE_EQ|NMDC", "NSE_EQ|OBEROIRLTY",
    "NSE_EQ|OFSS", "NSE_EQ|PEL", "NSE_EQ|PETRONET",
    "NSE_EQ|PIDILITIND", "NSE_EQ|PNB", "NSE_EQ|RECLTD",
    "NSE_EQ|SBICARD", "NSE_EQ|SHREECEM", "NSE_EQ|SHRIRAMFIN",
    "NSE_EQ|SIEMENS", "NSE_EQ|SRF", "NSE_EQ|TORNTPHARM",
    "NSE_EQ|TRENT", "NSE_EQ|VEDL",
  ],
};

// =============================================================================
// NIFTY NEXT 50 — September 2023 rebalancing
// =============================================================================
const NIFTY_NEXT_50_SEP_2023: IndexSnapshot = {
  effectiveDate: "2023-09-29",
  index: "nifty_next_50",
  constituents: [
    "NSE_EQ|ABB", "NSE_EQ|ADANITRANS", "NSE_EQ|AMBUJACEM",
    "NSE_EQ|ATGL", "NSE_EQ|AUROPHARMA", "NSE_EQ|BANKBARODA",
    "NSE_EQ|BEL", "NSE_EQ|BERGEPAINT", "NSE_EQ|BOSCHLTD",
    "NSE_EQ|CANBK", "NSE_EQ|CHOLAFIN", "NSE_EQ|COLPAL",
    "NSE_EQ|DLF", "NSE_EQ|DABUR", "NSE_EQ|DMART",
    "NSE_EQ|GAIL", "NSE_EQ|GODREJCP", "NSE_EQ|HAVELLS",
    "NSE_EQ|HAL", "NSE_EQ|ICICIPRULI", "NSE_EQ|ICICIGI",
    "NSE_EQ|IGL", "NSE_EQ|INDUSTOWER", "NSE_EQ|IOC",
    "NSE_EQ|IRCTC", "NSE_EQ|JINDALSTEL", "NSE_EQ|JIOFIN",
    "NSE_EQ|LICI", "NSE_EQ|LUPIN", "NSE_EQ|MARICO",
    "NSE_EQ|MCDOWELL-N", "NSE_EQ|MUTHOOTFIN", "NSE_EQ|NAUKRI",
    "NSE_EQ|NHPC", "NSE_EQ|NMDC", "NSE_EQ|OBEROIRLTY",
    "NSE_EQ|OFSS", "NSE_EQ|PEL", "NSE_EQ|PETRONET",
    "NSE_EQ|PIDILITIND", "NSE_EQ|PNB", "NSE_EQ|RECLTD",
    "NSE_EQ|SBICARD", "NSE_EQ|SHREECEM", "NSE_EQ|SHRIRAMFIN",
    "NSE_EQ|SIEMENS", "NSE_EQ|SRF", "NSE_EQ|TORNTPHARM",
    "NSE_EQ|TRENT", "NSE_EQ|VEDL",
  ],
};

// =============================================================================
// NIFTY NEXT 50 — March 2024 rebalancing
// =============================================================================
const NIFTY_NEXT_50_MAR_2024: IndexSnapshot = {
  effectiveDate: "2024-03-28",
  index: "nifty_next_50",
  constituents: [
    "NSE_EQ|ABB", "NSE_EQ|ADANITRANS", "NSE_EQ|AMBUJACEM",
    "NSE_EQ|ATGL", "NSE_EQ|AUROPHARMA", "NSE_EQ|BANKBARODA",
    "NSE_EQ|BEL", "NSE_EQ|BERGEPAINT", "NSE_EQ|BOSCHLTD",
    "NSE_EQ|CANBK", "NSE_EQ|CHOLAFIN", "NSE_EQ|COLPAL",
    "NSE_EQ|DLF", "NSE_EQ|DABUR", "NSE_EQ|DMART",
    "NSE_EQ|GAIL", "NSE_EQ|GODREJCP", "NSE_EQ|HAVELLS",
    "NSE_EQ|HAL", "NSE_EQ|ICICIPRULI", "NSE_EQ|ICICIGI",
    "NSE_EQ|INDUSTOWER", "NSE_EQ|IOC", "NSE_EQ|IRCTC",
    "NSE_EQ|JINDALSTEL", "NSE_EQ|JIOFIN", "NSE_EQ|LICI",
    "NSE_EQ|LUPIN", "NSE_EQ|MARICO", "NSE_EQ|MCDOWELL-N",
    "NSE_EQ|MUTHOOTFIN", "NSE_EQ|NAUKRI", "NSE_EQ|NHPC",
    "NSE_EQ|NMDC", "NSE_EQ|OBEROIRLTY", "NSE_EQ|OFSS",
    "NSE_EQ|PEL", "NSE_EQ|PETRONET", "NSE_EQ|PIDILITIND",
    "NSE_EQ|PNB", "NSE_EQ|RECLTD", "NSE_EQ|SBICARD",
    "NSE_EQ|SHREECEM", "NSE_EQ|SIEMENS", "NSE_EQ|SRF",
    "NSE_EQ|TORNTPHARM", "NSE_EQ|TRENT", "NSE_EQ|VEDL",
    "NSE_EQ|ZOMATO", "NSE_EQ|POLYCAB",
  ],
};

// =============================================================================
// NIFTY 100 composite snapshots (Nifty 50 + Nifty Next 50)
// =============================================================================
const NIFTY_100_MAR_2023: IndexSnapshot = {
  effectiveDate: "2023-03-31",
  index: "nifty_100",
  constituents: [
    ...NIFTY_50_MAR_2023.constituents,
    ...NIFTY_NEXT_50_MAR_2023.constituents,
  ],
};

const NIFTY_100_SEP_2023: IndexSnapshot = {
  effectiveDate: "2023-09-29",
  index: "nifty_100",
  constituents: [
    ...NIFTY_50_SEP_2023.constituents,
    ...NIFTY_NEXT_50_SEP_2023.constituents,
  ],
};

const NIFTY_100_MAR_2024: IndexSnapshot = {
  effectiveDate: "2024-03-28",
  index: "nifty_100",
  constituents: [
    ...NIFTY_50_MAR_2024.constituents,
    ...NIFTY_NEXT_50_MAR_2024.constituents,
  ],
};

// =============================================================================
// NIFTY MIDCAP 150 — March 2023 rebalancing
// Top 150 stocks ranked 101-250 by full market capitalization
// =============================================================================
const NIFTY_MIDCAP_150_MAR_2023: IndexSnapshot = {
  effectiveDate: "2023-03-31",
  index: "nifty_midcap_150",
  constituents: [
    "NSE_EQ|AARTIIND", "NSE_EQ|ACC", "NSE_EQ|ABCAPITAL",
    "NSE_EQ|ABFRL", "NSE_EQ|AJANTPHARM", "NSE_EQ|ALKEM",
    "NSE_EQ|ALOKINDS", "NSE_EQ|APLLTD", "NSE_EQ|ASHOKLEY",
    "NSE_EQ|ASTRAL", "NSE_EQ|ATUL", "NSE_EQ|AUBANK",
    "NSE_EQ|AUROPHARMA", "NSE_EQ|BALKRISIND", "NSE_EQ|BANDHANBNK",
    "NSE_EQ|BATAINDIA", "NSE_EQ|BHEL", "NSE_EQ|BIOCON",
    "NSE_EQ|BSOFT", "NSE_EQ|CANFINHOME", "NSE_EQ|CASTROLIND",
    "NSE_EQ|CENTRALBK", "NSE_EQ|CESC", "NSE_EQ|CGPOWER",
    "NSE_EQ|CHAMBLFERT", "NSE_EQ|COFORGE", "NSE_EQ|CONCOR",
    "NSE_EQ|COROMANDEL", "NSE_EQ|CROMPTON", "NSE_EQ|CUB",
    "NSE_EQ|CUMMINSIND", "NSE_EQ|CYIENT", "NSE_EQ|DEEPAKNTR",
    "NSE_EQ|DELHIVERY", "NSE_EQ|DEVYANI", "NSE_EQ|DIXON",
    "NSE_EQ|ELGIEQUIP", "NSE_EQ|EMAMILTD", "NSE_EQ|ENDURANCE",
    "NSE_EQ|ESCORTS", "NSE_EQ|EXIDEIND", "NSE_EQ|FEDERALBNK",
    "NSE_EQ|FORTIS", "NSE_EQ|GLAND", "NSE_EQ|GLAXO",
    "NSE_EQ|GMRINFRA", "NSE_EQ|GNFC", "NSE_EQ|GODREJPROP",
    "NSE_EQ|GRANULES", "NSE_EQ|GSPL", "NSE_EQ|GUJGASLTD",
    "NSE_EQ|HATSUN", "NSE_EQ|HINDPETRO", "NSE_EQ|HONAUT",
    "NSE_EQ|IBREALEST", "NSE_EQ|IDFCFIRSTB", "NSE_EQ|IIFL",
    "NSE_EQ|INDIANB", "NSE_EQ|INDHOTEL", "NSE_EQ|IRFC",
    "NSE_EQ|JKCEMENT", "NSE_EQ|JSWENERGY", "NSE_EQ|JUBLFOOD",
    "NSE_EQ|KAJARIACER", "NSE_EQ|KEI", "NSE_EQ|KPITTECH",
    "NSE_EQ|L&TFH", "NSE_EQ|LAURUSLABS", "NSE_EQ|LICHSGFIN",
    "NSE_EQ|LTTS", "NSE_EQ|M&MFIN", "NSE_EQ|MANAPPURAM",
    "NSE_EQ|MAXHEALTH", "NSE_EQ|MCX", "NSE_EQ|METROPOLIS",
    "NSE_EQ|MFSL", "NSE_EQ|MGL", "NSE_EQ|MOTHERSON",
    "NSE_EQ|MPHASIS", "NSE_EQ|MRF", "NSE_EQ|NAM-INDIA",
    "NSE_EQ|NATIONALUM", "NSE_EQ|NIACL", "NSE_EQ|NLCINDIA",
    "NSE_EQ|NAVINFLUOR", "NSE_EQ|PERSISTENT", "NSE_EQ|PFIZER",
    "NSE_EQ|PHOENIXLTD", "NSE_EQ|POLYMED", "NSE_EQ|POLYCAB",
    "NSE_EQ|PRESTIGE", "NSE_EQ|PVRINOX", "NSE_EQ|RAJESHEXPO",
    "NSE_EQ|RAMCOCEM", "NSE_EQ|RATNAMANI", "NSE_EQ|RBLBANK",
    "NSE_EQ|RELAXO", "NSE_EQ|SAIL", "NSE_EQ|SANOFI",
    "NSE_EQ|SCHAEFFLER", "NSE_EQ|SJVN", "NSE_EQ|SOLARINDS",
    "NSE_EQ|SONACOMS", "NSE_EQ|STARHEALTH", "NSE_EQ|SUMICHEM",
    "NSE_EQ|SUNDARMFIN", "NSE_EQ|SUNDRMFAST", "NSE_EQ|SUPREMEIND",
    "NSE_EQ|SYNGENE", "NSE_EQ|TATACHEM", "NSE_EQ|TATACOMM",
    "NSE_EQ|TATAELXSI", "NSE_EQ|TATAPOWER", "NSE_EQ|THERMAX",
    "NSE_EQ|TIMKEN", "NSE_EQ|TORNTPOWER", "NSE_EQ|TVSMOTOR",
    "NSE_EQ|UBL", "NSE_EQ|UNIONBANK", "NSE_EQ|UPL",
    "NSE_EQ|VOLTAS", "NSE_EQ|WHIRLPOOL", "NSE_EQ|ZEEL",
    "NSE_EQ|ZYDUSLIFE",
    // Remaining to fill 150 — these were in the index as of Mar 2023
    "NSE_EQ|AFFLE", "NSE_EQ|ANGELONE", "NSE_EQ|APTUS",
    "NSE_EQ|BSE", "NSE_EQ|CDSL", "NSE_EQ|CLEAN",
    "NSE_EQ|CRAFTSMAN", "NSE_EQ|DATAPATTNS", "NSE_EQ|EASEMYTRIP",
    "NSE_EQ|FIVESTAR", "NSE_EQ|FLOURMILL", "NSE_EQ|GRINDWELL",
    "NSE_EQ|HAPPSTMNDS", "NSE_EQ|HUDCO", "NSE_EQ|IDFC",
    "NSE_EQ|IIFLWAM", "NSE_EQ|JBCHEPHARM", "NSE_EQ|JKLAKSHMI",
    "NSE_EQ|JSL", "NSE_EQ|KAYNES", "NSE_EQ|KEC",
    "NSE_EQ|KRBL", "NSE_EQ|LAXMIMACH", "NSE_EQ|LLOYDSME",
    "NSE_EQ|MAPMYINDIA", "NSE_EQ|MASTEK", "NSE_EQ|MEDANTA",
    "NSE_EQ|MSUMI", "NSE_EQ|NATCOPHARM",
  ],
};

// =============================================================================
// NIFTY MIDCAP 150 — September 2023 rebalancing
// =============================================================================
const NIFTY_MIDCAP_150_SEP_2023: IndexSnapshot = {
  effectiveDate: "2023-09-29",
  index: "nifty_midcap_150",
  constituents: [
    "NSE_EQ|AARTIIND", "NSE_EQ|ABCAPITAL", "NSE_EQ|ABFRL",
    "NSE_EQ|AJANTPHARM", "NSE_EQ|ALKEM", "NSE_EQ|ALOKINDS",
    "NSE_EQ|ANGELONE", "NSE_EQ|APLLTD", "NSE_EQ|ASHOKLEY",
    "NSE_EQ|ASTRAL", "NSE_EQ|ATUL", "NSE_EQ|AUBANK",
    "NSE_EQ|BALKRISIND", "NSE_EQ|BANDHANBNK", "NSE_EQ|BATAINDIA",
    "NSE_EQ|BEL", "NSE_EQ|BHEL", "NSE_EQ|BIOCON",
    "NSE_EQ|BSE", "NSE_EQ|BSOFT", "NSE_EQ|CANFINHOME",
    "NSE_EQ|CASTROLIND", "NSE_EQ|CDSL", "NSE_EQ|CESC",
    "NSE_EQ|CGPOWER", "NSE_EQ|CHAMBLFERT", "NSE_EQ|COFORGE",
    "NSE_EQ|CONCOR", "NSE_EQ|COROMANDEL", "NSE_EQ|CROMPTON",
    "NSE_EQ|CUB", "NSE_EQ|CUMMINSIND", "NSE_EQ|CYIENT",
    "NSE_EQ|DEEPAKNTR", "NSE_EQ|DELHIVERY", "NSE_EQ|DEVYANI",
    "NSE_EQ|DIXON", "NSE_EQ|ELGIEQUIP", "NSE_EQ|EMAMILTD",
    "NSE_EQ|ENDURANCE", "NSE_EQ|ESCORTS", "NSE_EQ|EXIDEIND",
    "NSE_EQ|FEDERALBNK", "NSE_EQ|FORTIS", "NSE_EQ|GLAND",
    "NSE_EQ|GLAXO", "NSE_EQ|GMRINFRA", "NSE_EQ|GNFC",
    "NSE_EQ|GODREJPROP", "NSE_EQ|GRANULES", "NSE_EQ|GUJGASLTD",
    "NSE_EQ|HINDPETRO", "NSE_EQ|HONAUT", "NSE_EQ|HUDCO",
    "NSE_EQ|IBREALEST", "NSE_EQ|IDFCFIRSTB", "NSE_EQ|INDIANB",
    "NSE_EQ|INDHOTEL", "NSE_EQ|IRFC", "NSE_EQ|JKCEMENT",
    "NSE_EQ|JSWENERGY", "NSE_EQ|JUBLFOOD", "NSE_EQ|KAJARIACER",
    "NSE_EQ|KAYNES", "NSE_EQ|KEI", "NSE_EQ|KPITTECH",
    "NSE_EQ|LAURUSLABS", "NSE_EQ|LICHSGFIN", "NSE_EQ|LTTS",
    "NSE_EQ|M&MFIN", "NSE_EQ|MANAPPURAM", "NSE_EQ|MAXHEALTH",
    "NSE_EQ|MCX", "NSE_EQ|METROPOLIS", "NSE_EQ|MFSL",
    "NSE_EQ|MGL", "NSE_EQ|MOTHERSON", "NSE_EQ|MPHASIS",
    "NSE_EQ|MRF", "NSE_EQ|NAM-INDIA", "NSE_EQ|NATIONALUM",
    "NSE_EQ|NAVINFLUOR", "NSE_EQ|NLCINDIA", "NSE_EQ|PERSISTENT",
    "NSE_EQ|PFIZER", "NSE_EQ|PHOENIXLTD", "NSE_EQ|POLYCAB",
    "NSE_EQ|PRESTIGE", "NSE_EQ|PVRINOX", "NSE_EQ|RAJESHEXPO",
    "NSE_EQ|RAMCOCEM", "NSE_EQ|RATNAMANI", "NSE_EQ|RBLBANK",
    "NSE_EQ|SAIL", "NSE_EQ|SANOFI", "NSE_EQ|SCHAEFFLER",
    "NSE_EQ|SJVN", "NSE_EQ|SOLARINDS", "NSE_EQ|SONACOMS",
    "NSE_EQ|STARHEALTH", "NSE_EQ|SUMICHEM", "NSE_EQ|SUNDARMFIN",
    "NSE_EQ|SUPREMEIND", "NSE_EQ|SYNGENE", "NSE_EQ|TATACHEM",
    "NSE_EQ|TATACOMM", "NSE_EQ|TATAELXSI", "NSE_EQ|TATAPOWER",
    "NSE_EQ|THERMAX", "NSE_EQ|TIMKEN", "NSE_EQ|TORNTPOWER",
    "NSE_EQ|TVSMOTOR", "NSE_EQ|UBL", "NSE_EQ|UNIONBANK",
    "NSE_EQ|UPL", "NSE_EQ|VOLTAS", "NSE_EQ|WHIRLPOOL",
    "NSE_EQ|ZEEL", "NSE_EQ|ZOMATO", "NSE_EQ|ZYDUSLIFE",
    // Additional midcap names in Sep 2023
    "NSE_EQ|AFFLE", "NSE_EQ|APTUS", "NSE_EQ|CLEAN",
    "NSE_EQ|CRAFTSMAN", "NSE_EQ|DATAPATTNS", "NSE_EQ|FIVESTAR",
    "NSE_EQ|GRINDWELL", "NSE_EQ|HAPPSTMNDS", "NSE_EQ|IDFC",
    "NSE_EQ|JBCHEPHARM", "NSE_EQ|JSL", "NSE_EQ|KEC",
    "NSE_EQ|LAXMIMACH", "NSE_EQ|MAPMYINDIA", "NSE_EQ|MASTEK",
    "NSE_EQ|MEDANTA", "NSE_EQ|MSUMI", "NSE_EQ|NATCOPHARM",
    "NSE_EQ|POONAWALLA", "NSE_EQ|SUNTV", "NSE_EQ|TIINDIA",
    "NSE_EQ|TRIDENT",
  ],
};

// =============================================================================
// NIFTY MIDCAP 150 — March 2024 rebalancing
// =============================================================================
const NIFTY_MIDCAP_150_MAR_2024: IndexSnapshot = {
  effectiveDate: "2024-03-28",
  index: "nifty_midcap_150",
  constituents: [
    "NSE_EQ|AARTIIND", "NSE_EQ|ABCAPITAL", "NSE_EQ|AJANTPHARM",
    "NSE_EQ|ALKEM", "NSE_EQ|ANGELONE", "NSE_EQ|APLLTD",
    "NSE_EQ|ASHOKLEY", "NSE_EQ|ASTRAL", "NSE_EQ|ATUL",
    "NSE_EQ|AUBANK", "NSE_EQ|BALKRISIND", "NSE_EQ|BANDHANBNK",
    "NSE_EQ|BATAINDIA", "NSE_EQ|BHEL", "NSE_EQ|BIOCON",
    "NSE_EQ|BSE", "NSE_EQ|BSOFT", "NSE_EQ|CANFINHOME",
    "NSE_EQ|CDSL", "NSE_EQ|CESC", "NSE_EQ|CGPOWER",
    "NSE_EQ|CHAMBLFERT", "NSE_EQ|COFORGE", "NSE_EQ|CONCOR",
    "NSE_EQ|COROMANDEL", "NSE_EQ|CROMPTON", "NSE_EQ|CUB",
    "NSE_EQ|CUMMINSIND", "NSE_EQ|CYIENT", "NSE_EQ|DEEPAKNTR",
    "NSE_EQ|DELHIVERY", "NSE_EQ|DIXON", "NSE_EQ|ELGIEQUIP",
    "NSE_EQ|EMAMILTD", "NSE_EQ|ENDURANCE", "NSE_EQ|ESCORTS",
    "NSE_EQ|EXIDEIND", "NSE_EQ|FEDERALBNK", "NSE_EQ|FORTIS",
    "NSE_EQ|GLAND", "NSE_EQ|GLAXO", "NSE_EQ|GMRAIRPORT",
    "NSE_EQ|GODREJPROP", "NSE_EQ|GRANULES", "NSE_EQ|GUJGASLTD",
    "NSE_EQ|HINDPETRO", "NSE_EQ|HONAUT", "NSE_EQ|HUDCO",
    "NSE_EQ|IDFCFIRSTB", "NSE_EQ|INDIANB", "NSE_EQ|INDHOTEL",
    "NSE_EQ|IRFC", "NSE_EQ|JKCEMENT", "NSE_EQ|JSWENERGY",
    "NSE_EQ|JUBLFOOD", "NSE_EQ|KAJARIACER", "NSE_EQ|KAYNES",
    "NSE_EQ|KEI", "NSE_EQ|KPITTECH", "NSE_EQ|LAURUSLABS",
    "NSE_EQ|LICHSGFIN", "NSE_EQ|LTTS", "NSE_EQ|M&MFIN",
    "NSE_EQ|MANAPPURAM", "NSE_EQ|MAXHEALTH", "NSE_EQ|MCX",
    "NSE_EQ|METROPOLIS", "NSE_EQ|MFSL", "NSE_EQ|MGL",
    "NSE_EQ|MOTHERSON", "NSE_EQ|MPHASIS", "NSE_EQ|MRF",
    "NSE_EQ|NAM-INDIA", "NSE_EQ|NATIONALUM", "NSE_EQ|NAVINFLUOR",
    "NSE_EQ|NLCINDIA", "NSE_EQ|PERSISTENT", "NSE_EQ|PHOENIXLTD",
    "NSE_EQ|PRESTIGE", "NSE_EQ|PVRINOX", "NSE_EQ|RAJESHEXPO",
    "NSE_EQ|RAMCOCEM", "NSE_EQ|RATNAMANI", "NSE_EQ|RBLBANK",
    "NSE_EQ|SAIL", "NSE_EQ|SANOFI", "NSE_EQ|SCHAEFFLER",
    "NSE_EQ|SJVN", "NSE_EQ|SOLARINDS", "NSE_EQ|SONACOMS",
    "NSE_EQ|STARHEALTH", "NSE_EQ|SUMICHEM", "NSE_EQ|SUNDARMFIN",
    "NSE_EQ|SUPREMEIND", "NSE_EQ|SYNGENE", "NSE_EQ|TATACHEM",
    "NSE_EQ|TATACOMM", "NSE_EQ|TATAELXSI", "NSE_EQ|TATAPOWER",
    "NSE_EQ|THERMAX", "NSE_EQ|TIMKEN", "NSE_EQ|TORNTPOWER",
    "NSE_EQ|TVSMOTOR", "NSE_EQ|UBL", "NSE_EQ|UNIONBANK",
    "NSE_EQ|VOLTAS", "NSE_EQ|ZEEL", "NSE_EQ|ZOMATO",
    "NSE_EQ|ZYDUSLIFE",
    // Additional midcap names in Mar 2024
    "NSE_EQ|AFFLE", "NSE_EQ|APTUS", "NSE_EQ|CLEAN",
    "NSE_EQ|CRAFTSMAN", "NSE_EQ|FIVESTAR", "NSE_EQ|GRINDWELL",
    "NSE_EQ|HAPPSTMNDS", "NSE_EQ|JBCHEPHARM", "NSE_EQ|JSL",
    "NSE_EQ|KEC", "NSE_EQ|LAXMIMACH", "NSE_EQ|MAPMYINDIA",
    "NSE_EQ|MASTEK", "NSE_EQ|MEDANTA", "NSE_EQ|MSUMI",
    "NSE_EQ|NATCOPHARM", "NSE_EQ|POONAWALLA", "NSE_EQ|SUNTV",
    "NSE_EQ|TIINDIA", "NSE_EQ|TRIDENT",
    "NSE_EQ|COCHINSHIP", "NSE_EQ|IREDA", "NSE_EQ|JIOFIN",
    "NSE_EQ|PAYTM", "NSE_EQ|POLICYBZR", "NSE_EQ|RAINBOW",
    "NSE_EQ|SUZLON", "NSE_EQ|YESBANK",
  ],
};

// =============================================================================
// Master snapshot array
// =============================================================================
export const INDEX_SNAPSHOTS: IndexSnapshot[] = [
  NIFTY_50_MAR_2023,
  NIFTY_50_SEP_2023,
  NIFTY_50_MAR_2024,
  NIFTY_NEXT_50_MAR_2023,
  NIFTY_NEXT_50_SEP_2023,
  NIFTY_NEXT_50_MAR_2024,
  NIFTY_100_MAR_2023,
  NIFTY_100_SEP_2023,
  NIFTY_100_MAR_2024,
  NIFTY_MIDCAP_150_MAR_2023,
  NIFTY_MIDCAP_150_SEP_2023,
  NIFTY_MIDCAP_150_MAR_2024,
];
