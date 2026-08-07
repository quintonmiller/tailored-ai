/**
 * Contributing a block of context without knowing where it goes.
 *
 * The existing seam — `systemPrompt.order` / `.custom` — can express any layout
 * but demands you understand the whole one. A slot is the other half: you say
 * what you have and how it behaves, and core decides placement, ordering,
 * budget and cache position.
 *
 * The contributor answers exactly one question:
 *
 *   does this change between turns?
 *
 *   "reload" → standing knowledge. Rides in the system prompt, in front of the
 *              history, where it is part of the cacheable prefix.
 *   "turn"   → current state. Rides behind the history, deliberately outside
 *              that prefix, and is replaced wholesale every turn.
 *
 * Nobody types "tier". Nobody names the built-in layers. Nobody thinks about
 * cache breakpoints — which is important, because the volatile group has to
 * stay one contiguous block: the Anthropic provider's history breakpoint
 * targets `messages.length - 2` and so assumes exactly one volatile trailing
 * message. Several separately-placed slots would move that breakpoint into the
 * volatile region and buy a cache *write* every turn that nothing ever reads.
 *
 * There is deliberately no `refresh` value that appends to the conversation
 * record. Adding a view and rewriting history are different acts; a plugin that
 * wants the second replaces a composer instead.
 */

/** Everything a slot can use to decide what to render, or whether to render. */
export interface ContextSlotContext {
  /** The agent whose turn this is, when it has a name. */
  agent?: string;
  /** Project scope, mirroring `session.projectId`. */
  projectId: string | null;
  sessionId: string;
  /** What the agent was asked this turn. */
  userMessage: string;
}

export type SlotRefresh = "reload" | "turn";

export interface ContextSlot {
  /** Stable, unique. Used in warnings and to replace a slot on re-registration. */
  id: string;
  /** Whether the content changes between turns. Decides placement; see above. */
  refresh: SlotRefresh;
  /**
   * Ceiling for this slot's rendered text. Core truncates and says that it
   * truncated, so a contributor never has to guess a budget or police one.
   * Omitted means uncapped, which is the right default only for slots whose
   * size the author actually controls.
   */
  budgetTokens?: number;
  /**
   * Which agents see it. `["*"]` or omitted means all. Same shape as a tool
   * allowlist, so it reads the way the rest of the config does.
   */
  agents?: string[];
  /** Heading rendered above the content. Omitted renders the content bare. */
  title?: string;
  /** Return null (or "") to render nothing this turn. */
  render(ctx: ContextSlotContext): string | null | undefined;
}

const slots = new Map<string, ContextSlot>();

/**
 * Register a slot. Re-registering an id replaces it, so a plugin reloaded at
 * runtime does not end up contributing twice.
 */
export function registerContextSlot(slot: ContextSlot): void {
  if (!slot.id) throw new Error("registerContextSlot requires an id");
  if (slot.refresh !== "reload" && slot.refresh !== "turn") {
    throw new Error(`Slot "${slot.id}" has refresh "${slot.refresh}" — expected "reload" or "turn"`);
  }
  slots.set(slot.id, slot);
}

export function unregisterContextSlot(id: string): boolean {
  return slots.delete(id);
}

export function listContextSlots(): ContextSlot[] {
  return [...slots.values()];
}

/** Test seam, and what a full runtime reload uses to start clean. */
export function clearContextSlots(): void {
  slots.clear();
}

/** Slots whose author has already been told they misbehave. */
const warned = new Set<string>();

function appliesTo(slot: ContextSlot, agent: string | undefined): boolean {
  if (!slot.agents || slot.agents.length === 0) return true;
  if (slot.agents.includes("*")) return true;
  return agent !== undefined && slot.agents.includes(agent);
}

/**
 * Cut a slot to its budget and say so in the text.
 *
 * Silent truncation is the failure this whole area keeps producing: content
 * disappears and the model reads what is left as the whole of it. A slot that
 * overran should look overrun.
 */
export function capSlot(text: string, budgetTokens: number | undefined): string {
  if (!budgetTokens || budgetTokens <= 0) return text;
  const charBudget = budgetTokens * 4;
  if (text.length <= charBudget) return text;
  const notice = "\n[…truncated to fit this slot's budget]";
  return `${text.slice(0, Math.max(0, charBudget - notice.length)).trimEnd()}${notice}`;
}

/**
 * Render every applicable slot, split by where it belongs.
 *
 * A slot that throws or returns nothing is skipped and the turn continues. That
 * behaviour already exists in miniature — `buildChatLiveState` degrades
 * section-by-section in a try/catch — and it belongs to the framework rather
 * than being re-implemented, and re-forgotten, by every contributor.
 */
export function renderContextSlots(
  ctx: ContextSlotContext,
  registered: ContextSlot[] = listContextSlots(),
): { reload: string; turn: string } {
  const parts: Record<SlotRefresh, string[]> = { reload: [], turn: [] };

  for (const slot of registered) {
    if (!appliesTo(slot, ctx.agent)) continue;
    let text: string | null | undefined;
    try {
      text = slot.render(ctx);
    } catch (err) {
      if (!warned.has(slot.id)) {
        warned.add(slot.id);
        console.warn(`[context-slots] Slot "${slot.id}" threw and was skipped: ${(err as Error).message}`);
      }
      continue;
    }
    if (!text) continue;
    const body = capSlot(text.trim(), slot.budgetTokens);
    parts[slot.refresh].push(slot.title ? `## ${slot.title}\n\n${body}` : body);
  }

  return {
    reload: parts.reload.length > 0 ? `\n\n${parts.reload.join("\n\n")}\n` : "",
    turn: parts.turn.length > 0 ? `\n\n${parts.turn.join("\n\n")}\n` : "",
  };
}

/**
 * Turn config-declared slots into real ones.
 *
 * Built per call rather than registered once, because config is hot-reloadable
 * and a `file:` slot should pick up an edit on the next turn. Registering these
 * globally would also double them up on every reload.
 */
export function slotsFromConfig(
  declared: ConfigDeclaredSlot[] | undefined,
  readFile: (path: string) => string,
): ContextSlot[] {
  if (!declared?.length) return [];
  return declared.map((d) => ({
    id: d.id,
    refresh: d.refresh,
    budgetTokens: d.budgetTokens,
    agents: d.agents,
    title: d.title,
    render: () => {
      if (d.content !== undefined) return d.content;
      if (!d.file) return null;
      // Throwing is fine: renderContextSlots catches per slot, warns once, and
      // the turn continues without this block. A missing file should not be
      // the reason an agent cannot answer.
      return readFile(d.file);
    },
  }));
}

/** The config shape, restated here so this module depends on no config types. */
export interface ConfigDeclaredSlot {
  id: string;
  refresh: SlotRefresh;
  content?: string;
  file?: string;
  title?: string;
  budgetTokens?: number;
  agents?: string[];
}

/** Test seam for the once-per-slot warning. */
export function resetContextSlotWarnings(): void {
  warned.clear();
}
