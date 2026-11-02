const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  times: "×",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  sect: "§",
  para: "¶",
  dagger: "†",
  prime: "′",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  larr: "←",
  rarr: "→",
  harr: "↔",
  check: "✓",
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Turns a fragment of HTML into a single-line plain string (titles, snippets). */
export function stripTags(html: string): string {
  const withoutTags = html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

/** Converts a full HTML document (or its main chunk) into readable plain text. */
export function htmlToText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<(script|style|noscript|svg|canvas|iframe|template|head|form)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "\n• ");
  text = text.replace(/<h[1-6][^>]*>/gi, "\n\n");
  text = text.replace(/<\/(p|div|section|article|main|li|h[1-6]|tr|blockquote|pre|dd|dt|table|ul|ol)>/gi, "\n");
  text = text.replace(/<\/t[dh]>/gi, "\t");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/[ \t\u00a0\u200b]+/g, " ");
  text = text.replace(/ ?\n ?/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

const NOISE_BLOCKS = /<(nav|header|footer|aside|form|dialog|iframe|svg|script|style|noscript)\b[\s\S]*?<\/\1>/gi;

/** Very small readability pass: prefer <article>/<main>, otherwise drop chrome and keep <body>. */
export function mainContent(html: string): string {
  const article = firstMatch(html, /<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const main = article ?? firstMatch(html, /<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const body = main ?? firstMatch(html, /<body\b[^>]*>([\s\S]*?)<\/body>/i) ?? html;
  return body.replace(NOISE_BLOCKS, " ");
}

function firstMatch(input: string, re: RegExp): string | undefined {
  const match = input.match(re);
  return match?.[1];
}

export function pageTitle(html: string): string | undefined {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (og) return stripTags(og);
  const title = firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!title) return undefined;
  const clean = stripTags(title);
  return clean || undefined;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Pages rendered client-side return an almost empty shell; detect that to trigger the reader fallback. */
export function looksLikeShell(text: string): boolean {
  if (wordCount(text) < 80) return true;
  const lower = text.toLowerCase();
  const hints = ["enable javascript", "requires javascript", "javascript is disabled", "please turn on javascript"];
  return hints.some((hint) => lower.includes(hint));
}

export function cleanJina(text: string): { title?: string; text: string } {
  const title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
  const marker = text.indexOf("Markdown Content:");
  const body = marker >= 0 ? text.slice(marker + "Markdown Content:".length) : text;
  return { title, text: body.trim() };
}
