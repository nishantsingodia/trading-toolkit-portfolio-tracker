import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import { runFnoBacktestHandler } from "./run-fno-backtest";

export const compareFnoStrategiesSchema = {
  underlying: z.enum(["NIFTY", "BANKNIFTY"]).describe("Index underlying"),
  from_date: z.string().min(1, "From date (YYYY-MM-DD)"),
  to_date: z.string().min(1, "To date (YYYY-MM-DD)"),
  strategies: z.string().describe("Comma-separated list of F&O strategies (max 5). Available: short_straddle, short_strangle, iron_condor, iron_butterfly, deep_otm_sell, bull_call_spread, bear_put_spread, ema50_directional, long_straddle, calendar_spread, straddle_920, oi_max_pain"),
  initial_capital: z.number().optional().describe("Starting capital (default: 500000)"),
};

interface CompareFnoArgs {
  underlying: string;
  from_date: string;
  to_date: string;
  strategies: string;
  initial_capital?: number;
}

export const compareFnoStrategiesHandler: ToolHandler<CompareFnoArgs, Env> = async (
  args: CompareFnoArgs,
  env: Env
): Promise<ToolResponse> => {
  try {
    const strategyNames = args.strategies.split(",").map(s => s.trim());
    if (strategyNames.length > 5) {
      return { content: [{ type: "text", text: "Maximum 5 strategies for comparison" }], isError: true };
    }

    const results: Array<{
      strategy: string;
      metrics: any;
      score: number;
    }> = [];

    for (const stratName of strategyNames) {
      const result = await runFnoBacktestHandler({
        underlying: args.underlying,
        from_date: args.from_date,
        to_date: args.to_date,
        strategy: stratName,
        initial_capital: args.initial_capital,
      }, env);

      try {
        const data = JSON.parse((result.content[0] as any).text);
        const m = data.metrics;

        // Composite score: 40% return + 20% Sharpe + 20% win rate + 20% inverse drawdown
        const returnScore = m.totalReturnPct ?? 0;
        const sharpeScore = Math.min((m.sharpeRatio ?? 0) * 20, 100);
        const winRateScore = (m.winRate ?? 0) * 100;
        const ddScore = Math.max(0, 100 - (m.maxDrawdownPct ?? 0));
        const score = returnScore * 0.4 + sharpeScore * 0.2 + winRateScore * 0.2 + ddScore * 0.2;

        results.push({ strategy: stratName, metrics: m, score });
      } catch {
        results.push({ strategy: stratName, metrics: {}, score: 0 });
      }
    }

    results.sort((a, b) => b.score - a.score);

    const rankings = results.map((r, i) => ({
      rank: i + 1,
      strategy: r.strategy,
      score: Math.round(r.score * 100) / 100,
      totalReturn: `${(r.metrics.totalReturnPct ?? 0).toFixed(2)}%`,
      winRate: `${((r.metrics.winRate ?? 0) * 100).toFixed(1)}%`,
      sharpe: (r.metrics.sharpeRatio ?? 0).toFixed(2),
      maxDrawdown: `${(r.metrics.maxDrawdownPct ?? 0).toFixed(2)}%`,
      totalTrades: r.metrics.totalTrades ?? 0,
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          underlying: args.underlying,
          from_date: args.from_date,
          to_date: args.to_date,
          rankings,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error comparing F&O strategies:", error);
    return {
      content: [{ type: "text", text: `Compare error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};
