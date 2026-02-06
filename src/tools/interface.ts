export interface ToolContext {
  sessionId: string;
  workingDirectory: string;
  env: Record<string, string>;
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
}
