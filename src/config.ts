// Access token is provided at runtime via the Cloudflare env binding
// `UPSTOX_ACCESS_TOKEN` (set with `wrangler secret put` / `.dev.vars`),
// never hardcoded here. This constant is kept only for legacy imports.
export const UPSTOX_CONFIG = {
  ACCESS_TOKEN: "",
};
