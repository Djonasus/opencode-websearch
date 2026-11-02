import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDdgBlockPage, parseDdgHtml } from "../src/engines/duckduckgo.ts";
import { parseDdgLite } from "../src/engines/ddg-lite.ts";
import { parseBingHtml, parseBingRss } from "../src/engines/bing.ts";
import { parseNewsRss } from "../src/engines/news.ts";
import { decodeBingRedirect, decodeDuckDuckGoUrl, hostOf } from "../src/net.ts";
import { htmlToText, looksLikeShell, mainContent, pageTitle, stripTags } from "../src/extract.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

describe("duckduckgo html", () => {
  const html = fixture("ddg.html");
  const hits = parseDdgHtml(html);

  test("parses a real SERP", () => {
    expect(hits.length).toBeGreaterThanOrEqual(5);
    expect(hits[0]!.host).toBe("opencode.ai");
    expect(hits[0]!.url.startsWith("https://")).toBe(true);
    expect(hits[0]!.title.length).toBeGreaterThan(0);
  });

  test("drops ads and self-links", () => {
    for (const hit of hits) {
      expect(hit.host).not.toBe("duckduckgo.com");
      expect(hit.url).not.toContain("ad_domain");
    }
  });

  test("detects the anti-bot page", () => {
    expect(isDdgBlockPage(html)).toBe(false);
    expect(isDdgBlockPage('<div class="anomaly-modal">bots use DuckDuckGo</div>')).toBe(true);
    expect(isDdgBlockPage("<html><body>No results.</body></html>")).toBe(false);
  });
});

describe("duckduckgo lite", () => {
  test("parses the lite SERP", () => {
    const hits = parseDdgLite(fixture("ddg-lite.html"));
    expect(hits.length).toBeGreaterThanOrEqual(5);
    expect(hits[0]!.host).toBe("opencode.ai");
    expect(hits[0]!.snippet.length).toBeGreaterThan(0);
  });
});

describe("bing", () => {
  test("parses html results and unwraps redirects", () => {
    const hits = parseBingHtml(fixture("bing.html"));
    expect(hits.length).toBeGreaterThanOrEqual(5);
    for (const hit of hits) {
      expect(hit.url.startsWith("https://")).toBe(true);
      expect(hostOf(hit.url)).not.toBe("bing.com");
      expect(hostOf(hit.url)).not.toContain("bing.com");
    }
  });

  test("parses rss results", () => {
    const hits = parseBingRss(fixture("bing.xml"));
    expect(hits.length).toBeGreaterThanOrEqual(5);
    expect(hits[0]!.title.length).toBeGreaterThan(0);
  });
});

describe("news rss", () => {
  test("parses google news and strips the publisher suffix", () => {
    const hits = parseNewsRss(fixture("news.xml"));
    expect(hits.length).toBeGreaterThanOrEqual(5);
    expect(hits[0]!.title).not.toMatch(/\s-\s[^-]{2,40}$/);
  });
});

describe("url decoding", () => {
  test("ddg redirect", () => {
    expect(decodeDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fopencode.ai%2F&rut=abc")).toBe("https://opencode.ai/");
    expect(decodeDuckDuckGoUrl("https://example.com/page")).toBe("https://example.com/page");
  });

  test("bing redirect", () => {
    const encoded = "https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9vcGVuY29kZS5haS9kb2Nz&ntb=1";
    expect(decodeBingRedirect(encoded)).toBe("https://opencode.ai/docs");
    expect(decodeBingRedirect("https://example.com/")).toBe("https://example.com/");
  });
});

describe("html extraction", () => {
  test("strips chrome and scripts", () => {
    const html = `<html><head><title>Demo &amp; Co</title><style>.a{color:red}</style></head>
      <body><nav>menu</nav><main><h1>Hello</h1><p>First&amp;second line.</p>
      <script>alert(1)</script><ul><li>one</li><li>two</li></ul></main><footer>bye</footer></body></html>`;
    const text = htmlToText(mainContent(html));
    expect(text).toContain("Hello");
    expect(text).toContain("First&second line.");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("color:red");
    expect(pageTitle(html)).toBe("Demo & Co");
  });

  test("detects js shells", () => {
    expect(looksLikeShell("Loading...")).toBe(true);
    expect(looksLikeShell("word ".repeat(200))).toBe(false);
  });

  test("decodes entities in snippets", () => {
    expect(stripTags("<b>Bun</b> &#183; v1.4 &mdash; fast")).toBe("Bun · v1.4 — fast");
  });
});
