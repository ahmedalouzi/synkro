import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { IPC_CHANNELS, IPC_EVENTS, type ApprovalDecision, type ApprovalOutcome, type ApprovalRequest } from '@peep/shared';

/**
 * The agent's questions to the user: "may I run this command / delete this file?". A request waits until the user
 * answers in the chat's approval card (Allow once / Always allow in this project / Reject). There is no timeout: a new
 * message, Stop, or the end of the run ends it as "no-answer". Before this, main sent agent:confirm-command and nothing
 * in the window listened, so every such command waited 60 s and was then reported as rejected.
 */
export class ApprovalService {
  private pendingById = new Map<string, { request: ApprovalRequest; settle: (outcome: ApprovalOutcome) => void }>();

  constructor(
    /** Sends an event to the window (webContents.send). */
    private readonly send: (channel: string, payload: unknown) => void,
    /** Called for each new request, e.g. a desktop notification when the window is not focused. */
    private readonly onRequest?: (request: ApprovalRequest) => void,
  ) {}

  request(request: Omit<ApprovalRequest, 'id'>): Promise<ApprovalOutcome> {
    const full: ApprovalRequest = { ...request, id: randomUUID() };
    return new Promise<ApprovalOutcome>((resolvePromise) => {
      this.pendingById.set(full.id, {
        request: full,
        settle: (outcome) => {
          this.pendingById.delete(full.id);
          this.send(IPC_EVENTS.AGENT_APPROVAL_RESOLVED, { id: full.id, outcome });
          resolvePromise(outcome);
        },
      });
      this.send(IPC_EVENTS.AGENT_APPROVAL_REQUEST, full);
      this.onRequest?.(full);
    });
  }

  /** The user's answer. "always" is only accepted where the request offered it. Returns false for an unknown id. */
  respond(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pendingById.get(id);
    if (!entry || !['allow-once', 'always', 'reject'].includes(decision)) return false;
    if (decision === 'always' && !entry.request.alwaysAllowKey) return false;
    entry.settle(decision);
    return true;
  }

  /** Ends every waiting request as "no-answer" (new message, Stop, end of the run). */
  cancelAll(): void {
    for (const entry of [...this.pendingById.values()]) entry.settle('no-answer');
  }

  pending(): ApprovalRequest[] {
    return [...this.pendingById.values()].map((e) => e.request);
  }
}

/**
 * "Always allow in this project" choices, per project, in the app's data folder: not in the project, where the agent
 * could write its own permissions.
 */
export class ApprovalStore {
  constructor(private readonly file: string) {}

  private static key(projectPath: string): string {
    const p = resolve(projectPath);
    return process.platform === 'win32' ? p.toLowerCase() : p;
  }

  private readAll(): Record<string, string[]> {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
      const clean: Record<string, string[]> = {};
      for (const [project, keys] of Object.entries(data)) {
        if (Array.isArray(keys)) clean[project] = keys.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 200);
      }
      return clean;
    } catch {
      return {};
    }
  }

  allowed(projectPath: string): Set<string> {
    return new Set(this.readAll()[ApprovalStore.key(projectPath)] ?? []);
  }

  allow(projectPath: string, key: string): void {
    const all = this.readAll();
    const project = ApprovalStore.key(projectPath);
    all[project] = [...new Set([...(all[project] ?? []), key])];
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(all, null, 2));
    } catch (err) {
      console.error('[ApprovalStore] Could not save the "always allow" choice:', err);
    }
  }
}

/** The IPC handlers for the approval cards. Exported so the IPC round-trip test registers exactly these. */
export function registerApprovalIpc(
  ipc: { handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => void },
  approvals: ApprovalService,
): void {
  ipc.handle(IPC_CHANNELS.AGENT_APPROVAL_RESPOND, (_event, id: unknown, decision: unknown) =>
    typeof id === 'string' && typeof decision === 'string' ? approvals.respond(id, decision as ApprovalDecision) : false);
  ipc.handle(IPC_CHANNELS.AGENT_APPROVAL_PENDING, () => approvals.pending());
}
