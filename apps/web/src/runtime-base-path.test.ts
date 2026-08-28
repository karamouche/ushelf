import { describe, expect, it } from "vitest";
import { resolveRuntimeBasePath } from "./runtime-base-path.js";

describe("resolveRuntimeBasePath", () => {
  it("prefers the server-injected runtime path", () => {
    expect(resolveRuntimeBasePath("/reader/", "./")).toBe("/reader/");
  });

  it("normalizes development and relative build defaults", () => {
    expect(resolveRuntimeBasePath(undefined, "/dev/")).toBe("/dev/");
    expect(resolveRuntimeBasePath(undefined, "./")).toBe("/");
  });
});
