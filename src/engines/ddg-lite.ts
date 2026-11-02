import { BlockedError, fetchText, hostOf, HttpError } from "../net.ts";
import { gateFor } from "../queue.ts";
import { dedupe, normalizeSnippet } from "./duckduckgo.ts";
import type { SearchHit, SearchParams } from "../types.ts";

const BLOCK_MARKERS = [/anomaly-modal/i, /challenge-form/i, /bots use DuckDuckGo/i, /duckduckgo\.com\/anomaly/i];

export function parseDdgLite(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkRe = /<a\b[^>]*\bclass=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
  const matches = [...html.matchAll(linkRe)];

  for (const [index, match] of matches.entries()) {
    const href = match[0].match(/\bhref=['"]([^'"]+)['"]/)?.[1];
    if (!href) continue;
    const url = href.startsWith("//") ? `https:${href}` : href;
    const resolved = (() => {
      try {
        const parsed = new URL(url);
        const target = parsed.searchParams.get("uddg");
        return target ?? parsed.toString();
      } catch {
        return url;
      }
    })();
    if (!/^https?:\/\//.test(resolved)) continue;

    const nextStart = match.index + match[0].length;
    const nextMatch = matches[index + 1];
    const nextEnd = nextMatch ? nextMatch.index : html.length;
    const window = html.slice(nextStart, Math.min(nextStart + 2_000, nextEnd));
    const snippetHtml = window.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/)?.[1] ?? "";

    hits.push({
      title: match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || hostOf(resolved),
      url: resolved,
      snippet: normalizeSnippet(snippetHtml),
      host: hostOf(resolved),
      engine: "ddg-lite",
    });
  }

  return dedupe(hits);
}

export async function searchDdgLite(params: SearchParams, signal?: AbortSignal): Promise<SearchHit[]> {
  const search = new URLSearchParams({ q: params.query });
  if (params.region) search.set("kl", params.region);

  const url = `https://lite.duckduckgo.com/lite/?${search.toString()}`;
  const response = await gateFor("duckduckgo", 3_500).run(
    () => fetchText(url, { signal, retries: 0, timeoutMs: 12_000 }),
    signal,
  );

  if (response.status === 202) throw new BlockedError("ddg-lite", "202 anti-bot page");
  if (response.status >= 400) throw new HttpError(response.status, url);
  if (BLOCK_MARKERS.some((marker) => marker.test(response.text))) {
    throw new BlockedError("ddg-lite", "challenge page");
  }
  if (!/result-link/.test(response.text) && !/No results/i.test(response.text)) {
    throw new BlockedError("ddg-lite", "unexpected layout");
  }

  return parseDdgLite(response.text);
}
