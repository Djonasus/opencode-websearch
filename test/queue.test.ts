import { describe, expect, test } from "bun:test";
import { EngineGate, cooldownRemaining, markBlocked } from "../src/queue.ts";

describe("engine gate", () => {
  test("keeps a minimum gap between tasks", async () => {
    const gate = new EngineGate(120);
    const stamps: number[] = [];
    await Promise.all(
      [0, 1, 2].map(() =>
        gate.run(async () => {
          stamps.push(Date.now());
        }),
      ),
    );
    expect(stamps.length).toBe(3);
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(100);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(100);
  });

  test("serializes work", async () => {
    const gate = new EngineGate(0);
    const order: string[] = [];
    await Promise.all([
      gate.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push("a");
      }),
      gate.run(async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["a", "b"]);
  });
});

describe("cooldowns", () => {
  test("grow exponentially and reset", () => {
    const engine = `test-${Math.random()}`;
    expect(cooldownRemaining(engine)).toBe(0);
    const first = markBlocked(engine, 50);
    const second = markBlocked(engine, 50);
    expect(first).toBe(50);
    expect(second).toBe(100);
    expect(cooldownRemaining(engine)).toBeGreaterThan(0);
  });
});
