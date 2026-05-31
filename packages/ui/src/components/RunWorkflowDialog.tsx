import { useState } from "react";
import type { WorkflowDefinition, WorkflowInputSchema } from "../api";

interface Props {
  workflow: WorkflowDefinition;
  onCancel(): void;
  onSubmit(input: Record<string, unknown>): void;
}

/**
 * Renders one input per workflow.inputs entry. The form is intentionally simple —
 * we expect typical run inputs to be 3-5 fields, not hundreds. Submitting
 * sanitizes the values (numbers and booleans cast from strings) before handing
 * back to the caller; server-side validation is the authoritative check.
 */
export function RunWorkflowDialog({ workflow, onCancel, onSubmit }: Props) {
  const schema = workflow.inputs ?? {};
  const fields = Object.entries(schema);

  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const [name, field] of fields) {
      if (field.default !== undefined) {
        init[name] = typeof field.default === "string" ? field.default : String(field.default);
      }
    }
    return init;
  });

  if (fields.length === 0) return null; // caller handles bare runs

  function set(name: string, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const out: Record<string, unknown> = {};
    for (const [name, field] of fields) {
      const raw = values[name] ?? "";
      if (raw === "" && !field.required) continue;
      out[name] = coerce(field, raw);
    }
    onSubmit(out);
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="modal-card" onSubmit={submit}>
        <h3 className="modal-title">Run {workflow.name}</h3>
        {workflow.description && <p className="modal-subtitle">{workflow.description}</p>}
        {fields.map(([name, field]) => (
          <FieldRow key={name} name={name} field={field} value={values[name] ?? ""} onChange={(v) => set(name, v)} />
        ))}
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn-secondary">
            Run
          </button>
        </div>
      </form>
    </div>
  );
}

function FieldRow({
  name,
  field,
  value,
  onChange,
}: {
  name: string;
  field: WorkflowInputSchema;
  value: string;
  onChange(v: string): void;
}) {
  const label = field.label ?? name;
  const required = field.required ? <span className="field-required">*</span> : null;
  return (
    <div className="field-group">
      <label className="field-label">
        {label}
        {required}
      </label>
      {renderControl(field, value, onChange)}
      {field.description && <div className="wf-field-hint">{field.description}</div>}
    </div>
  );
}

function renderControl(field: WorkflowInputSchema, value: string, onChange: (v: string) => void) {
  if (field.type === "string" && field.enum && field.enum.length > 0) {
    return (
      <select className="field-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— pick one —</option>
        {field.enum.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "boolean") {
    return (
      <select className="field-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (field.type === "date") {
    return <input className="field-input" type="date" value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  if (field.type === "number") {
    return (
      <input
        className="field-input"
        type="number"
        value={value}
        min={field.min}
        max={field.max}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (field.type === "json") {
    return (
      <textarea
        className="field-textarea"
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder='{"key": "value"}'
      />
    );
  }
  return <input className="field-input" value={value} onChange={(e) => onChange(e.target.value)} />;
}

function coerce(field: WorkflowInputSchema, raw: string): unknown {
  switch (field.type) {
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case "boolean":
      return raw === "true";
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}
