/**
 * Action tier classification system.
 *
 * Determines which config/permission changes require approval based on
 * a four-tier model:
 *
 *   Green  — auto-approve (read-only, harmless operations)
 *   Yellow — log + notify (minor config tweaks)
 *   Red    — require user approval (permission changes, agent creation)
 *   Black  — blocked entirely (self-modification of policies)
 */

// --- Tier enum ---

export const ActionTier = {
  Green: "green",
  Yellow: "yellow",
  Red: "red",
  Black: "black",
} as const;

export type ActionTier = (typeof ActionTier)[keyof typeof ActionTier];

// --- Action entry ---

export interface ActionEntry {
  /** Human-readable description of the action. */
  description: string;
  /** The tier this action belongs to. */
  tier: ActionTier;
}

// --- Registry ---

export class ActionRegistry {
  private actions = new Map<string, ActionEntry>();

  /**
   * Register a new action with its tier classification.
   * @param name  Unique action identifier (e.g. "read_config", "create_agent").
   * @param entry Tier and description.
   */
  register(name: string, entry: ActionEntry): void {
    this.actions.set(name, entry);
  }

  /**
   * Register multiple actions at once.
   */
  registerMany(actions: Record<string, ActionEntry>): void {
    for (const [name, entry] of Object.entries(actions)) {
      this.register(name, entry);
    }
  }

  /**
   * Look up an action entry by name. Returns `undefined` if not registered.
   */
  get(name: string): ActionEntry | undefined {
    return this.actions.get(name);
  }

  /**
   * Classify an action name. Returns the tier, or `undefined` if the action
   * is not registered.
   */
  classifyAction(name: string): ActionTier | undefined {
    const entry = this.actions.get(name);
    return entry?.tier;
  }

  /**
   * Check whether an action is allowed (not black).
   * Unregistered actions are treated as not allowed (fail-safe).
   */
  isAllowed(name: string): boolean {
    const tier = this.classifyAction(name);
    if (tier === undefined) return false;
    return tier !== ActionTier.Black;
  }

  /**
   * Check whether an action requires user approval (red tier).
   */
  requiresApproval(name: string): boolean {
    return this.classifyAction(name) === ActionTier.Red;
  }

  /**
   * Check whether an action is auto-approved (green tier).
   */
  isAutoApproved(name: string): boolean {
    return this.classifyAction(name) === ActionTier.Green;
  }

  /**
   * List all registered action names.
   */
  listActions(): string[] {
    return [...this.actions.keys()];
  }

  /**
   * List all actions in a given tier.
   */
  actionsByTier(tier: ActionTier): Map<string, ActionEntry> {
    const result = new Map<string, ActionEntry>();
    for (const [name, entry] of this.actions) {
      if (entry.tier === tier) {
        result.set(name, entry);
      }
    }
    return result;
  }
}

// --- Default built-in classifications ---

/**
 * Create a pre-populated registry with sensible defaults for common
 * TAI operations.
 */
export function createDefaultRegistry(): ActionRegistry {
  const registry = new ActionRegistry();

  // Green — read-only / harmless
  registry.registerMany({
    read_config: {
      description: "Read configuration values",
      tier: ActionTier.Green,
    },
    list_tools: {
      description: "List available tools",
      tier: ActionTier.Green,
    },
    list_agents: {
      description: "List registered agents",
      tier: ActionTier.Green,
    },
    list_tasks: {
      description: "List project tasks",
      tier: ActionTier.Green,
    },
    get_task: {
      description: "Get a single task by ID",
      tier: ActionTier.Green,
    },
    read_file: {
      description: "Read a file from disk",
      tier: ActionTier.Green,
    },
    search_codebase: {
      description: "Search the codebase (grep, ripgrep, etc.)",
      tier: ActionTier.Green,
    },
    list_sessions: {
      description: "List agent sessions",
      tier: ActionTier.Green,
    },
    get_session: {
      description: "Get session metadata",
      tier: ActionTier.Green,
    },
  });

  // Yellow — log + notify (minor config tweaks)
  registry.registerMany({
    update_task_status: {
      description: "Update a task's status",
      tier: ActionTier.Yellow,
    },
    comment_task: {
      description: "Add a comment to a task",
      tier: ActionTier.Yellow,
    },
    write_note: {
      description: "Write a short-term memory note",
      tier: ActionTier.Yellow,
    },
    update_config_minor: {
      description: "Update minor config values (e.g. temperature, maxToolRounds)",
      tier: ActionTier.Yellow,
    },
    create_document: {
      description: "Create a new document",
      tier: ActionTier.Yellow,
    },
    update_document: {
      description: "Update an existing document",
      tier: ActionTier.Yellow,
    },
  });

  // Red — require user approval
  registry.registerMany({
    create_agent: {
      description: "Create a new agent definition",
      tier: ActionTier.Red,
    },
    update_agent: {
      description: "Modify an existing agent definition",
      tier: ActionTier.Red,
    },
    delete_agent: {
      description: "Delete an agent definition",
      tier: ActionTier.Red,
    },
    update_permissions: {
      description: "Change permission rules for tools",
      tier: ActionTier.Red,
    },
    update_config_major: {
      description: "Update major config values (providers, sandboxes, etc.)",
      tier: ActionTier.Red,
    },
    install_resource: {
      description: "Install a new resource (tool, skill, workflow, etc.)",
      tier: ActionTier.Red,
    },
    delete_resource: {
      description: "Uninstall a resource",
      tier: ActionTier.Red,
    },
    create_custom_tool: {
      description: "Create a new custom shell-backed tool",
      tier: ActionTier.Red,
    },
    delete_custom_tool: {
      description: "Delete a custom tool",
      tier: ActionTier.Red,
    },
  });

  // Black — blocked entirely
  registry.registerMany({
    modify_self_policy: {
      description: "Modify the agent's own policy/tier definitions",
      tier: ActionTier.Black,
    },
    disable_security: {
      description: "Disable security controls (permissions, rate limits, etc.)",
      tier: ActionTier.Black,
    },
    modify_tier_definitions: {
      description: "Change tier classification rules",
      tier: ActionTier.Black,
    },
    write_system_config: {
      description: "Write to ~/.tailored-ai/ or agent.db directly",
      tier: ActionTier.Black,
    },
    escalate_privileges: {
      description: "Grant self or other agents elevated privileges",
      tier: ActionTier.Black,
    },
  });

  return registry;
}

// --- Standalone classifyAction helper ---

/**
 * Convenience function: classify an action using the default registry.
 * Callers that don't need a custom registry can use this directly.
 */
export function classifyAction(name: string): ActionTier | undefined {
  return defaultRegistry.classifyAction(name);
}

/**
 * Register an action on the default registry at runtime.
 */
export function registerAction(name: string, entry: ActionEntry): void {
  defaultRegistry.register(name, entry);
}

/** Singleton default registry used by the standalone helpers. */
const defaultRegistry = createDefaultRegistry();
