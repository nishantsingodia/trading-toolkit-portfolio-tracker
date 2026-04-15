import { z } from "zod";
import { ToolHandler, ToolResponse, Env } from "../types";
import { UPSTOX_API_BASE_URL, HEADERS } from "../constants";
import { FNO_STRATEGY_REGISTRY } from "../../fno-backtester/src/engine/strategies";
import type { Underlying, MarketRegime } from "../../fno-backtester/src/engine/types";

export const suggestFnoStrategiesSchema = {
  underlying: z.enum(["NIFTY", "BANKNIFTY"]).describe("Index underlying"),
  vix_level: z.number().optional().describe("Current India VIX level (optional, auto-detected if omitted)"),
  market_view: z.enum(["bullish", "bearish", "neutral", "volatile"]).optional().describe("Your market view"),
  dte: z.number().optional().describe("Days to expiry you're targeting"),
  intraday: z.boolean().optional().describe("Looking for intraday strategies only? (default: false)"),
};

interface SuggestFnoArgs {
  underlying: string;
  vix_level?: number;
  market_view?: string;
  dte?: number;
  intraday?: boolean;
}

export const suggestFnoStrategiesHandler: ToolHandler<SuggestFnoArgs, Env> = async (
  args: SuggestFnoArgs,
  env: Env
): Promise<ToolResponse> => {
  try {
    const underlying = args.underlying as Underlying;
    const vix = args.vix_level ?? 15; // default to normal
    const intraday = args.intraday ?? false;
    const dte = args.dte ?? 7;

    // Map market view to regime
    let regime: MarketRegime = "range_bound";
    if (args.market_view === "bullish") regime = "trending_up";
    else if (args.market_view === "bearish") regime = "trending_down";
    else if (args.market_view === "volatile") regime = "high_volatility";

    // Filter compatible strategies
    const suggestions: Array<{
      strategy: string;
      description: string;
      executionMode: string;
      confidence: string;
      vixFit: boolean;
      regimeFit: boolean;
      reason: string;
    }> = [];

    for (const [name, def] of Object.entries(FNO_STRATEGY_REGISTRY)) {
      // Filter by execution mode
      if (intraday && def.executionMode !== "intraday") continue;
      if (!intraday && def.executionMode === "intraday") continue;

      const vixFit = vix >= def.vixRange.min && vix <= def.vixRange.max;
      const regimeFit = def.regimes.includes(regime);

      let reason = "";
      let confidence = "low";

      if (vixFit && regimeFit) {
        confidence = "high";
        reason = `VIX ${vix} within range [${def.vixRange.min}-${def.vixRange.max}], regime ${regime} matches`;
      } else if (vixFit) {
        confidence = "medium";
        reason = `VIX fits, but strategy prefers ${def.regimes.join("/")} — current: ${regime}`;
      } else if (regimeFit) {
        confidence = "medium";
        reason = `Regime fits, but VIX ${vix} outside ideal range [${def.vixRange.min}-${def.vixRange.max}]`;
      } else {
        reason = `VIX ${vix} and regime ${regime} don't match strategy's sweet spot`;
      }

      suggestions.push({
        strategy: name,
        description: def.description,
        executionMode: def.executionMode,
        confidence,
        vixFit,
        regimeFit,
        reason,
      });
    }

    // Sort: high confidence first, then medium, then low
    const order = { high: 0, medium: 1, low: 2 };
    suggestions.sort((a, b) => (order[a.confidence as keyof typeof order] ?? 2) - (order[b.confidence as keyof typeof order] ?? 2));

    // VIX-based recommendation text
    let vixAdvice = "";
    if (vix < 12) vixAdvice = "Low VIX — premium selling strategies (straddle, strangle, iron condor) have edge. Premiums are small but decay is reliable.";
    else if (vix < 18) vixAdvice = "Normal VIX — all strategies viable. Spreads and premium selling work well.";
    else if (vix < 25) vixAdvice = "Elevated VIX — good premiums for sellers but higher risk. Consider defined-risk strategies (iron condor, spreads). Buying strategies also viable.";
    else vixAdvice = "High VIX (fear) — AVOID naked selling. Use defined-risk strategies only. Long straddle/strangle can work if you expect further volatility.";

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          market_context: {
            underlying,
            vix_level: vix,
            regime,
            dte,
            intraday,
            vix_advice: vixAdvice,
          },
          recommended: suggestions.filter(s => s.confidence === "high").map(s => s.strategy),
          all_suggestions: suggestions,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error suggesting F&O strategies:", error);
    return {
      content: [{ type: "text", text: `Suggest error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};
