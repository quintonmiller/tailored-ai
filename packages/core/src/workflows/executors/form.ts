import type { OutboundNotifier } from "../../channels/outbound.js";
import type { StepContext, StepExecutor, StepResult } from "../engine.js";
import type { FormRegistry } from "../form-registry.js";
import { FormCancelledError } from "../form-registry.js";
import { resolveString } from "../scope.js";
import type { FormStep, WorkflowStepDef } from "../types.js";

const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface FormExecutorOptions {
  registry: FormRegistry;
  /** Resolve the outbound notifier for the form's notify option (default channel when absent). */
  resolveOutbound?: (channelId?: string) => OutboundNotifier | undefined;
  /** Returns the configured owner id for a channel, the default DM target. */
  getOwnerId?: (channelId?: string) => string | undefined;
  /** Defaults to console.log — overridable in tests. */
  log?: (message: string) => void;
}

/**
 * Pauses the workflow run, persists a pending-form row, optionally fires a
 * channel/log notification, and awaits submission via the registry.
 *
 * In dry-run mode the executor short-circuits with synthesized default
 * values: required fields use empty defaults (string `""`, number 0, etc.)
 * unless the schema declares a `default` — same shape the registry would
 * have validated to. This keeps dry-run from blocking forever.
 */
export class FormExecutor implements StepExecutor {
  type = "form" as const;
  private registry: FormRegistry;
  private resolveOutbound?: (channelId?: string) => OutboundNotifier | undefined;
  private getOwnerId?: (channelId?: string) => string | undefined;
  private log: (message: string) => void;

  constructor(opts: FormExecutorOptions) {
    this.registry = opts.registry;
    this.resolveOutbound = opts.resolveOutbound;
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
    const channel = step.notify.channel;
    const sender = this.resolveOutbound?.(channel);
    if (!sender) {
      this.log(`channel "${channel}" not connected; would have sent: ${message}`);
      return;
    }
    const ownerId = this.getOwnerId?.(channel);
    const channelId = step.notify.channelId;
    const userId = step.notify.userId ?? ownerId;
    if (channelId) {
      await sender.send(channelId, message);
    } else if (userId) {
      await sender.sendDM(userId, message);
    } else {
      this.log(`No channel or user id resolved for "${channel}"; would have sent: ${message}`);
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
