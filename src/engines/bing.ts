import { BlockedError, decodeBingRedirect, fetchText, hostOf, HttpError } from "../net.ts";
import { gateFor } from "../queue.ts";
import { stripTags } from "../extract.ts";
import { dedupe, normalizeSnippet } from "./duckduckgo.ts";
import type { Recency, SearchHit, SearchParams } from "../types.ts";

/**
 * Bing serves a degraded/empty page to cold clients: the first request must warm up
 * cookies from the homepage. Measured 2026-11: without cookies ~0 results, with them ~10.
 */
const COOKIE_TTL_MS = 25 * 60_000;
let session: { cookie: string; at: number } | null = null;
let bootstrapping: Promise<string> | null = null;

async function bingCookie(signal?: AbortSignal): Promise<string> {
  if (session && Date.now() - session.at < COOKIE_TTL_MS) return session.cookie;
  if (bootstrapping) return bootstrapping;

  bootstrapping = (async () => {
    const response = await gateFor("bing", 2_500).run(
      () => fetchText("https://www.bing.com/", { signal, retries: 0, timeoutMs: 12_000 }),
      signal,
    );
    const cookie = response.setCookies.map((item) => item.split(";")[0]).filter(Boolean).join("; ");
    session = { cookie, at: Date.now() };
    return cookie;
  })().finally(() => {
    bootstrapping = null;
  });

  return bootstrapping;
}

const CAPTCHA = [/verify you are human/i, /unusual traffic/i, /b_captcha/i, /\/turing\/captcha/i];

const BING_AGE_FILTER: Record<Recency, string> = {
  day: '&filters=ex1%3a%22ez1%22',
  week: '&filters=ex1%3a%22ez2%22',
  month: '&filters=ex1%3a%22ez3%22',
  year: '&filters=ex1%3a%22ez5%22',
};

export function parseBingHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // Bing ships a few different SERP layouts: classic <li class="b_algo"> and richer
  // <li class="b_ans"> answer blocks. Both carry results as <h2><a href="/ck/a?...">.
  const blocks = html.split(/(?=<li class="b_)/).slice(1);

  for (const block of blocks) {
    const heading = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/);
    if (!heading) continue;

    const href = heading[1].replace(/&amp;/g, "&");
    const isBingRedirect = /\/ck\/a/.test(href);
    const url = decodeBingRedirect(href);
    if (!/^https?:\/\//.test(url)) continue;
    if (/(^|\.)bing\.com$/.test(hostOf(url))) continue;
    if (!isBingRedirect && !/^https?:\/\/([a-z0-9-]+\.)+[a-z]{2,}/i.test(href)) continue;

    const snippetHtml =
      block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ??
      block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ??
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ??
      "";

    hits.push({
      title: stripTags(heading[2]),
      url,
      snippet: normalizeSnippet(snippetHtml),
      host: hostOf(url),
      engine: "bing",
    });
  }

  return dedupe(hits);
}

export async function searchBingHtml(params: SearchParams, signal?: AbortSignal): Promise<SearchHit[]> {
  const search = new URLSearchParams({ q: params.query });
  if (params.region) search.set("setlang", params.region.slice(0, 2));
  const suffix = params.recency ? BING_AGE_FILTER[params.recency] : "";
  const url = `https://www.bing.com/search?${search.toString()}${suffix}`;

  const cookie = await bingCookie(signal);
  const response = await gateFor("bing", 2_500).run(
    () => fetchText(url, { signal, retries: 0, timeoutMs: 15_000, headers: cookie ? { cookie } : {} }),
    signal,
  );

  if (response.status === 202) throw new BlockedError("bing", "202 anti-bot page");
  if (response.status >= 400) throw new HttpError(response.status, url);

  const hits = parseBingHtml(response.text);
  if (hits.length === 0) {
    if (/There are no results/i.test(response.text)) return [];
    if (CAPTCHA.some((marker) => marker.test(response.text))) throw new BlockedError("bing", "captcha");
    session = null; // force a fresh cookie next time
    throw new BlockedError("bing", "empty result page");
  }

  return hits;
}

export function parseBingRss(xml: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = item[1];
    const link = body.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
    if (!link || !/^https?:\/\//.test(link)) continue;
    const url = decodeBingRedirect(link.replace(/&amp;/g, "&"));
    const title = stripTags((body.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, ""));
    if (!title) continue;
    if (/(^|\.)bing\.com$/.test(hostOf(url))) continue;

    const description = (body.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "");
    const published = body.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();

    hits.push({
      title,
      url,
      snippet: normalizeSnippet(description),
      host: hostOf(url),
      ...(published ? { published: toIsoDate(published) } : {}),
      engine: "bing-rss",
    });
  }
  return dedupe(hits);
}

export async function searchBingRss(params: SearchParams, signal?: AbortSignal): Promise<SearchHit[]> {
  // The RSS endpoint only honours a bare query: extra params (setlang, filters) zero it out.
  const url = `https://www.bing.com/search?q=${encodeURIComponent(params.query)}&format=rss`;
  const cookie = await bingCookie(signal);
  const response = await gateFor("bing", 2_500).run(
    () => fetchText(url, { signal, retries: 0, timeoutMs: 12_000, headers: cookie ? { cookie } : {} }),
    signal,
  );

  if (response.status >= 400) throw new HttpError(response.status, url);
  const hits = parseBingRss(response.text);
  if (hits.length === 0) throw new BlockedError("bing-rss", "empty feed");
  return hits;
}

export function toIsoDate(input: string): string | undefined {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}
