export interface ToolContext {
  sessionId: string;
  workingDirectory: string;
  env: Record<string, string>;
  agentContextDir?: string;
  kbDir?: string;
  agentKbDir?: string;
  approvalHandler?: import("../approval.js").ApprovalHandler;
  permissions?: import("../approval.js").PermissionsConfig;
  /** When set, the tool is executing inside the autopilot worker for this project task. */
  autopilotTaskId?: string;
  /** Name of the agent currently running. Used as the author on tool-initiated records (comments, etc.). */
  agentName?: string;
  db?: import("better-sqlite3").Database;
  /** Sandbox handle to route shell/file operations through. When unset, tools execute on the host. */
  sandbox?: import("../sandboxes/interface.js").Sandbox;
  sandboxHandle?: import("../sandboxes/interface.js").SandboxHandle;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;

  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;

  /** Optional cleanup hook called when the tool is being replaced (e.g. on config reload). */
  destroy?(): Promise<void>;
}
