import { type Plugin, tool } from "@opencode-ai/plugin";
import { searchWeb } from "./search.ts";
import { formatHits } from "./format.ts";
import { formatOpenResults, openUrl, OPEN_LIMITS, type OpenResult } from "./tools/open.ts";
import type { EngineId, Logger } from "./types.ts";

const ENGINES: EngineId[] = ["auto", "duckduckgo", "bing", "bing-rss", "ddg-lite", "news", "searxng"];
const TOTAL_OPEN_CHARS = 24_000;

export const WebSearchPlugin: Plugin = async ({ client }) => {
  const log: Logger = (level, message, extra) => {
    void client.app
      .log({ body: { service: "websearch", level, message, extra } })
      .catch(() => undefined);
  };

  const hooks: {
    tool: Record<string, unknown>;
    "experimental.chat.system.transform": (input: unknown, output: { system: string[] }) => Promise<void>;
  } = {
    tool: {
      web_search: tool({
        description:
          "Free web search (no API key). Use it for anything time-sensitive: releases, versions, docs, news, errors. " +
          "Returns titles, URLs and snippets. Follow up with web_open to read the best pages. " +
          "DuckDuckGo is primary; Bing and DDG-lite are automatic fallbacks. Supports site: restriction and recency.",
        args: {
          query: tool.schema.string().describe("Search query. Supports search operators such as \"exact phrase\" or site:github.com"),
          count: tool.schema.number().int().min(1).max(20).optional().describe("How many results to return (default 8)"),
          site: tool.schema.string().optional().describe("Restrict results to one domain, e.g. github.com or opencode.ai"),
          recency: tool.schema.enum(["day", "week", "month", "year"]).optional().describe("Prefer recent results"),
          region: tool.schema.string().optional().describe("Region/locale hint such as ru-ru or us-en"),
          engine: tool.schema.enum(ENGINES).optional().describe("Force one engine (default auto: duckduckgo -> bing -> ddg-lite)"),
        },
        async execute(args, context) {
          const query = args.query?.trim();
          if (!query) return { title: "web_search", output: "query is required" };

          context.metadata({ title: `web_search: ${query.slice(0, 60)}` });

          try {
            const outcome = await searchWeb(
              {
                query,
                count: args.count ?? 8,
                site: args.site,
                recency: args.recency,
                region: args.region,
                engine: args.engine ?? "auto",
              },
              { signal: context.abort, logger: log },
            );

            return {
              title: `${outcome.hits.length} results for ${query.slice(0, 40)}`,
              output: formatHits(outcome.hits, outcome),
              metadata: {
                engine: outcome.engine,
                cached: outcome.cached,
                results: outcome.hits.length,
                notes: outcome.notes,
              },
            };
          } catch (error) {
            log("error", "web_search failed", { error: (error as Error).message });
            return { title: "web_search failed", output: `web_search failed: ${(error as Error).message}` };
          }
        },
      }),

      web_open: tool({
        description:
          "Read web pages as clean text (no API key). Give it 1-4 URLs, usually from web_search results. " +
          "Strips navigation and scripts; falls back to a reader service for JavaScript-heavy pages. " +
          "Prefer this over fetching search snippets repeatedly.",
        args: {
          urls: tool.schema.array(tool.schema.string()).min(1).max(OPEN_LIMITS.MAX_URLS).describe("URLs to read"),
          max_chars: tool.schema.number().int().min(500).max(20_000).optional().describe("Max characters per page (default 6000)"),
        },
        async execute(args, context) {
          const urls = [...new Set(args.urls.map((url) => url.trim()).filter(Boolean))].slice(0, OPEN_LIMITS.MAX_URLS);
          if (urls.length === 0) return { title: "web_open", output: "urls is required" };

          context.metadata({ title: `web_open: ${urls.length} page${urls.length > 1 ? "s" : ""}` });

          const maxChars = args.max_chars ?? 6_000;
          const results: OpenResult[] = [];
          let budget = TOTAL_OPEN_CHARS;

          for (const url of urls) {
            if (budget <= 0) {
              results.push({ url, title: url, text: "", via: "direct", truncated: false, error: "skipped: output budget exhausted" });
              continue;
            }
            const limit = Math.min(maxChars, budget);
            const result = await openUrl(url, limit, context.abort);
            budget -= result.text.length;
            results.push(result);
          }

          const withText = results.filter((result) => result.text).length;
          log("info", "web_open finished", { urls: urls.length, withText });

          return {
            title: `read ${withText}/${results.length} page${results.length > 1 ? "s" : ""}`,
            output: formatOpenResults(results),
            metadata: {
              pages: results.length,
              read: withText,
              chars: results.reduce((sum, result) => sum + result.text.length, 0),
            },
          };
        },
      }),
    },

    "experimental.chat.system.transform": async (_input, output) => {
      if (process.env.WEBSEARCH_NO_HINT && process.env.WEBSEARCH_NO_HINT !== "0") return;
      output.system.push(
        "Web access: prefer `web_search` for discovery and `web_open` to read result pages. " +
          "Use them whenever the answer depends on current versions, releases, prices, or recent events instead of relying on memory.",
      );
    },
  };

  if (process.env.WEBSEARCH_OVERRIDE_BUILTIN && process.env.WEBSEARCH_OVERRIDE_BUILTIN !== "0") {
    hooks.tool.websearch = hooks.tool.web_search;
  }

  return hooks as never;
};
