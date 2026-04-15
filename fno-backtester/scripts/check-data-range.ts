import * as fs from "fs";
import * as path from "path";

const devVarsPath = path.join(process.cwd(), "..", ".dev.vars");
const content = fs.readFileSync(devVarsPath, "utf-8");
const match = content.match(/UPSTOX_ACCESS_TOKEN=(.+)/);
const token = match![1].trim();

async function tryFetch(from: string, to: string): Promise<number> {
  const key = encodeURIComponent("NSE_INDEX|Nifty 50");
  const url = `https://api.upstox.com/v2/historical-candle/${key}/day/${to}/${from}`;
  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (!res.ok) { console.log(`${from} → ${to}: HTTP ${res.status}`); return 0; }
  const json = (await res.json()) as any;
  const candles = json.data?.candles ?? [];
  const count = candles.length;
  const first = candles[candles.length - 1]?.[0]?.slice(0, 10) ?? "N/A";
  const last = candles[0]?.[0]?.slice(0, 10) ?? "N/A";
  const firstPrice = candles[candles.length - 1]?.[4] ?? 0;
  const lastPrice = candles[0]?.[4] ?? 0;
  console.log(`${from} → ${to}: ${count} candles (${first} to ${last}), Nifty ${firstPrice} → ${lastPrice}`);
  return count;
}

async function main() {
  console.log("Testing Upstox historical data availability for Nifty 50...\n");
  await tryFetch("2013-01-01", "2013-12-31");
  await tryFetch("2015-01-01", "2015-12-31");
  await tryFetch("2018-01-01", "2018-12-31");
  await tryFetch("2020-01-01", "2020-12-31");
  await tryFetch("2022-01-01", "2022-12-31");
  await tryFetch("2023-01-01", "2023-12-31");
  await tryFetch("2024-01-01", "2024-12-31");
  await tryFetch("2025-01-01", "2025-03-28");

  console.log("\nTrying full range...");
  await tryFetch("2000-01-01", "2025-03-28");
}

main().catch(console.error);
