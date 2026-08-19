import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractReadableArticle } from "./extraction.js";

describe("readable article extraction", () => {
  it("preserves code nested in documentation widgets as fenced blocks", () => {
    const dom = articleDom(`
      <h1>Example agent</h1>
      <p>A useful introduction with enough text for Readability to identify this as an article.</p>
      <div data-component-part="tab-content">
        <p><span title="agent.py">agent.py</span></p>
        <div data-component-part="scroll-area-content">
          <div><pre language="python"><code language="python"><span>from deepagents import create_agent</span>\n<span>agent = create_agent()</span></code></pre></div>
        </div>
      </div>
      <p>This closing explanation contains enough additional prose to keep extraction deterministic. It describes the project structure, deployment process, runtime behavior, and all of the configuration files that make up a production agent.</p>
    `);

    const result = extractReadableArticle(dom, "https://docs.example.test/guide");

    expect(result.markdown).toContain(
      "```python\nfrom deepagents import create_agent\nagent = create_agent()\n```",
    );
  });

  it("imports lazy and relative article images", () => {
    const dom = articleDom(`
      <h1>Illustrated guide</h1>
      <p>A useful introduction with enough text for Readability to identify this as an article.</p>
      <figure><img src="data:image/gif;base64,placeholder" data-src="../media/diagram.png" alt="Agent architecture"><figcaption>Runtime flow</figcaption></figure>
      <p>This closing explanation contains enough additional prose to keep extraction deterministic.</p>
    `);

    const result = extractReadableArticle(dom, "https://docs.example.test/guides/overview");

    expect(result.markdown).toContain(
      "![Agent architecture](https://docs.example.test/media/diagram.png)",
    );
    expect(result.markdown).toContain("Runtime flow");
  });
});

function articleDom(content: string): JSDOM {
  return new JSDOM(
    `<html><head><title>Guide</title></head><body><main><article>${content}</article></main></body></html>`,
  );
}
