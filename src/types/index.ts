export interface Env {
  UPSTOX_ACCESS_TOKEN: string;
  UPSTOX_API_KEY: string;
  UPSTOX_API_SECRET: string;
}

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{
    type: "text";
    text: string;
  } | {
    type: "image";
    data: string;
    mimeType: string;
  } | {
    type: "resource";
    resource: {
      text: string;
      uri: string;
      mimeType?: string;
    } | {
      uri: string;
      blob: string;
      mimeType?: string;
    };
  }>;
  _meta?: {
    [key: string]: unknown;
  };
  isError?: boolean;
}

export interface ToolHandler<T, E = { [key: string]: unknown }> {
  (args: T, extra: E): Promise<ToolResponse>;
}

export interface GetHoldingsArgs {
  // no args needed — token comes from env
}

/** Handler type for tools that need SQL access via the Durable Object agent */
export interface SqlAgent {
  sql: InstanceType<typeof Object>; // Durable Object SQL proxy
}

export interface WatchlistToolHandler<T> {
  (args: T, env: Env, agent: SqlAgent): Promise<ToolResponse>;
}
