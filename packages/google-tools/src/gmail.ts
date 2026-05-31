import { execFile } from "node:child_process";
import {
  type EmailDisposition,
  filterUnseenIds,
  markEmailSeen,
  type Tool,
  type ToolContext,
  type ToolResult,
  updateEmailDisposition,
} from "@tailored-ai/core";
import type Database from "better-sqlite3";

export class GmailTool implements Tool {
  name = "gmail";
  description = "Read and search Gmail. Actions: search, read, send, mark_seen.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "The action: search, read, send, mark_seen.",
      },
      query: {
        type: "string",
        description: 'Gmail search query for search action (e.g. "is:unread", "from:someone@example.com").',
      },
      message_id: {
        type: "string",
        description: "Message ID for read or mark_seen action.",
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
      exclude_seen: {
        type: "boolean",
        description:
          "When true on search, hide messages already in email_seen (the dedup ledger). Use for inbox sweeps so recurring items don't reappear every tick.",
      },
      mark_as_seen: {
        type: "boolean",
        description:
          "When true on search, the returned results are recorded in email_seen as 'noted'. Combine with exclude_seen for a 'show me only new mail' sweep.",
      },
      disposition: {
        type: "string",
        description: "For mark_seen: one of noted, ignored, triaged, replied, archived. Default noted.",
      },
    },
    required: ["action"],
  };

  private account: string;
  private gogKeyringPassword: string;
  private db?: Database.Database;

  constructor(account: string, gogKeyringPassword: string, db?: Database.Database) {
    this.account = account;
    this.gogKeyringPassword = gogKeyringPassword;
    this.db = db;
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
          return this.search(args.query as string, args.exclude_seen === true, args.mark_as_seen === true);
        case "read":
          return this.read(args.message_id as string);
        case "send":
          return this.send(args.to as string, args.subject as string, args.body as string);
        case "mark_seen":
          return this.markSeen(args.message_id as string, args.disposition as string | undefined);
        default:
          return {
            success: false,
            output: "",
            error: `Unknown action: ${action}. Use: search, read, send, mark_seen.`,
          };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private async search(query: string, excludeSeen: boolean, markAsSeen: boolean): Promise<ToolResult> {
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

    let threads: { id: string; date: string; from: string; subject: string; labels: string[] }[];
    try {
      const data = JSON.parse(stdout) as { threads?: typeof threads };
      threads = data.threads ?? [];
    } catch {
      // If JSON parsing fails, return raw output (dedup not possible).
      return { success: true, output: stdout.slice(0, 4000) };
    }

    // Apply dedup filtering BEFORE formatting (docs/agent-unification.md RC4 —
    // set membership in SQL, never in the LLM prompt).
    let hiddenSeen = 0;
    if ((excludeSeen || markAsSeen) && !this.db) {
      console.warn("[gmail] exclude_seen/mark_as_seen requested but no db wired; ignoring.");
    } else if (excludeSeen && this.db) {
      const ids = threads.map((t) => t.id);
      const unseenIds = new Set(filterUnseenIds(this.db, ids));
      hiddenSeen = ids.length - unseenIds.size;
      threads = threads.filter((t) => unseenIds.has(t.id));
    }

    if (markAsSeen && this.db) {
      for (const t of threads) {
        markEmailSeen(this.db, {
          message_id: t.id,
          from_addr: t.from,
          subject: t.subject,
          disposition: "noted",
        });
      }
    }

    if (threads.length === 0) {
      const suffix = hiddenSeen > 0 ? ` (filtered out ${hiddenSeen} already-seen)` : "";
      return { success: true, output: `No results for "${query}"${suffix}.` };
    }

    const formatted = threads
      .map(
        (t) => `- ${t.subject}\n  From: ${t.from}\n  Date: ${t.date}\n  ID: ${t.id}\n  Labels: ${t.labels.join(", ")}`,
      )
      .join("\n\n");
    const header = hiddenSeen > 0 ? `(${hiddenSeen} already-seen hidden)\n\n` : "";
    return { success: true, output: header + formatted };
  }

  private async markSeen(messageId: string, disposition?: string): Promise<ToolResult> {
    if (!messageId) return { success: false, output: "", error: "message_id is required for mark_seen." };
    if (!this.db) {
      return {
        success: false,
        output: "",
        error: "mark_seen requires a database connection that wasn't wired into this GmailTool instance.",
      };
    }
    const allowed: EmailDisposition[] = ["noted", "ignored", "triaged", "replied", "archived"];
    const disp = (disposition as EmailDisposition) ?? "noted";
    if (!allowed.includes(disp)) {
      return {
        success: false,
        output: "",
        error: `Invalid disposition "${disposition}". Use one of: ${allowed.join(", ")}.`,
      };
    }
    // Try update first; fall through to mark if the id wasn't in the ledger.
    const updated = updateEmailDisposition(this.db, messageId, disp);
    if (updated) return { success: true, output: `${messageId} → ${disp}` };
    markEmailSeen(this.db, { message_id: messageId, disposition: disp });
    return { success: true, output: `${messageId} → ${disp} (newly marked)` };
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
