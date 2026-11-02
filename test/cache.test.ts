import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WEBSEARCH_CACHE_DIR = mkdtempSync(join(tmpdir(), "websearch-cache-"));

const { cacheGet, cacheKey, cacheSet } = await import("../src/cache.ts");

describe("cache", () => {
  test("stores and reads values", () => {
    const key = cacheKey({ q: "hello" });
    cacheSet(key, { ok: true }, 60_000);
    expect(cacheGet<{ ok: boolean }>(key)).toEqual({ ok: true });
  });

  test("keys are stable and distinct", () => {
    expect(cacheKey({ a: 1 })).toBe(cacheKey({ a: 1 }));
    expect(cacheKey({ a: 1 })).not.toBe(cacheKey({ a: 2 }));
  });

  test("expires values", async () => {
    const key = cacheKey({ q: "ttl" });
    cacheSet(key, "short", 30);
    expect(cacheGet(key)).toBe("short");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cacheGet(key)).toBeUndefined();
  });
});
