import { useCallback, useEffect, useRef, useState } from "react";
import {
  archiveStateRecord,
  createStateRecord,
  deleteStateRecord,
  fetchStateHistory,
  fetchStateRecord,
  fetchStateRecords,
  fetchStateTypes,
  replaceStateRecord,
  type StateActor,
  type StateChangeInfo,
  type StateRecordInfo,
  type StateTypeInfo,
  unarchiveStateRecord,
} from "../api";

/**
 * World state: the typed records agents and people share.
 *
 * Browse a type's records, open one for its data and history, and edit,
 * archive or delete it. Archived records are hidden until "Show archived" is
 * on. Changes from anywhere — an agent's tool call, a subscription, a plugin —
 * arrive over `/api/state/events` and refresh what is on screen.
 */
export function State({ type, id }: { type?: string; id?: string }) {
  const [types, setTypes] = useState<StateTypeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<"connecting" | "live" | "lost">("connecting");
  // Bumped by the stream; each panel refetches what it shows when its type or record changed.
  const [lastChange, setLastChange] = useState<StateChangeInfo | null>(null);

  useEffect(() => {
    fetchStateTypes()
      .then((res) => setTypes(res.types))
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/state/events");
    es.addEventListener("ready", () => setLive("live"));
    es.addEventListener("change", (ev) => {
      try {
        setLastChange(JSON.parse((ev as MessageEvent).data) as StateChangeInfo);
      } catch {}
    });
    // EventSource reconnects by itself; this only says so while it does.
    es.onerror = () => setLive("lost");
    return () => es.close();
  }, []);

  const selected = types?.find((t) => t.name === type) ?? (type ? undefined : types?.[0]);

  return (
    <div className="state-page">
      <div className="tools-header">
        <div>
          <h2>State</h2>
          <p className="tools-subtitle">
            Typed records your agents and you share. Changes show up here as they happen.
          </p>
        </div>
        <span className={`state-live state-live-${live}`}>
          {live === "live" ? "Live" : live === "lost" ? "Reconnecting…" : "Connecting…"}
        </span>
      </div>
      {error && <div className="config-error">{error}</div>}
      {types && types.length === 0 && (
        <div className="empty-state">
          No state types yet. Declare one under <code>state.types</code> in config, or install a plugin that adds one.
        </div>
      )}
      {types && types.length > 0 && (
        <div className="state-layout">
          <nav className="state-types" aria-label="State types">
            {types.map((t) => (
              <a
                key={t.name}
                href={`#/state/${encodeURIComponent(t.name)}`}
                className={`state-type${t.name === selected?.name ? " active" : ""}`}
              >
                <span className="state-type-name">{t.name}</span>
                {t.description && <span className="state-type-desc">{t.description}</span>}
              </a>
            ))}
          </nav>
          {selected ? (
            <TypePanel key={selected.name} def={selected} openId={id} lastChange={lastChange} />
          ) : (
            <div className="empty-state">There is no state type called “{type}”.</div>
          )}
        </div>
      )}
    </div>
  );
}

function TypePanel({
  def,
  openId,
  lastChange,
}: {
  def: StateTypeInfo;
  openId?: string;
  lastChange: StateChangeInfo | null;
}) {
  const [records, setRecords] = useState<StateRecordInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // An opened record the list leaves out, read by id: an archived one while archived records are hidden,
  // or `null` once the read says it is gone.
  const [unlisted, setUnlisted] = useState<{ id: string; record: StateRecordInfo | null } | undefined>(undefined);

  const load = useCallback(() => {
    fetchStateRecords(def.name, 200, showArchived ? { includeArchived: true } : {})
      .then((res) => {
        setRecords(res.records);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [def.name, showArchived]);

  useEffect(load, [load]);

  // A change to this type: refetch, and mark the row so the eye finds it.
  useEffect(() => {
    if (!lastChange || lastChange.type !== def.name) return;
    load();
    const changed = lastChange.id;
    setFresh((prev) => new Set(prev).add(changed));
    const timer = setTimeout(
      () =>
        setFresh((prev) => {
          const next = new Set(prev);
          next.delete(changed);
          return next;
        }),
      2000,
    );
    return () => clearTimeout(timer);
  }, [lastChange, def.name, load]);

  const listed = records?.find((r) => r.id === openId);
  // Read again whenever the list is, so an archived record that is open stays current.
  useEffect(() => {
    if (!openId || !records || listed) return;
    let cancelled = false;
    fetchStateRecord(def.name, openId)
      .then((record) => !cancelled && setUnlisted({ id: openId, record }))
      .catch(() => !cancelled && setUnlisted({ id: openId, record: null }));
    return () => {
      cancelled = true;
    };
  }, [def.name, openId, records, listed]);
  const fetched = openId && unlisted?.id === openId ? unlisted.record : undefined;
  const open = listed ?? fetched ?? undefined;
  const archivedCount = records?.filter((r) => r.archivedAt).length ?? 0;

  return (
    <section className="state-main">
      <header className="state-main-header">
        <div>
          <h3>{def.name}</h3>
          <div className="state-meta-line">
            <span className="state-chip">{def.scope ?? "global"} scope</span>
            {!def.canWrite && <span className="state-chip">read only</span>}
            {records && (
              <span>
                {records.length === 200 ? "first 200 records" : `${records.length} records`}
                {showArchived && archivedCount > 0 ? `, ${archivedCount} archived` : ""}
              </span>
            )}
          </div>
        </div>
        <div className="state-actions">
          <label className="state-toggle">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
          {def.canWrite && !creating && (
            <button type="button" className="btn-secondary" onClick={() => setCreating(true)}>
              New record
            </button>
          )}
        </div>
      </header>
      {error && <div className="config-error">{error}</div>}
      {creating && (
        <NewRecord
          def={def}
          onDone={(created) => {
            setCreating(false);
            if (created)
              window.location.hash = `#/state/${encodeURIComponent(def.name)}/${encodeURIComponent(created)}`;
          }}
        />
      )}
      {records && records.length === 0 && !creating && (
        <div className="empty-state">
          {showArchived
            ? `No ${def.name} records yet. Agents create them with the state tool.`
            : `No ${def.name} records to show. Agents create them with the state tool; archived ones are hidden.`}
        </div>
      )}
      {records && records.length > 0 && (
        <div className="state-table-wrap">
          <table className="state-table">
            <thead>
              <tr>
                <th>id</th>
                {def.title && <th>{def.title}</th>}
                <th>scope</th>
                <th className="num">v</th>
                <th>updated</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr
                  key={r.id}
                  className={`${r.id === openId ? "active" : ""}${fresh.has(r.id) ? " fresh" : ""}${r.archivedAt ? " archived" : ""}`}
                  onClick={() => {
                    window.location.hash = `#/state/${encodeURIComponent(def.name)}/${encodeURIComponent(r.id)}`;
                  }}
                >
                  <td>
                    <a
                      href={`#/state/${encodeURIComponent(def.name)}/${encodeURIComponent(r.id)}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {r.id}
                    </a>
                    {r.archivedAt && <span className="state-chip state-chip-archived">archived</span>}
                  </td>
                  {def.title && <td>{typeof r.data[def.title] === "string" ? String(r.data[def.title]) : ""}</td>}
                  <td className="dim">{r.scope}</td>
                  <td className="num">{r.version}</td>
                  <td className="dim" title={r.archiveReason}>
                    {r.archivedAt
                      ? archivedLabel(r, "archived")
                      : `${relativeTime(r.updatedAt)} · ${actorLabel(r.updatedBy)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId && records && !open && fetched === null && (
        <div className="empty-state">
          {def.name}/{openId} no longer exists. Its history is kept; agents can still read it by id.
        </div>
      )}
      {open && <RecordPanel def={def} record={open} lastChange={lastChange} onChanged={load} />}
    </section>
  );
}

function RecordPanel({
  def,
  record,
  lastChange,
  onChanged,
}: {
  def: StateTypeInfo;
  record: StateRecordInfo;
  lastChange: StateChangeInfo | null;
  /** After an archive or a restore, so the list need not wait for the stream. */
  onChanged: () => void;
}) {
  const [history, setHistory] = useState<StateChangeInfo[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editVersion, setEditVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // `record.version` is in the deps on purpose: a newer version means new history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the record moves on
  useEffect(() => {
    fetchStateHistory(def.name, record.id)
      .then((res) => setHistory(res.changes))
      .catch(() => setHistory([]));
  }, [def.name, record.id, record.version]);

  useEffect(() => {
    panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  const changedUnderEdit =
    editing !== null &&
    lastChange?.type === def.name &&
    lastChange.id === record.id &&
    lastChange.version > editVersion;

  async function save() {
    if (editing === null) return;
    let data: unknown;
    try {
      data = JSON.parse(editing);
    } catch {
      setError("That is not valid JSON.");
      return;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      setError("A record's data is an object of field names to values.");
      return;
    }
    setBusy(true);
    try {
      await replaceStateRecord(def.name, record.id, data as Record<string, unknown>, editVersion);
      setEditing(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    const reason = prompt(
      `Archive ${def.name}/${record.id}? It is kept, with its history, but left out of lists and agents' queries. Why? (optional)`,
    );
    if (reason === null) return;
    setBusy(true);
    try {
      await archiveStateRecord(def.name, record.id, reason.trim() || undefined, record.version);
      setError(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    setBusy(true);
    try {
      await unarchiveStateRecord(def.name, record.id, record.version);
      setError(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete ${def.name}/${record.id}? Its history is kept.`)) return;
    setBusy(true);
    try {
      await deleteStateRecord(def.name, record.id);
      window.location.hash = `#/state/${encodeURIComponent(def.name)}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="state-record" ref={panelRef}>
      <header className="state-main-header">
        <div>
          <h3>
            {def.name}/{record.id}
          </h3>
          <div className="state-meta-line">
            <span className="state-chip">{record.scope}</span>
            {record.archivedAt && <span className="state-chip state-chip-archived">archived</span>}
            <span>version {record.version}</span>
            <span>
              updated {relativeTime(record.updatedAt)} by {actorLabel(record.updatedBy)}
              {record.source?.surface ? ` via ${record.source.surface}` : ""}
              {record.source?.tool ? ` via the ${record.source.tool} tool` : ""}
            </span>
          </div>
        </div>
        {def.canWrite && editing === null && (
          <div className="state-actions">
            {record.archivedAt ? (
              // Restored first, then edited: saving an edit would bring it back without saying so.
              <button type="button" className="btn-secondary" disabled={busy} onClick={restore}>
                Restore
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setEditing(JSON.stringify(record.data, null, 2));
                    setEditVersion(record.version);
                    setError(null);
                  }}
                >
                  Edit
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={archive}>
                  Archive
                </button>
              </>
            )}
            <button type="button" className="btn-danger" disabled={busy} onClick={remove}>
              Delete
            </button>
          </div>
        )}
      </header>
      {record.archivedAt && (
        <div className="state-archived-note">
          <span>{archivedLabel(record, "Archived")}</span>
          <span className="dim">Lists and agents' queries leave it out until it is restored.</span>
        </div>
      )}
      {error && <div className="config-error">{error}</div>}
      {editing === null ? (
        <pre className="state-json">{JSON.stringify(record.data, null, 2)}</pre>
      ) : (
        <div className="state-edit">
          {changedUnderEdit && (
            <div className="state-warning">
              Someone changed this record while you were editing. Saving now will be refused; cancel to see the new
              version.
            </div>
          )}
          <textarea
            className="state-json-input"
            value={editing}
            spellCheck={false}
            rows={Math.min(24, Math.max(6, editing.split("\n").length + 1))}
            onChange={(e) => setEditing(e.target.value)}
            aria-label={`${def.name}/${record.id} data as JSON`}
          />
          <div className="state-actions">
            <button type="button" className="btn-secondary" disabled={busy} onClick={save}>
              Save
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <h4 className="state-subhead">History</h4>
      {history === null ? null : history.length === 0 ? (
        <div className="dim">No history.</div>
      ) : (
        <ol className="state-history">
          {history.map((c) => (
            <li key={`${c.version}-${c.at}`}>
              <span className={`state-op state-op-${c.lifecycle ?? c.op}`}>{c.lifecycle ?? c.op}</span>
              <span className="num">v{c.version}</span>
              <span>{actorLabel(c.actor)}</span>
              <span className="dim">{relativeTime(c.at)}</span>
              <span className="dim state-history-fields">{changedFields(c)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function NewRecord({ def, onDone }: { def: StateTypeInfo; onDone: (createdId?: string) => void }) {
  const [id, setId] = useState("");
  const [scope, setScope] = useState("");
  const [data, setData] = useState(() => JSON.stringify(skeleton(def.schema), null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      setError("That is not valid JSON.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setError("A record's data is an object of field names to values.");
      return;
    }
    setBusy(true);
    try {
      const created = await createStateRecord(def.name, {
        ...(id.trim() ? { id: id.trim() } : {}),
        ...(scope.trim() ? { scope: scope.trim() } : {}),
        data: parsed as Record<string, unknown>,
      });
      onDone(created.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="state-record">
      <h3>New {def.name}</h3>
      {error && <div className="config-error">{error}</div>}
      <div className="state-new-fields">
        <label>
          id <span className="dim">(optional; one is made up if blank)</span>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="lisbon-trip" />
        </label>
        <label>
          scope <span className="dim">(optional; default {def.scope ?? "global"})</span>
          <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="global" />
        </label>
      </div>
      <textarea
        className="state-json-input"
        value={data}
        spellCheck={false}
        rows={Math.min(24, Math.max(6, data.split("\n").length + 1))}
        onChange={(e) => setData(e.target.value)}
        aria-label={`New ${def.name} data as JSON`}
      />
      <div className="state-actions">
        <button type="button" className="btn-secondary" disabled={busy} onClick={create}>
          Create
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** An empty value for each property the schema names, so a new record starts from its fields. */
function skeleton(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const props = (schema?.properties ?? {}) as Record<string, { type?: string }>;
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(props)) {
    out[name] = p.type === "number" || p.type === "integer" ? 0 : p.type === "boolean" ? false : "";
  }
  return out;
}

function changedFields(c: StateChangeInfo): string {
  if (c.lifecycle === "archived") return c.archiveReason ?? "";
  if (c.op === "create") return Object.keys(c.after ?? {}).join(", ");
  if (c.op === "delete") return "";
  const before = c.before ?? {};
  const after = c.after ?? {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  return changed.length ? `changed ${changed.join(", ")}` : "";
}

/** When an archived record was archived, by whom and why: "archived 2h ago by you: trip is over". */
function archivedLabel(r: StateRecordInfo, word: string): string {
  const by = r.archivedBy ? ` by ${actorLabel(r.archivedBy)}` : "";
  return `${word} ${relativeTime(r.archivedAt ?? r.updatedAt)}${by}${r.archiveReason ? `: ${r.archiveReason}` : ""}`;
}

function actorLabel(a: StateActor): string {
  return a.kind === "agent"
    ? a.name
    : a.kind === "user"
      ? a.name === "owner"
        ? "you"
        : a.name
      : `${a.kind} ${a.name}`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
