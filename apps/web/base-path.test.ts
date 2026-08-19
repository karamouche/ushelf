import { describe, expect, it } from "vitest";
import { resolveWebBasePath } from "./base-path.js";

describe("resolveWebBasePath", () => {
  it("defaults to the root path", () => {
    expect(resolveWebBasePath(undefined)).toBe("/");
    expect(resolveWebBasePath("  ")).toBe("/");
  });

  it("accepts the root path", () => {
    expect(resolveWebBasePath("/")).toBe("/");
  });

  it("normalizes a subpath with a trailing slash", () => {
    expect(resolveWebBasePath("/reader")).toBe("/reader/");
    expect(resolveWebBasePath(" /reader/ ")).toBe("/reader/");
  });

  it("rejects values that are not absolute URL paths", () => {
    expect(() => resolveWebBasePath("reader")).toThrow("must start with /");
    expect(() => resolveWebBasePath("//example.com/reader")).toThrow("must be a URL path");
    expect(() => resolveWebBasePath("/reader?mode=full")).toThrow("must be a URL path");
    expect(() => resolveWebBasePath("/reader#top")).toThrow("must be a URL path");
  });
});
