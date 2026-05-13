import { useEffect, useState } from "react";
import {
  fetchResources,
  fetchResourceDetail,
  fetchTrust,
  fetchPendingApprovals,
  fetchAuthored,
  saveAuthored,
  deleteAuthored,
  installResource,
  resolveApproval,
  uninstallResource,
  searchRegistry,
  trustPublisher,
  revokePublisher,
  type AuthoredResource,
  type LockfileEntry,
  type PendingApprovalRequest,
  type RegistryIndexEntry,
  type ResourceDetail,
  type TrustedPublisher,
} from "../api";

type Tab = "installed" | "browse" | "trust" | "author";

export function Resources() {
  const [tab, setTab] = useState<Tab>("installed");
  return (
    <div className="resources-page">
      <div className="resources-header">
        <h2>Resources</h2>
        <p className="resources-blurb">
          Manage installed plugins/resources, browse the federated registry, and curate trusted publishers.
        </p>
      </div>
      <div className="tabs">
        <button type="button" className={`tab${tab === "installed" ? " active" : ""}`} onClick={() => setTab("installed")}>
          Installed
        </button>
        <button type="button" className={`tab${tab === "browse" ? " active" : ""}`} onClick={() => setTab("browse")}>
          Browse
        </button>
        <button type="button" className={`tab${tab === "trust" ? " active" : ""}`} onClick={() => setTab("trust")}>
          Trust
        </button>
        <button type="button" className={`tab${tab === "author" ? " active" : ""}`} onClick={() => setTab("author")}>
          Author
        </button>
      </div>
      {tab === "installed" && <InstalledTab />}
      {tab === "browse" && <BrowseTab />}
      {tab === "trust" && <TrustTab />}
      {tab === "author" && <AuthorTab />}
    </div>
  );
}

function InstalledTab() {
  const [entries, setEntries] = useState<LockfileEntry[]>([]);
  const [lockfilePath, setLockfilePath] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ResourceDetail>>({});
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchResources()
      .then((r) => {
        if (cancelled) return;
        setEntries(r.resources);
        setLockfilePath(r.lockfilePath);
        setError(null);
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  function toggle(entry: LockfileEntry) {
    const key = `${entry.kind}:${entry.id}`;
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (!details[key]) {
      fetchResourceDetail(entry.kind, entry.id)
        .then((d) => setDetails((prev) => ({ ...prev, [key]: d })))
        .catch((e) => setError((e as Error).message));
    }
  }

  async function handleUninstall(entry: LockfileEntry) {
    if (!confirm(`Uninstall ${entry.kind}/${entry.id}@${entry.version}? This removes the lockfile entry and revokes the trust record.`)) {
      return;
    }
    try {
      await uninstallResource(entry.kind, entry.id);
      setReloadTick((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="resources-section">
      {error && <div className="config-error">{error}</div>}
      {lockfilePath && (
        <div className="resources-meta-line">
          Lockfile: <code>{lockfilePath}</code>
        </div>
      )}
      {entries.length === 0 ? (
        <div className="empty-state">
          No resources installed. Switch to <strong>Browse</strong> to find some, or install one by URI from the CLI.
        </div>
      ) : (
        <table className="resources-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>ID</th>
              <th>Version</th>
              <th>Origin</th>
              <th>Installed</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const key = `${e.kind}:${e.id}`;
              const isOpen = expanded === key;
              return (
                <>
                  <tr key={key} className={isOpen ? "row-open" : ""}>
                    <td><span className="kind-chip">{e.kind}</span></td>
                    <td><code>{e.id}</code></td>
                    <td>{e.version}</td>
                    <td className="truncate" title={e.uri}>{e.uri}</td>
                    <td>{new Date(e.installedAt).toLocaleDateString()}</td>
                    <td className="row-actions">
                      <button type="button" className="btn-ghost" onClick={() => toggle(e)}>
                        {isOpen ? "Hide" : "Details"}
                      </button>
                      <button type="button" className="btn-danger" onClick={() => handleUninstall(e)}>
                        Uninstall
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${key}-detail`}>
                      <td colSpan={6} className="detail-cell">
                        <DetailPanel detail={details[key]} entry={e} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DetailPanel({ detail, entry }: { detail?: ResourceDetail; entry: LockfileEntry }) {
  if (!detail) return <div className="empty-state">Loading…</div>;
  return (
    <div className="resource-detail">
      <dl>
        <dt>Manifest hash</dt>
        <dd><code>{entry.manifestHash}</code></dd>
        <dt>Installed at</dt>
        <dd>{new Date(entry.installedAt).toLocaleString()}</dd>
        <dt>Trust status</dt>
        <dd>
          {detail.trusted ? (
            <>
              <span className="status-pill ok">Trusted</span>
              <span className="muted"> — recorded {new Date(detail.trusted.trustedAt).toLocaleString()}</span>
            </>
          ) : (
            <span className="status-pill warn">No trust record (hash drift?)</span>
          )}
        </dd>
        {detail.trusted && Object.keys(detail.trusted.grantedPermissions).length > 0 && (
          <>
            <dt>Permissions</dt>
            <dd><PermissionsList perms={detail.trusted.grantedPermissions as Record<string, string[] | undefined>} /></dd>
          </>
        )}
      </dl>
    </div>
  );
}

function PermissionsList({ perms }: { perms: Record<string, string[] | undefined> | undefined }) {
  const rows: Array<[string, string[]]> = [];
  const safe = (perms ?? {}) as Record<string, string[] | undefined>;
  for (const k of ["network", "filesystem", "tools", "env"]) {
    const v = safe[k];
    if (v && v.length > 0) rows.push([k, v]);
  }
  if (rows.length === 0) return <span className="muted">(none)</span>;
  return (
    <ul className="perm-list">
      {rows.map(([k, v]) => (
        <li key={k}>
          <strong>{k}:</strong> {v.join(", ")}
        </li>
      ))}
    </ul>
  );
}

function BrowseTab() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RegistryIndexEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [installState, setInstallState] = useState<Record<string, string>>({});
  // The set of URIs currently waiting on the approvals queue. The
  // ApprovalQueueWatcher polls /api/approvals, finds matching resource_install
  // requests, and renders modals from them.
  const [pendingByUri, setPendingByUri] = useState<Set<string>>(new Set());

  async function handleSearch(e?: React.FormEvent) {
    e?.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await searchRegistry(query.trim());
      setResults(res.results);
      if (res.error) setError(res.error);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleInstall(uri: string) {
    setInstallState((s) => ({ ...s, [uri]: "installing" }));
    setPendingByUri((s) => new Set(s).add(uri));
    try {
      const { status, body } = await installResource(uri, { useApprovalQueue: true });
      if (status === 200 && body.ok) {
        setInstallState((s) => ({ ...s, [uri]: `installed (${body.mode})` }));
        return;
      }
      if (status === 403 && body.mode === "denied") {
        setInstallState((s) => ({ ...s, [uri]: `denied: ${body.reason ?? "user denied"}` }));
        return;
      }
      setInstallState((s) => ({ ...s, [uri]: `error: ${body.error ?? body.reason ?? "unknown"}` }));
    } catch (err) {
      setInstallState((s) => ({ ...s, [uri]: `error: ${(err as Error).message}` }));
    } finally {
      setPendingByUri((s) => {
        const next = new Set(s);
        next.delete(uri);
        return next;
      });
    }
  }

  function installByUri(uri: string) {
    return handleInstall(uri);
  }

  return (
    <div className="resources-section">
      <form className="resources-search-row" onSubmit={handleSearch}>
        <input
          type="text"
          className="field-input"
          placeholder="Search the registry (e.g. 'scraper', 'review')…"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
        />
        <button type="submit" className="btn-primary" disabled={loading || !query.trim()}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      <DirectInstallRow onInstall={installByUri} state={installState} />

      {error && <div className="config-error">{error}</div>}

      {results.length === 0 && !loading && query.trim() && !error && (
        <div className="empty-state">No results.</div>
      )}

      {results.length > 0 && (
        <table className="resources-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>ID</th>
              <th>Version</th>
              <th>Description</th>
              <th>Tags</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const installUri = `tai-registry:${r.id}`;
              return (
                <tr key={`${r.kind}:${r.id}`}>
                  <td><span className="kind-chip">{r.kind}</span></td>
                  <td><code>{r.id}</code></td>
                  <td>{r.version}</td>
                  <td>{r.description ?? ""}</td>
                  <td>{r.tags?.join(", ") ?? ""}</td>
                  <td className="row-actions">
                    <button type="button" className="btn-primary" onClick={() => handleInstall(installUri)}>
                      Install
                    </button>
                    {installState[installUri] && <span className="muted">{installState[installUri]}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {pendingByUri.size > 0 && <ApprovalQueueWatcher />}
    </div>
  );
}

/**
 * Polls /api/approvals while an install is in flight. When a `resource_install`
 * request appears, renders an approval modal that posts back to
 * /api/approvals/:id. This is the same queue tool approvals flow through, so
 * the same UX covers installs initiated from anywhere (CLI, agent tool, the
 * Resources page itself).
 */
function ApprovalQueueWatcher() {
  const [requests, setRequests] = useState<PendingApprovalRequest[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function tick() {
      fetchPendingApprovals()
        .then((all) => {
          if (cancelled) return;
          setRequests(all.filter((r) => r.toolName === "resource_install"));
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) timer = setTimeout(tick, 1000);
        });
    }
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  async function decide(req: PendingApprovalRequest, approved: boolean) {
    setResolving(req.requestId);
    try {
      await resolveApproval(req.requestId, approved);
      setRequests((rs) => rs.filter((r) => r.requestId !== req.requestId));
    } finally {
      setResolving(null);
    }
  }

  if (requests.length === 0) return null;
  // Show the oldest pending request first.
  const req = requests[0];
  const args = (req.toolArgs ?? {}) as {
    kind?: string;
    id?: string;
    version?: string;
    origin?: string;
    permissions?: Record<string, string[] | undefined>;
    reason?: string;
  };
  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Approve install</h3>
        </div>
        <div className="modal-body">
          <dl>
            <dt>Resource</dt>
            <dd>
              <code>
                {args.kind}/{args.id}@{args.version}
              </code>
            </dd>
            {args.origin && (
              <>
                <dt>Origin</dt>
                <dd><code>{args.origin}</code></dd>
              </>
            )}
            <dt>Permissions</dt>
            <dd><PermissionsList perms={args.permissions} /></dd>
          </dl>
          {req.description && <pre className="modal-description">{req.description}</pre>}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn-ghost"
            disabled={resolving === req.requestId}
            onClick={() => decide(req, false)}
          >
            Deny
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={resolving === req.requestId}
            onClick={() => decide(req, true)}
          >
            Approve & install
          </button>
        </div>
      </div>
    </div>
  );
}

function DirectInstallRow({
  onInstall,
  state,
}: {
  onInstall: (uri: string) => Promise<void>;
  state: Record<string, string>;
}) {
  const [uri, setUri] = useState("");
  return (
    <div className="resources-direct-install">
      <label className="field-label">Install by URI</label>
      <div className="resources-search-row">
        <input
          type="text"
          className="field-input"
          placeholder="file:///path or https://… or git+https://… or tai-registry:org/name"
          value={uri}
          onChange={(e) => setUri(e.target.value)}
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={!uri.trim()}
          onClick={() => uri.trim() && onInstall(uri.trim())}
        >
          Install
        </button>
        {state[uri] && <span className="muted">{state[uri]}</span>}
      </div>
    </div>
  );
}

function TrustTab() {
  const [publishers, setPublishers] = useState<TrustedPublisher[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [newKey, setNewKey] = useState("");
  const [newPublisher, setNewPublisher] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchTrust()
      .then((r) => {
        if (cancelled) return;
        setPublishers(r.publishers);
        setError(null);
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newKey.trim() || !newPublisher.trim()) return;
    try {
      await trustPublisher(newKey.trim(), newPublisher.trim());
      setNewKey("");
      setNewPublisher("");
      setReloadTick((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRevoke(key: string) {
    if (!confirm(`Revoke trust for ${key}? Future installs signed by this key will require manual approval.`)) {
      return;
    }
    try {
      await revokePublisher(key);
      setReloadTick((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="resources-section">
      <div className="resources-meta-line">
        Resources signed by a trusted publisher install without an approval prompt. Per-resource approvals are stored
        separately and shown on the <strong>Installed</strong> tab.
      </div>
      {error && <div className="config-error">{error}</div>}
      <form className="trust-add-form" onSubmit={handleAdd}>
        <div className="field-group">
          <label className="field-label">Publisher name</label>
          <input
            type="text"
            className="field-input"
            placeholder="Acme Inc."
            value={newPublisher}
            onChange={(e) => setNewPublisher(e.target.value)}
          />
        </div>
        <div className="field-group">
          <label className="field-label">Public key</label>
          <input
            type="text"
            className="field-input"
            placeholder="ed25519:…"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary" disabled={!newKey.trim() || !newPublisher.trim()}>
          Trust publisher
        </button>
      </form>

      {publishers.length === 0 ? (
        <div className="empty-state">No trusted publishers yet.</div>
      ) : (
        <table className="resources-table">
          <thead>
            <tr>
              <th>Publisher</th>
              <th>Public key</th>
              <th>Trusted at</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {publishers.map((p) => (
              <tr key={p.publicKey}>
                <td>{p.publisher}</td>
                <td><code className="truncate" title={p.publicKey}>{p.publicKey}</code></td>
                <td>{new Date(p.trustedAt).toLocaleString()}</td>
                <td className="row-actions">
                  <button type="button" className="btn-danger" onClick={() => handleRevoke(p.publicKey)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AuthorTab() {
  const [kind, setKind] = useState<"skill" | "prompt">("skill");
  const [items, setItems] = useState<AuthoredResource[]>([]);
  const [editing, setEditing] = useState<AuthoredResource | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchAuthored(kind)
      .then((r) => {
        if (cancelled) return;
        setItems(r.resources);
        setError(null);
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [kind, reloadTick]);

  async function handleDelete(item: AuthoredResource) {
    if (!confirm(`Delete ${item.kind}/${item.id}? The manifest file will be removed and the resource unregistered.`)) {
      return;
    }
    try {
      await deleteAuthored(item.kind, item.id);
      setReloadTick((n) => n + 1);
      if (editing?.id === item.id) setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function startNew() {
    setEditing({
      kind,
      id: "",
      manifest: { kind, id: "", version: "0.0.0", description: "", data: kind === "skill" ? { instructions: "", toolRefs: [] } : { text: "" } },
    });
    setCreating(true);
  }

  return (
    <div className="resources-section">
      <div className="resources-meta-line">
        Author local resources stored under <code>data/authored-resources/&lt;kind&gt;/&lt;id&gt;/</code>{" "}
        — skills land in <code>SKILL.md</code> (agentskills.io standard), prompts in{" "}
        <code>manifest.yaml</code>. Changes register live; the same files survive restart.
      </div>
      <div className="resources-search-row">
        <label className="field-label">Kind</label>
        <select
          className="field-select"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as "skill" | "prompt");
            setEditing(null);
            setCreating(false);
          }}
        >
          <option value="skill">Skill</option>
          <option value="prompt">Prompt</option>
        </select>
        <button type="button" className="btn-primary" onClick={startNew}>
          + New {kind}
        </button>
      </div>

      {error && <div className="config-error">{error}</div>}

      {editing ? (
        <AuthorEditor
          item={editing}
          isCreate={creating}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            setReloadTick((n) => n + 1);
          }}
          onError={setError}
        />
      ) : items.length === 0 ? (
        <div className="empty-state">No {kind}s authored yet. Click "New {kind}" to create one.</div>
      ) : (
        <table className="resources-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Version</th>
              <th>Description</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={`${r.kind}:${r.id}`}>
                <td><code>{r.id}</code></td>
                <td>{r.manifest.version}</td>
                <td>{r.manifest.description ?? ""}</td>
                <td className="row-actions">
                  <button type="button" className="btn-ghost" onClick={() => { setEditing(r); setCreating(false); }}>
                    Edit
                  </button>
                  <button type="button" className="btn-danger" onClick={() => handleDelete(r)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AuthorEditor({
  item,
  isCreate,
  onCancel,
  onSaved,
  onError,
}: {
  item: AuthoredResource;
  isCreate: boolean;
  onCancel: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [id, setId] = useState(item.id);
  const [version, setVersion] = useState(item.manifest.version);
  const [description, setDescription] = useState(item.manifest.description ?? "");
  const data = (item.manifest.data ?? {}) as Record<string, unknown>;
  const [text, setText] = useState((data.text as string) ?? "");
  const [instructions, setInstructions] = useState((data.instructions as string) ?? "");
  const [toolRefs, setToolRefs] = useState(((data.toolRefs as string[]) ?? []).join(", "));
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!id.trim()) {
      onError("id is required");
      return;
    }
    if (item.kind === "skill") {
      if (!description.trim()) {
        onError("description is required for SKILL.md");
        return;
      }
      if (!/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/.test(id.trim())) {
        onError("skill id must be lowercase letters, digits, hyphens (one optional `org/` prefix)");
        return;
      }
    }
    setSaving(true);
    try {
      if (item.kind === "skill") {
        await saveAuthored(item.kind, {
          id: id.trim(),
          version: version.trim() || "0.0.0",
          description: description.trim(),
          instructions,
          allowedTools: toolRefs.split(",").map((s) => s.trim()).filter(Boolean),
        });
      } else {
        await saveAuthored(item.kind, {
          id: id.trim(),
          version: version.trim() || "0.0.0",
          description: description.trim() || undefined,
          data: { text },
        });
      }
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="resource-editor">
      <h3>{isCreate ? `New ${item.kind}` : `Edit ${item.kind}/${item.id}`}</h3>
      <div className="field-group">
        <label className="field-label">ID</label>
        <input
          type="text"
          className="field-input"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="acme/widget"
          disabled={!isCreate}
        />
      </div>
      <div className="field-group">
        <label className="field-label">Version</label>
        <input
          type="text"
          className="field-input"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          placeholder="0.0.0"
        />
      </div>
      <div className="field-group">
        <label className="field-label">Description</label>
        <input
          type="text"
          className="field-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {item.kind === "skill" ? (
        <>
          <div className="field-group">
            <label className="field-label">Instructions (SKILL.md body)</label>
            <textarea
              className="field-textarea"
              rows={10}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Markdown body — the actual skill content. Loaded only when the agent activates this skill."
            />
          </div>
          <div className="field-group">
            <label className="field-label">Allowed tools (comma-separated)</label>
            <input
              type="text"
              className="field-input"
              value={toolRefs}
              onChange={(e) => setToolRefs(e.target.value)}
              placeholder="read, write, exec"
            />
            <div className="field-hint">
              Maps to <code>allowed-tools</code> in the SKILL.md frontmatter. Leave empty to inherit
              the agent's tool set.
            </div>
          </div>
        </>
      ) : (
        <div className="field-group">
          <label className="field-label">Prompt text</label>
          <textarea
            className="field-textarea"
            rows={10}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Prompt template — supports {{var}} and {{include:path}} expansion."
          />
        </div>
      )}
      <div className="modal-footer">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
