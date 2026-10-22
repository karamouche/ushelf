import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  getItem,
  originalFileUrl,
  type Citation,
  type ReadingStatus,
  type ShelfItem,
} from "../api.js";
import { Brand } from "../components/Brand.js";
import { Empty } from "../components/Empty.js";
import { KindleDelivery } from "../components/KindleDelivery.js";
import { LogoutButton } from "../components/LogoutButton.js";
import { Markdown } from "../components/Markdown.js";
import { formatDate, sourceTypeLabel, statuses } from "../format.js";
import { useReadingProgress } from "../use-reading-progress.js";

export function Reader() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState<ShelfItem>();
  const [error, setError] = useState("");
  const { liveProgress, saveError, changeStatus, flush } = useReadingProgress(item, setItem);

  useEffect(() => {
    getItem(id)
      .then((next) => {
        setItem(next);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [id]);
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
        <button
          className="reader-back"
          onClick={() => {
            void flush({ keepalive: true });
            navigate(-1);
          }}
          aria-label="Back to library"
        >
          ←
        </button>
        <Brand />
        <div className="reader-nav-actions">
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
          <LogoutButton />
        </div>
      </header>
      <div className="reading-progress" style={{ width: `${liveProgress * 100}%` }} />
      <main className="article">
        {saveError ? (
          <p className="reader-save-error" role="alert">
            {saveError}
          </p>
        ) : null}
        <p className="eyebrow">
          {sourceTypeLabel(item.sourceType)} · saved {formatDate(item.capturedAt)}
        </p>
        <h1>{item.title}</h1>
        <div className="byline">
          {item.author && <span>By {item.author}</span>}
          <div className="reader-actions">
            {item.sourceType === "document" ? (
              <a href={originalFileUrl(item.id)} target="_blank" rel="noreferrer">
                Open PDF ↗
              </a>
            ) : (
              <a href={item.originalUrl} target="_blank" rel="noreferrer">
                Open original ↗
              </a>
            )}
            {item.extraction.status === "complete" && item.sourceMarkdown.trim() ? (
              <KindleDelivery item={item} />
            ) : null}
          </div>
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
            <Markdown value={insightDocument} itemId={item.id} />
          ) : (
            <p className="muted">Waiting for an agent to add insights.</p>
          )}
        </section>
        <section className="document source">
          <h2>Source</h2>
          {item.sourceMarkdown ? (
            <Markdown value={item.sourceMarkdown} itemId={item.id} />
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

function readerCitation(itemId: string, citation: Citation): string {
  return "url" in citation
    ? `- [${citation.label}](${citation.url})`
    : `- [Page ${citation.page} — ${citation.label}](${originalFileUrl(itemId, citation.page)})`;
}
