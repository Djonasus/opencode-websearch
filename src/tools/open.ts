import { fetchText, hostOf } from "../net.ts";
import { gateFor } from "../queue.ts";
import { cacheGet, cacheKey, cacheSet } from "../cache.ts";
import { cleanJina, htmlToText, looksLikeShell, mainContent, pageTitle, wordCount } from "../extract.ts";

const CACHE_TTL_MS = 60 * 60_000;
const MAX_URLS = 4;
const JINA_TIMEOUT_MS = 20_000;

export type OpenResult = {
  url: string;
  title: string;
  text: string;
  via: "direct" | "reader";
  truncated: boolean;
  error?: string;
};

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

export async function openUrl(rawUrl: string, maxChars: number, signal?: AbortSignal): Promise<OpenResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, title: rawUrl, text: "", via: "direct", truncated: false, error: "invalid URL" };
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    return { url: rawUrl, title: rawUrl, text: "", via: "direct", truncated: false, error: "only http(s) URLs are supported" };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { url: rawUrl, title: rawUrl, text: "", via: "direct", truncated: false, error: "refusing to fetch a local/private address" };
  }

  const key = cacheKey({ v: 2, url: parsed.toString(), maxChars });
  const cached = cacheGet<OpenResult>(key);
  if (cached) return cached;

  let title = hostOf(parsed.toString());
  let text = "";
  let via: OpenResult["via"] = "direct";
  let failure: string | undefined;

  try {
    const response = await gateFor("pages", 350).run(
      () => fetchText(parsed.toString(), { signal, timeoutMs: 15_000, retries: 1, acceptLanguage: "en-US,en;q=0.9" }),
      signal,
    );

    if (response.status >= 400) {
      failure = `HTTP ${response.status}`;
    } else if (response.contentType.includes("application/pdf")) {
      failure = "pdf";
    } else if (response.contentType.startsWith("text/") || response.contentType.includes("json") || response.contentType.includes("xml")) {
      const plain = response.contentType.includes("html") ? "" : response.text;
      if (plain) {
        text = plain.trim();
      } else {
        title = pageTitle(response.text) ?? title;
        text = htmlToText(mainContent(response.text));
      }
    } else {
      title = pageTitle(response.text) ?? title;
      text = htmlToText(mainContent(response.text));
    }
  } catch (error) {
    failure = (error as Error).message.slice(0, 120);
  }

  if (failure === "pdf" || !text || looksLikeShell(text) || wordCount(text) < 80) {
    const reader = await readWithJina(parsed.toString(), signal);
    if (reader && reader.text.length > text.length) {
      text = reader.text;
      title = reader.title || title;
      via = "reader";
      failure = undefined;
    }
  }

  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars).trimEnd();

  const result: OpenResult = {
    url: parsed.toString(),
    title,
    text,
    via,
    truncated,
    ...(failure && !text ? { error: failure } : {}),
  };

  if (result.text) cacheSet(key, result, CACHE_TTL_MS);
  return result;
}

async function readWithJina(url: string, signal?: AbortSignal): Promise<{ title?: string; text: string } | undefined> {
  try {
    const response = await gateFor("jina", 1_200).run(
      () => fetchText(`https://r.jina.ai/${url}`, { signal, timeoutMs: JINA_TIMEOUT_MS, retries: 0, headers: { accept: "text/plain" } }),
      signal,
    );
    if (response.status >= 400) return undefined;
    const parsed = cleanJina(response.text);
    return { title: parsed.title, text: parsed.text };
  } catch {
    return undefined;
  }
}

export function formatOpenResults(results: OpenResult[]): string {
  const blocks = results.map((result) => {
    const heading = `## ${result.title || hostOf(result.url)}\n${result.url}`;
    if (result.error && !result.text) return `${heading}\n! ${result.error}`;
    const meta = `via: ${result.via}${result.truncated ? ", truncated" : ""}`;
    return `${heading}\n${meta}\n\n${result.text}`;
  });
  return blocks.join("\n\n---\n\n");
}

export const OPEN_LIMITS = { MAX_URLS, CACHE_TTL_MS };
