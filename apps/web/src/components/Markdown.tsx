import { isValidElement, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { localMediaUrl } from "../api.js";
import { MermaidDiagram } from "./MermaidDiagram.js";

export function Markdown({ value, itemId }: { value: string; itemId: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        img: ({ src, alt, ...props }) => {
          const localSource = localMediaUrl(itemId, src);
          return localSource ? (
            <img {...props} src={localSource} alt={alt ?? ""} loading="lazy" />
          ) : (
            <span className="media-omitted">Image omitted: {alt || "image"}.</span>
          );
        },
        pre: MermaidPre,
        table: ({ children, ...props }) => (
          <div className="table-scroll" tabIndex={0}>
            <table {...props}>{children}</table>
          </div>
        ),
      }}
    >
      {value}
    </ReactMarkdown>
  );
}

function MermaidPre({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  if (isValidElement(children)) {
    const code = children.props as { className?: string; children?: ReactNode };
    if (code.className?.split(/\s+/).includes("language-mermaid")) {
      return <MermaidDiagram source={String(code.children ?? "").replace(/\n$/, "")} />;
    }
  }
  return <pre {...props}>{children}</pre>;
}
