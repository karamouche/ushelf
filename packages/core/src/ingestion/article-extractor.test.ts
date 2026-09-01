import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractReadableArticle } from "./article-extractor.js";

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

  it.each([
    ["pre class", '<pre class="mermaid">graph TD\nA--&gt;B</pre>'],
    ["div class", '<div class="mermaid">graph LR\nA--&gt;B</div>'],
    [
      "nested code language",
      '<pre><code class="language-mermaid">sequenceDiagram\nA-&gt;&gt;B: Hello</code></pre>',
    ],
    ["language attribute", '<pre data-language="mermaid">flowchart TD\nA--&gt;B</pre>'],
  ])("preserves Mermaid source from a %s as a fenced block", (_name, diagram) => {
    const dom = articleDom(`
      <h1>Diagram guide</h1>
      <p>A useful introduction with enough text for Readability to identify this as an article.</p>
      ${diagram}
      <p>This closing explanation contains enough additional prose to keep extraction deterministic and useful.</p>
    `);

    const result = extractReadableArticle(dom, "https://docs.example.test/diagram");

    expect(result.markdown).toMatch(/```mermaid\n(?:graph|sequenceDiagram|flowchart)/);
    expect(result.markdown.match(/```mermaid/g)).toHaveLength(1);
  });

  it("does not change the language of ordinary fenced code", () => {
    const dom = articleDom(`
      <h1>Code guide</h1>
      <p>A useful introduction with enough text for Readability to identify this as an article.</p>
      <pre><code class="language-typescript">const answer = 42;</code></pre>
      <p>This closing explanation contains enough additional prose to keep extraction deterministic and useful.</p>
    `);

    const result = extractReadableArticle(dom, "https://docs.example.test/code");

    expect(result.markdown).toContain("```typescript\nconst answer = 42;\n```");
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

  it("preserves inline image data for localization", () => {
    const dom = articleDom(`
      <h1>Embedded image guide</h1>
      <p>A useful introduction with enough text for Readability to identify this as an article.</p>
      <img src="data:image/png;base64,iVBORw0KGgo=" alt="Embedded diagram">
      <p>This closing explanation contains enough additional prose to keep extraction deterministic.</p>
    `);

    const result = extractReadableArticle(dom, "https://docs.example.test/guide");
    expect(result.markdown).toContain("![Embedded diagram](data:image/png;base64,iVBORw0KGgo=)");
  });

  it("uses the metadata image when the article has no inline image", () => {
    const dom = articleDom(
      `<h1>Metadata image guide</h1>
       <p>This article contains enough useful explanatory text for Readability to extract it reliably without requiring any unrelated navigation content.</p>
       <p>Its page artwork is exposed through metadata rather than an image element in the article body.</p>`,
      '<meta property="og:image" content="/generated/cover.png">',
    );

    const result = extractReadableArticle(dom, "https://docs.example.test/guides/overview");

    expect(result.markdown).toContain("![Guide](https://docs.example.test/generated/cover.png)");
  });

  it("resolves relative links and images against the final response URL", () => {
    const dom = articleDom(`
      <h1>Redirected guide</h1>
      <p>A useful introduction with enough text for Readability to identify this as an article.</p>
      <p><a href="next">Continue reading</a></p>
      <img src="images/diagram.png" alt="Redirected diagram">
      <p>This closing explanation contains enough additional prose to keep extraction deterministic.</p>
    `);

    const result = extractReadableArticle(dom, "https://cdn.example.test/articles/final/");

    expect(result.markdown).toContain(
      "[Continue reading](https://cdn.example.test/articles/final/next)",
    );
    expect(result.markdown).toContain(
      "![Redirected diagram](https://cdn.example.test/articles/final/images/diagram.png)",
    );
  });

  it("converts article tables to GitHub-Flavored Markdown", () => {
    const dom = articleDom(`
      <h1>Capability guide</h1>
      <p>This guide explains the available capabilities and contains enough prose for reliable article extraction.</p>
      <table>
        <thead><tr><th>Capability</th><th>Path</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><a href="/model">Model</a></td><td><code>agent.py</code></td><td>Required core options.</td></tr>
          <tr><td>Tools</td><td><code>tools/</code></td><td>Application logic | services.</td></tr>
        </tbody>
      </table>
      <p>The remaining explanatory text describes how each capability maps to a file or directory in the project.</p>
    `);

    const result = extractReadableArticle(dom, "https://docs.example.test/guide");

    expect(result.markdown).toContain(`| Capability | Path | Description |
| --- | --- | --- |
| [Model](https://docs.example.test/model) | \`agent.py\` | Required core options. |
| Tools | \`tools/\` | Application logic \\| services. |`);
  });
});

function articleDom(content: string, metadata = ""): JSDOM {
  return new JSDOM(
    `<html><head><title>Guide</title>${metadata}</head><body><main><article>${content}</article></main></body></html>`,
  );
}
