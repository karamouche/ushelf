import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractPublicX } from "./x-extractor.js";

const sourceUrl = "https://x.com/XOpenSource/status/2087951962004230428";

describe("public X extraction", () => {
  it("captures short public descriptions and metadata images", () => {
    const result = extractPublicX(
      xDom(`
        <meta property="og:title" content="X Open Source (@XOpenSource) on X">
        <meta property="og:description" content="Open-sourcing the For You timeline">
        <meta property="og:image" content="https://pbs.twimg.com/media/HPplsydXMAETRLO.jpg">
      `),
      sourceUrl,
    );

    expect(result).toEqual({
      sourceType: "x",
      title: "X Open Source (@XOpenSource) on X",
      markdown: `![X Open Source (@XOpenSource) on X](https://pbs.twimg.com/media/HPplsydXMAETRLO.jpg)

Open-sourcing the For You timeline

[View post on X](${sourceUrl})`,
      method: "public_extract",
    });
  });

  it.each(["javascript:alert(1)", "data:image/png;base64,unsafe", "/relative.jpg"])(
    "ignores a non-HTTP metadata image: %s",
    (image) => {
      const result = extractPublicX(
        xDom(`
          <meta property="og:description" content="A short public post">
          <meta property="og:image" content="${image}">
        `),
        sourceUrl,
      );

      expect(result?.markdown).toBe(`A short public post\n\n[View post on X](${sourceUrl})`);
    },
  );

  it("uses a valid Twitter image when the Open Graph image is unsafe", () => {
    const result = extractPublicX(
      xDom(`
        <meta property="og:description" content="A short public post">
        <meta property="og:image" content="javascript:alert(1)">
        <meta name="twitter:image" content="https://pbs.twimg.com/media/safe.jpg">
      `),
      sourceUrl,
    );

    expect(result?.markdown).toContain("![X](https://pbs.twimg.com/media/safe.jpg)");
  });

  it("keeps the agent fallback when public source text is absent", () => {
    expect(
      extractPublicX(
        xDom('<meta property="og:title" content="X Open Source (@XOpenSource) on X">'),
        sourceUrl,
      ),
    ).toBeUndefined();
  });
});

function xDom(metadata: string): JSDOM {
  return new JSDOM(`<html><head>${metadata}</head><body></body></html>`);
}
