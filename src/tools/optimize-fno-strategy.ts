import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import { runFnoBacktestHandler } from "./run-fno-backtest";

export const optimizeFnoStrategySchema = {
  underlying: z.enum(["NIFTY", "BANKNIFTY"]).describe("Index underlying"),
  from_date: z.string().min(1, "From date (YYYY-MM-DD)"),
  to_date: z.string().min(1, "To date (YYYY-MM-DD)"),
  strategy: z.enum([
    "short_straddle", "short_strangle", "iron_condor", "iron_butterfly",
    "deep_otm_sell", "bull_call_spread", "bear_put_spread", "ema50_directional",
    "long_straddle", "calendar_spread", "straddle_920", "oi_max_pain",
  ]).describe("F&O strategy to optimize"),
  param_ranges: z.string().describe('JSON object of param ranges, e.g. {"targetPct":[30,50,70],"stopLossPct":[30,50]}'),
  optimize_for: z.string().optional().describe("Metric to optimize for (default: totalReturnPct)"),
  initial_capital: z.number().optional().describe("Starting capital (default: 500000)"),
};

interface OptimizeFnoArgs {
  underlying: string;
  from_date: string;
  to_date: string;
  strategy: string;
  param_ranges: string;
  optimize_for?: string;
  initial_capital?: number;
}

export const optimizeFnoStrategyHandler: ToolHandler<OptimizeFnoArgs, Env> = async (
  args: OptimizeFnoArgs,
  env: Env
): Promise<ToolResponse> => {
  try {
    const paramRanges = JSON.parse(args.param_ranges) as Record<string, (number | string)[]>;
    const optimizeFor = args.optimize_for ?? "totalReturnPct";

    // Generate Cartesian product
    const paramNames = Object.keys(paramRanges);
    const paramValues = paramNames.map(k => paramRanges[k]);
    const totalCount = paramValues.reduce((prod, arr) => prod * arr.length, 1);

    if (totalCount > 100) {
      return { content: [{ type: "text", text: `Too many combinations: ${totalCount} (max 100 for F&O). Reduce param ranges.` }], isError: true };
    }

    const combinations = cartesianProduct(paramValues);
    const results: Array<{ params: Record<string, any>; metric: number; metrics: any }> = [];

    for (const combo of combinations) {
      const params: Record<string, any> = {};
      for (let i = 0; i < paramNames.length; i++) params[paramNames[i]] = combo[i];

      const result = await runFnoBacktestHandler({
        underlying: args.underlying,
        from_date: args.from_date,
        to_date: args.to_date,
        strategy: args.strategy,
        strategy_params: JSON.stringify(params),
        initial_capital: args.initial_capital,
      }, env);

      try {
        const data = JSON.parse((result.content[0] as any).text);
        const metricValue = Number(data.metrics[optimizeFor]) || 0;
        results.push({ params, metric: metricValue, metrics: data.metrics });
      } catch {
        results.push({ params, metric: 0, metrics: {} });
      }
    }

    results.sort((a, b) => b.metric - a.metric);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          strategy: args.strategy,
          optimize_for: optimizeFor,
          total_combinations: combinations.length,
          best_params: results[0]?.params ?? {},
          best_metric: results[0]?.metric ?? 0,
          top_results: results.slice(0, 5).map(r => ({
            params: r.params,
            [optimizeFor]: r.metric,
            winRate: `${((r.metrics.winRate ?? 0) * 100).toFixed(1)}%`,
            totalTrades: r.metrics.totalTrades ?? 0,
          })),
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error optimizing F&O strategy:", error);
    return {
      content: [{ type: "text", text: `Optimize error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};

function cartesianProduct(arrays: (number | string)[][]): (number | string)[][] {
  if (arrays.length === 0) return [[]];
  const [first, ...rest] = arrays;
  const restProduct = cartesianProduct(rest);
  return first.flatMap(val => restProduct.map(combo => [val, ...combo]));
}
