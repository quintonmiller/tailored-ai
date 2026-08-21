/**
 * Attachment handling for the chat composer.
 *
 * Three ways in, because people reach for all three: a file picker, a paste
 * (which is how anyone sends a screenshot), and a drop. Paste matters most —
 * the whole point of a vision-capable agent is being able to hit PrintScreen
 * and ask "what is this?".
 *
 * Uploading happens as soon as a file is chosen, not on send. The store is
 * content-addressed, so re-attaching the same screenshot costs nothing, and it
 * means the send path stays JSON — it names ids rather than carrying bytes.
 */

import { useCallback, useRef, useState } from "react";
import { uploadMedia } from "../api";
import { formatBytes, isImage, type MediaRef, mediaSrc } from "../lib/content.js";

export interface PendingAttachment {
  /** Stable across the upload, so a row can render before its id exists. */
  key: string;
  name: string;
  status: "uploading" | "ready" | "failed";
  ref?: MediaRef;
  error?: string;
}

export function useAttachments() {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const counter = useRef(0);

  const add = useCallback(async (files: File[]) => {
    for (const file of files) {
      const key = `att-${++counter.current}`;
      setAttachments((prev) => [...prev, { key, name: file.name, status: "uploading" }]);
      try {
        const ref = await uploadMedia(file);
        setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, status: "ready", ref } : a)));
      } catch (err) {
        // A failed upload stays visible as a failed row. Removing it silently
        // would let someone send a message believing an image went with it.
        setAttachments((prev) =>
          prev.map((a) => (a.key === key ? { ...a, status: "failed", error: (err as Error).message } : a)),
        );
      }
    }
  }, []);

  const remove = useCallback((key: string) => {
    setAttachments((prev) => prev.filter((a) => a.key !== key));
  }, []);

  const clear = useCallback(() => setAttachments([]), []);

  /** Ids to send, in order. Only the ones that actually made it. */
  const readyIds = attachments.filter((a) => a.status === "ready" && a.ref).map((a) => a.ref?.id ?? "");
  const busy = attachments.some((a) => a.status === "uploading");

  return { attachments, add, remove, clear, readyIds, busy };
}

export function AttachmentTray(props: { attachments: PendingAttachment[]; onRemove: (key: string) => void }) {
  if (props.attachments.length === 0) return null;
  return (
    <div className="attachment-tray">
      {props.attachments.map((a) => (
        <div key={a.key} className={`attachment-chip ${a.status}`}>
          {a.ref && isImage(a.ref) ? (
            <img className="attachment-thumb" src={mediaSrc(a.ref)} alt="" />
          ) : (
            <span className="attachment-icon" aria-hidden="true">
              ◫
            </span>
          )}
          <span className="attachment-name">{a.name}</span>
          <span className="attachment-meta">
            {a.status === "uploading" ? "uploading…" : null}
            {a.status === "failed" ? (a.error ?? "failed") : null}
            {a.status === "ready" && a.ref ? formatBytes(a.ref.bytes) : null}
          </span>
          <button
            type="button"
            className="attachment-remove"
            onClick={() => props.onRemove(a.key)}
            aria-label={`Remove ${a.name}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** Files from a paste, if the clipboard carried any. */
export function filesFromPaste(e: React.ClipboardEvent): File[] {
  const items = Array.from(e.clipboardData?.items ?? []);
  return items
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile())
    .filter((f): f is File => f !== null);
}

/** Files from a drop. */
export function filesFromDrop(e: React.DragEvent): File[] {
  return Array.from(e.dataTransfer?.files ?? []);
}
