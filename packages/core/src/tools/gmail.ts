import { execFile } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

export class GmailTool implements Tool {
  name = "gmail";
  description = "Read and search Gmail. Actions: search, read, send.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "The action: search, read, send.",
      },
      query: {
        type: "string",
        description: 'Gmail search query for search action (e.g. "is:unread", "from:someone@example.com").',
      },
      message_id: {
        type: "string",
        description: "Message ID for read action.",
      },
      to: {
        type: "string",
        description: "Recipient email for send action.",
      },
      subject: {
        type: "string",
        description: "Email subject for send action.",
      },
      body: {
        type: "string",
        description: "Email body for send action.",
      },
    },
    required: ["action"],
  };

  private account: string;
  private gogKeyringPassword: string;

  constructor(account: string, gogKeyringPassword: string) {
    this.account = account;
    this.gogKeyringPassword = gogKeyringPassword;
  }

  private gog(args: string[], timeoutMs: number = 30_000): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      execFile(
        "gog",
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, GOG_KEYRING_PASSWORD: this.gogKeyringPassword },
        },
        (error, stdout, stderr) => {
          resolve({
            stdout,
            stderr,
            code: error ? ((error as unknown as { code?: number }).code ?? 1) : 0,
          });
        },
      );
    });
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = args.action as string;
    if (!action) {
      return { success: false, output: "", error: "No action provided." };
    }

    try {
      switch (action) {
        case "search":
          return this.search(args.query as string);
        case "read":
          return this.read(args.message_id as string);
        case "send":
          return this.send(args.to as string, args.subject as string, args.body as string);
        default:
          return { success: false, output: "", error: `Unknown action: ${action}. Use: search, read, send.` };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private async search(query: string): Promise<ToolResult> {
    if (!query) return { success: false, output: "", error: "query is required for search." };

    const { stdout, stderr, code } = await this.gog([
      "gmail",
      "search",
      query,
      "--account",
      this.account,
      "--json",
      "--no-input",
    ]);

    if (code !== 0) return { success: false, output: "", error: stderr || "gog gmail search failed" };

    try {
      const data = JSON.parse(stdout) as {
        threads?: { id: string; date: string; from: string; subject: string; labels: string[] }[];
      };
      const threads = data.threads ?? [];
      if (threads.length === 0) return { success: true, output: `No results for "${query}".` };

      const formatted = threads
        .map(
          (t) =>
            `- ${t.subject}\n  From: ${t.from}\n  Date: ${t.date}\n  ID: ${t.id}\n  Labels: ${t.labels.join(", ")}`,
        )
        .join("\n\n");
      return { success: true, output: formatted };
    } catch {
      // If JSON parsing fails, return raw output
      return { success: true, output: stdout.slice(0, 4000) };
    }
  }

  private async read(messageId: string): Promise<ToolResult> {
    if (!messageId) return { success: false, output: "", error: "message_id is required for read." };

    const { stdout, stderr, code } = await this.gog([
      "gmail",
      "get",
      messageId,
      "--account",
      this.account,
      "--json",
      "--no-input",
    ]);

    if (code !== 0) return { success: false, output: "", error: stderr || "gog gmail get failed" };

    // Truncate very long messages
    const output = stdout.length > 6000 ? `${stdout.slice(0, 6000)}\n\n[Truncated]` : stdout;
    return { success: true, output };
  }

  private async send(to: string, subject: string, body: string): Promise<ToolResult> {
    if (!to) return { success: false, output: "", error: "to is required for send." };
    if (!subject) return { success: false, output: "", error: "subject is required for send." };
    if (!body) return { success: false, output: "", error: "body is required for send." };

    const sendArgs = [
      "gmail",
      "send",
      "--to",
      to,
      "--subject",
      subject,
      "--body",
      body,
      "--account",
      this.account,
      "--json",
      "--no-input",
    ];

    const { stdout, stderr, code } = await this.gog(sendArgs);

    if (code !== 0) return { success: false, output: "", error: stderr || "gog gmail send failed" };

    return { success: true, output: stdout || `Email sent to ${to}.` };
  }
}
