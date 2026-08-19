import { describe, expect, it } from "vitest";
import { canonicalizeUrl, detectSourceType } from "./url.js";
import { isPrivateAddress } from "./extraction.js";

describe("canonicalizeUrl", () => {
  it("removes fragments, trackers, duplicate trailing slashes, and sorts query parameters", () => {
    expect(canonicalizeUrl("https://EXAMPLE.com/read///?utm_source=x&b=2&a=1#part")).toBe(
      "https://example.com/read?a=1&b=2",
    );
  });

  it("rejects unsafe schemes and credentials", () => {
    expect(() => canonicalizeUrl("file:///etc/passwd")).toThrow(/HTTP/);
    expect(() => canonicalizeUrl("https://user:pass@example.com")).toThrow(/credentials/);
  });

  it("recognizes both X hostnames", () => {
    expect(detectSourceType("https://x.com/example/status/1")).toBe("x_thread");
    expect(detectSourceType("https://twitter.com/example/status/1")).toBe("x_thread");
  });
});

describe("private address protection", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.20.0.1", "192.168.1.1", "169.254.1.1", "::1", "fd00::1"])(
    "blocks %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(true);
    },
  );
  it("allows public addresses", () => expect(isPrivateAddress("1.1.1.1")).toBe(false));
});
