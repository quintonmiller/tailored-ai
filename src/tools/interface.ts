export interface ToolContext {
  sessionId: string;
  workingDirectory: string;
  env: Record<string, string>;
  profileContextDir?: string;
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
