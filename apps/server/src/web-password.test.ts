import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWebPassword } from "./web-password.js";

describe("resolveWebPassword", () => {
  it("defaults to no password when no secret is configured", () => {
    expect(
      resolveWebPassword("", mkdtempSync(path.join(tmpdir(), "ushelf-password-"))),
    ).toBeUndefined();
  });

  it("reads a saved password and lets a nonempty environment value override it", () => {
    const secrets = mkdtempSync(path.join(tmpdir(), "ushelf-password-"));
    writeFileSync(path.join(secrets, "web-password"), "stored password");
    expect(resolveWebPassword("", secrets)).toBe("stored password");
    expect(resolveWebPassword("environment password", secrets)).toBe("environment password");
  });

  it("fails closed for an empty saved password", () => {
    const secrets = mkdtempSync(path.join(tmpdir(), "ushelf-password-"));
    writeFileSync(path.join(secrets, "web-password"), "");
    expect(() => resolveWebPassword("", secrets)).toThrow("empty");
  });
});
