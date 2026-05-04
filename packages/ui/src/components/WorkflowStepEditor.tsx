import type { WorkflowStepDef, WorkflowStepType } from "../api";

const STEP_TYPES: WorkflowStepType[] = [
  "agent_run",
  "tool_call",
  "shell",
  "condition",
  "loop",
  "parallel",
];

const ON_ERROR: Array<"fail" | "continue" | "retry"> = ["fail", "continue", "retry"];

interface Props {
  step: WorkflowStepDef;
  onChange: (next: WorkflowStepDef) => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  depth?: number;
}

export function WorkflowStepEditor({ step, onChange, onRemove, onMoveUp, onMoveDown, depth = 0 }: Props) {
  function update<K extends keyof WorkflowStepDef>(key: K, value: WorkflowStepDef[K]) {
    onChange({ ...step, [key]: value });
  }

  return (
    <div className="workflow-step" style={{ marginLeft: depth * 16 }}>
      <div className="workflow-step-header">
        <input
          className="field-input workflow-step-name"
          value={step.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder="step name"
        />
        <select
          className="field-select"
          value={step.type}
          onChange={(e) => onChange(changeStepType(step, e.target.value as WorkflowStepType))}
        >
          {STEP_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
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

      <div className="workflow-step-body">
        {renderTypeFields(step, update, depth)}

        <details className="workflow-step-advanced">
          <summary>Advanced</summary>
          <div className="field-group">
            <label className="field-label">onError</label>
            <select
              className="field-select"
              value={step.onError ?? "fail"}
              onChange={(e) => update("onError", e.target.value as "fail" | "continue" | "retry")}
            >
              {ON_ERROR.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
          <div className="field-group">
            <label className="field-label">deadlineMs</label>
            <input
              className="field-input"
              type="number"
              value={step.deadlineMs ?? ""}
              onChange={(e) =>
                update("deadlineMs", e.target.value ? Number(e.target.value) : undefined)
              }
              placeholder="(none)"
            />
          </div>
          {step.onError === "retry" && (
            <div className="field-group">
              <label className="field-label">retry.maxAttempts</label>
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
              <label className="field-label">retry.backoffMs</label>
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

function renderTypeFields(
  step: WorkflowStepDef,
  update: <K extends keyof WorkflowStepDef>(key: K, value: WorkflowStepDef[K]) => void,
  depth: number,
) {
  switch (step.type) {
    case "agent_run":
      return (
        <>
          <div className="field-group">
            <label className="field-label">Agent</label>
            <input
              className="field-input"
              value={step.agent ?? ""}
              onChange={(e) => update("agent", e.target.value)}
              placeholder="agent name"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Prompt</label>
            <textarea
              className="field-textarea"
              rows={3}
              value={step.prompt ?? ""}
              onChange={(e) => update("prompt", e.target.value)}
            />
          </div>
          <div className="field-group">
            <label className="field-label">maxToolRounds (optional)</label>
            <input
              className="field-input"
              type="number"
              value={step.maxToolRounds ?? ""}
              onChange={(e) =>
                update("maxToolRounds", e.target.value ? Number(e.target.value) : undefined)
              }
            />
          </div>
        </>
      );
    case "tool_call":
      return (
        <>
          <div className="field-group">
            <label className="field-label">Tool</label>
            <input
              className="field-input"
              value={step.tool ?? ""}
              onChange={(e) => update("tool", e.target.value)}
              placeholder="tool name"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Args (JSON)</label>
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
            <label className="field-label">cwd (optional)</label>
            <input
              className="field-input"
              value={step.cwd ?? ""}
              onChange={(e) => update("cwd", e.target.value || undefined)}
            />
          </div>
          <div className="field-group">
            <label className="field-label">timeoutMs (optional)</label>
            <input
              className="field-input"
              type="number"
              value={step.timeoutMs ?? ""}
              onChange={(e) =>
                update("timeoutMs", e.target.value ? Number(e.target.value) : undefined)
              }
            />
          </div>
        </>
      );
    case "condition":
      return (
        <>
          <div className="field-group">
            <label className="field-label">if (expression)</label>
            <input
              className="field-input"
              value={step.if ?? ""}
              onChange={(e) => update("if", e.target.value)}
              placeholder="steps.foo.output.success"
            />
          </div>
          <div className="field-group">
            <label className="field-label">then (step names, comma-separated)</label>
            <input
              className="field-input"
              value={(step.then ?? []).join(", ")}
              onChange={(e) =>
                update(
                  "then",
                  e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </div>
          <div className="field-group">
            <label className="field-label">else (step names, comma-separated)</label>
            <input
              className="field-input"
              value={(step.else ?? []).join(", ")}
              onChange={(e) =>
                update(
                  "else",
                  e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </div>
        </>
      );
    case "loop":
      return (
        <>
          <div className="field-group">
            <label className="field-label">over (expression)</label>
            <input
              className="field-input"
              value={step.over ?? ""}
              onChange={(e) => update("over", e.target.value)}
              placeholder="steps.previous.output.items"
            />
          </div>
          <div className="field-group">
            <label className="field-label">as (variable name)</label>
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
              <span className="field-inline-label">parallel</span>
            </label>
            {step.parallel && (
              <>
                <label className="field-label">maxConcurrency</label>
                <input
                  className="field-input"
                  type="number"
                  value={step.maxConcurrency ?? ""}
                  onChange={(e) =>
                    update("maxConcurrency", e.target.value ? Number(e.target.value) : undefined)
                  }
                />
              </>
            )}
          </div>
          <NestedStepList
            label="body"
            steps={step.body ?? []}
            depth={depth + 1}
            onChange={(next) => update("body", next)}
          />
        </>
      );
    case "parallel":
      return (
        <NestedStepList
          label="steps"
          steps={step.steps ?? []}
          depth={depth + 1}
          onChange={(next) => update("steps", next)}
        />
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
  }
}

function changeStepType(prev: WorkflowStepDef, type: WorkflowStepType): WorkflowStepDef {
  // Preserve name + advanced fields, reset type-specific fields.
  const next = blankStep(type);
  next.name = prev.name;
  next.deadlineMs = prev.deadlineMs;
  next.onError = prev.onError;
  next.retry = prev.retry;
  return next;
}
