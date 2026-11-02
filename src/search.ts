import { BlockedError, hostOf } from "./net.ts";
import { cacheGet, cacheKey, cacheSet } from "./cache.ts";
import { cooldownRemaining, markBlocked, markHealthy } from "./queue.ts";
import { searchDuckDuckGo } from "./engines/duckduckgo.ts";
import { searchBingHtml, searchBingRss } from "./engines/bing.ts";
import { searchDdgLite } from "./engines/ddg-lite.ts";
import { searchNews } from "./engines/news.ts";
import { searchSearxng, searxngUrl } from "./engines/searxng.ts";
import type { EngineId, Logger, SearchHit, SearchOutcome, SearchParams } from "./types.ts";

const CACHE_TTL_MS = 10 * 60_000;
const MAX_ENGINE_ATTEMPTS = 3;
const TIME_BUDGET_MS = 30_000;
const ORDER_VERSION = 4;
const RECENCY_DAYS: Record<NonNullable<SearchParams["recency"]>, number> = { day: 2, week: 8, month: 32, year: 370 };

type Engine = { label: string; run: (params: SearchParams, signal?: AbortSignal) => Promise<SearchHit[]> };

const ENGINES: Record<Exclude<EngineId, "auto">, Engine> = {
  duckduckgo: { label: "duckduckgo", run: searchDuckDuckGo },
  bing: { label: "bing", run: searchBingHtml },
  "bing-rss": { label: "bing-rss", run: searchBingRss },
  "ddg-lite": { label: "ddg-lite", run: searchDdgLite },
  news: { label: "news", run: searchNews },
  searxng: { label: "searxng", run: searchSearxng },
};

export function engineOrder(explicit?: EngineId): string[] {
  if (explicit && explicit !== "auto") return [explicit];
  const chain = ["duckduckgo", "bing", "ddg-lite", "bing-rss"];
  return searxngUrl() ? ["searxng", ...chain] : chain;
}

export function normalizeSite(site?: string): string | undefined {
  if (!site) return undefined;
  const cleaned = site
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
  return cleaned || undefined;
}

export function buildQuery(params: SearchParams): string {
  const query = params.query.trim().replace(/\s+/g, " ");
  const site = normalizeSite(params.site);
  if (site && !/\bsite:/i.test(query)) return `${query} site:${site}`;
  return query;
}

export function filterHits(hits: SearchHit[], params: SearchParams, limit: number): SearchHit[] {
  const site = normalizeSite(params.site);
  const out: SearchHit[] = [];
  const perHost = new Map<string, number>();
  const days = params.recency ? RECENCY_DAYS[params.recency] : undefined;

  for (const hit of hits) {
    if (!hit.url.startsWith("http")) continue;
    if (/(^|\.)(duckduckgo|bing)\.com$/.test(hit.host)) continue;
    if (site && !(hit.host === site || hit.host.endsWith(`.${site}`))) continue;
    if (days && hit.published && !withinDays(hit.published, days)) continue;

    const seen = perHost.get(hit.host) ?? 0;
    if (seen >= 2) continue;
    perHost.set(hit.host, seen + 1);

    out.push(hit);
    if (out.length >= limit) break;
  }

  return out;
}

function withinDays(published: string, days: number): boolean {
  const date = Date.parse(published);
  if (Number.isNaN(date)) return true;
  return Date.now() - date <= days * 86_400_000;
}

export type SearchOptions = {
  signal?: AbortSignal;
  logger?: Logger;
  bypassCache?: boolean;
};

export async function searchWeb(input: SearchParams, options: SearchOptions = {}): Promise<SearchOutcome> {
  const { signal, logger } = options;
  const params: SearchParams = {
    ...input,
    query: buildQuery(input),
    count: Math.min(20, Math.max(1, Math.round(input.count || 8))),
    engine: input.engine ?? "auto",
  };
  if (!params.query) throw new Error("query is empty");

  const order = engineOrder(params.engine);
  const key = cacheKey({ v: ORDER_VERSION, q: params.query, count: params.count, recency: params.recency, region: params.region, order });

  if (!options.bypassCache) {
    const cached = cacheGet<SearchHit[]>(key);
    if (cached) {
      return { hits: filterHits(cached, params, params.count), engine: "cache", cached: true, notes: [] };
    }
  }

  const collected: SearchHit[] = [];
  const notes: string[] = [];
  const deadline = Date.now() + TIME_BUDGET_MS;
  let usedEngine = "";
  let attempts = 0;

  for (const id of order) {
    if (attempts >= MAX_ENGINE_ATTEMPTS) break;
    if (Date.now() > deadline) {
      notes.push("time budget exceeded");
      break;
    }

    const engine = ENGINES[id as Exclude<EngineId, "auto">];
    if (!engine) continue;

    const cooldown = cooldownRemaining(id);
    if (cooldown > 0) {
      notes.push(`${id}: cooling down ${Math.ceil(cooldown / 1000)}s`);
      continue;
    }

    attempts++;
    const started = Date.now();
    try {
      const hits = await engine.run(params, signal);
      markHealthy(id);
      const usable = filterHits(hits, params, params.count);
      logger?.("debug", "engine finished", { engine: id, hits: usable.length, ms: Date.now() - started });

      if (usable.length > 0) {
        usedEngine = usedEngine || engine.label;
        collected.push(...usable);
      }
      if (collected.length >= Math.min(params.count, 5)) break;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof BlockedError) {
        const backoff = markBlocked(id, 60_000);
        notes.push(`${id}: blocked, retry in ${Math.ceil(backoff / 60_000)}m`);
        logger?.("warn", "engine blocked", { engine: id, reason: error.reason });
      } else {
        notes.push(`${id}: ${(error as Error).message.slice(0, 120)}`);
        logger?.("warn", "engine failed", { engine: id, error: (error as Error).message });
      }
    }
  }

  const hits = filterHits(collected, params, params.count);
  if (hits.length > 0) cacheSet(key, hits, CACHE_TTL_MS);

  return { hits, engine: usedEngine || "none", cached: false, notes };
}

export function describeEngine(id: string): string {
  return ENGINES[id as Exclude<EngineId, "auto">]?.label ?? id;
}

export function hitsByHost(hits: SearchHit[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const hit of hits) map.set(hostOf(hit.url), (map.get(hostOf(hit.url)) ?? 0) + 1);
  return map;
}
