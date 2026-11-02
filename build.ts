import { build } from "bun";
import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const outdir = process.env.WEBSEARCH_PLUGIN_DIR || join(homedir(), ".config", "opencode", "plugins");
mkdirSync(outdir, { recursive: true });

const result = await build({
  entrypoints: ["./src/index.ts"],
  outdir,
  target: "bun",
  format: "esm",
  naming: "websearch.js",
  external: ["@opencode-ai/plugin"],
  minify: false,
  sourcemap: "none",
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

for (const output of result.outputs) {
  const size = statSync(output.path).size;
  console.log(`built ${output.path} (${(size / 1024).toFixed(1)} kB)`);
}
