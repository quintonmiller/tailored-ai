import { useEffect, useRef, useState } from "react";
import {
  type BodyChange,
  type BodyLooks,
  bodyWith,
  EMOTES,
  ERRANDS,
  IDLES,
  POSTURES,
  SIZE_LIMITS,
  WALKS,
} from "../avatar/body";

/** Colours to choose from at a touch, by the names the server knows them by (core's `places-layout.ts`). */
const SWATCHES: [string, string][] = [
  ["teal", "#2a8a8a"],
  ["sky blue", "#8cc4e8"],
  ["navy", "#2b3a66"],
  ["purple", "#8064a2"],
  ["pink", "#e89ab0"],
  ["coral", "#ee7f6d"],
  ["red", "#c0392b"],
  ["gold", "#d4a72c"],
  ["white", "#f5f3ef"],
  ["charcoal", "#3b3f45"],
];

/** The most things a body can say it likes doing, as the server allows. */
const LIKES_MOST = 6;

/** How a body looks and carries itself, in a few words: "coral, 1.2× · lively, upright, brisk". */
export function bodyWords(looks: BodyLooks): string {
  const look = [looks.colorName ?? looks.color, looks.model?.replace(/\.vrm$/i, ""), looks.size && `${looks.size}×`]
    .filter(Boolean)
    .join(", ");
  const carriage = [looks.idle, looks.posture, looks.walk].filter(Boolean).join(", ");
  return [look, carriage].filter(Boolean).join(" · ") || "As it always was";
}

/**
 * Choosing how an agent's body looks and carries itself, on its card: the
 * same choices its `body` tool has. Each choice is made at once, and shows as
 * made until the world says it is, or until saving it fails.
 */
export function BodyControls({
  name,
  looks,
  busy,
  onBody,
  onEmote,
}: {
  /** The agent's name, as people read it. */
  name: string;
  looks: BodyLooks;
  busy: boolean;
  /** Make a change; true once it is saved, false when it couldn't be (the card says why). */
  onBody: (change: BodyChange) => Promise<boolean>;
  onEmote?: (emote: string) => void;
}) {
  // What was just asked for, until what the world says catches up.
  const [asked, setAsked] = useState<BodyChange>({});
  const key = JSON.stringify(looks);
  // biome-ignore lint/correctness/useExhaustiveDependencies: what the world says now is how it looks; asking is over.
  useEffect(() => {
    setAsked({});
  }, [key]);
  const shown = bodyWith(looks as Record<string, unknown>, asked) as BodyLooks;
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    let gone = false;
    fetch("/api/live/models")
      .then((res) => (res.ok ? (res.json() as Promise<{ models?: string[] }>) : { models: [] }))
      .then((body) => {
        if (!gone) setModels(body.models ?? []);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  const change = (next: BodyChange) => {
    setAsked((was) => ({ ...was, ...next }));
    void onBody(next).then((saved) => {
      if (saved) return;
      // Not saved, so not chosen: the card goes back to the body as it still is, unless something else was asked since.
      setAsked((was) => {
        const out: BodyChange = { ...was };
        for (const key of Object.keys(next) as (keyof BodyChange)[]) if (out[key] === next[key]) delete out[key];
        return out;
      });
    });
  };
  // The free colour shows as the person drags round the picker, and is saved once, when they close it: a browser
  // says "input" at every step of a drag (React's onChange) and "change" only at the end.
  const [picking, setPicking] = useState<string | undefined>(undefined);
  const picker = useRef<HTMLInputElement>(null);
  const pickColour = useRef<(hex: string) => void>(() => {});
  pickColour.current = (hex: string) => {
    setPicking(undefined);
    if (hex !== shown.color) change({ color: hex, colorName: null });
  };
  useEffect(() => {
    const input = picker.current;
    if (!input) return;
    const picked = () => pickColour.current(input.value.toLowerCase());
    input.addEventListener("change", picked);
    return () => input.removeEventListener("change", picked);
  }, []);
  // A choice of one among several, or none: pressing the one chosen takes it back.
  const pick = <K extends "idle" | "posture" | "walk">(field: K, value: NonNullable<BodyLooks[K]>) =>
    change({ [field]: shown[field] === value ? null : value } as BodyChange);
  const liked = shown.errands ?? [];
  const like = (id: string) => {
    const next = liked.includes(id) ? liked.filter((e) => e !== id) : [...liked, id].slice(-LIKES_MOST);
    change({ errands: next.length ? next : null });
  };
  const [size, setSize] = useState(shown.size ?? 1);
  useEffect(() => {
    setSize(shown.size ?? 1);
  }, [shown.size]);
  const chips = <T extends string>(
    label: string,
    values: readonly T[],
    on: (v: T) => boolean,
    press: (v: T) => void,
    word: (v: T) => string = (v) => v,
  ) => (
    <span className="world-wear" role="group" aria-label={label}>
      {values.map((v) => (
        <button
          key={v}
          type="button"
          className="world-wear-chip"
          aria-pressed={on(v)}
          disabled={busy}
          onClick={() => press(v)}
        >
          {word(v)}
        </button>
      ))}
    </span>
  );

  return (
    <div className="body-controls">
      <div className="body-row">
        <span className="body-label">Colour</span>
        <span className="body-swatches" role="group" aria-label={`${name}'s colour`}>
          <button
            type="button"
            className="body-swatch body-swatch-own"
            aria-pressed={!shown.color}
            title="Its own colour"
            disabled={busy}
            onClick={() => change({ color: null, colorName: null })}
          >
            own
          </button>
          {SWATCHES.map(([word, hex]) => (
            <button
              key={word}
              type="button"
              className="body-swatch"
              style={{ background: hex }}
              aria-pressed={shown.color === hex}
              aria-label={word}
              title={word}
              disabled={busy}
              onClick={() => change({ color: hex, colorName: word })}
            />
          ))}
          <label className="body-swatch body-swatch-any" title="Any colour">
            <input
              ref={picker}
              type="color"
              aria-label="Any colour"
              value={picking ?? shown.color ?? "#4c8c4a"}
              disabled={busy}
              onChange={(e) => setPicking(e.target.value.toLowerCase())}
            />
          </label>
        </span>
      </div>
      {models.length > 1 && (
        <label className="body-row">
          <span className="body-label">Model</span>
          <select
            className="body-select"
            value={shown.model ?? ""}
            disabled={busy}
            onChange={(e) => change({ model: e.target.value || null })}
          >
            <option value="">Its own</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m.replace(/\.vrm$/i, "")}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="body-row">
        <span className="body-label">Size</span>
        <input
          type="range"
          className="body-size"
          min={SIZE_LIMITS[0]}
          max={SIZE_LIMITS[1]}
          step={0.05}
          value={size}
          disabled={busy}
          onChange={(e) => setSize(Number(e.target.value))}
          onPointerUp={() => change({ size: size === 1 ? null : Math.round(size * 100) / 100 })}
          onKeyUp={() => change({ size: size === 1 ? null : Math.round(size * 100) / 100 })}
        />
        <span className="body-size-value">{size.toFixed(2)}×</span>
      </label>
      <div className="body-row">
        <span className="body-label">Idles</span>
        {chips(
          `How ${name} idles`,
          IDLES,
          (v) => shown.idle === v,
          (v) => pick("idle", v),
        )}
      </div>
      <div className="body-row">
        <span className="body-label">Stands</span>
        {chips(
          `How ${name} stands`,
          POSTURES,
          (v) => shown.posture === v,
          (v) => pick("posture", v),
        )}
      </div>
      <div className="body-row">
        <span className="body-label">Walks</span>
        {chips(
          `How ${name} walks`,
          WALKS,
          (v) => shown.walk === v,
          (v) => pick("walk", v),
        )}
      </div>
      <div className="body-row">
        <span className="body-label">Likes</span>
        {chips(
          `What ${name} likes doing when idle`,
          Object.keys(ERRANDS),
          (id) => liked.includes(id),
          (id) => like(id),
          // The words the agent is told, "plants" and "the task board", not the names they are kept by.
          (id) => ERRANDS[id] ?? id,
        )}
      </div>
      {onEmote && (
        <div className="body-row">
          <span className="body-label">Now</span>
          <span className="world-wear" role="group" aria-label={`Ask ${name} to make a gesture`}>
            {EMOTES.map((e) => (
              <button key={e} type="button" className="world-wear-chip" disabled={busy} onClick={() => onEmote(e)}>
                {e}
              </button>
            ))}
          </span>
        </div>
      )}
      {shown.spot && (
        <div className="body-row">
          <span className="body-label">Stays</span>
          <span>
            {shown.spot.name}
            {" · "}
            <button type="button" className="world-panel-inline" disabled={busy} onClick={() => change({ spot: null })}>
              let it roam
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
