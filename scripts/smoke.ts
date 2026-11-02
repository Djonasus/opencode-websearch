import { searchWeb } from "../src/search.ts";
import { formatHits } from "../src/format.ts";
import { openUrl } from "../src/tools/open.ts";
import type { SearchParams } from "../src/types.ts";

const cases: Array<{ name: string; params: SearchParams }> = [
  { name: "english", params: { query: "bun latest release", count: 5 } },
  { name: "russian", params: { query: "плагины opencode", count: 5, region: "ru-ru" } },
  { name: "site filter", params: { query: "websearch plugin", count: 5, site: "github.com" } },
  { name: "recency", params: { query: "AI news", count: 5, recency: "week" } },
  { name: "news engine", params: { query: "bun release", count: 5, engine: "news" } },
];

let failures = 0;
for (const testCase of cases) {
  const started = Date.now();
  try {
    const outcome = await searchWeb(testCase.params, {
      bypassCache: true,
      logger: (level, message, extra) => console.log(`  [${level}] ${message}`, extra ?? ""),
    });
    const elapsed = Date.now() - started;
    console.log(`\n=== ${testCase.name} (${elapsed} ms) ===`);
    console.log(formatHits(outcome.hits, outcome));
    if (outcome.hits.length === 0) failures++;
  } catch (error) {
    failures++;
    console.log(`\n=== ${testCase.name} FAILED ===`, (error as Error).message);
  }
}

const first = await searchWeb({ query: "opencode docs plugins", count: 3 }, { bypassCache: true });
const target = first.hits[0]?.url;
if (target) {
  const started = Date.now();
  const page = await openUrl(target, 2_000);
  console.log(`\n=== web_open ${target} (${Date.now() - started} ms) ===`);
  console.log(`title: ${page.title}`);
  console.log(`via: ${page.via}, chars: ${page.text.length}, truncated: ${page.truncated}`);
  console.log(page.text.slice(0, 400));
  if (!page.text) failures++;
}

console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
