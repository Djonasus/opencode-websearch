import { BlockedError, decodeDuckDuckGoUrl, fetchText, hostOf, HttpError, sleep } from "../net.ts";
import { gateFor } from "../queue.ts";
import { decodeEntities, stripTags } from "../extract.ts";
import type { Recency, SearchHit, SearchParams } from "../types.ts";

const DF: Record<Recency, string> = { day: "d", week: "w", month: "m", year: "y" };

const BLOCK_MARKERS = [
  /anomaly-modal/i,
  /challenge-form/i,
  /detected unusual traffic/i,
  /bots use DuckDuckGo/i,
  /duckduckgo\.com\/anomaly/i,
  /g-recaptcha/i,
];

export function isDdgBlockPage(html: string): boolean {
  if (BLOCK_MARKERS.some((marker) => marker.test(html))) return true;
  // A real SERP always carries result anchors; an empty body plus "no results" is a genuine miss.
  return !/result__a|result-link/.test(html) && !/No results/i.test(html);
}

export function parseDdgHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/(?=<div class="result )/).slice(1);

  for (const block of blocks) {
    if (block.includes("result--ad") || block.includes("y.js?ad_domain")) continue;

    const anchor = block.match(/<a[^>]*\bclass="result__a"[^>]*>([\s\S]*?)<\/a>/);
    if (!anchor) continue;
    const href = anchor[0].match(/\bhref="([^"]+)"/)?.[1];
    if (!href) continue;

    const url = decodeDuckDuckGoUrl(href);
    if (!/^https?:\/\//.test(url)) continue;

    const snippetHtml = block.match(/<a[^>]*\bclass="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
    const title = stripTags(anchor[1]);

    hits.push({
      title: title || hostOf(url),
      url,
      snippet: normalizeSnippet(snippetHtml),
      host: hostOf(url),
      engine: "duckduckgo",
    });
  }

  return dedupe(hits);
}

export async function searchDuckDuckGo(params: SearchParams, signal?: AbortSignal): Promise<SearchHit[]> {
  const search = new URLSearchParams({ q: params.query });
  if (params.region) search.set("kl", params.region);
  if (params.recency) search.set("df", DF[params.recency]);

  const gate = gateFor("duckduckgo", 3_500);
  const serp = (host: string) =>
    gate.run(
      () =>
        fetchText(`https://${host}/html/?${search.toString()}`, {
          signal,
          retries: 0,
          timeoutMs: 9_000,
          acceptLanguage: acceptLanguage(params.region),
        }),
      signal,
    );

  let response;
  try {
    response = await serp("html.duckduckgo.com");
  } catch (error) {
    if (signal?.aborted) throw error;
    response = await serp("duckduckgo.com");
  }

  // A 202 or a dead frontend is often host-scoped: retry once through the other host.
  if (response.status === 202) {
    await sleep(2_000, signal);
    response = await serp("duckduckgo.com");
  }

  if (response.status === 202) throw new BlockedError("duckduckgo", "202 anti-bot page");
  if (response.status >= 400) throw new HttpError(response.status, "duckduckgo");
  if (isDdgBlockPage(response.text)) throw new BlockedError("duckduckgo", "challenge page");

  return parseDdgHtml(response.text);
}

export function normalizeSnippet(html: string): string {
  // Some feeds (Google News) double-encode their HTML, so decode, strip, then decode again.
  return decodeEntities(stripTags(decodeEntities(html))).replace(/\s+/g, " ").trim();
}

export function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const key = hit.url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

export function acceptLanguage(region?: string): string | undefined {
  if (!region || !/^[a-z]{2}-[a-z]{2}$/.test(region)) return undefined;
  const lang = region.slice(0, 2);
  return `${lang}-${lang.toUpperCase()},${lang};q=0.9,en;q=0.6`;
}
