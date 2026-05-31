import { useCallback, useEffect, useState } from "react";
import {
  type AutopilotSettings,
  type AutopilotUsage,
  fetchAutopilotSettings,
  fetchAutopilotUsage,
  runAutopilotDigest,
  updateAutopilotSettings,
} from "../api";

function UsageMeter({ label, used, cap }: { label: string; used: number; cap: number | null }) {
  const pct = cap && cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const over = cap && cap > 0 && used >= cap;
  return (
    <div className="field-group" style={{ flex: 1 }}>
      <label className="field-label">
        {label}: {used.toLocaleString()} {cap ? `/ ${cap.toLocaleString()}` : "(no cap)"}
      </label>
      {cap ? (
        <div
          style={{
            height: 6,
            background: "var(--border)",
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: over ? "#d04040" : pct > 80 ? "#d8a128" : "#4ade80",
              transition: "width 0.3s",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function nullableNumber(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

function nullableText(v: string): string | null {
  const t = v.trim();
  return t || null;
}

export function Autopilot() {
  const [settings, setSettings] = useState<AutopilotSettings | null>(null);
  const [usage, setUsage] = useState<AutopilotUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Form state (strings for easier input handling).
  const [cap1h, setCap1h] = useState("");
  const [cap5h, setCap5h] = useState("");
  const [cap24h, setCap24h] = useState("");
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");
  const [disabledStart, setDisabledStart] = useState("");
  const [disabledEnd, setDisabledEnd] = useState("");
  const [digestTime, setDigestTime] = useState("");
  const [paused, setPaused] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await fetchAutopilotSettings();
      setSettings(s);
      setCap1h(s.token_cap_1h?.toString() ?? "");
      setCap5h(s.token_cap_5h?.toString() ?? "");
      setCap24h(s.token_cap_24h?.toString() ?? "");
      setQuietStart(s.quiet_start ?? "");
      setQuietEnd(s.quiet_end ?? "");
      setDisabledStart(s.disabled_start ?? "");
      setDisabledEnd(s.disabled_end ?? "");
      setDigestTime(s.digest_time ?? "");
      setPaused(s.paused);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetchAutopilotUsage()
        .then((u) => {
          if (!cancelled) setUsage(u);
        })
        .catch(() => {
          /* ignore */
        });
    };
    poll();
    const id = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const save = async () => {
    try {
      const updated = await updateAutopilotSettings({
        token_cap_1h: nullableNumber(cap1h),
        token_cap_5h: nullableNumber(cap5h),
        token_cap_24h: nullableNumber(cap24h),
        quiet_start: nullableText(quietStart),
        quiet_end: nullableText(quietEnd),
        disabled_start: nullableText(disabledStart),
        disabled_end: nullableText(disabledEnd),
        digest_time: nullableText(digestTime),
        paused,
      });
      setSettings(updated);
      setSavedAt(Date.now());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const togglePause = async () => {
    const next = !paused;
    setPaused(next);
    try {
      await updateAutopilotSettings({ paused: next });
    } catch (e) {
      setPaused(!next);
      setError((e as Error).message);
    }
  };

  const triggerDigest = async () => {
    try {
      await runAutopilotDigest();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (loading) return <div className="tasks-page">Loading autopilot settings…</div>;

  return (
    <div className="tasks-page">
      <div className="tasks-header">
        <h2>Autopilot</h2>
        <div className="tasks-header-actions">
          <button className={paused ? "tasks-new-btn" : "tasks-delete-btn"} onClick={togglePause}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button className="tasks-edit-btn" onClick={triggerDigest}>
            Run digest now
          </button>
        </div>
      </div>

      {error && (
        <div className="tasks-error">
          {error}
          <button className="tasks-error-dismiss" onClick={() => setError(null)}>
            x
          </button>
        </div>
      )}

      <section style={{ marginBottom: 24 }}>
        <h3>Token budget</h3>
        <p className="field-hint">
          Caps on rolling windows. Blank = no cap. When a cap is hit, autopilot finishes the current LLM round and
          defers in-flight tasks with blocked(budget); they auto-resume when the window rolls.
        </p>
        {usage && (
          <div className="tasks-form-row" style={{ marginBottom: 12 }}>
            <UsageMeter label="1h" used={usage.usage["1h"]} cap={settings?.token_cap_1h ?? null} />
            <UsageMeter label="5h" used={usage.usage["5h"]} cap={settings?.token_cap_5h ?? null} />
            <UsageMeter label="24h" used={usage.usage["24h"]} cap={settings?.token_cap_24h ?? null} />
          </div>
        )}
        {usage?.budget.exceeded && (
          <div className="tasks-error" style={{ marginBottom: 12 }}>
            Budget cap hit on {usage.budget.window} window ({usage.budget.usage}/{usage.budget.cap}). Autopilot is
            deferring new tasks until the window rolls.
          </div>
        )}
        <div className="tasks-form-row">
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">1 hour cap</label>
            <input
              className="field-input"
              type="number"
              min={0}
              value={cap1h}
              onChange={(e) => setCap1h(e.target.value)}
            />
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">5 hour cap</label>
            <input
              className="field-input"
              type="number"
              min={0}
              value={cap5h}
              onChange={(e) => setCap5h(e.target.value)}
            />
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">24 hour cap</label>
            <input
              className="field-input"
              type="number"
              min={0}
              value={cap24h}
              onChange={(e) => setCap24h(e.target.value)}
            />
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3>Quiet hours</h3>
        <p className="field-hint">
          Agent keeps working; notifications (errors, questions) are silenced until the window ends.
        </p>
        <div className="tasks-form-row">
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Start (HH:MM)</label>
            <input
              className="field-input"
              placeholder="22:00"
              value={quietStart}
              onChange={(e) => setQuietStart(e.target.value)}
            />
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">End (HH:MM)</label>
            <input
              className="field-input"
              placeholder="07:00"
              value={quietEnd}
              onChange={(e) => setQuietEnd(e.target.value)}
            />
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3>Disabled hours</h3>
        <p className="field-hint">Agent does no work during this window. Use for sleep/offline periods.</p>
        <div className="tasks-form-row">
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Start (HH:MM)</label>
            <input
              className="field-input"
              placeholder="00:00"
              value={disabledStart}
              onChange={(e) => setDisabledStart(e.target.value)}
            />
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">End (HH:MM)</label>
            <input
              className="field-input"
              placeholder="06:00"
              value={disabledEnd}
              onChange={(e) => setDisabledEnd(e.target.value)}
            />
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3>Morning digest</h3>
        <p className="field-hint">
          Daily summary of overnight activity, delivered via Discord DM when available. Blank = disabled.
        </p>
        <div className="tasks-form-row">
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Time (HH:MM)</label>
            <input
              className="field-input"
              placeholder="08:00"
              value={digestTime}
              onChange={(e) => setDigestTime(e.target.value)}
            />
          </div>
        </div>
      </section>

      <div className="tasks-form-actions">
        {savedAt && (
          <span className="field-hint" style={{ marginRight: "auto" }}>
            Saved {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
        <button className="tasks-submit-btn" onClick={save}>
          Save
        </button>
      </div>

      {settings?.updated_at && (
        <p className="field-hint">Last change: {new Date(`${settings.updated_at}Z`).toLocaleString()}</p>
      )}
    </div>
  );
}
