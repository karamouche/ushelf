import { describe, expect, it } from "vitest";
import { isPrivateAddress, pinnedLookup } from "./safe-html-fetcher.js";
import { canonicalizeUrl, detectSourceType } from "./source-url.js";

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
    expect(detectSourceType("https://x.com/example/status/1")).toBe("x");
    expect(detectSourceType("https://twitter.com/example/status/1")).toBe("x");
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

  it("pins HTTP connections to the address that passed validation", async () => {
    const lookup = pinnedLookup("203.0.113.10");
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("rebound.example", {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: String(address), family: Number(family) });
      });
    });

    expect(result).toEqual({ address: "203.0.113.10", family: 4 });

    const all = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      lookup("rebound.example", { all: true }, (error, addresses) => {
        if (error) reject(error);
        else if (Array.isArray(addresses)) resolve(addresses);
        else reject(new Error("Expected all resolved addresses"));
      });
    });
    expect(all).toEqual([{ address: "203.0.113.10", family: 4 }]);
  });
});
