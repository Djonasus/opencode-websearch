import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Entry = { exp: number; at: number; v: unknown };

const MAX_ENTRIES = 300;

let resolvedDir: string | undefined;
let resolvedFile: string | undefined;

function paths(): { dir: string; file: string } {
  if (!resolvedDir || !resolvedFile) {
    resolvedDir = process.env.WEBSEARCH_CACHE_DIR || join(homedir(), ".cache", "opencode", "websearch");
    resolvedFile = join(resolvedDir, "cache.json");
  }
  return { dir: resolvedDir, file: resolvedFile };
}

const memory = new Map<string, Entry>();
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(paths().file, "utf8")) as { entries?: Record<string, Entry> };
    const now = Date.now();
    for (const [key, entry] of Object.entries(raw.entries ?? {})) {
      if (entry && entry.exp > now) memory.set(key, entry);
    }
  } catch {
    // missing or corrupt cache is not an error
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 400);
  if (typeof (saveTimer as { unref?: () => void }).unref === "function") {
    (saveTimer as { unref: () => void }).unref();
  }
}

function persist(): void {
  try {
    const now = Date.now();
    const entries = [...memory.entries()]
      .filter(([, entry]) => entry.exp > now)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES);
    memory.clear();
    for (const [key, entry] of entries) memory.set(key, entry);

    const { dir, file } = paths();
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }));
    renameSync(tmp, file);
  } catch {
    // cache is best effort; never break a tool call because of it
  }
}

export function cacheKey(parts: unknown): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex");
}

export function cacheGet<T>(key: string): T | undefined {
  load();
  const entry = memory.get(key);
  if (!entry) return undefined;
  if (entry.exp <= Date.now()) {
    memory.delete(key);
    scheduleSave();
    return undefined;
  }
  entry.at = Date.now();
  scheduleSave();
  return entry.v as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  load();
  memory.delete(key);
  memory.set(key, { exp: Date.now() + ttlMs, at: Date.now(), v: value });
  while (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next();
    if (oldest.done) break;
    memory.delete(oldest.value);
  }
  scheduleSave();
}

export function cacheStats(): { entries: number; file: string } {
  load();
  return { entries: memory.size, file: paths().file };
}
