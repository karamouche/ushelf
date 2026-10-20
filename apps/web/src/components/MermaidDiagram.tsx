import { useEffect, useId, useMemo, useState } from "react";

let mermaidModule: Promise<typeof import("mermaid").default> | undefined;

function loadMermaid(): Promise<typeof import("mermaid").default> {
  mermaidModule ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      securityLevel: "strict",
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: "neutral",
    });
    return mermaid;
  });
  return mermaidModule;
}

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const renderId = useMemo(
    () => `ushelf-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );
  const [svg, setSvg] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    let current = true;
    setSvg("");
    setError(false);
    void loadMermaid()
      .then((mermaid) => mermaid.render(renderId, source))
      .then(({ svg: rendered }) => {
        if (current) setSvg(rendered);
      })
      .catch(() => {
        if (current) setError(true);
      });
    return () => {
      current = false;
    };
  }, [renderId, source]);

  if (error) {
    return (
      <div className="mermaid-fallback" aria-label="Mermaid diagram source">
        <p role="alert">Diagram could not be rendered. Showing its source instead.</p>
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      </div>
    );
  }
  if (!svg)
    return (
      <div className="mermaid-loading" role="status">
        Rendering diagram…
      </div>
    );
  return (
    <div
      className="mermaid-diagram"
      aria-label="Mermaid diagram"
      role="img"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
