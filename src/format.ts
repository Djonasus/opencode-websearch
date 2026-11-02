import type { SearchHit } from "./types.ts";

export function trimSnippet(value: string, limit = 240): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

export function formatHits(hits: SearchHit[], meta: { engine: string; cached: boolean; notes: string[] }): string {
  if (hits.length === 0) {
    const reasons = meta.notes.length ? `\n${meta.notes.map((note) => `- ${note}`).join("\n")}` : "";
    return `No results.${reasons}\nTry a shorter query, another engine, or web_open on a known URL.`;
  }

  const header = `engine: ${meta.engine} · results: ${hits.length}${meta.cached ? " · cached" : ""}`;
  const blocks = hits.map((hit, index) => {
    const lines = [`${index + 1}. ${hit.title}`, `   ${hit.url}`];
    const snippet = trimSnippet(hit.snippet);
    if (snippet) lines.push(`   ${snippet}`);
    const extra = [hit.host, hit.published].filter(Boolean).join(" · ");
    if (extra) lines.push(`   ${extra}`);
    return lines.join("\n");
  });

  const notes = meta.notes.length ? `\nnotes: ${meta.notes.join("; ")}` : "";
  return `${header}${notes}\n\n${blocks.join("\n\n")}`;
}
