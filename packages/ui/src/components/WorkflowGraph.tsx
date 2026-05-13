import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  deleteWorkflowSecret,
  listWorkflowSecrets,
  listWorkflowVersions,
  restoreWorkflowVersion,
  setWorkflowSecret,
  type SecretRecord,
  type WorkflowVersionSummary,
} from "../api";
import type {
  WorkflowDefinition,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowStepDef,
  WorkflowStepType,
  WorkflowTriggerDef,
} from "../api";
import { blankStep, WorkflowStepEditor } from "./WorkflowStepEditor";
import {
  CRON_PRESETS,
  STEP_TYPE_LABELS,
  TRIGGER_HELP,
  TRIGGER_KIND_LABELS,
  describeCron,
  describeStep,
  presetIdForSchedule,
  useWorkflowMetadata,
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
  "http_request",
  "notify",
];

const DOC_EVENTS: Array<"created" | "updated" | "deleted"> = ["created", "updated", "deleted"];

const TRIGGER_NODE_ID = "__trigger__";

type StepNodeData = {
  step: WorkflowStepDef;
  contractWarning?: string;
};

type TriggerNodeData = {
  triggers: WorkflowTriggerDef[];
};

type AppNode = Node<StepNodeData, "step"> | Node<TriggerNodeData, "trigger">;

interface Props {
  workflow: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
}

function StepNode({ data, id, selected }: { data: StepNodeData; id: string; selected: boolean }) {
  const { step, contractWarning } = data;
  const label = stepLabel(step);
  const isCondition = step.type === "condition";
  return (
    <div className={`wf-node wf-node-${step.type}${selected ? " wf-node-selected" : ""}`}>
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="wf-node-type">{STEP_TYPE_LABELS[step.type]}</div>
      <div className="wf-node-name">{step.name || <em>(unnamed)</em>}</div>
      {label && <div className="wf-node-label">{label}</div>}
      {contractWarning && (
        <div className="wf-node-warning" title={contractWarning}>
          ⚠ {contractWarning}
        </div>
      )}
      {isCondition ? (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="true"
            className="wf-handle wf-handle-true"
            style={{ top: "35%" }}
          />
          <span className="wf-handle-label wf-handle-label-true">true</span>
          <Handle
            type="source"
            position={Position.Right}
            id="false"
            className="wf-handle wf-handle-false"
            style={{ top: "75%" }}
          />
          <span className="wf-handle-label wf-handle-label-false">false</span>
        </>
      ) : (
        <Handle type="source" position={Position.Right} className="wf-handle" />
      )}
      <span className="wf-node-id" data-step-id={id} />
    </div>
  );
}

function TriggerNode({ data, selected }: { data: TriggerNodeData; selected: boolean }) {
  const t = data.triggers[0];
  const summary = t ? triggerSummary(t) : "manual";
  return (
    <div className={`wf-node wf-node-trigger${selected ? " wf-node-selected" : ""}`}>
      <div className="wf-node-type">Trigger</div>
      <div className="wf-node-name">When this fires</div>
      <div className="wf-node-label">{summary}</div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

function stepLabel(step: WorkflowStepDef): string {
  return describeStep(step);
}

function triggerSummary(t: WorkflowTriggerDef): string {
  switch (t.kind) {
    case "manual":
      return "Manual run";
    case "cron":
      return describeCron(t.schedule);
    case "tool_called":
      return `When tool: ${t.tool || "(none)"}`;
    case "document_event":
      return `On document ${t.events.join(" / ") || "(none)"}`;
    case "config_event":
      return `On config change ${t.path ? `(${t.path})` : ""}`.trim();
    case "file_drop":
      return `Watch ${t.path}${t.extensions ? ` (${t.extensions})` : ""}`;
    case "webhook":
      return `Webhook${t.token ? " (auth)" : ""}`;
    case "email_message":
      return `Email: ${t.query.slice(0, 32) || "(no query)"}`;
    case "calendar_event":
      return `Calendar ${t.beforeMinutes ?? 15}m before${t.titleContains ? ` (${t.titleContains})` : ""}`;
    case "rss":
      return `RSS ${t.url}${t.matchTitle ? ` (title~"${t.matchTitle}")` : ""}`;
    case "geofence":
      return `Geofence ${t.center.lat.toFixed(3)},${t.center.lng.toFixed(3)} r=${t.radiusMeters}m`;
    case "weather":
      return `Weather ${t.field} ${t.op} ${t.threshold} @ ${t.lat.toFixed(2)},${t.lng.toFixed(2)}`;
    case "sensor":
      return `Sensor ${t.valuePath} ${t.op} ${t.threshold}`;
    case "finance":
      return `${t.symbol.toUpperCase()} ${t.cross} ${t.threshold}`;
    case "home_assistant":
      return `HA ${t.entityId}`;
  }
}

function checkContractCompatibility(
  src: WorkflowStepDef,
  dst: WorkflowStepDef,
): string | undefined {
  const out = src.outputContract;
  const inp = dst.inputContract;
  if (!out || !inp) return undefined;
  if (out.kind !== inp.kind) {
    return `output (${out.kind}) ≠ input (${inp.kind})`;
  }
  if (out.kind === "choice" && inp.kind === "choice") {
    const allowed = new Set(inp.choices);
    const missing = out.choices.filter((c) => !allowed.has(c));
    if (missing.length > 0) return `choices not accepted: ${missing.join(", ")}`;
  }
  return undefined;
}

function topoSortSteps(
  steps: WorkflowStepDef[],
  edges: WorkflowGraphEdge[],
): WorkflowStepDef[] {
  const byName = new Map(steps.map((s) => [s.name, s]));
  const incoming = new Map<string, Set<string>>();
  for (const s of steps) incoming.set(s.name, new Set());
  for (const e of edges) {
    if (e.from === TRIGGER_NODE_ID) continue;
    if (!byName.has(e.from) || !byName.has(e.to)) continue;
    incoming.get(e.to)!.add(e.from);
  }
  const ready: string[] = [];
  for (const [name, ins] of incoming) {
    if (ins.size === 0) ready.push(name);
  }
  const result: WorkflowStepDef[] = [];
  const visited = new Set<string>();
  while (ready.length > 0) {
    const name = ready.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const step = byName.get(name);
    if (step) result.push(step);
    for (const e of edges) {
      if (e.from !== name) continue;
      const targetIns = incoming.get(e.to);
      if (!targetIns) continue;
      targetIns.delete(name);
      if (targetIns.size === 0) ready.push(e.to);
    }
  }
  if (result.length !== steps.length) {
    const seen = new Set(result.map((s) => s.name));
    for (const s of steps) if (!seen.has(s.name)) result.push(s);
  }
  return result;
}

function autoLayout(steps: WorkflowStepDef[]): WorkflowGraphNode[] {
  return steps.map((s, i) => ({
    stepName: s.name,
    position: { x: 240 + i * 220, y: 80 },
  }));
}

function autoEdges(steps: WorkflowStepDef[]): WorkflowGraphEdge[] {
  const edges: WorkflowGraphEdge[] = [];
  if (steps.length > 0) edges.push({ from: TRIGGER_NODE_ID, to: steps[0].name });
  for (let i = 1; i < steps.length; i++) {
    edges.push({ from: steps[i - 1].name, to: steps[i].name });
  }
  return edges;
}

const nodeTypes: NodeTypes = {
  step: StepNode as unknown as NodeTypes[string],
  trigger: TriggerNode as unknown as NodeTypes[string],
};

export function WorkflowGraph({ workflow, onChange }: Props) {
  return (
    <ReactFlowProvider>
      <WorkflowGraphInner workflow={workflow} onChange={onChange} />
    </ReactFlowProvider>
  );
}

type Selection =
  | { kind: "none" }
  | { kind: "trigger" }
  | { kind: "step"; name: string };

function buildFlowNodes(workflow: WorkflowDefinition, selection: Selection): AppNode[] {
  const graph = workflow.graph ?? {
    nodes: autoLayout(workflow.steps),
    edges: autoEdges(workflow.steps),
  };
  const positions = new Map<string, { x: number; y: number }>();
  for (const n of graph.nodes) positions.set(n.stepName, n.position);

  const byName = new Map(workflow.steps.map((s) => [s.name, s]));
  const warnings = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.from === TRIGGER_NODE_ID) continue;
    const src = byName.get(e.from);
    const dst = byName.get(e.to);
    if (!src || !dst) continue;
    const issue = checkContractCompatibility(src, dst);
    if (issue) warnings.set(e.to, issue);
  }

  const ns: AppNode[] = [];
  ns.push({
    id: TRIGGER_NODE_ID,
    type: "trigger",
    position: { x: 0, y: 80 },
    data: { triggers: workflow.triggers ?? [] },
    selected: selection.kind === "trigger",
  });
  for (const step of workflow.steps) {
    ns.push({
      id: step.name,
      type: "step",
      position: positions.get(step.name) ?? { x: 240, y: 80 },
      data: { step, contractWarning: warnings.get(step.name) },
      selected: selection.kind === "step" && selection.name === step.name,
    });
  }
  return ns;
}

function buildFlowEdges(workflow: WorkflowDefinition): Edge[] {
  const graph = workflow.graph ?? {
    nodes: autoLayout(workflow.steps),
    edges: autoEdges(workflow.steps),
  };
  return graph.edges.map((e, i) => ({
    id: `${e.from}->${e.to}-${e.sourceHandle ?? ""}-${i}`,
    source: e.from,
    target: e.to,
    sourceHandle: e.sourceHandle,
    animated: false,
    label: e.sourceHandle,
  }));
}

/**
 * Keep each condition step's `then` / `else` arrays in lockstep with the
 * graph edges that emerge from it via the matching sourceHandle. Edges are
 * the visual source of truth; this projects them back onto the step config
 * so the engine (which still reads step.then/else) executes the right branch.
 */
function syncConditionBranches(
  steps: WorkflowStepDef[],
  edges: WorkflowGraphEdge[],
): WorkflowStepDef[] {
  return steps.map((s) => {
    if (s.type !== "condition") return s;
    const thenTargets: string[] = [];
    const elseTargets: string[] = [];
    for (const e of edges) {
      if (e.from !== s.name) continue;
      if (e.sourceHandle === "true") thenTargets.push(e.to);
      else if (e.sourceHandle === "false") elseTargets.push(e.to);
    }
    return { ...s, then: thenTargets, else: elseTargets };
  });
}

function WorkflowGraphInner({ workflow, onChange }: Props) {
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  // Local graph state. The parent's `workflow` is the persistence shape; this
  // local state is what xyflow renders. We sync them at well-defined moments
  // (workflow identity change, drag stop, edge change, connect) — NOT on every
  // drag tick, which is what caused the controlled-state race that made nodes
  // flicker mid-drag.
  const [flowNodes, setFlowNodes] = useState<AppNode[]>(() => buildFlowNodes(workflow, { kind: "none" }));
  const [flowEdges, setFlowEdges] = useState<Edge[]>(() => buildFlowEdges(workflow));

  // Re-derive local graph state when the parent's workflow object changes
  // identity. This fires after dragStop / edge change / step add — all benign,
  // since the parent now mirrors our local state. It does NOT fire during a
  // drag, because we no longer commit position-ticks to the parent.
  useEffect(() => {
    setFlowNodes(buildFlowNodes(workflow, selection));
    setFlowEdges(buildFlowEdges(workflow));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow]);

  // Mirror selection changes onto existing flowNodes without rebuilding them,
  // so selecting a node doesn't reset positions while a future drag is in flight.
  useEffect(() => {
    setFlowNodes((cur) =>
      cur.map((n) =>
        n.id === TRIGGER_NODE_ID
          ? { ...n, selected: selection.kind === "trigger" }
          : { ...n, selected: selection.kind === "step" && selection.name === n.id },
      ),
    );
  }, [selection]);

  // Click-outside dismissal for the floating add-step menu.
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as globalThis.Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [addMenuOpen]);

  const commitGraph = useCallback(
    (nextGraph: { nodes: WorkflowGraphNode[]; edges: WorkflowGraphEdge[] }) => {
      // Sync condition step branches from edges before topo-sorting, so steps
      // and edges stay consistent for both runtime and the next render.
      const syncedSteps = syncConditionBranches(workflow.steps, nextGraph.edges);
      const orderedSteps = topoSortSteps(syncedSteps, nextGraph.edges);
      onChange({ ...workflow, steps: orderedSteps, graph: nextGraph });
    },
    [onChange, workflow],
  );

  /**
   * Cycle detection: does an edge from `source` to `target` introduce a
   * back-edge in the current directed graph? Walks reachable-from-`target`
   * looking for `source`. Excludes the trigger node since it has no inputs.
   */
  const wouldIntroduceCycle = useCallback(
    (source: string, target: string): boolean => {
      if (source === target) return true;
      if (source === TRIGGER_NODE_ID) return false;
      const adjacency = new Map<string, string[]>();
      for (const e of flowEdges) {
        if (!adjacency.has(e.source)) adjacency.set(e.source, []);
        adjacency.get(e.source)!.push(String(e.target));
      }
      const stack = [target];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (cur === source) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const next = adjacency.get(cur);
        if (next) stack.push(...next);
      }
      return false;
    },
    [flowEdges],
  );

  /**
   * Reject a connection attempt if it would create a cycle, or if the two
   * steps have explicit contracts that don't match. Contracts are also
   * surfaced as soft warnings on the target node — this is the hard-stop.
   */
  const isValidConnection = useCallback(
    (params: Connection | Edge): boolean => {
      const source = String(params.source ?? "");
      const target = String(params.target ?? "");
      if (!source || !target) return false;
      if (wouldIntroduceCycle(source, target)) return false;

      // Don't validate contracts on the trigger node — it has no outputContract.
      if (source === TRIGGER_NODE_ID) return true;
      const srcStep = workflow.steps.find((s) => s.name === source);
      const dstStep = workflow.steps.find((s) => s.name === target);
      if (!srcStep || !dstStep) return false;

      const issue = checkContractCompatibility(srcStep, dstStep);
      return !issue;
    },
    [workflow.steps, wouldIntroduceCycle],
  );

  // Position changes (dragging) update only local state. Selection changes
  // route through `setSelection` so the inspector follows along. Crucially,
  // we never call `commitGraph` here — that's the whole flicker fix.
  const onNodesChange = useCallback((changes: NodeChange<AppNode>[]) => {
    setFlowNodes((cur) => applyNodeChanges(changes, cur));

    const selChange = changes.find((c) => c.type === "select");
    if (selChange && selChange.type === "select") {
      if (selChange.selected) {
        if (selChange.id === TRIGGER_NODE_ID) setSelection({ kind: "trigger" });
        else setSelection({ kind: "step", name: selChange.id });
      } else {
        setSelection((prev) => {
          if (prev.kind === "trigger" && selChange.id === TRIGGER_NODE_ID) return { kind: "none" };
          if (prev.kind === "step" && prev.name === selChange.id) return { kind: "none" };
          return prev;
        });
      }
    }
  }, []);

  // Fires once when the user releases the drag. Commit the new positions to
  // the parent so they survive save/reload.
  const onNodeDragStop = useCallback(() => {
    setFlowNodes((cur) => {
      const positions: WorkflowGraphNode[] = cur
        .filter((n) => n.id !== TRIGGER_NODE_ID)
        .map((n) => ({ stepName: n.id, position: n.position }));
      const currentEdges: WorkflowGraphEdge[] =
        workflow.graph?.edges ?? autoEdges(workflow.steps);
      commitGraph({ nodes: positions, edges: currentEdges });
      return cur;
    });
  }, [workflow, commitGraph]);

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      setFlowEdges((cur) => {
        const next = applyEdgeChanges(changes, cur);
        const edges: WorkflowGraphEdge[] = next.map((e) => ({
          from: String(e.source),
          to: String(e.target),
          sourceHandle: e.sourceHandle ?? undefined,
        }));
        const positions: WorkflowGraphNode[] = flowNodes
          .filter((n) => n.id !== TRIGGER_NODE_ID)
          .map((n) => ({ stepName: n.id, position: n.position }));
        commitGraph({ nodes: positions, edges });
        return next;
      });
    },
    [flowNodes, commitGraph],
  );

  const onConnect = useCallback(
    (params: Connection) => {
      setFlowEdges((cur) => {
        const next = addEdge(params, cur);
        const edges: WorkflowGraphEdge[] = next.map((e) => ({
          from: String(e.source),
          to: String(e.target),
          sourceHandle: e.sourceHandle ?? undefined,
        }));
        const positions: WorkflowGraphNode[] = flowNodes
          .filter((n) => n.id !== TRIGGER_NODE_ID)
          .map((n) => ({ stepName: n.id, position: n.position }));
        commitGraph({ nodes: positions, edges });
        return next;
      });
    },
    [flowNodes, commitGraph],
  );

  /**
   * xyflow fires this when the user hits Delete on selected nodes. We map
   * the deleted ids back to workflow steps and commit a new workflow.
   * Trigger node deletion is ignored (it's a fixed entry point).
   */
  const onNodesDelete = useCallback(
    (deleted: AppNode[]) => {
      const idsToDelete = new Set(
        deleted.filter((n) => n.id !== TRIGGER_NODE_ID).map((n) => n.id),
      );
      if (idsToDelete.size === 0) return;
      const remainingSteps = workflow.steps.filter((s) => !idsToDelete.has(s.name));
      const remainingNodes = (workflow.graph?.nodes ?? autoLayout(workflow.steps)).filter(
        (n) => !idsToDelete.has(n.stepName),
      );
      const remainingEdges = (workflow.graph?.edges ?? autoEdges(workflow.steps)).filter(
        (e) => !idsToDelete.has(e.from) && !idsToDelete.has(e.to),
      );
      onChange({
        ...workflow,
        steps: remainingSteps,
        graph: { nodes: remainingNodes, edges: remainingEdges },
      });
      setSelection((prev) =>
        prev.kind === "step" && idsToDelete.has(prev.name) ? { kind: "none" } : prev,
      );
    },
    [workflow, onChange],
  );

  // Snapshot the persisted graph (used by mutations that need a stable view of
  // edges; positions are sourced from flowNodes so any in-flight drag survives).
  const currentEdges: WorkflowGraphEdge[] =
    workflow.graph?.edges ?? autoEdges(workflow.steps);

  const livePositions = useCallback((): WorkflowGraphNode[] => {
    return flowNodes
      .filter((n) => n.id !== TRIGGER_NODE_ID)
      .map((n) => ({ stepName: n.id, position: n.position }));
  }, [flowNodes]);

  const addStepNode = useCallback(
    (type: WorkflowStepType) => {
      const step = blankStep(type);
      const existing = new Set(workflow.steps.map((s) => s.name));
      while (existing.has(step.name)) step.name = `${type}_${Math.random().toString(36).slice(2, 6)}`;
      const positions = livePositions();
      const xs = positions.map((n) => n.position.x);
      const ys = positions.map((n) => n.position.y);
      const x = (xs.length ? Math.max(...xs) : 240) + 220;
      const y = ys.length ? Math.min(...ys) : 80;
      const newNode: WorkflowGraphNode = { stepName: step.name, position: { x, y } };
      onChange({
        ...workflow,
        steps: [...workflow.steps, step],
        graph: {
          nodes: [...positions, newNode],
          edges: currentEdges,
        },
      });
      setSelection({ kind: "step", name: step.name });
      setAddMenuOpen(false);
    },
    [workflow, currentEdges, livePositions, onChange],
  );

  const updateStep = useCallback(
    (name: string, next: WorkflowStepDef) => {
      const oldName = name;
      const renamed = next.name !== oldName;
      const nextSteps = workflow.steps.map((s) => (s.name === oldName ? next : s));
      const nextNodes: WorkflowGraphNode[] = livePositions().map((n) =>
        n.stepName === oldName ? { ...n, stepName: next.name } : n,
      );
      const nextEdges: WorkflowGraphEdge[] = currentEdges.map((e) => ({
        from: e.from === oldName ? next.name : e.from,
        to: e.to === oldName ? next.name : e.to,
      }));
      onChange({
        ...workflow,
        steps: nextSteps,
        graph: { nodes: nextNodes, edges: nextEdges },
      });
      if (renamed && selection.kind === "step" && selection.name === oldName) {
        setSelection({ kind: "step", name: next.name });
      }
    },
    [workflow, currentEdges, livePositions, onChange, selection],
  );

  const removeStep = useCallback(
    (name: string) => {
      const nextSteps = workflow.steps.filter((s) => s.name !== name);
      const nextNodes = livePositions().filter((n) => n.stepName !== name);
      const nextEdges = currentEdges.filter((e) => e.from !== name && e.to !== name);
      onChange({
        ...workflow,
        steps: nextSteps,
        graph: { nodes: nextNodes, edges: nextEdges },
      });
      if (selection.kind === "step" && selection.name === name) setSelection({ kind: "none" });
    },
    [workflow, currentEdges, livePositions, onChange, selection],
  );

  const selectedStep =
    selection.kind === "step" ? workflow.steps.find((s) => s.name === selection.name) : null;

  return (
    <div className="wf-graph-layout">
      <div className="wf-graph-canvas">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onNodesDelete={onNodesDelete}
          isValidConnection={isValidConnection}
          deleteKeyCode={["Delete", "Backspace"]}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>

        {/* Floating add-step menu, anchored to the canvas */}
        <div className="wf-graph-add-anchor" ref={addMenuRef}>
          <button
            type="button"
            className="wf-graph-add-trigger"
            onClick={() => setAddMenuOpen((o) => !o)}
            aria-expanded={addMenuOpen}
          >
            + Add step
          </button>
          {addMenuOpen && (
            <div className="wf-graph-add-menu" role="menu">
              {STEP_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="menuitem"
                  className="wf-graph-add-menu-item"
                  onClick={() => addStepNode(t)}
                >
                  {STEP_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <aside className="wf-inspector">
        <header className="wf-inspector-header">
          <h4>{inspectorTitle(selection, selectedStep ? selectedStep.name : null)}</h4>
        </header>
        <div className="wf-inspector-body">
          {selection.kind === "none" && (
            <WorkflowMetaPanel workflow={workflow} onChange={onChange} />
          )}
          {selection.kind === "trigger" && (
            <TriggerEditor
              triggers={workflow.triggers ?? []}
              workflowName={workflow.name}
              onChange={(triggers) => onChange({ ...workflow, triggers })}
            />
          )}
          {selection.kind === "step" && selectedStep && (
            <>
              <WorkflowStepEditor
                step={selectedStep}
                onChange={(next) => updateStep(selectedStep.name, next)}
                onRemove={() => removeStep(selectedStep.name)}
                trigger={(workflow.triggers ?? [])[0]}
                siblingSteps={workflow.steps}
              />
              <div className="wf-inspector-danger">
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => removeStep(selectedStep.name)}
                >
                  Delete step
                </button>
                <p className="wf-inspector-danger-hint">
                  Or select the node on the canvas and press Delete / Backspace.
                </p>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function inspectorTitle(sel: Selection, stepName: string | null): string {
  if (sel.kind === "none") return "Workflow";
  if (sel.kind === "trigger") return "Trigger";
  return `Step: ${stepName ?? sel.name}`;
}

function WorkflowMetaPanel({
  workflow,
  onChange,
}: {
  workflow: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
}) {
  return (
    <div>
      <p className="wf-inspector-hint">Click a node to edit it, or drag to connect steps.</p>
      <div className="field-group">
        <label className="field-label">Name</label>
        <input className="field-input" value={workflow.name} readOnly title="Rename a workflow by deleting and recreating." />
      </div>
      <div className="field-group">
        <label className="field-label">Description</label>
        <textarea
          className="field-textarea"
          rows={3}
          value={workflow.description ?? ""}
          onChange={(e) => onChange({ ...workflow, description: e.target.value })}
          placeholder="What this pipeline does"
        />
      </div>
      <div className="field-group">
        <label className="field-label">Deadline (ms, optional)</label>
        <input
          className="field-input"
          type="number"
          value={workflow.deadlineMs ?? ""}
          onChange={(e) =>
            onChange({
              ...workflow,
              deadlineMs: e.target.value ? Number(e.target.value) : undefined,
            })
          }
          placeholder="(none)"
        />
      </div>
      <div className="field-group">
        <label className="field-label">Execution mode</label>
        <select
          className="field-select"
          value={workflow.executionMode ?? "linear"}
          onChange={(e) =>
            onChange({ ...workflow, executionMode: e.target.value as "linear" | "graph" })
          }
        >
          <option value="linear">Linear (run steps in order)</option>
          <option value="graph">Graph (run independent branches in parallel)</option>
        </select>
        <div className="wf-field-hint">
          Graph mode reads <code>graph.edges</code> and fans out siblings concurrently. Use linear if
          your steps depend on the previous one's <code>${"{prev}"}</code> output.
        </div>
      </div>
      <InputsSchemaEditor
        inputs={workflow.inputs ?? {}}
        onChange={(next) =>
          onChange({ ...workflow, inputs: Object.keys(next).length > 0 ? next : undefined })
        }
      />
      <SecretsPanel workflowName={workflow.name} />
      <VersionsPanel workflowName={workflow.name} />
      <div className="wf-inspector-meta">
        <div>{workflow.steps.length} step{workflow.steps.length === 1 ? "" : "s"}</div>
        <div>
          {(workflow.triggers?.length ?? 0)} trigger{(workflow.triggers?.length ?? 0) === 1 ? "" : "s"}{" "}
          configured
        </div>
      </div>
    </div>
  );
}

/**
 * Inline editor for the workflow's declared `inputs:` schema. Each row is a
 * name + type pair with sensible per-type options (required, default, enum
 * values for strings, min/max for numbers). The schema feeds both the Run
 * dialog and server-side payload validation, so getting it right here pays
 * off both for users and external HTTP callers.
 */
function InputsSchemaEditor({
  inputs,
  onChange,
}: {
  inputs: Record<string, import("../api").WorkflowInputSchema>;
  onChange: (next: Record<string, import("../api").WorkflowInputSchema>) => void;
}) {
  const entries = Object.entries(inputs);
  function setField(name: string, field: import("../api").WorkflowInputSchema) {
    onChange({ ...inputs, [name]: field });
  }
  function removeField(name: string) {
    const next = { ...inputs };
    delete next[name];
    onChange(next);
  }
  function renameField(oldName: string, newName: string) {
    if (!newName || newName === oldName || inputs[newName]) return;
    const next: Record<string, import("../api").WorkflowInputSchema> = {};
    for (const [k, v] of Object.entries(inputs)) {
      next[k === oldName ? newName : k] = v;
    }
    onChange(next);
  }
  function addField() {
    let n = 1;
    let name = `field_${n}`;
    while (inputs[name]) name = `field_${++n}`;
    onChange({ ...inputs, [name]: { type: "string" } });
  }

  return (
    <div className="field-group">
      <div className="wf-inspector-section-header">
        <label className="field-label">Inputs (run dialog form)</label>
        <button type="button" className="btn-ghost btn-small" onClick={addField}>+ Add input</button>
      </div>
      {entries.length === 0 && (
        <div className="wf-field-hint">
          No inputs declared. The Run button fires the workflow immediately. Add inputs to require
          the user (or HTTP caller) to supply specific values like a URL or document text.
        </div>
      )}
      {entries.map(([name, field]) => (
        <div key={name} className="wf-input-row">
          <input
            className="field-input wf-input-name"
            value={name}
            onChange={(e) => renameField(name, e.target.value.replace(/\s+/g, "_"))}
            placeholder="field_name"
          />
          <select
            className="field-select"
            value={field.type}
            onChange={(e) => setField(name, { ...field, type: e.target.value as typeof field.type })}
          >
            {(["string", "number", "boolean", "date", "file", "json"] as const).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <label className="field-row" title="Required">
            <input
              type="checkbox"
              checked={field.required ?? false}
              onChange={(e) => setField(name, { ...field, required: e.target.checked || undefined })}
            />
            <span className="field-inline-label">required</span>
          </label>
          <button type="button" className="btn-ghost btn-small" onClick={() => removeField(name)}>×</button>
        </div>
      ))}
    </div>
  );
}

/**
 * Per-workflow secrets management. Values are write-only — the panel shows
 * only the list of key names plus when each was last set. Reference a secret
 * inside any string field via `${secrets.NAME}`. Encryption uses a key derived
 * from `TAI_SECRETS_KEY` or an auto-generated key file under the data dir.
 */
function SecretsPanel({ workflowName }: { workflowName: string }) {
  const [secrets, setSecrets] = useState<SecretRecord[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    listWorkflowSecrets(workflowName)
      .then((r) => setSecrets(r.secrets))
      .catch(() => setSecrets([]));
  }, [workflowName, reloadTick]);

  async function save() {
    const key = newKey.trim();
    if (!key) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      setStatus("Key must be a valid identifier");
      return;
    }
    const r = await setWorkflowSecret(workflowName, key, newValue);
    if (r.error) {
      setStatus(r.error);
      return;
    }
    setNewKey("");
    setNewValue("");
    setStatus("Saved");
    setReloadTick((n) => n + 1);
    setTimeout(() => setStatus(null), 1500);
  }

  async function remove(key: string) {
    if (!confirm(`Delete secret "${key}"?`)) return;
    await deleteWorkflowSecret(workflowName, key);
    setReloadTick((n) => n + 1);
  }

  return (
    <div className="field-group">
      <div className="wf-inspector-section-header">
        <label className="field-label">Secrets (write-only)</label>
      </div>
      <div className="wf-field-hint">
        Reference with <code>${"${secrets.NAME}"}</code> in any string field. Values are encrypted
        at rest and never echoed back; UI only shows key names.
      </div>
      {secrets.length === 0 && (
        <div className="wf-field-hint">No secrets stored for this workflow yet.</div>
      )}
      {secrets.map((s) => (
        <div key={s.key} className="wf-secret-row">
          <code className="wf-secret-key">{s.key}</code>
          <span className="wf-secret-meta">updated {new Date(s.updated_at).toLocaleString()}</span>
          <button type="button" className="btn-ghost btn-small" onClick={() => remove(s.key)}>×</button>
        </div>
      ))}
      <div className="wf-secret-row">
        <input
          className="field-input wf-secret-key-input"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="KEY_NAME"
        />
        <input
          className="field-input"
          type="password"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder="value"
        />
        <button type="button" className="btn-secondary btn-small" onClick={save}>
          Save
        </button>
      </div>
      {status && <div className="wf-field-hint">{status}</div>}
    </div>
  );
}

/**
 * Version history panel: shows the last N snapshots of this workflow's YAML
 * along with a Restore button. Snapshots are taken on every save; the active
 * file on disk is also the highest-numbered version.
 */
function VersionsPanel({ workflowName }: { workflowName: string }) {
  const [versions, setVersions] = useState<WorkflowVersionSummary[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    listWorkflowVersions(workflowName)
      .then((r) => setVersions(r.versions))
      .catch(() => setVersions([]));
  }, [workflowName, reloadTick]);

  async function restore(version: number) {
    if (!confirm(`Restore version ${version}? This will overwrite the current file (and snapshot the current state first).`)) return;
    const r = await restoreWorkflowVersion(workflowName, version);
    if (r.error) {
      setStatus(r.error);
      return;
    }
    setStatus(`Restored to version ${version}. Reload the workflow to see changes.`);
    setReloadTick((n) => n + 1);
    setTimeout(() => setStatus(null), 3000);
  }

  return (
    <div className="field-group">
      <div className="wf-inspector-section-header">
        <label className="field-label">Version history</label>
      </div>
      {versions.length === 0 && (
        <div className="wf-field-hint">No saves yet — save this workflow to start tracking versions.</div>
      )}
      {versions.map((v) => (
        <div key={v.version} className="wf-version-row">
          <code className="wf-version-num">v{v.version}</code>
          <span className="wf-version-meta">
            {new Date(v.saved_at).toLocaleString()}
            {v.saved_by ? ` (${v.saved_by})` : ""}
          </span>
          <button type="button" className="btn-ghost btn-small" onClick={() => restore(v.version)}>
            Restore
          </button>
        </div>
      ))}
      {status && <div className="wf-field-hint">{status}</div>}
    </div>
  );
}

/**
 * Single-trigger editor. Underlying storage is still `triggers: []` for forward
 * compat, but the UI exposes only one. Empty array = manual-only.
 */
function TriggerEditor({
  triggers,
  workflowName,
  onChange,
}: {
  triggers: WorkflowTriggerDef[];
  workflowName: string;
  onChange: (next: WorkflowTriggerDef[]) => void;
}) {
  const meta = useWorkflowMetadata();
  const trigger: WorkflowTriggerDef = triggers[0] ?? { kind: "manual" };

  const setTrigger = (next: WorkflowTriggerDef) => onChange([next]);

  const changeKind = (kind: WorkflowTriggerDef["kind"]) => {
    if (kind === trigger.kind) return;
    const fresh: WorkflowTriggerDef =
      kind === "manual"
        ? { kind: "manual" }
        : kind === "cron"
          ? { kind: "cron", schedule: "0 9 * * *" }
          : kind === "tool_called"
            ? { kind: "tool_called", tool: "" }
            : kind === "document_event"
              ? { kind: "document_event", events: ["created"] }
              : kind === "file_drop"
                ? { kind: "file_drop", path: "./inbox" }
                : kind === "webhook"
                  ? { kind: "webhook" }
                  : kind === "email_message"
                    ? { kind: "email_message", query: "is:unread newer_than:1h" }
                    : kind === "calendar_event"
                      ? { kind: "calendar_event", beforeMinutes: 15 }
                      : { kind: "config_event" };
    setTrigger(fresh);
  };

  const help = TRIGGER_HELP[trigger.kind];

  return (
    <div>
      <div className="field-group">
        <label className="field-label">When should this workflow run?</label>
        <select
          className="field-select"
          value={trigger.kind}
          onChange={(e) => changeKind(e.target.value as WorkflowTriggerDef["kind"])}
        >
          {(Object.keys(TRIGGER_KIND_LABELS) as Array<WorkflowTriggerDef["kind"]>).map((k) => (
            <option key={k} value={k}>{TRIGGER_KIND_LABELS[k]}</option>
          ))}
        </select>
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
          </div>
        </div>
      </div>

      {trigger.kind === "cron" && (
        <CronEditor
          schedule={trigger.schedule}
          onChange={(schedule) => setTrigger({ kind: "cron", schedule })}
        />
      )}
      {trigger.kind === "tool_called" && (
        <div className="field-group">
          <label className="field-label">Tool to watch</label>
          <select
            className="field-select"
            value={meta.tools.includes(trigger.tool) || trigger.tool === "" ? trigger.tool : "__custom__"}
            onChange={(e) => {
              if (e.target.value === "__custom__") return;
              setTrigger({ kind: "tool_called", tool: e.target.value });
            }}
          >
            <option value="">— select a tool —</option>
            {meta.tools.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
            <option value="__custom__">Custom…</option>
          </select>
          {(!meta.tools.includes(trigger.tool) && trigger.tool !== "") && (
            <input
              className="field-input"
              value={trigger.tool}
              onChange={(e) => setTrigger({ kind: "tool_called", tool: e.target.value })}
              placeholder="tool name"
            />
          )}
        </div>
      )}
      {trigger.kind === "document_event" && (
        <div className="field-group">
          <label className="field-label">Which document events?</label>
          <div className="wf-checkbox-group">
            {DOC_EVENTS.map((ev) => (
              <label key={ev} className="wf-checkbox-row">
                <input
                  type="checkbox"
                  checked={trigger.events.includes(ev)}
                  onChange={(e) => {
                    const next = new Set(trigger.events);
                    if (e.target.checked) next.add(ev);
                    else next.delete(ev);
                    setTrigger({ kind: "document_event", events: Array.from(next) });
                  }}
                />
                <span>{ev.charAt(0).toUpperCase() + ev.slice(1)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {trigger.kind === "config_event" && (
        <div className="field-group">
          <label className="field-label">Config path (optional)</label>
          <input
            className="field-input"
            value={trigger.path ?? ""}
            onChange={(e) =>
              setTrigger({ kind: "config_event", path: e.target.value || undefined })
            }
            placeholder="e.g. agent.temperature (leave blank for any change)"
          />
        </div>
      )}
      {trigger.kind === "file_drop" && (
        <>
          <div className="field-group">
            <label className="field-label">Watch directory</label>
            <input
              className="field-input"
              value={trigger.path}
              onChange={(e) =>
                setTrigger({ ...trigger, path: e.target.value })
              }
              placeholder="./inbox  (relative to tai's cwd)"
            />
            <div className="wf-field-hint">
              Directory is created if it doesn't exist. Each new (or modified) file fires the
              workflow once it stays unchanged for the debounce window.
            </div>
          </div>
          <div className="field-group">
            <label className="field-label">Extension filter (optional)</label>
            <input
              className="field-input"
              value={trigger.extensions ?? ""}
              onChange={(e) =>
                setTrigger({ ...trigger, extensions: e.target.value || undefined })
              }
              placeholder="pdf,jpg,png  (leave blank to accept all)"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Stable-for window (ms, optional)</label>
            <input
              className="field-input"
              type="number"
              value={trigger.stableForMs ?? ""}
              onChange={(e) =>
                setTrigger({
                  ...trigger,
                  stableForMs: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              placeholder="1500"
            />
          </div>
        </>
      )}
      {trigger.kind === "webhook" && (
        <WebhookTriggerFields
          token={trigger.token}
          workflowName={workflowName}
          onChange={(token) => setTrigger({ kind: "webhook", token })}
        />
      )}
      {trigger.kind === "email_message" && (
        <>
          <div className="field-group">
            <label className="field-label">Gmail search query</label>
            <input
              className="field-input"
              value={trigger.query}
              onChange={(e) => setTrigger({ ...trigger, query: e.target.value })}
              placeholder="is:unread newer_than:1h from:billing@acme.com"
            />
            <div className="wf-field-hint">
              Uses Gmail's normal search grammar. The poller dedupes by message ID — so even if the
              query keeps matching, each message only fires once.
            </div>
          </div>
          <div className="field-group">
            <label className="field-label">Poll interval (seconds, optional)</label>
            <input
              className="field-input"
              type="number"
              min={30}
              value={trigger.intervalSeconds ?? ""}
              onChange={(e) =>
                setTrigger({
                  ...trigger,
                  intervalSeconds: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              placeholder="300 (5 minutes)"
            />
          </div>
          <div className="wf-field-hint">
            Requires the <code>gmail</code> tool to be enabled in config. The trigger fires per new
            message with <code>${"${input.message_id}"}</code> and{" "}
            <code>${"${input.message_body}"}</code> available to your steps.
          </div>
        </>
      )}
      {trigger.kind === "calendar_event" && (
        <>
          <div className="field-group">
            <label className="field-label">Lead time (minutes before event)</label>
            <input
              className="field-input"
              type="number"
              min={1}
              value={trigger.beforeMinutes ?? ""}
              onChange={(e) =>
                setTrigger({ ...trigger, beforeMinutes: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="15"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Title contains (optional filter)</label>
            <input
              className="field-input"
              value={trigger.titleContains ?? ""}
              onChange={(e) =>
                setTrigger({ ...trigger, titleContains: e.target.value || undefined })
              }
              placeholder="e.g. interview, 1:1, doctor (case-insensitive)"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Calendar (optional)</label>
            <input
              className="field-input"
              value={trigger.calendarId ?? ""}
              onChange={(e) => setTrigger({ ...trigger, calendarId: e.target.value || undefined })}
              placeholder="primary"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Poll interval (seconds, optional)</label>
            <input
              className="field-input"
              type="number"
              min={60}
              value={trigger.intervalSeconds ?? ""}
              onChange={(e) =>
                setTrigger({
                  ...trigger,
                  intervalSeconds: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              placeholder="300"
            />
          </div>
          <div className="wf-field-hint">
            Requires the <code>google_calendar</code> tool to be enabled in config. Fires per event
            with <code>${"${input.summary}"}</code>, <code>${"${input.start}"}</code>, etc.
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Webhook trigger fields: the inbound URL is the same `/api/workflows/:name/run`
 * endpoint regardless of trigger config — we surface it here so users have one
 * spot to grab the URL + optional bearer token to paste into Stripe / Linear /
 * GitHub / wherever. Generating a token is a single click; clearing it removes
 * authentication.
 */
function WebhookTriggerFields({
  token,
  workflowName,
  onChange,
}: {
  token: string | undefined;
  workflowName: string;
  onChange: (next: string | undefined) => void;
}) {
  const url =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/workflows/${encodeURIComponent(workflowName)}/run`
      : `/api/workflows/${encodeURIComponent(workflowName)}/run`;

  function generateToken() {
    // Browser-safe random token (~128 bits of entropy).
    const buf = new Uint8Array(16);
    (window.crypto || (globalThis as { crypto?: Crypto }).crypto)?.getRandomValues(buf);
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
    onChange(hex);
  }

  function copy(text: string) {
    void navigator.clipboard?.writeText(text);
  }

  const curl = token
    ? `curl -X POST ${url} \\\n  -H 'Authorization: Bearer ${token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"input": {}}'`
    : `curl -X POST ${url} \\\n  -H 'Content-Type: application/json' \\\n  -d '{"input": {}}'`;

  return (
    <>
      <div className="field-group">
        <label className="field-label">Inbound URL</label>
        <div className="wf-webhook-row">
          <input className="field-input" value={url} readOnly />
          <button type="button" className="btn-ghost btn-small" onClick={() => copy(url)}>Copy</button>
        </div>
        <div className="wf-field-hint">
          POST a JSON body to this URL. The body becomes <code>${"{input}"}</code> in the workflow scope.
        </div>
      </div>
      <div className="field-group">
        <label className="field-label">Bearer token (optional)</label>
        <div className="wf-webhook-row">
          <input
            className="field-input"
            value={token ?? ""}
            onChange={(e) => onChange(e.target.value || undefined)}
            placeholder="(leave blank for no auth)"
          />
          <button type="button" className="btn-ghost btn-small" onClick={generateToken}>Generate</button>
          {token && (
            <button type="button" className="btn-ghost btn-small" onClick={() => copy(token)}>Copy</button>
          )}
        </div>
        <div className="wf-field-hint">
          When set, inbound calls must present <code>Authorization: Bearer &lt;token&gt;</code> or
          they get a 401.
        </div>
      </div>
      <div className="field-group">
        <label className="field-label">Example cURL</label>
        <pre className="wf-webhook-curl">{curl}</pre>
        <button type="button" className="btn-ghost btn-small" onClick={() => copy(curl)}>Copy</button>
      </div>
    </>
  );
}

/**
 * Cron editor: presets dropdown + an editable schedule field that's only
 * surfaced when the user picks "Custom". A live human-readable preview sits
 * underneath both so they can sanity-check the expression.
 */
function CronEditor({
  schedule,
  onChange,
}: {
  schedule: string;
  onChange: (schedule: string) => void;
}) {
  const presetId = presetIdForSchedule(schedule);
  return (
    <>
      <div className="field-group">
        <label className="field-label">Schedule</label>
        <select
          className="field-select"
          value={presetId}
          onChange={(e) => {
            const id = e.target.value;
            if (id === "custom") return;
            const preset = CRON_PRESETS.find((p) => p.id === id);
            if (preset) onChange(preset.schedule);
          }}
        >
          {CRON_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
          <option value="custom">Custom cron expression…</option>
        </select>
      </div>
      {presetId === "custom" && (
        <div className="field-group">
          <label className="field-label">Cron expression or natural schedule</label>
          <input
            className="field-input"
            value={schedule}
            onChange={(e) => onChange(e.target.value)}
            placeholder='0 9 * * *  or  "every weekday at 9am"'
          />
          <div className="wf-field-hint">
            Cron: <code>minute hour day-of-month month day-of-week</code> (<code>0 9 * * 1-5</code> = weekdays at 9 AM).
            <br />
            Or natural language: <code>every day at 9am</code>, <code>weekdays at 5pm</code>, <code>every 30 minutes</code>,{" "}
            <code>every monday at 8:30am</code>, <code>at noon</code>.
          </div>
        </div>
      )}
      <div className="wf-cron-preview">
        Runs: <strong>{describeCron(schedule)}</strong>
      </div>
    </>
  );
}
