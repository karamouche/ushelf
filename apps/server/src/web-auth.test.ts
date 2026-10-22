import { describe, expect, it } from "vitest";
import { requirePasswordBeyondLoopback } from "./web-auth.js";

describe("requirePasswordBeyondLoopback", () => {
  it("allows loopback exposure without a password", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", " 127.0.0.1 "]) {
      expect(() => requirePasswordBeyondLoopback(host, undefined)).not.toThrow();
    }
  });

  it("refuses any other exposure without a password", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "nas.local", "127.example.com", ""]) {
      expect(() => requirePasswordBeyondLoopback(host, undefined)).toThrow(/USHELF_APP_PASSWORD/);
    }
  });

  it("allows any exposure with a password", () => {
    expect(() => requirePasswordBeyondLoopback("0.0.0.0", "a strong password")).not.toThrow();
  });
});
