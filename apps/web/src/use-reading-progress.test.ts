import { describe, expect, it } from "vitest";
import { calculateReadingProgress, readingUpdateFor } from "./use-reading-progress.js";

describe("reading progress decisions", () => {
  it("calculates and clamps the current document position", () => {
    expect(calculateReadingProgress(600, 1000, 200)).toBe(0.75);
    expect(calculateReadingProgress(-20, 1000, 200)).toBe(0);
    expect(calculateReadingProgress(900, 1000, 200)).toBe(1);
    expect(calculateReadingProgress(0, 500, 500)).toBe(1);
  });

  it("persists meaningful movement in both directions", () => {
    expect(readingUpdateFor("reading", 0.2, "reading", 0.7, false)).toEqual({
      status: "reading",
      progress: 0.7,
    });
    expect(readingUpdateFor("reading", 0.7, "reading", 0.25, false)).toEqual({
      status: "reading",
      progress: 0.25,
    });
    expect(readingUpdateFor("reading", 0.5, "reading", 0.504, false)).toBeUndefined();
  });

  it("promotes Inbox on automatic progress while preserving completion", () => {
    expect(readingUpdateFor("inbox", 0, "reading", 0.3, false)).toEqual({
      status: "reading",
      progress: 0.3,
    });
    expect(readingUpdateFor("read", 1, "read", 0.3, false)).toBeUndefined();
    expect(readingUpdateFor("reading", 0.8, "read", 0.3, true)).toEqual({
      status: "read",
      progress: 1,
    });
  });

  it("clamps persisted positions to the domain range", () => {
    expect(readingUpdateFor("reading", 0.5, "reading", -1, false)?.progress).toBe(0);
    expect(readingUpdateFor("reading", 0.5, "reading", 2, false)?.progress).toBe(1);
  });
});
