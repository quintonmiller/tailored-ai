import { useState } from "react";
import type {
  StepContract,
  WorkflowStepDef,
  WorkflowStepType,
  WorkflowTriggerDef,
} from "../api";
import {
  GLOBAL_VARIABLES,
  ON_ERROR_LABELS,
  STEP_HELP,
  FALLBACK_STEP_HELP,
  STEP_TYPE_LABELS,
  TRIGGER_KIND_LABELS,
  defaultAgentName,
  triggerInputVariables,
  useWorkflowMetadata,
  type TemplateVariable,
  type WorkflowMetadata,
} from "../workflow-metadata";

const STEP_TYPES: WorkflowStepType[] = [
  "agent_run",
  "tool_call",
  "shell",
  "condition",
  "loop",
  "parallel",
  "discord_message",
  "trigger_workflow",
];

const ON_ERROR: Array<"fail" | "continue" | "retry"> = ["fail", "continue", "retry"];

/**
 * Output format options surfaced under each step's "Output" block. "auto"
 * (undefined contract) means we don't assert anything about the shape and
 * downstream steps won't be blocked from connecting — that's the right default
 * for most agent runs. The other kinds drive the UI's connection-validation
 * check between this step and its successors.
 */
const OUTPUT_FORMAT_OPTIONS: Array<{ id: StepContract["kind"] | "auto"; label: string }> = [
  { id: "auto", label: "Auto (no constraint)" },
  { id: "raw_text", label: "Raw text" },
  { id: "number", label: "Number" },
  { id: "choice", label: "One of a fixed set of choices" },
  { id: "json_schema", label: "JSON (matches schema)" },
];

function OutputFormatEditor({
  value,
  onChange,
}: {
  value: StepContract | undefined;
  onChange: (c: StepContract | undefined) => void;
}) {
  const kind = value?.kind ?? "auto";
  return (
    <div className="wf-output-format">
      <label className="wf-output-format-label">
        Format:
        <select
          className="field-select"
          value={kind}
          onChange={(e) => {
            const k = e.target.value as StepContract["kind"] | "auto";
            if (k === "auto") onChange(undefined);
            else if (k === "raw_text") onChange({ kind: "raw_text" });
            else if (k === "number") onChange({ kind: "number" });
            else if (k === "choice") onChange({ kind: "choice", choices: [] });
            else if (k === "json_schema") onChange({ kind: "json_schema", schema: {} });
          }}
        >
          {OUTPUT_FORMAT_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>
      </label>
      {value?.kind === "choice" && (
        <input
          className="field-input"
          value={value.choices.join(", ")}
          onChange={(e) =>
            onChange({
              kind: "choice",
              choices: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder="comma-separated choices, e.g. approve, reject, escalate"
        />
      )}
      {value?.kind === "json_schema" && (
        <textarea
          className="field-textarea"
          rows={4}
          value={JSON.stringify(value.schema, null, 2)}
          onChange={(e) => {
            try {
              onChange({ kind: "json_schema", schema: JSON.parse(e.target.value || "{}") });
            } catch {
              // Mid-edit invalid JSON — keep typing.
            }
          }}
          placeholder='{"type":"object","properties":{...}}'
        />
      )}
    </div>
  );
}

interface Props {
  step: WorkflowStepDef;
  onChange: (next: WorkflowStepDef) => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  depth?: number;
  /**
   * Workflow-level context used to populate the variable-reference panel.
   * Optional so nested step lists (loop body, parallel branches) can omit it
   * — the panel will then only show globals.
   */
  trigger?: WorkflowTriggerDef;
  /** All other steps in the workflow, used to surface ${steps.X} options. */
  siblingSteps?: WorkflowStepDef[];
}

export function WorkflowStepEditor({
  step,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  depth = 0,
  trigger,
  siblingSteps,
}: Props) {
  const meta = useWorkflowMetadata();

  function update<K extends keyof WorkflowStepDef>(key: K, value: WorkflowStepDef[K]) {
    onChange({ ...step, [key]: value });
  }

  const help = STEP_HELP[step.type] ?? FALLBACK_STEP_HELP;

  return (
    <div className="workflow-step" style={{ marginLeft: depth * 16 }}>
      <div className="workflow-step-header">
        <label className="field-label">Step name</label>
        <input
          className="field-input workflow-step-name"
          value={step.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder="step name"
        />
        <label className="field-label">Type</label>
        <select
          className="field-select"
          value={step.type}
          onChange={(e) => onChange(changeStepType(step, e.target.value as WorkflowStepType, meta))}
        >
          {STEP_TYPES.map((t) => (
            <option key={t} value={t}>{STEP_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <div className="workflow-step-actions">
          {onMoveUp && (
            <button type="button" className="btn-ghost" onClick={onMoveUp} title="Move up">↑</button>
          )}
          {onMoveDown && (
            <button type="button" className="btn-ghost" onClick={onMoveDown} title="Move down">↓</button>
          )}
          <button type="button" className="btn-danger-ghost" onClick={onRemove} title="Remove step">×</button>
        </div>
      </div>

      <div className="wf-help-block">
        <div className="wf-help-summary">{help.summary}</div>
        <div className="wf-help-io">
          <div className="wf-help-io-section">
            <div className="wf-help-io-label">Input</div>
            <div className="wf-help-io-text">{help.input}</div>
          </div>
          <div className="wf-help-io-section">
            <div className="wf-help-io-label">Output</div>
            <div className="wf-help-io-text">{help.output}</div>
            <OutputFormatEditor
              value={step.outputContract}
              onChange={(c) => onChange({ ...step, outputContract: c })}
            />
          </div>
        </div>
      </div>

      <div className="workflow-step-body">
        {renderTypeFields(step, update, onChange, depth, meta)}

        {stepHasTemplates(step.type) && (
          <VariableReference
            trigger={trigger}
            siblingSteps={(siblingSteps ?? []).filter((s) => s.name !== step.name)}
          />
        )}

        <details className="workflow-step-advanced">
          <summary>Advanced</summary>
          <div className="field-group">
            <label className="field-label">On error</label>
            <select
              className="field-select"
              value={step.onError ?? "fail"}
              onChange={(e) => update("onError", e.target.value as "fail" | "continue" | "retry")}
            >
              {ON_ERROR.map((v) => (
                <option key={v} value={v}>{ON_ERROR_LABELS[v]}</option>
              ))}
            </select>
          </div>
          <div className="field-group">
            <label className="field-label">Deadline (milliseconds)</label>
            <input
              className="field-input"
              type="number"
              value={step.deadlineMs ?? ""}
              onChange={(e) =>
                update("deadlineMs", e.target.value ? Number(e.target.value) : undefined)
              }
              placeholder="(no limit)"
            />
          </div>
          {step.onError === "retry" && (
            <div className="field-group">
              <label className="field-label">Max retry attempts</label>
              <input
                className="field-input"
                type="number"
                min={1}
                value={step.retry?.maxAttempts ?? 1}
                onChange={(e) =>
                  update("retry", {
                    maxAttempts: Number(e.target.value) || 1,
                    backoffMs: step.retry?.backoffMs,
                  })
                }
              />
              <label className="field-label">Backoff between retries (ms)</label>
              <input
                className="field-input"
                type="number"
                min={0}
                value={step.retry?.backoffMs ?? ""}
                onChange={(e) =>
                  update("retry", {
                    maxAttempts: step.retry?.maxAttempts ?? 1,
                    backoffMs: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                placeholder="(default)"
              />
            </div>
          )}
        </details>
      </div>
    </div>
  );
}

/**
 * Renders a dropdown of known names with a free-text fallback for unknown
 * values. Used for agent / tool / workflow pickers — the source of truth is
 * still a string, so a stale or hand-edited name still survives a round trip.
 */
function NamePicker({
  value,
  options,
  onChange,
  placeholder,
  emptyHint,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder: string;
  emptyHint?: string;
}) {
  const isKnown = value === "" || options.includes(value);
  return (
    <>
      <div className="wf-name-picker">
        <select
          className="field-select"
          value={isKnown ? value : "__custom__"}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__custom__") onChange(value || "");
            else onChange(v);
          }}
        >
          <option value="">— select —</option>
          {options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
        {!isKnown && (
          <input
            className="field-input"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
          />
        )}
      </div>
      {options.length === 0 && emptyHint && (
        <div className="wf-field-hint">{emptyHint}</div>
      )}
    </>
  );
}

function renderTypeFields(
  step: WorkflowStepDef,
  update: <K extends keyof WorkflowStepDef>(key: K, value: WorkflowStepDef[K]) => void,
  onChange: (next: WorkflowStepDef) => void,
  depth: number,
  meta: WorkflowMetadata,
) {
  switch (step.type) {
    case "agent_run":
      return (
        <>
          <div className="field-group">
            <label className="field-label">Agent</label>
            <NamePicker
              value={step.agent ?? ""}
              options={meta.agents}
              onChange={(v) => update("agent", v)}
              placeholder="agent name"
              emptyHint="No agents configured yet. Add some under Agents to populate this list."
            />
          </div>
          <div className="field-group">
            <label className="field-label">Prompt</label>
            <textarea
              className="field-textarea"
              rows={3}
              value={step.prompt ?? ""}
              onChange={(e) => update("prompt", e.target.value)}
              placeholder="What should the agent do? Use ${input.x} or ${steps.x} to thread data through."
            />
          </div>
          <div className="field-group">
            <label className="field-label">Max tool rounds (optional)</label>
            <input
              className="field-input"
              type="number"
              value={step.maxToolRounds ?? ""}
              onChange={(e) =>
                update("maxToolRounds", e.target.value ? Number(e.target.value) : undefined)
              }
              placeholder="(use agent default)"
            />
          </div>
        </>
      );
    case "tool_call":
      return (
        <>
          <div className="field-group">
            <label className="field-label">Tool</label>
            <NamePicker
              value={step.tool ?? ""}
              options={meta.tools}
              onChange={(v) => update("tool", v)}
              placeholder="tool name"
              emptyHint="No tools loaded yet."
            />
          </div>
          <div className="field-group">
            <label className="field-label">Arguments (JSON)</label>
            <textarea
              className="field-textarea"
              rows={4}
              value={step.args ? JSON.stringify(step.args, null, 2) : ""}
              onChange={(e) => {
                const text = e.target.value;
                try {
                  update("args", text.trim() ? JSON.parse(text) : undefined);
                } catch {
                  // Keep typing — invalid JSON is allowed mid-edit; we'll catch it on save.
                }
              }}
              placeholder='{"key": "value"}'
            />
          </div>
        </>
      );
    case "shell":
      return (
        <>
          <div className="field-group">
            <label className="field-label">Command</label>
            <textarea
              className="field-textarea"
              rows={3}
              value={step.command ?? ""}
              onChange={(e) => update("command", e.target.value)}
              placeholder="echo hello"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Working directory (optional)</label>
            <input
              className="field-input"
              value={step.cwd ?? ""}
              onChange={(e) => update("cwd", e.target.value || undefined)}
              placeholder="(workflow's cwd)"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Timeout (milliseconds, optional)</label>
            <input
              className="field-input"
              type="number"
              value={step.timeoutMs ?? ""}
              onChange={(e) =>
                update("timeoutMs", e.target.value ? Number(e.target.value) : undefined)
              }
              placeholder="(no timeout)"
            />
          </div>
        </>
      );
    case "condition":
      return (
        <>
          <div className="field-group">
            <label className="field-label">If (expression)</label>
            <input
              className="field-input"
              value={step.if ?? ""}
              onChange={(e) => update("if", e.target.value)}
              placeholder='steps.classify === "approve"'
            />
            <div className="wf-field-hint">
              Connect downstream steps to the green (true) or red (false) handle on the canvas — no need to fill these
              in by hand.
            </div>
          </div>
        </>
      );
    case "loop":
      return (
        <>
          <div className="field-group">
            <label className="field-label">Iterate over (expression)</label>
            <input
              className="field-input"
              value={step.over ?? ""}
              onChange={(e) => update("over", e.target.value)}
              placeholder="steps.fetch.items"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Each item is called</label>
            <input
              className="field-input"
              value={step.as ?? ""}
              onChange={(e) => update("as", e.target.value)}
              placeholder="item"
            />
          </div>
          <div className="field-group">
            <label className="field-row">
              <input
                type="checkbox"
                checked={step.parallel === true}
                onChange={(e) => update("parallel", e.target.checked)}
              />
              <span className="field-inline-label">Run iterations in parallel</span>
            </label>
            {step.parallel && (
              <>
                <label className="field-label">Max concurrent iterations</label>
                <input
                  className="field-input"
                  type="number"
                  value={step.maxConcurrency ?? ""}
                  onChange={(e) =>
                    update("maxConcurrency", e.target.value ? Number(e.target.value) : undefined)
                  }
                  placeholder="(unlimited)"
                />
              </>
            )}
          </div>
          <NestedStepList
            label="Body (runs per iteration)"
            steps={(step.body as WorkflowStepDef[] | undefined) ?? []}
            depth={depth + 1}
            onChange={(next) => update("body", next)}
          />
        </>
      );
    case "parallel":
      return (
        <NestedStepList
          label="Parallel branches"
          steps={step.steps ?? []}
          depth={depth + 1}
          onChange={(next) => update("steps", next)}
        />
      );
    case "discord_message":
      return (
        <>
          <div className="field-group">
            <label className="field-label">Message</label>
            <textarea
              className="field-textarea"
              rows={3}
              value={step.message ?? ""}
              onChange={(e) => update("message", e.target.value)}
              placeholder="Hello ${input.who}"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Send to</label>
            <select
              className="field-select"
              value={step.channelId ? "channel" : step.userId ? "user" : "owner"}
              onChange={(e) => {
                const mode = e.target.value;
                if (mode === "owner") onChange({ ...step, channelId: undefined, userId: undefined });
                else if (mode === "channel") onChange({ ...step, userId: undefined, channelId: step.channelId ?? "" });
                else onChange({ ...step, channelId: undefined, userId: step.userId ?? "" });
              }}
            >
              <option value="owner">Configured Discord owner (default)</option>
              <option value="channel">A specific channel</option>
              <option value="user">A specific user (DM)</option>
            </select>
          </div>
          {step.channelId !== undefined && (
            <div className="field-group">
              <label className="field-label">Channel ID</label>
              <input
                className="field-input"
                value={step.channelId ?? ""}
                onChange={(e) => update("channelId", e.target.value)}
                placeholder="Discord channel ID"
              />
              <div className="wf-field-hint">
                Right-click a channel in Discord with developer mode on to copy its ID.
              </div>
            </div>
          )}
          {step.userId !== undefined && (
            <div className="field-group">
              <label className="field-label">User ID</label>
              <input
                className="field-input"
                value={step.userId ?? ""}
                onChange={(e) => update("userId", e.target.value)}
                placeholder="Discord user ID"
              />
            </div>
          )}
        </>
      );
    case "trigger_workflow":
      return (
        <>
          <div className="field-group">
            <label className="field-label">Workflow</label>
            <NamePicker
              value={step.workflow ?? ""}
              options={meta.workflows}
              onChange={(v) => update("workflow", v)}
              placeholder="child-workflow-name"
              emptyHint="No other workflows saved yet."
            />
          </div>
          <div className="field-group">
            <label className="field-label">Input (JSON, optional)</label>
            <textarea
              className="field-textarea"
              rows={4}
              value={step.input ? JSON.stringify(step.input, null, 2) : ""}
              onChange={(e) => {
                const text = e.target.value;
                try {
                  update("input", text.trim() ? JSON.parse(text) : undefined);
                } catch {
                  // Mid-edit invalid JSON is fine; caught on save.
                }
              }}
              placeholder='{"key": "${steps.previous}"}'
            />
          </div>
          <div className="field-group">
            <label className="field-row">
              <input
                type="checkbox"
                checked={step.fireAndForget === true}
                onChange={(e) => update("fireAndForget", e.target.checked)}
              />
              <span className="field-inline-label">Fire and forget (don't wait for completion)</span>
            </label>
          </div>
        </>
      );
    case "notify":
      return (
        <>
          <div className="field-group">
            <label className="field-label">Channel</label>
            <select
              className="field-select"
              value={step.channel ?? "discord"}
              onChange={(e) => update("channel", e.target.value as typeof step.channel)}
            >
              <option value="discord">Discord</option>
              <option value="email">Email</option>
              <option value="log">Log (stdout only)</option>
            </select>
          </div>
          <div className="field-group">
            <label className="field-label">Message</label>
            <textarea
              className="field-textarea"
              rows={3}
              value={step.message ?? ""}
              onChange={(e) => update("message", e.target.value)}
              placeholder="Hello ${input.who}"
            />
          </div>
          {step.channel === "email" && (
            <>
              <div className="field-group">
                <label className="field-label">Subject</label>
                <input
                  className="field-input"
                  value={step.subject ?? ""}
                  onChange={(e) => update("subject", e.target.value || undefined)}
                  placeholder="Workflow notification"
                />
              </div>
              <div className="field-group">
                <label className="field-label">To (comma-separated)</label>
                <input
                  className="field-input"
                  value={step.to ?? ""}
                  onChange={(e) => update("to", e.target.value || undefined)}
                  placeholder="alice@example.com, bob@example.com"
                />
                <div className="wf-field-hint">
                  Email backend isn't wired up yet — this field is editable but email steps will fail
                  at runtime until an email sender is configured.
                </div>
              </div>
            </>
          )}
          {step.channel === "discord" && (
            <>
              <div className="field-group">
                <label className="field-label">Send to</label>
                <select
                  className="field-select"
                  value={step.channelId ? "channel" : step.userId ? "user" : "owner"}
                  onChange={(e) => {
                    const mode = e.target.value;
                    if (mode === "owner") onChange({ ...step, channelId: undefined, userId: undefined });
                    else if (mode === "channel")
                      onChange({ ...step, userId: undefined, channelId: step.channelId ?? "" });
                    else onChange({ ...step, channelId: undefined, userId: step.userId ?? "" });
                  }}
                >
                  <option value="owner">Configured Discord owner (default)</option>
                  <option value="channel">A specific channel</option>
                  <option value="user">A specific user (DM)</option>
                </select>
              </div>
              {step.channelId !== undefined && (
                <div className="field-group">
                  <label className="field-label">Channel ID</label>
                  <input
                    className="field-input"
                    value={step.channelId ?? ""}
                    onChange={(e) => update("channelId", e.target.value)}
                  />
                </div>
              )}
              {step.userId !== undefined && (
                <div className="field-group">
                  <label className="field-label">User ID</label>
                  <input
                    className="field-input"
                    value={step.userId ?? ""}
                    onChange={(e) => update("userId", e.target.value)}
                  />
                </div>
              )}
            </>
          )}
        </>
      );
    case "http_request":
      return (
        <>
          <div className="field-group">
            <label className="field-label">Method</label>
            <select
              className="field-select"
              value={step.method ?? "GET"}
              onChange={(e) => update("method", e.target.value as typeof step.method)}
            >
              {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="field-group">
            <label className="field-label">URL</label>
            <input
              className="field-input"
              value={step.url ?? ""}
              onChange={(e) => update("url", e.target.value)}
              placeholder="https://api.example.com/path?key=${input.key}"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Headers (JSON, optional)</label>
            <textarea
              className="field-textarea"
              rows={3}
              value={step.headers ? JSON.stringify(step.headers, null, 2) : ""}
              onChange={(e) => {
                const text = e.target.value;
                try {
                  update("headers", text.trim() ? JSON.parse(text) : undefined);
                } catch {
                  // Mid-edit invalid JSON is fine.
                }
              }}
              placeholder='{"Authorization": "Bearer ${env.TOKEN}"}'
            />
          </div>
          <div className="field-group">
            <label className="field-label">Body (JSON or string, optional)</label>
            <textarea
              className="field-textarea"
              rows={4}
              value={
                step.body === undefined
                  ? ""
                  : typeof step.body === "string"
                    ? step.body
                    : JSON.stringify(step.body, null, 2)
              }
              onChange={(e) => {
                const text = e.target.value;
                if (!text.trim()) {
                  update("body", undefined);
                  return;
                }
                try {
                  update("body", JSON.parse(text));
                } catch {
                  // Not valid JSON — treat as raw string body.
                  update("body", text);
                }
              }}
              placeholder='{"hello": "${input.who}"}'
            />
          </div>
          <div className="field-group">
            <label className="field-label">Timeout (milliseconds, optional)</label>
            <input
              className="field-input"
              type="number"
              value={step.timeoutMs ?? ""}
              onChange={(e) =>
                update("timeoutMs", e.target.value ? Number(e.target.value) : undefined)
              }
              placeholder="30000"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Expected status codes (optional, comma-separated)</label>
            <input
              className="field-input"
              value={step.expectStatus?.join(", ") ?? ""}
              onChange={(e) => {
                const parts = e.target.value
                  .split(",")
                  .map((s) => Number(s.trim()))
                  .filter((n) => Number.isFinite(n));
                update("expectStatus", parts.length > 0 ? parts : undefined);
              }}
              placeholder="2xx by default; e.g. 200, 201, 302"
            />
          </div>
        </>
      );
    case "form":
      return (
        <>
          <div className="field-group">
            <label className="field-label">Prompt (shown above the form)</label>
            <textarea
              className="field-textarea"
              rows={3}
              value={step.prompt ?? ""}
              onChange={(e) => update("prompt", e.target.value)}
              placeholder="What does the human need to decide / fill in?"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Fields (JSON: name → schema)</label>
            <textarea
              className="field-textarea"
              rows={6}
              value={step.fields ? JSON.stringify(step.fields, null, 2) : ""}
              onChange={(e) => {
                const text = e.target.value;
                try {
                  update("fields", text.trim() ? JSON.parse(text) : undefined);
                } catch {
                  // Mid-edit invalid JSON is fine.
                }
              }}
              placeholder='{"approve": {"type": "boolean", "label": "Approve?"}}'
            />
          </div>
          <div className="field-group">
            <label className="field-label">Timeout (milliseconds, optional)</label>
            <input
              className="field-input"
              type="number"
              value={step.timeoutMs ?? ""}
              onChange={(e) =>
                update("timeoutMs", e.target.value ? Number(e.target.value) : undefined)
              }
              placeholder="86400000 (24h default)"
            />
          </div>
        </>
      );
    case "worktree":
      return (
        <>
          <div className="field-group">
            <label className="field-label">Strategy</label>
            <select
              className="field-select"
              value={step.strategy ?? "branch"}
              onChange={(e) => update("strategy", e.target.value as typeof step.strategy)}
            >
              <option value="head">head (no worktree — run in repo dir)</option>
              <option value="branch">branch (fresh worktree, no merge)</option>
              <option value="merge-to-head">merge-to-head (worktree + post-body merge)</option>
            </select>
          </div>
          <div className="field-group">
            <label className="field-label">Branch name (optional)</label>
            <input
              className="field-input"
              value={step.branch ?? ""}
              onChange={(e) => update("branch", e.target.value)}
              placeholder="agent/fix-${input.issue_id}"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Repo dir (optional)</label>
            <input
              className="field-input"
              value={step.repoDir ?? ""}
              onChange={(e) => update("repoDir", e.target.value)}
              placeholder="Defaults to the workflow cwd"
            />
          </div>
          <div className="field-group">
            <label className="field-label">
              <input
                type="checkbox"
                checked={step.mergeOnSuccess !== false}
                onChange={(e) => update("mergeOnSuccess", e.target.checked)}
              />
              {" "}Merge on success (merge-to-head only)
            </label>
          </div>
          <NestedStepList
            label="Body"
            steps={(step.body as WorkflowStepDef[]) ?? []}
            onChange={(b) => update("body", b)}
            depth={depth + 1}
          />
        </>
      );
    default:
      return (
        <div className="field-group">
          <label className="field-label">
            Step "{(step as { type: string }).type}" is not yet supported in the visual editor.
            Edit the YAML directly to configure it.
          </label>
          <textarea
            className="field-textarea"
            rows={8}
            readOnly
            value={JSON.stringify(step, null, 2)}
          />
        </div>
      );
  }
}

interface NestedProps {
  label: string;
  steps: WorkflowStepDef[];
  onChange: (steps: WorkflowStepDef[]) => void;
  depth: number;
}

function NestedStepList({ label, steps, onChange, depth }: NestedProps) {
  function update(idx: number, next: WorkflowStepDef) {
    onChange(steps.map((s, i) => (i === idx ? next : s)));
  }
  function remove(idx: number) {
    onChange(steps.filter((_, i) => i !== idx));
  }
  function move(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= steps.length) return;
    const copy = [...steps];
    [copy[idx], copy[target]] = [copy[target], copy[idx]];
    onChange(copy);
  }
  function add() {
    onChange([...steps, blankStep("agent_run")]);
  }
  return (
    <div className="workflow-nested">
      <div className="workflow-nested-header">
        <span>{label} ({steps.length})</span>
        <button type="button" className="btn-secondary" onClick={add}>+ Add</button>
      </div>
      {steps.map((s, idx) => (
        <WorkflowStepEditor
          key={idx}
          step={s}
          depth={depth}
          onChange={(next) => update(idx, next)}
          onRemove={() => remove(idx)}
          onMoveUp={idx > 0 ? () => move(idx, -1) : undefined}
          onMoveDown={idx < steps.length - 1 ? () => move(idx, 1) : undefined}
        />
      ))}
    </div>
  );
}

export function blankStep(type: WorkflowStepType): WorkflowStepDef {
  const base: WorkflowStepDef = { name: `step_${Math.random().toString(36).slice(2, 6)}`, type };
  switch (type) {
    case "agent_run":
      return { ...base, agent: "primary", prompt: "" };
    case "tool_call":
      return { ...base, tool: "" };
    case "shell":
      return { ...base, command: "" };
    case "condition":
      return { ...base, if: "" };
    case "loop":
      return { ...base, over: "", as: "item", body: [] };
    case "parallel":
      return { ...base, steps: [] };
    case "discord_message":
      return { ...base, message: "" };
    case "trigger_workflow":
      return { ...base, workflow: "" };
    case "http_request":
      return { ...base, method: "GET", url: "" };
    case "notify":
      return { ...base, channel: "discord", message: "" };
    case "form":
      return { ...base, prompt: "", fields: {} };
    case "worktree":
      return { ...base, strategy: "branch", body: [] };
  }
}

/**
 * Step types that interpolate `${...}` expressions in user-editable strings.
 * Parallel has no string args of its own (nested children render their own
 * panel), so we suppress the reference there to reduce noise.
 */
function stepHasTemplates(type: WorkflowStepType): boolean {
  return type !== "parallel";
}

/**
 * Discoverability panel: lists `${...}` variables the user can drop into the
 * step's prompt / message / args. Each row is a click-to-copy chip. Sources:
 *
 * - **Trigger input** — derived from the workflow's current trigger via
 *   `triggerInputVariables`. Shape depends on `trigger.kind`.
 * - **Prior step outputs** — every sibling step in the workflow as
 *   `${steps.NAME}`. We don't strictly enforce topological order here; the
 *   user knows their own pipeline shape, and the canvas already shows it.
 * - **Globals** — `${prev}` and `${env.NAME}` from `GLOBAL_VARIABLES`.
 *
 * The panel is a `<details>` open by default so the variables are
 * immediately visible, but collapsible for users who already know them.
 */
function VariableReference({
  trigger,
  siblingSteps,
}: {
  trigger?: WorkflowTriggerDef;
  siblingSteps: WorkflowStepDef[];
}) {
  const inputVars = triggerInputVariables(trigger);
  const triggerLabel = trigger ? TRIGGER_KIND_LABELS[trigger.kind] : "trigger";
  return (
    <details className="wf-var-ref" open>
      <summary>Available variables</summary>
      <div className="wf-var-ref-hint">
        Click any variable to copy its <code>${"${...}"}</code> form. Use them inside prompts,
        messages, JSON args, or shell commands.
      </div>

      <VariableSection title={`From trigger (${triggerLabel})`} variables={inputVars} emptyHint="This trigger doesn't pass any input." />

      <VariableSection
        title="From prior step outputs"
        variables={siblingSteps.map((s) => ({
          path: `steps.${s.name}`,
          description: `Output of "${s.name}" (${STEP_TYPE_LABELS[s.type]}).`,
        }))}
        emptyHint="Add more steps to chain their output into this one."
      />

      <VariableSection title="Global" variables={GLOBAL_VARIABLES} />
    </details>
  );
}

function VariableSection({
  title,
  variables,
  emptyHint,
}: {
  title: string;
  variables: TemplateVariable[] | undefined;
  emptyHint?: string;
}) {
  const vars = variables ?? [];
  return (
    <div className="wf-var-section">
      <div className="wf-var-section-title">{title}</div>
      {vars.length === 0 ? (
        <div className="wf-var-empty">{emptyHint ?? "—"}</div>
      ) : (
        <ul className="wf-var-list">
          {vars.map((v) => (
            <li key={v.path}>
              <VariableChip variable={v} />
              <span className="wf-var-desc">{v.description}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function VariableChip({ variable }: { variable: TemplateVariable }) {
  const [copied, setCopied] = useState(false);
  const literal = `\${${variable.path}}`;
  return (
    <button
      type="button"
      className={`wf-var-chip${copied ? " wf-var-chip-copied" : ""}`}
      title="Click to copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(literal);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // Clipboard API blocked (rare in modern browsers over https). Fall
          // back silently — the literal is still visible and selectable.
        }
      }}
    >
      <code>{literal}</code>
      {copied && <span className="wf-var-chip-status">copied</span>}
    </button>
  );
}

function changeStepType(
  prev: WorkflowStepDef,
  type: WorkflowStepType,
  meta: WorkflowMetadata,
): WorkflowStepDef {
  // Preserve name + advanced fields, reset type-specific fields. For agent_run
  // default the agent to whatever's known if "primary" isn't configured.
  const next = blankStep(type);
  next.name = prev.name;
  next.deadlineMs = prev.deadlineMs;
  next.onError = prev.onError;
  next.retry = prev.retry;
  if (next.type === "agent_run") next.agent = defaultAgentName(meta);
  return next;
}
