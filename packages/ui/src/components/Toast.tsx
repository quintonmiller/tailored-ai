import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type ToastKind = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  toasts: ToastItem[];
  push: (kind: ToastKind, message: string, opts?: { ttlMs?: number }) => void;
  info: (message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let _nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, opts?: { ttlMs?: number }) => {
      const id = _nextId++;
      setToasts((prev) => [...prev, { id, kind, message }]);
      const ttl = opts?.ttlMs ?? (kind === "error" ? 8000 : 4000);
      window.setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      toasts,
      push,
      info: (m) => push("info", m),
      success: (m) => push("success", m),
      error: (m) => push("error", m),
      dismiss,
    }),
    [toasts, push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Allow consumers in non-provider contexts (e.g. in tests) to no-op
    // instead of crashing. The api is still typed so call sites compile.
    return {
      toasts: [],
      push: () => {},
      info: () => {},
      success: () => {},
      error: () => {},
      dismiss: () => {},
    };
  }
  return ctx;
}

function ToastViewport({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  // Keep viewport mounted so we can animate enter/exit later. Don't return
  // null when empty — that triggers re-mount churn.
  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <ToastEntry key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastEntry({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  useEffect(() => {
    // no-op — kept so we can hook focus mgmt later
  }, []);
  return (
    <div className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
      <span className="toast-message">{toast.message}</span>
      <button type="button" className="toast-dismiss" onClick={onDismiss} aria-label="Dismiss notification">
        ×
      </button>
    </div>
  );
}

/** Convenience: turn a thrown error into a toast message string. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
