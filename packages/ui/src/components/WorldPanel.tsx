import { type ReactNode, useEffect } from "react";

/**
 * A panel laid over the 3D world: a heading, a way back when there is one, a
 * close button, and what it holds, scrolling inside when it is taller than
 * the stage. Escape closes it. The scene goes on behind it, and keys pressed
 * in it are its own: the stage leaves anything inside a dialog alone, so
 * typing here never walks your body.
 */
export function WorldPanel({
  title,
  kicker,
  label,
  className,
  onClose,
  onBack,
  backLabel,
  children,
  footer,
}: {
  title: ReactNode;
  /** A word over the title saying what this is: "Task", "Agent". */
  kicker?: string;
  /** What a screen reader calls it, when the title isn't plain words. */
  label?: string;
  className?: string;
  onClose: () => void;
  /** Where "back" goes, when this was opened from another panel. */
  onBack?: () => void;
  backLabel?: string;
  children: ReactNode;
  /** Pinned under the scrolling part: a link to the full page. */
  footer?: ReactNode;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Claimed, so the chat page doesn't take the same Escape as stopping a reply.
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <section
      className={`world-panel${className ? ` ${className}` : ""}`}
      role="dialog"
      aria-label={label ?? (typeof title === "string" ? title : kicker)}
    >
      <div className="world-panel-head">
        {onBack && (
          <button type="button" className="world-panel-back" onClick={onBack}>
            ← {backLabel ?? "Back"}
          </button>
        )}
        <button type="button" className="world-map-close world-panel-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        {kicker && <span className="world-panel-kicker">{kicker}</span>}
        <h2 className="world-panel-title">{title}</h2>
      </div>
      <div className="world-panel-body">{children}</div>
      {footer && <div className="world-panel-foot">{footer}</div>}
    </section>
  );
}
