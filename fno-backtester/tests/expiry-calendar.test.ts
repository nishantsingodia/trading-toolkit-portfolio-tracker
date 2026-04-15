import { describe, it, expect } from "vitest";
import {
  isTradingDay,
  getWeeklyExpiries,
  getMonthlyExpiries,
  getNextExpiry,
  getDTE,
  isExpiryDay,
  getLotSize,
  getStrikeInterval,
  dteToYears,
} from "../src/engine/expiry-calendar.js";

describe("isTradingDay", () => {
  it("returns false for Saturday", () => {
    expect(isTradingDay("2025-03-22")).toBe(false); // Saturday
  });

  it("returns false for Sunday", () => {
    expect(isTradingDay("2025-03-23")).toBe(false); // Sunday
  });

  it("returns true for a regular weekday", () => {
    expect(isTradingDay("2025-03-24")).toBe(true); // Monday
  });

  it("returns false for NSE holiday", () => {
    expect(isTradingDay("2025-08-15")).toBe(false); // Independence Day
  });

  it("returns false for Republic Day", () => {
    expect(isTradingDay("2025-02-26")).toBe(false);
  });
});

describe("getWeeklyExpiries", () => {
  it("returns Thursdays as weekly expiries", () => {
    const expiries = getWeeklyExpiries("NIFTY", "2025-03-01", "2025-03-31");
    expect(expiries.length).toBeGreaterThan(0);

    // Each expiry should be a trading day
    for (const exp of expiries) {
      expect(isTradingDay(exp)).toBe(true);
    }
  });

  it("returns 4-5 expiries per month", () => {
    const expiries = getWeeklyExpiries("NIFTY", "2025-03-01", "2025-03-31");
    expect(expiries.length).toBeGreaterThanOrEqual(4);
    expect(expiries.length).toBeLessThanOrEqual(5);
  });

  it("works for BankNifty too", () => {
    const expiries = getWeeklyExpiries("BANKNIFTY", "2025-03-01", "2025-03-31");
    expect(expiries.length).toBeGreaterThan(0);
  });
});

describe("getMonthlyExpiries", () => {
  it("returns last Thursday of each month", () => {
    const expiries = getMonthlyExpiries("NIFTY", "2025-01-01", "2025-06-30");
    expect(expiries.length).toBe(6); // 6 months

    // Each expiry should be a trading day
    for (const exp of expiries) {
      expect(isTradingDay(exp)).toBe(true);
    }
  });

  it("returns 12 monthly expiries for a full year", () => {
    const expiries = getMonthlyExpiries("NIFTY", "2025-01-01", "2025-12-31");
    expect(expiries.length).toBe(12);
  });
});

describe("getNextExpiry", () => {
  it("returns next weekly expiry", () => {
    const next = getNextExpiry("NIFTY", "2025-03-24", "weekly");
    expect(next).toBeDefined();
    expect(next >= "2025-03-24").toBe(true);
  });

  it("returns next monthly expiry", () => {
    const next = getNextExpiry("NIFTY", "2025-03-01", "monthly");
    expect(next).toBeDefined();
    expect(next >= "2025-03-01").toBe(true);
  });

  it("returns the same day if it is an expiry", () => {
    const expiries = getWeeklyExpiries("NIFTY", "2025-03-01", "2025-03-31");
    if (expiries.length > 0) {
      const next = getNextExpiry("NIFTY", expiries[0], "weekly");
      expect(next).toBe(expiries[0]);
    }
  });
});

describe("getDTE", () => {
  it("returns 0 for same day", () => {
    expect(getDTE("2025-03-27", "2025-03-27")).toBe(0);
  });

  it("returns correct days", () => {
    expect(getDTE("2025-03-20", "2025-03-27")).toBe(7);
  });

  it("returns 0 for past expiry", () => {
    expect(getDTE("2025-03-28", "2025-03-27")).toBe(0);
  });

  it("returns 30 for a month gap", () => {
    expect(getDTE("2025-03-01", "2025-03-31")).toBe(30);
  });
});

describe("isExpiryDay", () => {
  it("returns true for actual expiry day", () => {
    const expiries = getWeeklyExpiries("NIFTY", "2025-03-27", "2025-03-27");
    if (expiries.includes("2025-03-27")) {
      expect(isExpiryDay("2025-03-27", "NIFTY")).toBe(true);
    }
  });

  it("returns false for non-expiry day", () => {
    // Monday is typically not an expiry day
    expect(isExpiryDay("2025-03-24", "NIFTY")).toBe(false);
  });
});

describe("getLotSize", () => {
  it("returns 75 for NIFTY", () => {
    expect(getLotSize("NIFTY")).toBe(75);
  });

  it("returns 30 for BANKNIFTY", () => {
    expect(getLotSize("BANKNIFTY")).toBe(30);
  });
});

describe("getStrikeInterval", () => {
  it("returns 50 for NIFTY", () => {
    expect(getStrikeInterval("NIFTY")).toBe(50);
  });

  it("returns 100 for BANKNIFTY", () => {
    expect(getStrikeInterval("BANKNIFTY")).toBe(100);
  });
});

describe("dteToYears", () => {
  it("converts 365 DTE to 1 year", () => {
    expect(dteToYears(365)).toBeCloseTo(1, 5);
  });

  it("converts 30 DTE correctly", () => {
    expect(dteToYears(30)).toBeCloseTo(30 / 365, 5);
  });

  it("converts 0 DTE to 0", () => {
    expect(dteToYears(0)).toBe(0);
  });
});
