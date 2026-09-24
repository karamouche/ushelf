import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAppPassword } from "./app-password.js";

describe("resolveAppPassword", () => {
  it("defaults to no password when no secret is configured", () => {
    expect(
      resolveAppPassword("", mkdtempSync(path.join(tmpdir(), "ushelf-password-"))),
    ).toBeUndefined();
  });

  it("reads a saved password and lets a nonempty environment value override it", () => {
    const secrets = mkdtempSync(path.join(tmpdir(), "ushelf-password-"));
    writeFileSync(path.join(secrets, "app-password"), "stored password");
    expect(resolveAppPassword("", secrets)).toBe("stored password");
    expect(resolveAppPassword("environment password", secrets)).toBe("environment password");
  });

  it("fails closed for an empty saved password", () => {
    const secrets = mkdtempSync(path.join(tmpdir(), "ushelf-password-"));
    writeFileSync(path.join(secrets, "app-password"), "");
    expect(() => resolveAppPassword("", secrets)).toThrow("empty");
  });
});
