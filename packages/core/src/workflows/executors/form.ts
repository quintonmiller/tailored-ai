import type { StepContext, StepExecutor, StepResult } from "../engine.js";
import type { FormRegistry } from "../form-registry.js";
import { FormCancelledError } from "../form-registry.js";
import { resolveString } from "../scope.js";
import type { FormStep, WorkflowStepDef } from "../types.js";
import type { DiscordSender } from "./discord-message.js";

const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface FormExecutorOptions {
  registry: FormRegistry;
  /** Optional Discord plumbing for the form's notify option. */
  getDiscord?: () => DiscordSender | undefined;
  /** Optional Discord owner id used as the default DM target. */
  getOwnerId?: () => string | undefined;
  /** Defaults to console.log — overridable in tests. */
  log?: (message: string) => void;
}

/**
 * Pauses the workflow run, persists a pending-form row, optionally fires a
 * Discord/log notification, and awaits submission via the registry.
 *
 * In dry-run mode the executor short-circuits with synthesized default
 * values: required fields use empty defaults (string `""`, number 0, etc.)
 * unless the schema declares a `default` — same shape the registry would
 * have validated to. This keeps dry-run from blocking forever.
 */
export class FormExecutor implements StepExecutor {
  type = "form" as const;
  private registry: FormRegistry;
  private getDiscord?: () => DiscordSender | undefined;
  private getOwnerId?: () => string | undefined;
  private log: (message: string) => void;

  constructor(opts: FormExecutorOptions) {
    this.registry = opts.registry;
    this.getDiscord = opts.getDiscord;
    this.getOwnerId = opts.getOwnerId;
    this.log = opts.log ?? ((m: string) => console.log(`[form] ${m}`));
  }

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    const s = step as FormStep;
    const prompt = String(resolveString(s.prompt, ctx.scope) ?? "");

    if (ctx.dryRun) {
      const values = synthesizeDefaults(s.fields);
      this.log(`[dry-run] form "${s.name}" — synthesizing defaults: ${JSON.stringify(values)}`);
      return { output: { fields: values, formId: null, dryRun: true } };
    }

    const timeoutMs = s.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const { formId, promise } = this.registry.register({
      runId: ctx.runId,
      stepId: ctx.stepId,
      stepName: s.name,
      prompt,
      fields: s.fields,
      timeoutMs,
    });

    // Fire optional notification ping. Best-effort — failures are logged but
    // don't block the form (the user can still submit via the UI).
    if (s.notify) {
      try {
        await this.sendNotify(s, ctx, prompt);
      } catch (err) {
        this.log(`form notify failed for "${s.name}": ${(err as Error).message}`);
      }
    }

    // Honor cancellation by cancelling the form so the registry resolves out.
    const abortListener = () => this.registry.cancelRun(ctx.runId);
    ctx.signal.addEventListener("abort", abortListener, { once: true });

    try {
      const values = await promise;
      return { output: { fields: values, formId } };
    } catch (err) {
      if (err instanceof FormCancelledError) {
        throw err;
      }
      throw err;
    } finally {
      ctx.signal.removeEventListener("abort", abortListener);
    }
  }

  private async sendNotify(step: FormStep, ctx: StepContext, prompt: string): Promise<void> {
    if (!step.notify) return;
    const message =
      step.notify.message ?? `📝 Form "${step.name}" needs your input — see workflow run ${ctx.runId}.\n\n${prompt}`;
    if (step.notify.channel === "log") {
      this.log(message);
      return;
    }
    if (step.notify.channel === "discord") {
      const sender = this.getDiscord?.();
      if (!sender) {
        this.log(`Discord not connected; would have sent: ${message}`);
        return;
      }
      const ownerId = this.getOwnerId?.();
      const channelId = step.notify.channelId;
      const userId = step.notify.userId ?? ownerId;
      if (channelId) {
        await sender.send(channelId, message);
      } else if (userId) {
        await sender.sendDM(userId, message);
      } else {
        this.log(`No Discord channel or user id resolved; would have sent: ${message}`);
      }
    }
  }
}

function synthesizeDefaults(fields: FormStep["fields"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields ?? {})) {
    if (field.default !== undefined) {
      out[name] = field.default;
      continue;
    }
    switch (field.type) {
      case "number":
        out[name] = 0;
        break;
      case "boolean":
        out[name] = false;
        break;
      case "json":
        out[name] = {};
        break;
      default:
        out[name] = "";
    }
  }
  return out;
}
