import type { Underlying } from "./types.js";
import { LOT_SIZES, STRIKE_INTERVALS } from "./types.js";

/**
 * NSE holidays — hardcoded for 2023-2026.
 * Format: "YYYY-MM-DD"
 */
const NSE_HOLIDAYS: Set<string> = new Set([
  // 2023
  "2023-01-26", "2023-03-07", "2023-03-30", "2023-04-04", "2023-04-07",
  "2023-04-14", "2023-04-22", "2023-05-01", "2023-06-28", "2023-06-29",
  "2023-08-15", "2023-09-19", "2023-10-02", "2023-10-24", "2023-11-14",
  "2023-11-27", "2023-12-25",
  // 2024
  "2024-01-26", "2024-03-08", "2024-03-25", "2024-03-29", "2024-04-11",
  "2024-04-14", "2024-04-17", "2024-04-21", "2024-05-01", "2024-05-23",
  "2024-06-17", "2024-07-17", "2024-08-15", "2024-09-16", "2024-10-02",
  "2024-10-12", "2024-11-01", "2024-11-15", "2024-11-20", "2024-12-25",
  // 2025
  "2025-02-26", "2025-03-14", "2025-03-31", "2025-04-10", "2025-04-14",
  "2025-04-18", "2025-05-01", "2025-05-12", "2025-06-26", "2025-08-15",
  "2025-08-16", "2025-08-27", "2025-10-02", "2025-10-21", "2025-10-22",
  "2025-11-05", "2025-11-26", "2025-12-25",
  // 2026
  "2026-01-26", "2026-02-17", "2026-03-10", "2026-03-20", "2026-04-03",
  "2026-04-14", "2026-05-01", "2026-05-25", "2026-07-10", "2026-08-15",
  "2026-08-17", "2026-10-02", "2026-10-20", "2026-10-21", "2026-11-09",
  "2026-11-16", "2026-12-25",
]);

/** Check if a given date string is a weekend (Sat/Sun). */
function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + "T12:00:00Z"); // noon UTC to avoid timezone issues
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** Check if a given date is an NSE trading day. */
export function isTradingDay(dateStr: string): boolean {
  return !isWeekend(dateStr) && !NSE_HOLIDAYS.has(dateStr);
}

/** Get the previous trading day (skipping holidays & weekends). */
export function previousTradingDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (!isTradingDay(formatDate(d)));
  return formatDate(d);
}

/** Format Date to "YYYY-MM-DD". */
function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Get the Thursday of the given week containing `date`. */
function getThursdayOfWeek(d: Date): Date {
  const result = new Date(d.getTime());
  const day = result.getUTCDay();
  // Thursday = 4
  const diff = 4 - day;
  result.setUTCDate(result.getUTCDate() + diff);
  return result;
}

/** Get all Thursdays in a given month/year. */
function getThursdaysInMonth(year: number, month: number): Date[] {
  const thursdays: Date[] = [];
  const d = new Date(Date.UTC(year, month, 1));
  while (d.getUTCMonth() === month) {
    if (d.getUTCDay() === 4) {
      thursdays.push(new Date(d.getTime()));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return thursdays;
}

/**
 * Resolve an expiry Thursday to an actual trading day.
 * If the Thursday is a holiday, shift to previous trading day.
 */
function resolveExpiryDay(thursdayStr: string): string {
  if (isTradingDay(thursdayStr)) return thursdayStr;
  return previousTradingDay(thursdayStr);
}

/** Get the day-of-week (0=Sun..6=Sat) for a specific weekday in a given Date's week. */
function getDayOfWeekInWeek(d: Date, targetDay: number): Date {
  const result = new Date(d.getTime());
  const diff = targetDay - result.getUTCDay();
  result.setUTCDate(result.getUTCDate() + diff);
  return result;
}

/**
 * Get all weekly expiry dates for an underlying between two dates.
 *
 * NIFTY:      Thursday (pre-Nov 2024) → Tuesday (post-Nov 2024, SEBI change)
 * BANKNIFTY:  Wednesday (pre-Nov 2024) → NO weekly post-Nov 2024 (SEBI removed)
 *             For BANKNIFTY post-Nov 2024, falls back to monthly expiry (last Thursday).
 */
export function getWeeklyExpiries(
  underlying: Underlying,
  fromDate: string,
  toDate: string
): string[] {
  const expiries: string[] = [];
  const start = new Date(fromDate + "T00:00:00");
  const end = new Date(toDate + "T00:00:00");
  // Nov 20, 2024 — SEBI changed weekly expiry rules
  const sebiCutoff = new Date("2024-11-20T00:00:00");

  if (underlying === "BANKNIFTY") {
    // Pre-SEBI: Wednesday weekly
    let current = getDayOfWeekInWeek(start, 3); // Wednesday = 3
    if (current < start) current.setUTCDate(current.getUTCDate() + 7);

    while (current <= end && current < sebiCutoff) {
      const resolved = resolveExpiryDay(formatDate(current));
      if (resolved >= fromDate && resolved <= toDate) {
        expiries.push(resolved);
      }
      current.setUTCDate(current.getUTCDate() + 7);
    }

    // Post-SEBI: BANKNIFTY only has monthly expiry (last Thursday)
    if (end >= sebiCutoff) {
      const monthlyFrom = sebiCutoff > start ? formatDate(sebiCutoff) : fromDate;
      const monthlyExpiries = getMonthlyExpiries(underlying, monthlyFrom, toDate);
      expiries.push(...monthlyExpiries);
    }
  } else {
    // NIFTY: Thursday pre-cutoff, Tuesday post-cutoff
    // Pre-SEBI: Thursday
    let current = getThursdayOfWeek(start);
    if (current < start) current.setUTCDate(current.getUTCDate() + 7);

    while (current <= end && current < sebiCutoff) {
      const resolved = resolveExpiryDay(formatDate(current));
      if (resolved >= fromDate && resolved <= toDate) {
        expiries.push(resolved);
      }
      current.setUTCDate(current.getUTCDate() + 7);
    }

    // Post-SEBI: Tuesday
    if (end >= sebiCutoff) {
      let tue = getDayOfWeekInWeek(sebiCutoff, 2); // Tuesday = 2
      if (tue < sebiCutoff) tue.setUTCDate(tue.getUTCDate() + 7);

      while (tue <= end) {
        const resolved = resolveExpiryDay(formatDate(tue));
        if (resolved >= fromDate && resolved <= toDate) {
          expiries.push(resolved);
        }
        tue.setUTCDate(tue.getUTCDate() + 7);
      }
    }
  }

  // Deduplicate and sort
  return [...new Set(expiries)].sort();
}

/**
 * Get all monthly expiry dates (last Thursday of each month).
 */
export function getMonthlyExpiries(
  _underlying: Underlying,
  fromDate: string,
  toDate: string
): string[] {
  const expiries: string[] = [];
  const start = new Date(fromDate + "T00:00:00");
  const end = new Date(toDate + "T00:00:00");

  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();

  while (true) {
    const thursdays = getThursdaysInMonth(year, month);
    if (thursdays.length > 0) {
      const lastThursday = thursdays[thursdays.length - 1];
      const resolved = resolveExpiryDay(formatDate(lastThursday));
      if (resolved > toDate) break;
      if (resolved >= fromDate) {
        expiries.push(resolved);
      }
    }

    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
    if (year > end.getUTCFullYear() + 1) break;
  }

  return expiries;
}

/**
 * Get the next expiry date from a given date.
 */
export function getNextExpiry(
  underlying: Underlying,
  date: string,
  expiryType: "weekly" | "monthly" = "weekly"
): string {
  // Search within a reasonable window (2 months)
  const from = date;
  const end = new Date(date + "T00:00:00");
  end.setUTCDate(end.getUTCDate() + 60);
  const toDate = formatDate(end);

  const expiries =
    expiryType === "weekly"
      ? getWeeklyExpiries(underlying, from, toDate)
      : getMonthlyExpiries(underlying, from, toDate);

  // Return first expiry on or after the given date
  for (const exp of expiries) {
    if (exp >= date) return exp;
  }

  // Fallback: shouldn't happen with 60-day window
  return expiries[expiries.length - 1] ?? date;
}

/**
 * Calculate Days To Expiry.
 */
export function getDTE(date: string, expiryDate: string): number {
  const d = new Date(date + "T00:00:00");
  const exp = new Date(expiryDate + "T00:00:00");
  const diffMs = exp.getTime() - d.getTime();
  return Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
}

/**
 * Check if a date is an expiry day for the given underlying.
 */
export function isExpiryDay(
  date: string,
  underlying: Underlying
): boolean {
  // Check if this date appears as a weekly expiry
  const expiries = getWeeklyExpiries(underlying, date, date);
  return expiries.includes(date);
}

/**
 * Get lot size for an underlying.
 */
export function getLotSize(underlying: Underlying): number {
  return LOT_SIZES[underlying];
}

/**
 * Get strike interval for an underlying.
 */
export function getStrikeInterval(underlying: Underlying): number {
  return STRIKE_INTERVALS[underlying];
}

/**
 * Convert time-to-expiry from DTE to years (for Black-Scholes).
 */
export function dteToYears(dte: number): number {
  return dte / 365;
}
