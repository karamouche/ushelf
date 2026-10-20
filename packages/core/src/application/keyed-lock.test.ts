import { describe, expect, it } from "vitest";
import { KeyedLock } from "./keyed-lock.js";

describe("KeyedLock", () => {
  it("runs tasks with the same key one at a time and in call order", async () => {
    const lock = new KeyedLock();
    const events: string[] = [];
    const task = (name: string) => async () => {
      events.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`${name}:end`);
      return name;
    };

    await expect(
      Promise.all([lock.run("a", task("first")), lock.run("a", task("second"))]),
    ).resolves.toEqual(["first", "second"]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("runs tasks with different keys concurrently", async () => {
    const lock = new KeyedLock();
    const events: string[] = [];
    let release!: () => void;
    const blocked = lock.run("a", async () => {
      events.push("a:start");
      await new Promise<void>((resolve) => (release = resolve));
      events.push("a:end");
    });
    await lock.run("b", async () => {
      events.push("b");
    });
    release();
    await blocked;
    expect(events).toEqual(["a:start", "b", "a:end"]);
  });

  it("keeps running queued tasks after a failure", async () => {
    const lock = new KeyedLock();
    const failed = lock.run("a", async () => {
      throw new Error("boom");
    });
    const next = lock.run("a", async () => "recovered");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("recovered");
  });
});
