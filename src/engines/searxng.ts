import { fetchText, hostOf, HttpError } from "../net.ts";
import { gateFor } from "../queue.ts";
import { dedupe } from "./duckduckgo.ts";
import type { SearchHit, SearchParams } from "../types.ts";

type SearxResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    publishedDate?: string;
    engine?: string;
  }>;
};

export function searxngUrl(): string | undefined {
  const base = process.env.SEARXNG_URL?.trim();
  return base ? base.replace(/\/+$/, "") : undefined;
}

export function parseSearxng(payload: SearxResponse): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const item of payload.results ?? []) {
    if (!item.url || !/^https?:\/\//.test(item.url)) continue;
    hits.push({
      title: (item.title ?? "").trim() || hostOf(item.url),
      url: item.url,
      snippet: (item.content ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
      host: hostOf(item.url),
      ...(item.publishedDate ? { published: item.publishedDate.slice(0, 10) } : {}),
      engine: "searxng",
    });
  }
  return dedupe(hits);
}

export async function searchSearxng(params: SearchParams, signal?: AbortSignal): Promise<SearchHit[]> {
  const base = searxngUrl();
  if (!base) throw new Error("SEARXNG_URL is not set");

  const search = new URLSearchParams({ q: params.query, format: "json" });
  if (params.region) search.set("language", `${params.region.slice(0, 2)}-${params.region.slice(3).toUpperCase()}`);
  if (params.recency) {
    search.set("time_range", params.recency === "day" ? "day" : params.recency);
  }

  const url = `${base}/search?${search.toString()}`;
  const response = await gateFor("searxng", 300).run(
    () => fetchText(url, { signal, retries: 0, timeoutMs: 15_000, headers: { accept: "application/json" } }),
    signal,
  );

  if (response.status >= 400) throw new HttpError(response.status, url);
  try {
    return parseSearxng(JSON.parse(response.text) as SearxResponse);
  } catch {
    throw new Error("SearXNG did not return JSON (enable search.formats: [html, json] in settings.yml)");
  }
}
