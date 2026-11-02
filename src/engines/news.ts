import { fetchText, hostOf, HttpError } from "../net.ts";
import { gateFor } from "../queue.ts";
import { stripTags } from "../extract.ts";
import { dedupe, normalizeSnippet } from "./duckduckgo.ts";
import { toIsoDate } from "./bing.ts";
import type { SearchHit, SearchParams } from "../types.ts";

/**
 * Google News RSS: free, no key, stable XML. Limited to news, so it is used on demand
 * (engine "news") rather than in the automatic chain.
 */
export function parseNewsRss(xml: string): SearchHit[] {
  const hits: SearchHit[] = [];

  for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = item[1];
    const link = body.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
    if (!link || !/^https?:\/\//.test(link)) continue;

    const rawTitle = stripTags((body.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, ""));
    if (!rawTitle) continue;

    // Google appends " - Publisher" to every headline.
    const title = rawTitle.replace(/\s+-\s+[^-]{2,40}$/, "").trim() || rawTitle;
    const published = body.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();
    const source = stripTags(body.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "");
    const sourceUrl = body.match(/<source[^>]*url="([^"]+)"/)?.[1];
    let snippet = normalizeSnippet(body.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "").slice(0, 240);
    // Google repeats the headline inside <description>; drop that echo.
    if (snippet.startsWith(title)) snippet = snippet.slice(title.length).replace(/^[\s·|—-]+/, "");

    hits.push({
      title,
      url: link,
      snippet,
      host: (sourceUrl ? hostOf(sourceUrl) : "") || hostOf(link) || source.toLowerCase(),
      ...(published ? { published: toIsoDate(published) } : {}),
      engine: "news",
    });
  }

  return dedupe(hits);
}

export async function searchNews(params: SearchParams, signal?: AbortSignal): Promise<SearchHit[]> {
  const lang = params.region?.slice(0, 2) ?? "en";
  const country = params.region?.slice(3, 5)?.toUpperCase() ?? "US";
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(params.query)}` +
    `&hl=${lang}-${country}&gl=${country}&ceid=${country}:${lang}`;

  const response = await gateFor("news", 800).run(
    () => fetchText(url, { signal, retries: 1, timeoutMs: 12_000 }),
    signal,
  );

  if (response.status >= 400) throw new HttpError(response.status, url);
  return parseNewsRss(response.text);
}
