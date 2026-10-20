import { useMemo } from "react";
import { type AgentActivity, doingCss } from "../avatar/doing";
import type { TownPlan as Plan, TownBuilding } from "../avatar/town";
import { nameOf } from "../lib/conversations";
import { type MapPlace, placeTitle } from "../lib/wayfinding";

/** A building's colour on the plan by what it is; a house is its owner's. */
const KIND_FILL: Record<string, string> = {
  hall: "#d9cdb4",
  office: "#9fb4cc",
  tavern: "#c0915e",
  studio: "#6a6182",
  workshop: "#b25e48",
  library: "#cfc5ad",
  hut: "#eae3cf",
  shop: "#e3c79a",
  cottage: "#d8c890",
};

/** A house's colour on the plan: its owner's, as the map's list and its body show it. */
const ownerFill = (owner: string, color: (agent: string) => string) => color(owner);

/** What is worth a mark on the plan: someone waiting on you, stuck, or at work. */
const MARKED = new Set<AgentActivity["doing"]>(["waiting", "stuck", "working", "thinking", "talking"]);

/**
 * The town from above, to find your way and go anywhere in one click: the
 * square, the streets and their names, the stream, the park and the shore,
 * and every building, each a button that takes you into it. A house is its
 * owner's colour, with a dot when its owner is at work or waiting on you, and
 * any building someone is in has a dot for them. The building you are in is
 * ringed; out in the town, a dot is where you stand.
 */
export function TownPlan({
  plan,
  places,
  here,
  you,
  activities,
  color,
  onGo,
}: {
  plan: Plan;
  places: MapPlace[];
  /** The place on screen now. */
  here: string | undefined;
  /** Where you stand in the town, while you are out in it. */
  you?: [number, number];
  activities: Record<string, AgentActivity>;
  /** An agent's colour. */
  color: (agent: string) => string;
  onGo: (id: string) => void;
}) {
  // Just what is built on, with a margin: the woods round it are for walking in, not for finding your way.
  const box = useMemo(() => {
    const xs = plan.buildings.flatMap((b) => [b.at[0] - 6, b.at[0] + 6]);
    const zs = plan.buildings.flatMap((b) => [b.at[1] - 6, b.at[1] + 6]);
    for (const p of plan.plots) xs.push(p.at[0] - p.size[0] / 2 - 2, p.at[0] + p.size[0] / 2 + 2);
    zs.push(plan.shore.sea + 4);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    return { x: x0, z: z0, w: x1 - x0, d: z1 - z0 };
  }, [plan]);
  const byId = useMemo(() => new Map(places.map((p) => [p.id, p])), [places]);
  // The building you are in: your own, or the office for a room on one of its floors.
  const inside = useMemo(() => {
    if (!here) return undefined;
    if (plan.buildings.some((b) => b.id === here)) return here;
    const office = plan.buildings.find((b) => b.kind === "office");
    const where = byId.get(here);
    return office && (where?.kind === "office" || where?.via?.startsWith("office")) ? office.id : undefined;
  }, [here, plan, byId]);
  const pct = (v: number, from: number, span: number) => `${((v - from) / span) * 100}%`;
  // Out in the woods past what the plan shows, you are at its edge.
  const edge = (v: number, from: number, span: number) => pct(Math.min(from + span, Math.max(from, v)), from, span);
  const line = (points: [number, number][]) => points.map(([x, z]) => `${x},${z}`).join(" ");
  const mark = (b: TownBuilding): AgentActivity["doing"] | undefined => {
    const own = b.owner ? activities[b.owner]?.doing : undefined;
    if (own && MARKED.has(own)) return own;
    const there = byId.get(b.id)?.agents.filter((a) => a !== b.owner) ?? [];
    const busy = there.map((a) => activities[a]?.doing).find((d) => d && MARKED.has(d));
    return busy ?? (there.length ? "idle" : undefined);
  };
  const title = (b: TownBuilding) => {
    const place = byId.get(b.id);
    const what = place ? placeTitle(place) : b.label;
    const doing = b.owner ? activities[b.owner]?.doing : undefined;
    return `${what.charAt(0).toUpperCase()}${what.slice(1)}, ${b.street}${b.owner && doing && doing !== "idle" ? ` · ${nameOf(b.owner)} is ${doing === "waiting" ? "waiting on you" : doing}` : ""}`;
  };
  const lanes = plan.roads.filter((r) => r.name && r.kind !== "promenade");
  return (
    <div className="world-plan" style={{ aspectRatio: `${box.w} / ${box.d}` }}>
      <svg viewBox={`${box.x} ${box.z} ${box.w} ${box.d}`} preserveAspectRatio="none" aria-hidden="true">
        <rect x={box.x} y={box.z} width={box.w} height={box.d} className="world-plan-grass" />
        <rect
          x={box.x}
          y={plan.shore.sand}
          width={box.w}
          height={plan.shore.sea - plan.shore.sand}
          className="world-plan-sand"
        />
        <rect x={box.x} y={plan.shore.sea} width={box.w} height={box.d} className="world-plan-sea" />
        {plan.plots.map((p) => (
          <rect
            key={p.id}
            x={p.at[0] - p.size[0] / 2}
            y={p.at[1] - p.size[1] / 2}
            width={p.size[0]}
            height={p.size[1]}
            className="world-plan-plot"
          />
        ))}
        <ellipse
          cx={plan.park.pond.at[0]}
          cy={plan.park.pond.at[1]}
          rx={plan.park.pond.size[0] / 2}
          ry={plan.park.pond.size[1] / 2}
          className="world-plan-water"
        />
        <polyline points={line(plan.stream.points)} strokeWidth={plan.stream.width} className="world-plan-stream" />
        {plan.roads.map((r) => (
          <polyline key={r.id} points={line(r.points)} strokeWidth={r.width} className={`world-plan-road ${r.kind}`} />
        ))}
        <circle cx={plan.square.at[0]} cy={plan.square.at[1]} r={plan.square.radius} className="world-plan-square" />
        <circle cx={plan.square.at[0]} cy={plan.square.at[1]} r={2.4} className="world-plan-water" />
      </svg>
      {lanes.map((r) => {
        // Partway along it; the avenue's middle is the square, so its name goes out along its eastern half.
        const end =
          r.points[Math.min(r.points.length - 1, Math.floor(r.points.length * (r.kind === "avenue" ? 0.8 : 0.55)))];
        // Written along the street, never upside down.
        const [a, z] = [r.points[0], r.points.at(-1) ?? r.points[0]];
        let turn = (Math.atan2(z[1] - a[1], z[0] - a[0]) * 180) / Math.PI;
        if (turn > 90) turn -= 180;
        if (turn < -90) turn += 180;
        return (
          <span
            key={r.id}
            className={`world-plan-street ${r.kind}`}
            style={{
              left: pct(end[0], box.x, box.w),
              top: pct(end[1], box.z, box.d),
              transform: `translate(-50%, -50%) rotate(${turn}deg)`,
            }}
          >
            {r.name}
          </span>
        );
      })}
      {here === "town" && you && (
        <span
          className="world-plan-you"
          role="img"
          aria-label="You are here"
          title="You are here"
          style={{ left: edge(you[0], box.x, box.w), top: edge(you[1], box.z, box.d) }}
        />
      )}
      {plan.buildings.map((b) => {
        const doing = mark(b);
        const big = b.kind === "hall" || b.kind === "office";
        return (
          <button
            key={b.id}
            type="button"
            className={`world-plan-building ${b.kind}${b.id === inside ? " here" : ""}`}
            title={title(b)}
            aria-label={title(b)}
            aria-current={b.id === inside ? "location" : undefined}
            style={{
              left: pct(b.at[0], box.x, box.w),
              top: pct(b.at[1], box.z, box.d),
              width: pct(box.x + b.size[0], box.x, box.w),
              height: pct(box.z + b.size[1], box.z, box.d),
              transform: `translate(-50%, -50%) rotate(${-b.facing}deg)`,
              background: b.owner ? ownerFill(b.owner, color) : KIND_FILL[b.kind],
            }}
            onClick={() => onGo(b.id)}
          >
            {big && <span className="world-plan-label">{b.label}</span>}
            {doing && <span className="world-plan-mark" style={{ background: doingCss(doing) }} aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
