import { useEffect, useState } from "react";
import {
  type AuthoredResource,
  fetchAuthored,
  fetchResources,
  installResource,
  type LockfileEntry,
  type RegistryIndexEntry,
  type ResourceInstallResponse,
  searchRegistry,
} from "../api";

type Tab = "search" | "uri" | "installed";

/**
 * Generic install/search modal usable for any resource kind (agent, tool,
 * skill, prompt, workflow, kb, bundle). Wraps the registry search,
 * arbitrary-URI install, and installed-list views behind one component so
 * editors don't each rebuild "find a resource" UX.
 *
 * On a successful install, `onInstalled(kind, id)` fires so the caller can
 * refresh its list. The picker stays open so the user can install more.
 */
export function ResourcePicker(props: {
  kind: string;
  onInstalled?: (kind: string, id: string) => void;
  onClose: () => void;
}) {
  const { kind, onInstalled, onClose } = props;
  const [tab, setTab] = useState<Tab>("search");

  return (
    <div className="resource-picker-overlay" onClick={onClose}>
      <div className="resource-picker" onClick={(e) => e.stopPropagation()}>
        <header className="resource-picker-header">
          <h3>Add {kind}</h3>
          <button type="button" className="resource-picker-close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="resource-picker-tabs">
          <TabButton current={tab} value="search" onClick={setTab}>
            Search registry
          </TabButton>
          <TabButton current={tab} value="uri" onClick={setTab}>
            Install from URL
          </TabButton>
          <TabButton current={tab} value="installed" onClick={setTab}>
            Already installed
          </TabButton>
        </div>
        <div className="resource-picker-body">
          {tab === "search" && <SearchTab kind={kind} onInstalled={onInstalled} />}
          {tab === "uri" && <UriTab onInstalled={onInstalled} />}
          {tab === "installed" && <InstalledTab kind={kind} />}
        </div>
      </div>
    </div>
  );
}

function TabButton(props: { current: Tab; value: Tab; onClick: (v: Tab) => void; children: React.ReactNode }) {
  const active = props.current === props.value;
  return (
    <button
      type="button"
      className={`resource-picker-tab${active ? " active" : ""}`}
      onClick={() => props.onClick(props.value)}
    >
      {props.children}
    </button>
  );
}

function SearchTab(props: { kind: string; onInstalled?: (kind: string, id: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RegistryIndexEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doSearch(e?: React.FormEvent) {
    e?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const r = await searchRegistry(query.trim());
      if (r.error) setError(r.error);
      setResults(r.results.filter((x) => x.kind === props.kind));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="rp-search">
      <form className="rp-search-bar" onSubmit={doSearch}>
        <input
          type="search"
          placeholder={`Search the registry for ${props.kind}s…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={searching || !query.trim()}>
          {searching ? "…" : "Search"}
        </button>
      </form>
      {error && <div className="rp-error">{error}</div>}
      {results !== null && results.length === 0 && !searching && (
        <div className="rp-empty">
          No {props.kind}s matched <code>{query}</code>.
        </div>
      )}
      {results && results.length > 0 && (
        <ul className="rp-result-list">
          {results.map((r) => (
            <RegistryRow key={`${r.kind}:${r.id}:${r.version}`} entry={r} onInstalled={props.onInstalled} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RegistryRow(props: { entry: RegistryIndexEntry; onInstalled?: (kind: string, id: string) => void }) {
  const { entry } = props;
  const [state, setState] = useState<"idle" | "installing" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleInstall() {
    setState("installing");
    setMessage(null);
    try {
      const { body } = await installResource(entry.source);
      if (body.ok || body.mode === "needs_approval") {
        setState("done");
        setMessage(installSummary(body));
        props.onInstalled?.(entry.kind, entry.id);
      } else {
        setState("error");
        setMessage(body.error ?? body.reason ?? "Install failed");
      }
    } catch (e) {
      setState("error");
      setMessage((e as Error).message);
    }
  }

  return (
    <li className="rp-result-row">
      <div className="rp-result-main">
        <div className="rp-result-title">
          <span className="rp-result-id">{entry.id}</span>
          <span className="rp-result-version">{entry.version}</span>
        </div>
        {entry.description && <div className="rp-result-desc">{entry.description}</div>}
        {entry.tags && entry.tags.length > 0 && (
          <div className="rp-result-tags">
            {entry.tags.map((t) => (
              <span key={t} className="rp-tag">
                {t}
              </span>
            ))}
          </div>
        )}
        {message && <div className={`rp-result-msg ${state}`}>{message}</div>}
      </div>
      <button
        type="button"
        className="rp-install-btn"
        onClick={handleInstall}
        disabled={state === "installing" || state === "done"}
      >
        {state === "installing" ? "…" : state === "done" ? "Installed" : "Install"}
      </button>
    </li>
  );
}

function UriTab(props: { onInstalled?: (kind: string, id: string) => void }) {
  const [uri, setUri] = useState("");
  const [state, setState] = useState<"idle" | "installing" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleInstall(e: React.FormEvent) {
    e.preventDefault();
    if (!uri.trim()) return;
    setState("installing");
    setMessage(null);
    try {
      const { body } = await installResource(uri.trim());
      if (body.ok || body.mode === "needs_approval") {
        setState("done");
        setMessage(installSummary(body));
        props.onInstalled?.(body.resource.manifest.kind, body.resource.manifest.id);
      } else {
        setState("error");
        setMessage(body.error ?? body.reason ?? "Install failed");
      }
    } catch (err) {
      setState("error");
      setMessage((err as Error).message);
    }
  }

  return (
    <form className="rp-uri" onSubmit={handleInstall}>
      <p className="rp-hint">
        Paste a URL. Supported schemes: <code>file://</code>, <code>https://</code>, <code>git+https://</code>,{" "}
        <code>npm:</code>, <code>tai-registry://</code>.
      </p>
      <div className="rp-uri-bar">
        <input
          type="text"
          placeholder="file:///path/to/resource  or  git+https://…"
          value={uri}
          onChange={(e) => setUri(e.target.value)}
        />
        <button type="submit" disabled={state === "installing" || !uri.trim()}>
          {state === "installing" ? "…" : state === "done" ? "Installed" : "Install"}
        </button>
      </div>
      {message && <div className={`rp-result-msg ${state}`}>{message}</div>}
    </form>
  );
}

function InstalledTab(props: { kind: string }) {
  const [resources, setResources] = useState<LockfileEntry[] | null>(null);
  const [authored, setAuthored] = useState<AuthoredResource[] | null>(null);

  useEffect(() => {
    fetchResources()
      .then((r) => setResources(r.resources.filter((x) => x.kind === props.kind)))
      .catch(() => setResources([]));
    fetchAuthored(props.kind)
      .then((r) => setAuthored(r.resources))
      .catch(() => setAuthored([]));
  }, [props.kind]);

  const loading = resources === null && authored === null;
  if (loading) return <div className="rp-empty">Loading…</div>;
  const total = (resources?.length ?? 0) + (authored?.length ?? 0);
  if (total === 0) {
    return <div className="rp-empty">No {props.kind}s installed yet.</div>;
  }
  return (
    <ul className="rp-result-list">
      {authored?.map((a) => (
        <li key={`auth-${a.id}`} className="rp-result-row">
          <div className="rp-result-main">
            <div className="rp-result-title">
              <span className="rp-result-id">{a.id}</span>
              <span className="rp-result-version rp-result-badge">authored</span>
            </div>
            {a.manifest.description && <div className="rp-result-desc">{a.manifest.description}</div>}
          </div>
        </li>
      ))}
      {resources?.map((r) => (
        <li key={`res-${r.id}-${r.version}`} className="rp-result-row">
          <div className="rp-result-main">
            <div className="rp-result-title">
              <span className="rp-result-id">{r.id}</span>
              <span className="rp-result-version">{r.version}</span>
            </div>
            <div className="rp-result-desc rp-result-uri">{r.uri}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function installSummary(body: ResourceInstallResponse): string {
  if (body.mode === "needs_approval") {
    return `Sent to approval queue: ${body.reason ?? "review pending"}`;
  }
  if (body.mode === "denied") {
    return `Denied: ${body.reason ?? "policy denied"}`;
  }
  return `Installed (${body.mode})`;
}
