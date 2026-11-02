import { sleep } from "./net.ts";

/**
 * Serializes requests per engine and enforces a minimum gap between them.
 * DuckDuckGo starts answering with 202 after 2-3 rapid requests, so pacing is mandatory.
 */
export class EngineGate {
  private tail: Promise<unknown> = Promise.resolve();
  private nextAt = 0;

  constructor(readonly minGapMs: number) {}

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const job = this.tail.then(async () => {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait, signal);
      try {
        return await task();
      } finally {
        this.nextAt = Date.now() + this.minGapMs;
      }
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
}

const gates = new Map<string, EngineGate>();

export function gateFor(engine: string, minGapMs: number): EngineGate {
  let gate = gates.get(engine);
  if (!gate) {
    gate = new EngineGate(minGapMs);
    gates.set(engine, gate);
  }
  return gate;
}

const cooldowns = new Map<string, { until: number; strikes: number }>();

export function cooldownRemaining(engine: string): number {
  const entry = cooldowns.get(engine);
  if (!entry) return 0;
  return Math.max(0, entry.until - Date.now());
}

export function markBlocked(engine: string, baseMs = 120_000): number {
  const strikes = (cooldowns.get(engine)?.strikes ?? 0) + 1;
  const backoff = Math.min(baseMs * 2 ** (strikes - 1), 15 * 60_000);
  cooldowns.set(engine, { until: Date.now() + backoff, strikes });
  return backoff;
}

export function markHealthy(engine: string): void {
  cooldowns.delete(engine);
}
