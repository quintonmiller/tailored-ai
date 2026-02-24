import { createInterface } from "node:readline";
import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from "@agent/core";

export class CliApprovalHandler implements ApprovalHandler {
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    const startTime = Date.now();

    process.stderr.write(`\n  [approval] ${request.description}\n`);

    const answer = await this.prompt("  Approve? [y/N/reason] ");
    const responseTimeMs = Date.now() - startTime;
    const trimmed = answer.trim().toLowerCase();

    if (trimmed === "y" || trimmed === "yes") {
      return { approved: true, responseTimeMs };
    }

    if (trimmed === "" || trimmed === "n" || trimmed === "no") {
      return { approved: false, responseTimeMs };
    }

    // Anything else is treated as a rejection with the text as reason
    return { approved: false, reason: answer.trim(), responseTimeMs };
  }

  private prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
}
