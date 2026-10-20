/**
 * The `build` tool: an agent makes models for the 3D world out of simple
 * parts (`places-models.ts`), and gives a box or a plate a face people use in
 * the room. The `place` tool then adds a model to a room like any kind of
 * thing.
 *
 * A face is a real agent interface (`interface` tool, `docs/agent-interfaces.md`),
 * made as the model's agent when the model is saved, so its query runs as that
 * agent and keeps the scopes it could see, and a tick or a button writes as
 * the person who used it. Remaking a model keeps each face's component when
 * the face is the same, changes it in place when it isn't, and closes the
 * ones a model no longer has, so a face never stops working under someone.
 *
 * Opt-in: the places plugin offers the tool only with `build: true` in its
 * config, so only deployments that want agents building pay for its schema.
 * The ready-made models (a to-do board, a habit tracker, a notes card) need
 * no `build`: `place` adds one by name, making it the agent's own first.
 */
import type { ComponentSpec } from "../content/types.js";
import { boundCardProps, queriedProps } from "../interfaces/bind.js";
import type { InterfaceStore } from "../interfaces/store.js";
import type { StateCaller, StateService } from "../state/service.js";
import { StateConflictError, StateError, type StateRecord } from "../state/types.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";
import { InterfaceTool } from "../tools/interface-tool.js";
import { agentStateCaller } from "../tools/state.js";
import {
  dayIn,
  describeModel,
  FACE_KINDS,
  FACE_TYPES,
  faceArgs,
  facesOf,
  HABIT_TYPE,
  habitTurnover,
  listOf,
  MODEL_LIMITS,
  MODEL_TYPE,
  MOUNTS,
  type Model,
  type ModelFace,
  modelFrom,
  modelId,
  modelLine,
  modelName,
  mountOf,
  nameProblem,
  partsToCopy,
  READY,
  type ReadyModel,
  readyModel,
  sameFace,
} from "./places-models.js";

const ACTIONS = ["list", "show", "make", "add", "remove", "copy", "delete"] as const;

const fail = (error: string): ToolResult => ({ success: false, output: "", error });
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * Something the agent asked for that can't be done, worded for it to act on.
 * A state error, so the `place` tool, which adds models too, passes it back
 * the way it passes back its own.
 */
class BuildError extends StateError {}

/**
 * The models agents keep: reading one, saving one with its faces made live,
 * and making a ready-made one an agent's own. Shared by the `build` tool and
 * the `place` tool, which adds a model to a room by name.
 */
export class ModelShelf {
  constructor(
    private readonly getService: () => StateService,
    /** Where interface components live; without it, a face can't be made live. */
    private readonly getStore: () => InterfaceStore | undefined,
  ) {}

  /** An agent's own model by name, as its record holds it. */
  async get(caller: StateCaller, agent: string, name: string): Promise<{ model: Model; version: number } | undefined> {
    const found = await this.getService()
      .get(caller, { type: MODEL_TYPE, id: modelId(agent, name) })
      .catch(() => null);
    return found ? { model: found.data as unknown as Model, version: found.version } : undefined;
  }

  /** Every model an agent keeps, by name. */
  async mine(caller: StateCaller, agent: string): Promise<Model[]> {
    const found = await this.getService()
      .query(caller, {
        type: MODEL_TYPE,
        scope: `agent:${agent}`,
        orderBy: { field: "createdAt", direction: "asc" },
        limit: 200,
      })
      .catch(() => [] as StateRecord[]);
    return found.map((r) => r.data as unknown as Model);
  }

  /**
   * The model to add to a room by this name: the agent's own, or a ready-made
   * one as it would be the agent's, with `own` to make it so (its records and
   * its face made too). Kept apart so a ready-made model becomes the agent's
   * only once the room has found it a place: a failed add leaves nothing.
   * None when there is no model by that name.
   */
  async forPlacing(
    context: ToolContext,
    agent: string,
    name: string,
  ): Promise<{ model: Model; own?: () => Promise<Model> } | undefined> {
    const found = await this.get(agentStateCaller(context, "place"), agent, name);
    if (found) return { model: found.model };
    const ready = readyModel(name);
    if (!ready) return undefined;
    const model = modelFrom({
      name: ready.name,
      owner: agent,
      mount: ready.mount,
      parts: ready.parts(agent),
      about: ready.about,
      from: ready.name,
    });
    if (typeof model === "string") throw new BuildError(model);
    return {
      model,
      own: async () => {
        await this.seed(context, agent, ready);
        return this.save(context, model);
      },
    };
  }

  /** Make the records a ready-made model's face shows, for an agent that has none yet. */
  async seed(context: ToolContext, agent: string, ready: ReadyModel): Promise<void> {
    const caller = agentStateCaller(context, "place");
    const service = this.getService();
    for (const seed of ready.seeds?.(agent) ?? []) {
      const ref = { type: seed.type, id: seed.id };
      if (!(await service.get(caller, ref).catch(() => null)))
        await service.put(caller, { ...ref, scope: `agent:${agent}`, data: seed.data });
    }
  }

  /**
   * Save a model as the agent: each face made live, or kept, or changed in
   * place from the model it replaces (`was`, at `version`), and the faces it
   * no longer has closed. A face that can't be made live says why, and
   * nothing is saved.
   */
  async save(context: ToolContext, model: Model, was?: { model: Model; version: number }): Promise<Model> {
    const agent = model.owner;
    const caller = agentStateCaller(context, "build");
    const service = this.getService();
    if (!was) {
      const kept = await this.mine(caller, agent);
      if (kept.length >= MODEL_LIMITS.models)
        throw new BuildError(`You keep at most ${MODEL_LIMITS.models} models. Delete one you no longer use first.`);
    }
    const faces = this.interfaces();
    const store = this.getStore();
    const open = (id: string | undefined) => !!id && store?.get(id)?.status === "open";
    const before = was ? facesOf(was.model).map((f) => f.face) : [];
    const made: string[] = [];
    // Each live face changed in place, as it was, to put back if this save fails.
    const changed: ComponentSpec[] = [];
    const used = new Set<string>();
    try {
      for (const [i, { part, face }] of facesOf(model).entries()) {
        if (!faces) throw new BuildError("Faces need TAI's database, and this one runs without it.");
        const prev = before[i];
        if (prev?.component && open(prev.component) && sameFace(prev, face)) {
          face.component = prev.component;
          used.add(prev.component);
          continue;
        }
        const live = prev?.component && open(prev.component) ? store?.get(prev.component) : undefined;
        const reuse = !!live && live.spec.kind === face.kind && sameShape(prev, face);
        const args = reuse
          ? { action: "update", id: prev?.component, ...faceArgs(face) }
          : { action: "send", ...faceArgs(face) };
        const got = await faces.execute(args, context);
        if (!got.success) throw new BuildError(`Part ${part}'s face: ${got.error}`);
        if (reuse && live) changed.push(live.spec);
        const id = (typeof got.output === "object" ? (got.output.structured as { componentId?: string }) : undefined)
          ?.componentId;
        if (!id) throw new BuildError(`Part ${part}'s face couldn't be made live.`);
        face.component = id;
        used.add(id);
        if (!reuse) made.push(id);
      }
      await service.put(
        caller,
        {
          type: MODEL_TYPE,
          id: modelId(agent, model.name),
          scope: `agent:${agent}`,
          data: model as unknown as Record<string, unknown>,
        },
        was?.version,
      );
    } catch (err) {
      // Nothing was saved: what was made live for it stops taking clicks, and what was changed is as it was.
      for (const id of made) await faces?.execute({ action: "close", id }, context);
      for (const spec of changed) store?.update(spec);
      throw err;
    }
    for (const prev of before)
      if (prev.component && !used.has(prev.component) && open(prev.component))
        await faces?.execute(
          { action: "close", id: prev.component, note: "This face was taken off its model." },
          context,
        );
    return model;
  }

  /** Delete an agent's model, closing its faces. */
  async remove(context: ToolContext, found: { model: Model; version: number }): Promise<void> {
    const caller = agentStateCaller(context, "build");
    await this.getService().delete(
      caller,
      { type: MODEL_TYPE, id: modelId(found.model.owner, found.model.name) },
      found.version,
    );
    const faces = this.interfaces();
    for (const { face } of facesOf(found.model))
      if (face.component && this.getStore()?.get(face.component)?.status === "open")
        await faces?.execute({ action: "close", id: face.component, note: "Its model was deleted." }, context);
  }

  /** The interface tool, which makes a face live exactly as an agent's own `interface` call would. */
  private interfaces(): InterfaceTool | undefined {
    const store = this.getStore();
    return store ? new InterfaceTool(() => store, this.getService) : undefined;
  }
}

/**
 * Whether a live face can be changed in place into this one: a card stays
 * bound to a record or stays unbound, since changing a card in place keeps
 * the record it was bound to when it is given none.
 */
function sameShape(prev: ModelFace | undefined, face: ModelFace): boolean {
  return !!prev?.bind?.id === !!face.bind?.id;
}

/**
 * What a model's faces do, said outright once it is saved, so the agent
 * doesn't wait for an answer that never comes: as the interface tool says it.
 */
function facesSaid(model: Model): string {
  const faces = facesOf(model).map((f) => f.face);
  if (!faces.length) return "";
  const writes =
    faces.some((f) => f.kind === "list" && f.props.check) ||
    faces.some((f) => f.actions?.some((a) => a.effect === "state"));
  return ` ${faces.length === 1 ? "Its face is" : "Its faces are"} live in the room.${writes ? " A tick or a button there writes the record directly; no message comes back to you." : ""}`;
}

const mountWords = (mount: string) =>
  mount === "wall" ? "on a wall" : mount === "on" ? "on a desk or table" : "on the floor";

const READY_WORDS = READY.map((r) => `${r.name} (${r.about})`).join("; ");

/**
 * A note that a model was saved under another name than the one asked for,
 * when more changed than its case and its spaces: "Bad Name!" is kept as
 * bad_name, the name to use for it from now on. Nothing for "Tall bookcase",
 * which is found by those words as it is.
 */
function savedAs(asked: unknown, name: string): string {
  if (typeof asked !== "string") return "";
  const plain = asked
    .trim()
    .toLowerCase()
    .replace(/^(the|a|an|my)\s+/, "")
    .replace(/[\s-]+/g, "_");
  return plain === name ? "" : ` Saved as ${name}: a model's name is letters, digits and _, so use that from now on.`;
}

export class BuildTool implements Tool {
  name = "build";
  description =
    "Make things for the 3D world out of simple parts, and give a part a face people use there: a list of records to tick, a card, a table. Add one to a room with the place tool.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        description:
          "list: your models and the ready-made ones. show: a model's parts. make: a model, new or whole again. add: parts to one. remove: parts by number. copy: a model, as `as`. delete: a model.",
      },
      name: { type: "string", description: "The model, e.g. bookcase." },
      mount: { type: "string", enum: MOUNTS, description: "make: where it goes: floor, wall, or on a desk or table." },
      parts: {
        type: "array",
        items: { type: "object" },
        description:
          "make, add: each {shape: box|cylinder|sphere|cone|torus|capsule|plane, size: [w,h,d] m, at: [x,y,z] m (y up, z front), turn?: [x,y,z] degrees, color, finish?: matte|glossy|metal|glass|glowing, face?}. A face, on a box or plane: {kind: list|card|table, title, bind: {type, where?} or {type, id, fields?, body?}, check?: {field}, columns?, actions?: [{label, patch}]}.",
      },
      part: { type: "array", items: { type: "number" }, description: "remove: part numbers, as show lists them." },
      about: { type: "string", description: "make: what it is for, in a line." },
      as: { type: "string", description: "copy: the new model's name." },
    },
    required: ["action"],
  };

  constructor(private readonly shelf: ModelShelf) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const agent = context.agentName ?? "default";
    const caller = agentStateCaller(context, "build");
    const action = text(args.action)?.toLowerCase();
    try {
      if (action === "list") return { success: true, output: await this.list(caller, agent) };
      if (!action || !(ACTIONS as readonly string[]).includes(action))
        return fail(`\`action\` is one of: ${ACTIONS.join(", ")}.`);
      const name = modelName(args.name);
      if (!name) return fail("Say which model with `name`, e.g. bookcase. `list` shows yours.");
      const found = await this.shelf.get(caller, agent, name);

      if (action === "show") {
        if (found) return { success: true, output: describeModel(found.model) };
        const ready = readyModel(name);
        if (!ready) return fail(`You have no model called ${name}. \`list\` shows yours.`);
        const model = modelFrom({
          name,
          owner: agent,
          mount: ready.mount,
          parts: ready.parts(agent),
          about: ready.about,
        });
        if (typeof model === "string") return fail(model);
        return {
          success: true,
          output: `${describeModel(model)}\nReady-made: add it to a room with place as it is, or copy it to change it.`,
        };
      }

      if (action === "make") {
        const problem = nameProblem(name);
        if (problem) return fail(problem);
        const parts = listOf(args.parts);
        if (!parts?.length) return fail("`make` needs `parts`: a list of {shape, size, at, color}.");
        // Rooms lay a model out by where it goes, so where it goes stays what it was made for.
        const mount = args.mount === undefined ? undefined : mountOf(args.mount);
        if (found && mount && mount !== found.model.mount)
          return fail(
            `${name} goes ${mountWords(found.model.mount)}, and rooms have it laid out there. To have one ${mountWords(mount)}, make it under another name.`,
          );
        const model = modelFrom({
          name,
          owner: agent,
          mount: args.mount ?? found?.model.mount,
          parts,
          about: args.about ?? found?.model.about,
          ...(found?.model.from ? { from: found.model.from } : {}),
        });
        if (typeof model === "string") return fail(model);
        const saved = await this.shelf.save(context, model, found);
        return {
          success: true,
          output: `${found ? "Made again" : "Made"} ${modelLine(saved)}.${found ? "" : savedAs(args.name, name)}${facesSaid(saved)} ${found ? "Wherever it stands, it shows as it is now." : `Add it to a room with place: add, kind "${name}".`}`,
        };
      }

      if (action === "copy") {
        const target = modelName(args.as) ?? (found ? undefined : name);
        if (!target) return fail("Say what to call the copy with `as`.");
        const problem = nameProblem(target);
        if (problem) return fail(problem);
        if (await this.shelf.get(caller, agent, target))
          return fail(`You already have a model called ${target}. Pick another name with \`as\`, or delete that one.`);
        const ready = found ? undefined : readyModel(name);
        if (!found && !ready)
          return fail(`There's no model called ${name} to copy. \`list\` shows yours and the ready-made ones.`);
        // A ready-made one copied under its own name is simply made the agent's own, as placing it would.
        if (ready && target === ready.name) {
          await (await this.shelf.forPlacing(context, agent, ready.name))?.own?.();
          return { success: true, output: `${target} is yours now, as it comes. \`show\` lists its parts to change.` };
        }
        const source = found
          ? { mount: found.model.mount, parts: partsToCopy(found.model), about: found.model.about }
          : { mount: ready?.mount, parts: ready?.parts(agent) ?? [], about: ready?.about };
        if (ready) await this.shelf.seed(context, agent, ready);
        const model = modelFrom({ name: target, owner: agent, ...source, ...(ready ? { from: ready.name } : {}) });
        if (typeof model === "string") return fail(model);
        const saved = await this.shelf.save(context, model);
        return {
          success: true,
          output: `Copied ${name} as ${modelLine(saved)}.${savedAs(args.as, target)} \`show\` lists its parts.`,
        };
      }

      if (!found) {
        const ready = readyModel(name);
        return fail(
          ready
            ? `${name} is ready-made: copy it first to make it yours to ${action}.`
            : `You have no model called ${name}. \`list\` shows yours.`,
        );
      }

      if (action === "delete") {
        await this.shelf.remove(context, found);
        return {
          success: true,
          output: `Deleted ${name}. Anywhere it still stands shows an empty frame until it is taken away with place remove.`,
        };
      }

      if (action === "add") {
        const parts = listOf(args.parts);
        if (!parts?.length) return fail("`add` needs `parts`: a list of {shape, size, at, color}.");
        const model = modelFrom({
          name,
          owner: agent,
          mount: found.model.mount,
          parts: [...found.model.parts, ...parts],
          about: found.model.about,
          ...(found.model.from ? { from: found.model.from } : {}),
        });
        if (typeof model === "string") return fail(model);
        const saved = await this.shelf.save(context, model, found);
        return {
          success: true,
          output: `Added ${parts.length} part${parts.length === 1 ? "" : "s"}: ${modelLine(saved)}.${facesSaid(saved)}`,
        };
      }

      // remove
      const numbers = (listOf(args.part) ?? (args.part === undefined ? [] : [args.part]))
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n));
      if (!numbers.length) return fail("Say which parts with `part`: their numbers, as `show` lists them.");
      const count = found.model.parts.length;
      const bad = numbers.find((n) => n < 1 || n > count);
      if (bad !== undefined) return fail(`${name} has parts 1 to ${count}; there's no part ${bad}.`);
      const left = found.model.parts.filter((_, i) => !numbers.includes(i + 1));
      if (!left.length) return fail(`That would leave nothing of ${name}. Delete the model instead.`);
      const model = modelFrom({
        name,
        owner: agent,
        mount: found.model.mount,
        parts: left,
        about: found.model.about,
        ...(found.model.from ? { from: found.model.from } : {}),
      });
      if (typeof model === "string") return fail(model);
      const saved = await this.shelf.save(context, model, found);
      return {
        success: true,
        output: `Removed part${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")}: ${modelLine(saved)}.`,
      };
    } catch (err) {
      if (err instanceof StateError || err instanceof StateConflictError) return fail(err.message);
      throw err;
    }
  }

  private async list(caller: StateCaller, agent: string): Promise<string> {
    const mine = await this.shelf.mine(caller, agent);
    return [
      mine.length ? `Your models:\n${mine.map((m) => `- ${modelLine(m)}`).join("\n")}` : "You have made no models yet.",
      `Ready-made, to add as they are or copy to change: ${READY_WORDS}.`,
      'Add any of them to a room with place: add, kind "<name>".',
    ].join("\n\n");
  }
}

/**
 * The models a place's things are drawn as, by record id, for the page: each
 * face with the component that shows it, filled from the records as they are
 * now, so its picture from across the room is true and it is drawn at once.
 * A model that is gone is left out, and the page draws an empty frame where
 * it stood.
 */
export async function modelsIn(
  service: StateService,
  caller: StateCaller,
  store: InterfaceStore | undefined,
  props: { model?: string }[],
): Promise<Record<string, Model>> {
  const out: Record<string, Model> = {};
  for (const id of new Set(props.flatMap((p) => (p.model ? [p.model] : [])))) {
    const found = await service.get(caller, { type: MODEL_TYPE, id }).catch(() => null);
    if (!found) continue;
    const model = found.data as unknown as Model;
    const mine = found.scope === `agent:${model.owner}`;
    out[id] = {
      ...model,
      parts: await Promise.all(
        model.parts.map(async (p) => {
          const spec =
            mine && p.face ? await faceSpec(service, caller, store, model.owner, p.face.component) : undefined;
          return spec && p.face ? { ...p, face: { ...p.face, spec } } : p;
        }),
      ),
    };
  }
  return out;
}

/**
 * The component a face shows, with its props filled fresh: a list's items or a
 * table's rows from its query, among the scopes its agent could see, or a
 * card's lines from its record. Only one its model's agent made, of a kind a
 * face can be, with buttons that only write: a model record edited by hand
 * can't bring some other conversation's question into the room.
 */
async function faceSpec(
  service: StateService,
  caller: StateCaller,
  store: InterfaceStore | undefined,
  owner: string,
  id: string | undefined,
): Promise<ComponentSpec | undefined> {
  const live = id ? store?.get(id) : undefined;
  if (!live || live.agent !== owner) return undefined;
  const { spec } = live;
  if (!(FACE_KINDS as readonly string[]).includes(spec.kind)) return undefined;
  if (spec.actions?.some((a) => a.effect.kind !== "state")) return undefined;
  try {
    if (spec.query) return { ...spec, props: await queriedProps(service, caller, spec.kind, spec.props, spec.query) };
    if (spec.bind) {
      const record = await service.get(caller, spec.bind);
      if (record)
        return {
          ...spec,
          props: boundCardProps(spec.props, record, service.getType(spec.bind.type)?.title, spec.bind),
        };
    }
  } catch {
    // Its records can't be read just now: drawn as it was last filled.
  }
  return spec;
}

/**
 * A new day on every habit tracker: each habit ticked on an earlier day
 * starts the day unticked, and its streak is counted (`habitTurnover`), as
 * the places plugin. Only while `habit` is the type the plugin declares: a
 * deployment's own habits are its own. How many were turned.
 */
export async function turnHabits(
  service: StateService,
  caller: StateCaller,
  timeZone: string,
  now: Date,
): Promise<number> {
  const ours: unknown = FACE_TYPES.find((t) => t.name === HABIT_TYPE)?.schema;
  if (!ours || service.getType(HABIT_TYPE)?.schema !== ours) return 0;
  const today = dayIn(now, timeZone);
  const habits = await service.query(caller, { type: HABIT_TYPE, limit: 1000 });
  let turned = 0;
  for (const habit of habits) {
    const patch = habitTurnover(habit.data, dayIn(new Date(habit.updatedAt), timeZone), today);
    if (!patch) continue;
    // Written over the version read, so a tick made meanwhile stands, and is turned tomorrow.
    await service
      .patch(caller, { type: HABIT_TYPE, id: habit.id }, patch, habit.version)
      .then(() => turned++)
      .catch(() => undefined);
  }
  return turned;
}
