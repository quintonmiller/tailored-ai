export interface ToolContext {
  sessionId: string;
  workingDirectory: string;
  env: Record<string, string>;
  agentContextDir?: string;
  kbDir?: string;
  agentKbDir?: string;
  approvalHandler?: import("../approval.js").ApprovalHandler;
  permissions?: import("../approval.js").PermissionsConfig;
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
