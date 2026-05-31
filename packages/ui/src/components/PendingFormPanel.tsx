import { useEffect, useState } from "react";
import { fetchPendingForms, submitWorkflowForm, type WorkflowFormPendingRow } from "../api";

interface Props {
  runId: string;
  /** Bumped externally when an SSE form.pending arrives so we re-fetch. */
  refreshKey?: number;
  /** Called after a successful submit so the parent can refresh run state. */
  onSubmitted?: () => void;
}

export function PendingFormPanel({ runId, refreshKey, onSubmitted }: Props) {
  const [forms, setForms] = useState<WorkflowFormPendingRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPendingForms(runId)
      .then((data) => {
        if (cancelled) return;
        setForms(data.forms.filter((f) => f.status === "pending"));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (loading && forms.length === 0) return null;
  if (forms.length === 0) return null;

  return (
    <div className="pending-forms-panel">
      <h3>Pending forms ({forms.length})</h3>
      {forms.map((form) => (
        <FormCard
          key={form.id}
          form={form}
          onSubmitted={() => {
            setForms((prev) => prev.filter((f) => f.id !== form.id));
            onSubmitted?.();
          }}
        />
      ))}
    </div>
  );
}

function FormCard({ form, onSubmitted }: { form: WorkflowFormPendingRow; onSubmitted: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(form.fields)) {
      if (field.default !== undefined) out[name] = field.default;
    }
    return out;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string[]>([]);

  function setField(name: string, value: unknown) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setErrorDetails([]);
    try {
      const res = await submitWorkflowForm(form.run_id, form.step_name, values);
      if (res.ok) {
        onSubmitted();
      } else {
        setError(res.error || "submit failed");
        setErrorDetails(res.details ?? []);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="pending-form-card" onSubmit={handleSubmit}>
      <div className="pending-form-header">
        <span className="pending-form-stepname">{form.step_name}</span>
        {form.expires_at && (
          <span className="pending-form-expires" title={form.expires_at}>
            expires {new Date(form.expires_at).toLocaleString()}
          </span>
        )}
      </div>
      <pre className="pending-form-prompt">{form.prompt}</pre>
      <div className="pending-form-fields">
        {Object.entries(form.fields).map(([name, field]) => (
          <FieldInput key={name} name={name} field={field} value={values[name]} onChange={(v) => setField(name, v)} />
        ))}
      </div>
      {error && (
        <div className="pending-form-error">
          <strong>{error}</strong>
          {errorDetails.length > 0 && (
            <ul>
              {errorDetails.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <button type="submit" className="btn-primary" disabled={submitting}>
        {submitting ? "Submitting…" : "Submit"}
      </button>
    </form>
  );
}

interface FieldProps {
  name: string;
  field: WorkflowFormPendingRow["fields"][string];
  value: unknown;
  onChange: (v: unknown) => void;
}

function FieldInput({ name, field, value, onChange }: FieldProps) {
  const label = field.label ?? name;
  const required = field.required ?? false;

  if (field.enum && field.type === "string") {
    return (
      <label className="pending-form-field">
        <span>
          {label}
          {required && <span className="required">*</span>}
        </span>
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} required={required}>
          <option value="">— choose —</option>
          {field.enum.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        {field.description && <small>{field.description}</small>}
      </label>
    );
  }

  if (field.type === "boolean") {
    return (
      <label className="pending-form-field pending-form-field-checkbox">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span>
          {label}
          {required && <span className="required">*</span>}
        </span>
        {field.description && <small>{field.description}</small>}
      </label>
    );
  }

  if (field.type === "number") {
    return (
      <label className="pending-form-field">
        <span>
          {label}
          {required && <span className="required">*</span>}
        </span>
        <input
          type="number"
          value={value == null ? "" : String(value)}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          required={required}
        />
        {field.description && <small>{field.description}</small>}
      </label>
    );
  }

  if (field.type === "json") {
    return (
      <label className="pending-form-field">
        <span>
          {label}
          {required && <span className="required">*</span>}
        </span>
        <textarea
          value={typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2)}
          onChange={(e) => onChange(e.target.value)}
          rows={5}
          placeholder="{ ... }"
          required={required}
        />
        {field.description && <small>{field.description}</small>}
      </label>
    );
  }

  const inputType = field.type === "date" ? "date" : "text";
  return (
    <label className="pending-form-field">
      <span>
        {label}
        {required && <span className="required">*</span>}
      </span>
      <input
        type={inputType}
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      />
      {field.description && <small>{field.description}</small>}
    </label>
  );
}
