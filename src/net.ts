export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string, detail?: string) {
    super(`HTTP ${status} for ${url}${detail ? ` (${detail})` : ""}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export class BlockedError extends Error {
  readonly engine: string;
  readonly reason: string;
  constructor(engine: string, reason: string) {
    super(`${engine} blocked: ${reason}`);
    this.name = "BlockedError";
    this.engine = engine;
    this.reason = reason;
  }
}

export type FetchOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  acceptLanguage?: string;
};

export type FetchResult = {
  status: number;
  text: string;
  url: string;
  contentType: string;
  setCookies: string[];
};

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Single HTTP entry point: browser-like headers, per-request timeout, bounded retries.
 * 429/5xx are retried; 202 is returned verbatim so engines can treat it as a block signal.
 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const { signal, timeoutMs = 12_000, retries = 1, headers = {}, method = "GET", body, acceptLanguage } = options;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason ?? new Error("aborted"));
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        body,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": DEFAULT_UA,
          "accept-language": acceptLanguage ?? "en-US,en;q=0.9",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
          "accept-encoding": "gzip, deflate, br",
          ...headers,
        },
      });

      const text = await response.text();

      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        await sleep(700 * (attempt + 1), signal);
        continue;
      }

      const headerBag = response.headers as Headers & { getSetCookie?: () => string[] };
      const setCookies = typeof headerBag.getSetCookie === "function" ? headerBag.getSetCookie() : [];

      return {
        status: response.status,
        text,
        url: response.url,
        contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
        setCookies,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (attempt >= retries) throw error;
      await sleep(700 * (attempt + 1), signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function decodeBingRedirect(href: string): string {
  try {
    const target = new URL(href, "https://www.bing.com");
    if (!/\/ck\/a/.test(target.pathname)) return href;
    const encoded = target.searchParams.get("u");
    if (!encoded || !encoded.startsWith("a1")) return href;
    const base64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return /^https?:\/\//.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

export function decodeDuckDuckGoUrl(href: string): string {
  let value = href.trim().replace(/&amp;/g, "&");
  if (value.startsWith("//")) value = "https:" + value;
  try {
    const url = new URL(value, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    if (target) return target;
    if (url.hostname.endsWith("duckduckgo.com") && url.pathname.startsWith("/l/")) {
      const fallback = url.searchParams.get("u");
      if (fallback) return fallback;
    }
    return url.toString();
  } catch {
    return value;
  }
}
