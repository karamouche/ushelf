import {
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FormEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import {
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  getItem,
  getKindleStatus,
  listItems,
  listKindleDevices,
  localMediaUrl,
  originalFileUrl,
  sendToKindle,
  claimOwner,
  decideDeviceCode,
  getAccount,
  inspectDeviceCode,
  listOAuthConsents,
  mcpUrl,
  revokeOAuthConsent,
  resetOwnerPassword,
  setupStatus,
  signIn,
  signOut,
  submitOAuthConsent,
  type ItemSummary,
  type Citation,
  type KindleDevice,
  type ReadingStatus,
  type ShelfItem,
} from "./api.js";
import { useReadingProgress } from "./use-reading-progress.js";

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
      <Route path="/setup" element={<Setup />} />
      <Route path="/login" element={<Login />} />
      <Route path="/reset" element={<PasswordReset />} />
      <Route path="/oauth/consent" element={<OAuthConsent />} />
      <Route path="/device" element={<DeviceApproval />} />
      <Route path="/connections" element={<Connections />} />
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

function OwnerMenu() {
  const navigate = useNavigate();
  return (
    <nav className="owner-menu" aria-label="Account">
      <Link to="/connections">Connections</Link>
      <button
        onClick={() => {
          void signOut().finally(() => navigate("/login", { replace: true }));
        }}
      >
        Log out
      </button>
    </nav>
  );
}

function AuthPage({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <Brand />
      <main className="auth-card">{children}</main>
    </div>
  );
}

function Setup() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [claimed, setClaimed] = useState<boolean>();
  useEffect(() => {
    setupStatus()
      .then(({ claimed: value }) => setClaimed(value))
      .catch((reason: Error) => setError(reason.message));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await claimOwner({
        code: String(data.get("code") ?? ""),
        email: String(data.get("email") ?? ""),
        password: String(data.get("password") ?? ""),
        name: String(data.get("name") ?? ""),
      });
      navigate("/login", { replace: true });
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  return (
    <AuthPage>
      <p className="eyebrow">First run</p>
      <h1>Claim your shelf</h1>
      {claimed ? (
        <p>
          This shelf already has an owner. <Link to="/login">Log in</Link>.
        </p>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <p>Enter the one-time code shown in the server logs.</p>
          <label>
            Claim code
            <input name="code" required autoComplete="one-time-code" />
          </label>
          <label>
            Name
            <input name="name" autoComplete="name" />
          </label>
          <label>
            Email
            <input name="email" required type="email" autoComplete="email" />
          </label>
          <label>
            Password
            <input
              name="password"
              required
              minLength={12}
              type="password"
              autoComplete="new-password"
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button type="submit">Create owner account</button>
        </form>
      )}
    </AuthPage>
  );
}

function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState("");
  const requested = new URLSearchParams(location.search).get("returnTo");
  const returnTo = requested?.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await signIn(String(data.get("email") ?? ""), String(data.get("password") ?? ""));
      window.location.assign(returnTo);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  return (
    <AuthPage>
      <p className="eyebrow">Welcome back</p>
      <h1>Open your shelf</h1>
      <form className="auth-form" onSubmit={submit}>
        <label>
          Email
          <input name="email" required type="email" autoComplete="email" />
        </label>
        <label>
          Password
          <input name="password" required type="password" autoComplete="current-password" />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button type="submit">Log in</button>
        <p>
          <Link to="/reset">Use a server-issued recovery code</Link>
        </p>
      </form>
    </AuthPage>
  );
}

function PasswordReset() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await resetOwnerPassword(String(data.get("code") ?? ""), String(data.get("password") ?? ""));
      navigate("/login", { replace: true });
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  return (
    <AuthPage>
      <p className="eyebrow">Account recovery</p>
      <h1>Reset your password</h1>
      <p>
        Ask the server administrator to run <code>reset-password</code> and enter its short-lived
        code here. All sessions and connections will be revoked.
      </p>
      <form className="auth-form" onSubmit={submit}>
        <label>
          Recovery code
          <input name="code" required autoComplete="one-time-code" />
        </label>
        <label>
          New password
          <input
            name="password"
            required
            minLength={12}
            type="password"
            autoComplete="new-password"
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button type="submit">Reset password</button>
      </form>
    </AuthPage>
  );
}

function OAuthConsent() {
  const location = useLocation();
  const [error, setError] = useState("");
  const params = new URLSearchParams(location.search);
  const oauthQuery = params.get("oauth_query") ?? location.search.slice(1);
  const scope = params.get("scope")?.split(" ") ?? [];

  async function decide(accept: boolean) {
    try {
      const result = await submitOAuthConsent(accept, oauthQuery);
      const destination = result.url ?? result.redirect_uri;
      if (destination) window.location.assign(destination);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  return (
    <AuthPage>
      <p className="eyebrow">Agent connection</p>
      <h1>Allow access to uShelf?</h1>
      <p>The requesting client is asking for:</p>
      <ul>
        {scope.map((value) => (
          <li key={value}>{scopeLabel(value)}</li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
      <div className="button-row">
        <button onClick={() => void decide(true)}>Allow</button>
        <button className="secondary" onClick={() => void decide(false)}>
          Deny
        </button>
      </div>
    </AuthPage>
  );
}

function DeviceApproval() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("user_code") ?? "");
  const [details, setDetails] = useState<{ scope?: string; client_id?: string }>();
  const [message, setMessage] = useState("");

  async function inspect(event: FormEvent) {
    event.preventDefault();
    try {
      setDetails(await inspectDeviceCode(code.trim()));
      setMessage("");
    } catch (reason) {
      setMessage((reason as Error).message);
    }
  }

  async function decide(accept: boolean) {
    try {
      await decideDeviceCode(code.trim(), accept);
      setMessage(accept ? "Device approved. You can return to the CLI." : "Device request denied.");
      setDetails(undefined);
    } catch (reason) {
      setMessage((reason as Error).message);
    }
  }

  return (
    <AuthPage>
      <p className="eyebrow">Device authorization</p>
      <h1>Connect the uShelf CLI</h1>
      <form className="auth-form" onSubmit={inspect}>
        <label>
          User code
          <input value={code} onChange={(event) => setCode(event.target.value)} required />
        </label>
        <button type="submit">Continue</button>
      </form>
      {details && (
        <div className="connection-card">
          <p>Client: {details.client_id ?? "uShelf CLI"}</p>
          <p>{details.scope}</p>
          <div className="button-row">
            <button onClick={() => void decide(true)}>Approve</button>
            <button className="secondary" onClick={() => void decide(false)}>
              Deny
            </button>
          </div>
        </div>
      )}
      {message && <p>{message}</p>}
    </AuthPage>
  );
}

function Connections() {
  const [account, setAccount] = useState<{ name: string; email: string }>();
  const [consents, setConsents] = useState<unknown[]>([]);
  const [error, setError] = useState("");
  const refresh = () =>
    Promise.all([getAccount(), listOAuthConsents()]).then(([owner, grants]) => {
      setAccount(owner);
      setConsents(grants);
    });
  useEffect(() => {
    void refresh().catch((reason: Error) => setError(reason.message));
  }, []);

  return (
    <div className="shell connections-page">
      <header className="topbar">
        <Brand />
        <OwnerMenu />
      </header>
      <main>
        <p className="eyebrow">Connections</p>
        <h1>Connect your agents</h1>
        <p>
          Signed in as {account?.name ?? "owner"} {account?.email && `(${account.email})`}.
        </p>
        <section className="connection-card">
          <h2>Remote MCP URL</h2>
          <code>{mcpUrl()}</code>
          <p>
            Use this URL in ChatGPT or Claude Desktop. The client will open uShelf to ask for your
            approval.
          </p>
        </section>
        <section className="connection-card">
          <h2>Codex and Claude Code</h2>
          <pre>
            ushelf connect {window.location.origin}
            {"\n"}ushelf setup codex{"\n"}ushelf setup claude-code
          </pre>
        </section>
        <section>
          <h2>Active grants</h2>
          {consents.length === 0 ? (
            <p className="muted">No active OAuth grants.</p>
          ) : (
            consents.map((value, index) => {
              const grant = value as Record<string, unknown>;
              const id = String(grant.id ?? index);
              return (
                <div className="connection-card" key={id}>
                  <pre>{JSON.stringify(grant, null, 2)}</pre>
                  {Boolean(grant.id) && (
                    <button
                      onClick={() =>
                        void revokeOAuthConsent(String(grant.id))
                          .then(refresh)
                          .catch((reason: Error) => setError(reason.message))
                      }
                    >
                      Revoke
                    </button>
                  )}
                </div>
              );
            })
          )}
        </section>
        {error && <p className="form-error">{error}</p>}
      </main>
    </div>
  );
}

function scopeLabel(scope: string): string {
  return (
    (
      {
        "ushelf:read": "Read your library",
        "ushelf:write": "Add and update items",
        "ushelf:kindle": "Send saved items to Kindle",
        offline_access: "Stay connected until revoked",
      } as Record<string, string>
    )[scope] ?? scope
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
        <OwnerMenu />
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
          <OwnerMenu />
        </header>
        <Empty title="This piece could not be opened" detail={error} />
      </div>
    );
  if (!item) return <div className="loading page-loading">Opening…</div>;
  return (
    <div className="reader-shell">
      <header className="reader-nav">
        <button
          onClick={() => {
            void flush({ keepalive: true });
            navigate(-1);
          }}
          aria-label="Back to library"
        >
          ←
        </button>
        <Brand />
        <Link className="quiet" to="/connections">
          Connections
        </Link>
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

function KindleDelivery({ item }: { item: ShelfItem }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [configured, setConfigured] = useState<boolean>();
  const [devices, setDevices] = useState<KindleDevice[]>([]);
  const [targetSerial, setTargetSerial] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  const show = async () => {
    setOpen(true);
    setLoading(true);
    setConfigured(undefined);
    setDevices([]);
    setTargetSerial("");
    setError("");
    setSuccess("");
    try {
      const status = await getKindleStatus();
      setConfigured(status.configured);
      if (status.error) {
        setError(status.error.message);
        return;
      }
      if (!status.configured) return;
      const available = await listKindleDevices();
      setDevices(available.devices);
      setTargetSerial(
        available.preferredTargetSerial ??
          (available.devices.length === 1 ? available.devices[0]!.serial : ""),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const deliver = async () => {
    if (!targetSerial || sending) return;
    setSending(true);
    setError("");
    try {
      const result = await sendToKindle(item.id, targetSerial);
      setSuccess(`Accepted by Send to Kindle · ${result.sku}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button className="kindle-trigger" type="button" onClick={() => void show()}>
        Send to Kindle
      </button>
      <dialog
        ref={dialogRef}
        className="kindle-dialog"
        aria-labelledby="kindle-dialog-title"
        onClose={() => setOpen(false)}
        onCancel={(event) => {
          if (sending) event.preventDefault();
        }}
      >
        <button
          className="dialog-close"
          type="button"
          aria-label="Close Send to Kindle"
          onClick={() => setOpen(false)}
          disabled={sending}
        >
          ×
        </button>
        <p className="eyebrow">Device delivery</p>
        <h2 id="kindle-dialog-title">Send to Kindle</h2>
        <p className="dialog-copy">
          uShelf will send a reflowable EPUB containing the saved source and its images. It will not
          include insights or remain in your Amazon cloud library.
        </p>
        {loading ? <p role="status">Checking Kindle…</p> : null}
        {!loading && configured === false ? (
          <div className="kindle-setup">
            <p>Kindle is not configured. Run this command, then reopen this dialog:</p>
            <code>ushelf kindle setup</code>
          </div>
        ) : null}
        {!loading && configured && !error && !success ? (
          devices.length ? (
            <>
              <label className="kindle-device">
                <span>Kindle device</span>
                <select
                  value={targetSerial}
                  onChange={(event) => setTargetSerial(event.target.value)}
                  disabled={sending}
                >
                  <option value="">Choose a device</option>
                  {devices.map((device) => (
                    <option key={device.serial} value={device.serial}>
                      {device.name} · {maskKindleSerial(device.serial)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="kindle-submit"
                type="button"
                disabled={!targetSerial || sending}
                onClick={() => void deliver()}
              >
                {sending ? "Sending…" : "Send to this device"}
              </button>
            </>
          ) : (
            <p>No Kindle devices are registered with this Amazon account.</p>
          )
        ) : null}
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="dialog-success" role="status">
            {success}
          </p>
        ) : null}
      </dialog>
    </>
  );
}

function maskKindleSerial(value: string): string {
  return value.length <= 4 ? value : `••••${value.slice(-4)}`;
}

function Markdown({ value, itemId }: { value: string; itemId: string }) {
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
