import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from "@agent/core";

export interface PendingApproval {
  request: ApprovalRequest;
  resolve: (response: ApprovalResponse) => void;
  startTime: number;
}

export class HttpApprovalHandler implements ApprovalHandler {
  private pending = new Map<string, PendingApproval>();
  private emitSSE: ((event: string, data: unknown) => void) | undefined;

  /** Set the SSE emitter for this handler. Called once per SSE stream. */
  setEmitter(emitSSE: (event: string, data: unknown) => void): void {
    this.emitSSE = emitSSE;
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    return new Promise<ApprovalResponse>((resolve) => {
      const startTime = Date.now();
      this.pending.set(request.requestId, { request, resolve, startTime });

      // Emit SSE event to the client
      this.emitSSE?.("approval_request", {
        requestId: request.requestId,
        toolName: request.toolName,
        toolArgs: request.toolArgs,
        sessionId: request.sessionId,
        description: request.description,
      });
    });
  }

  /** Resolve a pending approval request from a REST endpoint. Returns false if not found. */
  resolveApproval(requestId: string, approved: boolean, reason?: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    this.pending.delete(requestId);
    entry.resolve({
      approved,
      reason,
      responseTimeMs: Date.now() - entry.startTime,
    });
    return true;
  }

  /** List all pending approval requests. */
  listPending(): ApprovalRequest[] {
    return Array.from(this.pending.values()).map((e) => e.request);
  }

  /** Clean up any remaining pending requests (e.g. on stream close). */
  rejectAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      entry.resolve({
        approved: false,
        reason,
        responseTimeMs: Date.now() - entry.startTime,
      });
    }
    this.pending.clear();
  }
}

/** Global registry of active approval handlers by session key, so REST endpoints can find them. */
const activeHandlers = new Map<string, HttpApprovalHandler>();

export function registerHandler(key: string, handler: HttpApprovalHandler): void {
  activeHandlers.set(key, handler);
}

export function unregisterHandler(key: string): void {
  activeHandlers.delete(key);
}

export function getHandler(key: string): HttpApprovalHandler | undefined {
  return activeHandlers.get(key);
}

export function getAllPendingApprovals(): ApprovalRequest[] {
  const all: ApprovalRequest[] = [];
  for (const handler of activeHandlers.values()) {
    all.push(...handler.listPending());
  }
  return all;
}

/** Find the handler that owns a specific request ID and resolve it. */
export function resolveApprovalById(requestId: string, approved: boolean, reason?: string): boolean {
  for (const handler of activeHandlers.values()) {
    if (handler.resolveApproval(requestId, approved, reason)) {
      return true;
    }
  }
  return false;
}
