import { describe, expect, test } from "bun:test";
import { buildQuery, engineOrder, filterHits, normalizeSite } from "../src/search.ts";
import { formatHits } from "../src/format.ts";
import { isBlockedHost } from "../src/tools/open.ts";
import type { SearchHit } from "../src/types.ts";

const hit = (url: string, extra: Partial<SearchHit> = {}): SearchHit => ({
  title: "t",
  url,
  snippet: "s",
  host: new URL(url).hostname.replace(/^www\./, ""),
  engine: "duckduckgo",
  ...extra,
});

describe("query building", () => {
  test("normalizes sites", () => {
    expect(normalizeSite("https://www.GitHub.com/foo?x=1")).toBe("github.com");
    expect(normalizeSite(" github.com ")).toBe("github.com");
    expect(normalizeSite(undefined)).toBeUndefined();
  });

  test("appends site operator once", () => {
    expect(buildQuery({ query: "bun release", count: 5, site: "github.com" })).toBe("bun release site:github.com");
    expect(buildQuery({ query: "bun site:github.com", count: 5, site: "github.com" })).toBe("bun site:github.com");
  });
});

describe("engine chain", () => {
  test("auto starts with duckduckgo when searxng is not configured", () => {
    delete process.env.SEARXNG_URL;
    expect(engineOrder("auto")[0]).toBe("duckduckgo");
    expect(engineOrder("auto")).toContain("bing");
    expect(engineOrder("auto")).toContain("ddg-lite");
  });

  test("explicit engine wins", () => {
    expect(engineOrder("news")).toEqual(["news"]);
  });
});

describe("result filtering", () => {
  test("caps duplicates per host and drops self links", () => {
    const hits = [
      hit("https://a.com/1"),
      hit("https://a.com/2"),
      hit("https://a.com/3"),
      hit("https://b.com/1"),
      hit("https://duckduckgo.com/y.js"),
      hit("https://www.bing.com/search?q=x"),
    ];
    const filtered = filterHits(hits, { query: "q", count: 10 }, 10);
    expect(filtered.map((item) => item.url)).toEqual(["https://a.com/1", "https://a.com/2", "https://b.com/1"]);
  });

  test("applies site restriction", () => {
    const filtered = filterHits(
      [hit("https://github.com/a"), hit("https://example.com/b"), hit("https://gist.github.com/c")],
      { query: "q", count: 10, site: "github.com" },
      10,
    );
    expect(filtered.map((item) => item.host)).toEqual(["github.com", "gist.github.com"]);
  });

  test("respects the limit", () => {
    const many = Array.from({ length: 20 }, (_, index) => hit(`https://h${index}.com/`));
    expect(filterHits(many, { query: "q", count: 5 }, 5).length).toBe(5);
  });
});

describe("formatting", () => {
  test("prints a compact list", () => {
    const out = formatHits([hit("https://a.com/x", { title: "Alpha", snippet: "cool" })], {
      engine: "duckduckgo",
      cached: false,
      notes: [],
    });
    expect(out).toContain("engine: duckduckgo · results: 1");
    expect(out).toContain("1. Alpha");
    expect(out).toContain("https://a.com/x");
  });

  test("explains empty results", () => {
    const out = formatHits([], { engine: "none", cached: false, notes: ["bing: blocked"] });
    expect(out).toContain("No results.");
    expect(out).toContain("bing: blocked");
  });
});

describe("ssrf guard", () => {
  test("blocks local and private targets", () => {
    for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.1", "172.20.0.1", "169.254.169.254", "printer.local"]) {
      expect(isBlockedHost(host)).toBe(true);
    }
    for (const host of ["opencode.ai", "8.8.8.8", "172.32.0.1"]) {
      expect(isBlockedHost(host)).toBe(false);
    }
  });
});
