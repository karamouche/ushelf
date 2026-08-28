import {
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  getItem,
  listItems,
  originalFileUrl,
  updateReading,
  updateReadingOnExit,
  type ItemSummary,
  type Citation,
  type ReadingStatus,
  type ShelfItem,
} from "./api.js";

const statuses: Array<{ value: "" | ReadingStatus; label: string }> = [
  { value: "", label: "All" },
  { value: "inbox", label: "Inbox" },
  { value: "reading", label: "Reading" },
  { value: "read", label: "Read" },
  { value: "archived", label: "Archived" },
];

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

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Library />} />
      <Route path="/items/:id" element={<Reader />} />
    </Routes>
  );
}

function Brand() {
  return (
    <Link className="brand" to="/" aria-label="uShelf home">
      <span>u</span>Shelf
    </Link>
  );
}

function Library() {
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const sourceType = params.get("sourceType") ?? "";

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLoading(true);
      listItems({ q, status, sourceType })
        .then(setItems)
        .catch((reason: Error) => setError(reason.message))
        .finally(() => setLoading(false));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [q, status, sourceType]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <span className="quiet">A quiet place for unfinished reading.</span>
      </header>
      <main>
        <section className="library-head">
          <div>
            <p className="eyebrow">Your library</p>
            <h1>{status ? statuses.find((item) => item.value === status)?.label : "Everything"}</h1>
          </div>
          <p className="count">
            {loading ? "—" : items.length} {items.length === 1 ? "piece" : "pieces"}
          </p>
        </section>
        <div className="controls">
          <label className="search">
            <span className="sr-only">Search</span>
            <input
              value={q}
              onChange={(event) => setFilter("q", event.target.value)}
              placeholder="Search ideas, titles, tags…"
            />
          </label>
          <div className="status-tabs" aria-label="Reading status">
            {statuses.map((item) => (
              <button
                className={status === item.value ? "active" : ""}
                key={item.value}
                onClick={() => setFilter("status", item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <select
            aria-label="Source type"
            value={sourceType}
            onChange={(event) => setFilter("sourceType", event.target.value)}
          >
            <option value="">All sources</option>
            <option value="article">Articles</option>
            <option value="document">Documents</option>
            <option value="x">X</option>
          </select>
        </div>
        {error ? (
          <Empty title="The shelf could not be opened" detail={error} />
        ) : loading ? (
          <div className="loading">Opening the shelf…</div>
        ) : items.length === 0 ? (
          <Empty
            title="Nothing on this shelf yet"
            detail={
              q
                ? "Try a broader search."
                : "Connect an agent and ask it to save something worth returning to."
            }
          />
        ) : (
          <div className="item-list">
            {items.map((item) => (
              <ItemCard item={item} key={item.id} />
            ))}
          </div>
        )}
      </main>
      <footer>Local, portable, and agent-driven.</footer>
    </div>
  );
}

function ItemCard({ item }: { item: ItemSummary }) {
  return (
    <article className="item-card">
      <Link to={`/items/${item.id}`}>
        <div className="item-meta">
          <span>{sourceTypeLabel(item.sourceType)}</span>
          <span>{formatDate(item.capturedAt)}</span>
          <span className={`state state-${item.ingestionState}`}>
            {stateLabel(item.ingestionState)}
          </span>
        </div>
        <h2>{item.title}</h2>
        {item.summary ? (
          <p>{item.summary}</p>
        ) : (
          <p className="muted">Insights have not been added yet.</p>
        )}
        <div className="card-foot">
          <div className="tags">
            {item.tags.slice(0, 4).map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
          <span>{Math.round(item.progress * 100)}%</span>
        </div>
        <div className="progress">
          <i style={{ width: `${item.progress * 100}%` }} />
        </div>
      </Link>
    </article>
  );
}

function Reader() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState<ShelfItem>();
  const itemRef = useRef<ShelfItem | undefined>(undefined);
  const [error, setError] = useState("");
  const lastSaved = useRef(0);

  useEffect(() => {
    getItem(id)
      .then((next) => {
        setItem(next);
        itemRef.current = next;
      })
      .catch((reason: Error) => setError(reason.message));
  }, [id]);
  useEffect(() => {
    itemRef.current = item;
  }, [item]);
  useEffect(() => {
    if (!item) return;
    const timer = window.setTimeout(
      () =>
        window.scrollTo({
          top:
            item.reading.progress *
            Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
          behavior: "instant",
        }),
      80,
    );
    const onScroll = () => {
      const current = itemRef.current;
      if (!current || Date.now() - lastSaved.current < 4000) return;
      const denominator = document.documentElement.scrollHeight - window.innerHeight;
      const progress = denominator > 0 ? window.scrollY / denominator : 1;
      if (Math.abs(progress - current.reading.progress) < 0.025) return;
      lastSaved.current = Date.now();
      updateReading(
        current,
        current.reading.status === "inbox" ? "reading" : current.reading.status,
        progress,
      )
        .then((next) => {
          itemRef.current = next;
          setItem(next);
        })
        .catch(() => undefined);
    };
    const onPageHide = () => {
      const current = itemRef.current;
      if (!current) return;
      const denominator = document.documentElement.scrollHeight - window.innerHeight;
      const progress = denominator > 0 ? window.scrollY / denominator : 1;
      updateReadingOnExit(
        current,
        current.reading.status === "inbox" ? "reading" : current.reading.status,
        progress,
      );
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [item?.id]);

  const changeStatus = async (status: ReadingStatus) => {
    if (!item) return;
    try {
      const next = await updateReading(item, status, item.reading.progress);
      setItem(next);
      itemRef.current = next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const insightDocument = useMemo(
    () =>
      item
        ? [
            item.enrichment.summary ? `### Summary\n\n${item.enrichment.summary}` : "",
            item.enrichment.keyPoints?.length
              ? `### Key points\n\n${item.enrichment.keyPoints.map((point) => `- ${point}`).join("\n")}`
              : "",
            item.insightMarkdown,
            item.enrichment.citations?.length
              ? `### Citations\n\n${item.enrichment.citations.map((citation) => readerCitation(item.id, citation)).join("\n")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n\n")
        : "",
    [item],
  );

  if (error && !item)
    return (
      <div className="shell">
        <header className="topbar">
          <Brand />
        </header>
        <Empty title="This piece could not be opened" detail={error} />
      </div>
    );
  if (!item) return <div className="loading page-loading">Opening…</div>;
  return (
    <div className="reader-shell">
      <header className="reader-nav">
        <button onClick={() => navigate(-1)} aria-label="Back to library">
          ←
        </button>
        <Brand />
        <select
          aria-label="Reading status"
          value={item.reading.status}
          onChange={(event) => void changeStatus(event.target.value as ReadingStatus)}
        >
          {statuses.slice(1).map((status) => (
            <option key={status.value} value={status.value}>
              {status.label}
            </option>
          ))}
        </select>
      </header>
      <div className="reading-progress" style={{ width: `${item.reading.progress * 100}%` }} />
      <main className="article">
        <p className="eyebrow">
          {sourceTypeLabel(item.sourceType)} · saved {formatDate(item.capturedAt)}
        </p>
        <h1>{item.title}</h1>
        <div className="byline">
          {item.author && <span>By {item.author}</span>}
          {item.sourceType === "document" ? (
            <a href={originalFileUrl(item.id)} target="_blank" rel="noreferrer">
              Open PDF ↗
            </a>
          ) : (
            <a href={item.originalUrl} target="_blank" rel="noreferrer">
              Open original ↗
            </a>
          )}
        </div>
        {item.extraction.status !== "complete" || item.enrichment.status !== "complete" ? (
          <aside className="notice">
            <strong>
              {item.extraction.status !== "complete"
                ? "Source needs attention"
                : "Insights pending"}
            </strong>
            <span>
              {item.extraction.error ?? "Ask your connected agent to resume this ingestion."}
            </span>
          </aside>
        ) : null}
        <section className="document insights">
          <h2>Insights</h2>
          {insightDocument ? (
            <Markdown value={insightDocument} />
          ) : (
            <p className="muted">Waiting for an agent to add insights.</p>
          )}
        </section>
        <section className="document source">
          <h2>Source</h2>
          {item.sourceMarkdown ? (
            <Markdown value={item.sourceMarkdown} />
          ) : (
            <p className="muted">Source content has not been supplied.</p>
          )}
        </section>
        <details className="provenance">
          <summary>About this capture</summary>
          <dl>
            <dt>Extraction</dt>
            <dd>{item.extraction.method ?? item.extraction.status}</dd>
            <dt>Recipe</dt>
            <dd>
              {item.enrichment.recipe}
              {item.enrichment.recipeHash ? ` · ${item.enrichment.recipeHash.slice(0, 8)}` : ""}
            </dd>
            <dt>Revision</dt>
            <dd>{item.revision.slice(0, 12)}</dd>
          </dl>
        </details>
      </main>
    </div>
  );
}

function Markdown({ value }: { value: string }) {
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
        img: (props) => <img {...props} loading="lazy" referrerPolicy="no-referrer" />,
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

function MermaidDiagram({ source }: { source: string }) {
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

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <span>◌</span>
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function sourceTypeLabel(value: ItemSummary["sourceType"]): string {
  switch (value) {
    case "article":
      return "Article";
    case "document":
      return "Document";
    case "x":
      return "X";
  }
}

function readerCitation(itemId: string, citation: Citation): string {
  return "url" in citation
    ? `- [${citation.label}](${citation.url})`
    : `- [Page ${citation.page} — ${citation.label}](${originalFileUrl(itemId, citation.page)})`;
}
function stateLabel(value: string) {
  return (
    (
      {
        ready: "Ready",
        awaiting_source: "Needs source",
        awaiting_enrichment: "Needs insights",
        failed: "Failed",
        extracting: "Extracting",
      } as Record<string, string>
    )[value] ?? value
  );
}
