export type EngineId =
  | "auto"
  | "duckduckgo"
  | "bing"
  | "bing-rss"
  | "ddg-lite"
  | "news"
  | "searxng";

export type Recency = "day" | "week" | "month" | "year";

export type SearchParams = {
  query: string;
  count: number;
  site?: string;
  recency?: Recency;
  region?: string;
  engine?: EngineId;
};

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  host: string;
  published?: string;
  engine: string;
};

export type SearchOutcome = {
  hits: SearchHit[];
  engine: string;
  cached: boolean;
  notes: string[];
};

export type Logger = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;
