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
    expect(result.markdown).toContain("agent.py");
  });

  it("promotes code out of presentation-only wrappers without changing its order", () => {
    const dom = articleDom(`
      <h1>Agent patterns</h1>
      <p>Before the examples, this introduction provides enough useful prose for reliable article extraction.</p>
      <div class="not-prose my-6"><div class="overflow-hidden"><div class="overflow-y-auto">
        <pre data-language="typescript"><div><span>const first = await run();</span></div><div><span>  return first;</span></div><div></div><div><span>afterFirst();</span></div></pre>
        <button type="button"><span>Copy code</span></button>
      </div></div></div>
      <p>Between the examples, the article explains why each operation needs its own durable checkpoint.</p>
      <div class="not-prose my-6"><div class="overflow-hidden"><div class="overflow-y-auto">
        <pre><div><span>await sendLater();</span></div></pre>
      </div></div></div>
      <p>After the examples, this closing explanation contains enough additional prose to remain readable.</p>
    `);

    const result = extractReadableArticle(dom, "https://docs.example.test/agent-patterns");

    expect(result.markdown).toContain(
      "```typescript\nconst first = await run();\n  return first;\n\nafterFirst();\n```",
    );
    expect(result.markdown).toContain("```\nawait sendLater();\n```");
    expect(result.markdown).not.toContain("overflow-hidden");
    expect(result.markdown).not.toContain("Copy code");
    expect(result.markdown.indexOf("Before the examples")).toBeLessThan(
      result.markdown.indexOf("const first"),
    );
    expect(result.markdown.indexOf("const first")).toBeLessThan(
      result.markdown.indexOf("Between the examples"),
    );
    expect(result.markdown.indexOf("Between the examples")).toBeLessThan(
      result.markdown.indexOf("await sendLater"),
    );
  });

  it("preserves explicit line breaks in highlighted code", () => {
    const dom = articleDom(`
      <h1>Code guide</h1>
      <p>A useful introduction with enough text for Readability to identify this as an article.</p>
      <pre><code class="language-typescript"><span>const config = {</span><br><span>  enabled: true,</span><br><span>};</span></code></pre>
      <p>This closing explanation contains enough additional prose to keep extraction deterministic and useful.</p>
    `);

    const result = extractReadableArticle(dom, "https://docs.example.test/code-breaks");

    expect(result.markdown).toContain("```typescript\nconst config = {\n  enabled: true,\n};\n```");
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

  it("promotes inline images out of image-only media wrappers", () => {
    const dom = articleDom(
      `<h1>Illustrated workflow</h1>
       <p>The opening section contains enough explanatory prose for Readability to identify the main article.</p>
       <div class="content-block content-block--media"><figure class="article-image"><img src="../media/workflow.png" alt="Workflow overview"><figcaption>Workflow at a glance</figcaption></figure></div>
       <h2>Plan the change</h2>
       <p>This section explains the planning stage in enough detail to keep extraction deterministic and useful.</p>
       <div class="content-block content-block--media"><figure class="article-image"><img data-src="https://cdn.example.test/plan.png?width=1200&amp;format=webp" alt="Planning stage" title="Plan first"></figure></div>
       <p>The closing section verifies that all article images remain in their original reading order.</p>`,
      '<meta property="og:image" content="/metadata-cover.png">',
    );

    const result = extractReadableArticle(dom, "https://docs.example.test/guides/workflow");

    expect(result.markdown.match(/!\[/g)).toHaveLength(2);
    expect(result.markdown).toContain(
      "![Workflow overview](https://docs.example.test/media/workflow.png)",
    );
    expect(result.markdown).toContain("Workflow at a glance");
    expect(result.markdown).toContain(
      '![Planning stage](https://cdn.example.test/plan.png?width=1200&format=webp "Plan first")',
    );
    expect(result.markdown).not.toContain("metadata-cover.png");
    expect(result.markdown.indexOf("Workflow overview")).toBeLessThan(
      result.markdown.indexOf("Plan the change"),
    );
    expect(result.markdown.indexOf("Plan the change")).toBeLessThan(
      result.markdown.indexOf("Planning stage"),
    );
  });

  it("keeps mixed-content and multi-image figures intact", () => {
    const dom = articleDom(`
      <h1>Comparison guide</h1>
      <p>This introduction contains enough useful prose for Readability to identify the article consistently.</p>
      <div class="article-content">
        <p>The two diagrams below should remain together as a comparison.</p>
        <figure>
          <img src="/media/before.png" alt="Before">
          <img src="/media/after.png" alt="After">
          <figcaption>Before and after</figcaption>
        </figure>
      </div>
      <p>This closing explanation adds enough prose to keep the complete article readable.</p>
    `);

    const result = extractReadableArticle(dom, "https://docs.example.test/comparison");

    expect(result.markdown).toContain("The two diagrams below should remain together");
    expect(result.markdown).toContain("![Before](https://docs.example.test/media/before.png)");
    expect(result.markdown).toContain("![After](https://docs.example.test/media/after.png)");
    expect(result.markdown).toContain("Before and after");
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
