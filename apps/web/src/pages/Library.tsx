import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listItems, type ItemSummary } from "../api.js";
import { Brand } from "../components/Brand.js";
import { Empty } from "../components/Empty.js";
import { LogoutButton } from "../components/LogoutButton.js";
import { formatDate, sourceTypeLabel, stateLabel, statuses } from "../format.js";

export function Library() {
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
        <LogoutButton />
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
