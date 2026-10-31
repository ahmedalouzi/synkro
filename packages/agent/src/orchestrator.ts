import { OPENAI_TOOLS } from './tools/definitions';
import { ProviderError } from '@peep/shared';
import type { ChatMessage } from './types';

import type { AIGateway, CapabilityTier, AgentTimelineActivity, AgentTimelineActivityType } from '@peep/shared';
import { truncateConversationHistory, estimateTokens, estimateMessageTokens } from './context/truncate';

export interface AgentLogger {
  info(msg: string, meta?: any): void;
  warn(msg: string, meta?: any): void;
  error(msg: string, meta?: any): void;
}

export interface AgentConfig {
  capabilityTier: CapabilityTier;
  sessionToken: string;
  gateway?: AIGateway;
  logger?: AgentLogger;
  threadId?: string;
  runId?: string;
  manualModel?: string;
}

export interface AgentCallbacks {
  onStatus: (message: string) => void;
  onDelta: (text: string) => void;
  onError: (message: string) => void;
  onDone: () => void;
  /** Optional. Receives structured timeline events for the Agent Execution Timeline UI. */
  onTimelineActivity?: (activity: AgentTimelineActivity) => void;
  /** Optional. Receives runtime phase transitions for Task 15 state machine visibility. */
  onPhaseChange?: (phase: import('@peep/shared').AgentPhase, threadId?: string) => void;
}

// ---------------------------------------------------------------------------
// Stable ID helpers
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic run ID from fixed execution-context values.
 * No random component — repeated calls with the same inputs always return the
 * same string so the UI can safely deduplicate on `runId`.
 *
 * Format: `run:<sessionToken>:<firstUserMessage digest>:<epochSecond>`
 * We truncate each segment so IDs stay compact and human-readable.
 */
export function deriveRunId(sessionToken: string, firstUserMessage: string, startTimeMs: number): string {
  const session = sessionToken.slice(0, 12).replace(/[^a-zA-Z0-9]/g, '_');
  // Simple deterministic digest: sum of char-codes mod 1e6, zero-padded to 6 digits.
  let hash = 0;
  for (let i = 0; i < firstUserMessage.length; i++) {
    hash = (hash * 31 + firstUserMessage.charCodeAt(i)) >>> 0;
  }
  const digest = (hash % 1_000_000).toString().padStart(6, '0');
  // Use full millisecond timestamp so the runId stays stable for the entire
  // duration of a single runAgentLoop invocation. epochSec (seconds) was
  // wrong because a run that straddles a second boundary would produce two
  // different runIds within the same invocation.
  return `run:${session}:${digest}:${startTimeMs}`;
}

/**
 * Derives a deterministic activity ID from the run context.
 * `toolCallId` is the existing `ToolCall.id` from the LLM response (stable).
 * `suffix` differentiates `in_progress` from `completed`/`failed` for the same call.
 */
function deriveActivityId(runId: string, iterationIndex: number, toolCallId: string, suffix: string): string {
  return `${runId}:i${iterationIndex}:${toolCallId}:${suffix}`;
}

/** Maps a tool name to the closest AgentTimelineActivityType. */
function toolNameToActivityType(name: string): AgentTimelineActivityType {
  switch (name) {
    case 'read_file':         return 'reading';
    case 'propose_file_edit': return 'editing';
    case 'patch_file': return 'editing';
    case 'search_files':      return 'searching';
    case 'search_content':    return 'searching';
    case 'list_dir':          return 'exploring';
    case 'run_command':       return 'running';
    case 'delete_file':       return 'deleting';
    case 'rename_file':       return 'editing';
    case 'update_design_manifest': return 'editing';
    case 'manage_plan':       return 'validating';
    case 'get_preview_logs':  return 'validating';
    case 'restart_preview':   return 'running';
    default:                  return 'running';
  }
}

// ---------------------------------------------------------------------------
// Verify before claiming. After the agent changes the app (code, config or packages), it checks the result
// before it says the work is done or fixed: the project's type check (validate_project, or tsc / flutter
// analyze) and the preview (restart_preview / get_preview_logs: dev-server errors, runtime errors in the page,
// visible content). Both must come back clean after the last change. The model is told so at its first change;
// if it answers with a check missing or failing, it gets one more turn to check and fix; after that its answer
// is marked "Not verified" with what is missing and the last error.
// ---------------------------------------------------------------------------

/** A check's output that shows a problem. */
const CHECK_FAILED = /Error lines in the output \(|^Preview: (error|not running)|Start error:|Runtime errors in the page \(|visible content NO|Error overlay on screen|"success": false|error TS\d+|exited with code [1-9]|^Error:|^BLOCKED:/m;

const CHANGE_TOOLS = new Set(['propose_file_edit', 'patch_file', 'delete_file', 'rename_file', 'bootstrap_project']);
const PACKAGE_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add|remove|uninstall|rm)\b|\bexpo\s+install\b/i;
const DEPS_CHECK_COMMAND = /\bexpo\s+install\b.*--check\b/i;
const TYPECHECK_COMMAND = /\btsc\b|\b(flutter|dart)\s+analyze\b/i;
/** Notes, not the app: the plan and walkthrough under .peep/, Markdown and text files. */
const NOTES = /(^|[\\/])\.peep[\\/]|\.(md|txt)$/i;
/** The Expo dependency check the app appends to a package command's output (agent-service run_command). */
const DEPS_CHECK_MARKER = 'npx expo install --check:';

export type VerificationRole = 'change' | 'deps' | 'depscheck' | 'typecheck' | 'preview' | null;

/**
 * Whether a tool call changes the app's code, changes its packages, checks its packages, checks its types,
 * checks the preview, or none of these. Exported for tests.
 */
export function verificationRole(name: string, args: Record<string, unknown>): VerificationRole {
  if (NOTES.test(String(args.path ?? ''))) return null;
  if (CHANGE_TOOLS.has(name)) return 'change';
  if (name === 'install_dependencies') return 'deps';
  if (name === 'validate_project') return 'typecheck';
  if (name === 'restart_preview' || name === 'get_preview_logs') return 'preview';
  if (name === 'run_command') {
    const command = String(args.command ?? '');
    if (DEPS_CHECK_COMMAND.test(command)) return 'depscheck';
    if (PACKAGE_COMMAND.test(command)) return 'deps';
    if (TYPECHECK_COMMAND.test(command)) return 'typecheck';
  }
  return null;
}

type CheckState = 'missing' | 'failed' | 'ok';

/** What one run changed and checked. Exported for tests. */
export class RunVerification {
  private changed = false;
  private checks: Record<'typecheck' | 'preview', CheckState> = { typecheck: 'missing', preview: 'missing' };
  /** Expo projects: whether the packages match the SDK ('ok' where there is no check to run). */
  private deps: 'ok' | 'failed' = 'ok';
  private failure = '';

  private noteFailure(output: string): void {
    const lines = output.split(/\r?\n/).filter((l) => /error|fail|NO:|not running|exited with code|should be updated|expected version/i.test(l));
    this.failure = (lines.length ? lines.slice(0, 4).join('\n') : output).slice(0, 600);
  }

  record(role: VerificationRole, output: string): void {
    if (role === 'change' || role === 'deps') {
      this.changed = true;
      this.checks = { typecheck: 'missing', preview: 'missing' };
      // A package change in an Expo project comes with its dependency check appended.
      const at = output.indexOf(DEPS_CHECK_MARKER);
      if (role === 'deps' && at >= 0) {
        const check = output.slice(at);
        this.deps = /exited with code [1-9]|^Command error:/m.test(check) ? 'failed' : 'ok';
        if (this.deps === 'failed') this.noteFailure(check);
      }
    } else if (role === 'depscheck') {
      this.deps = /exited with code [1-9]|^Command error:/m.test(output) ? 'failed' : 'ok';
      if (this.deps === 'failed') this.noteFailure(output);
    } else if (role === 'typecheck' || role === 'preview') {
      const failed = CHECK_FAILED.test(output);
      this.checks[role] = failed ? 'failed' : 'ok';
      // validate_project includes the Expo dependency check: clean means the packages match too.
      if (role === 'typecheck' && !failed && output.includes('"expo-deps"')) this.deps = 'ok';
      if (failed) this.noteFailure(output);
    }
  }

  get hasChanges(): boolean {
    return this.changed;
  }

  /** What is still missing or failing; empty when nothing changed or both checks passed after the last change. */
  gaps(): string[] {
    if (!this.changed) return [];
    const gaps: string[] = [];
    if (this.checks.typecheck === 'missing') gaps.push('the type check was not run after the last change');
    if (this.checks.typecheck === 'failed') gaps.push('the type check reports errors');
    if (this.checks.preview === 'missing') gaps.push('the preview was not checked after the last change');
    if (this.checks.preview === 'failed') gaps.push('the preview shows errors or an empty screen');
    if (this.deps === 'failed') gaps.push("some packages do not match the project's Expo SDK (npx expo install --check)");
    return gaps;
  }

  get lastFailure(): string {
    return this.failure;
  }
}

/** Exported for tests. */
export const VERIFY_REMINDER = '[Atomvs] When you have finished changing the app, and before you tell the user it is done or fixed, '
  + 'check it: run validate_project (zero type errors), then restart_preview (it waits for a fresh bundle and for the page to report) '
  + 'and read the report: no dev-server errors, no runtime errors in the page, and visible content. If a check fails, fix it '
  + 'and check again. Say it works ONLY when both checks are clean; otherwise say plainly what is still failing, quote the '
  + 'error, and say what you will try next.';

/** The mark on an answer whose changes were not verified. Exported for tests. */
export function unverifiedNotice(gaps: string[], lastFailure: string): string {
  const error = lastFailure ? `\n\n\`\`\`\n${lastFailure}\n\`\`\`` : '';
  return `\n\n**Not verified:** ${gaps.join('; ')}.${error}`;
}

export interface AgentToolExecutor {
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  lastOriginalContent?: string;
  lastProposedContent?: string;
}

const MAX_ITERATIONS = 50;

async function callOpenAI(
  config: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta?: (text: string) => void,
  onStatus?: (text: string) => void,
): Promise<ChatMessage> {
  if (!config.gateway) {
    throw new Error('AIGateway is required to make calls');
  }

  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    attempt++;
    let fullContent = '';
    const toolCalls: Array<{ id: string; name: string; arguments: string | Record<string, unknown> }> = [];
    let streamUsage: any;

    try {
      const stream = config.gateway.stream(
        {
          tier: config.capabilityTier,
          manualModel: config.manualModel,
          messages: messages.map((m) => {
            if (m.role === 'tool') {
              return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id, name: m.name || 'tool_name' };
            }
            if (m.role === 'assistant' && m.tool_calls) {
              return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls };
            }
            return { role: m.role, content: m.content };
          }),
          tools: OPENAI_TOOLS,
        },
        { signal }
      );

      for await (const event of stream) {
        if (signal.aborted) {
          throw new Error('Cancelled');
        }

        if (event.type === 'delta' && event.content) {
          fullContent += event.content;
          onDelta?.(event.content);
        } else if (event.type === 'tool_call' && event.toolCall) {
          toolCalls.push({
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
          });
        } else if (event.type === 'error' && event.error) {
          throw event.error; // Will be caught below and mapped if needed, though usually gateway handles it
        }
        if (event.usage) {
          streamUsage = event.usage;
        }
      }

      // Token Tracking
      if (streamUsage) {
        config.logger?.info('Token usage (official provider metric)', streamUsage);
      } else {
        const estInput = messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
        let estOutput = estimateTokens(fullContent);
        if (toolCalls.length > 0) {
          for (const tc of toolCalls) {
            estOutput += estimateTokens(tc.name) + estimateTokens(typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments));
          }
        }
        config.logger?.info('Token usage (estimated fallback)', { inputTokens: estInput, outputTokens: estOutput });
      }

      if (toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: fullContent,
          tool_calls: toolCalls.map((t) => ({
            id: t.id,
            type: 'function',
            function: {
              name: t.name,
              arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments),
            },
          })),
        };
      }

      return { role: 'assistant', content: fullContent || 'No response.' };

    } catch (error: any) {
      if (signal.aborted || error.message === 'Cancelled' || error.name === 'AbortError') {
        throw error;
      }

      // If we already emitted content to the user, DO NOT retry. Just return what we have or throw.
      // We throw to ensure the state machine hits error properly and we don't present a broken half-response as complete.
      if (fullContent.length > 0) {
        throw error;
      }

      if (error instanceof ProviderError && error.retryable && attempt < maxAttempts) {
        const backoffMs = error.retryAfterMs || (attempt === 1 ? 2000 : 4000);
        // Structured warn for every retryable attempt → local file log only (not a Sentry breadcrumb).
        // Sentry breadcrumbs are reserved for exhaustion/fatal events below.
        config.logger?.warn(`Provider error (${error.code}). Retrying attempt ${attempt}`, { attempt, error_code: error.code, backoffMs });
        
        if (onStatus) {
          onStatus(`Provider error (${error.code}). Retrying in ${backoffMs / 1000}s...`);
        }
        
        // Wait with abort signal check
        let timeoutId: any;
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timeoutId);
            reject(new Error('Cancelled'));
          };
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort);
          timeoutId = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, backoffMs);
        });
        
        continue;
      }
      
      // Non-retryable or retries exhausted → high-value event for both local log and Sentry breadcrumb.
      config.logger?.error('Provider fatal error or non-retryable', { err: error, runId: config.runId || config.threadId, attempt, code: error.code });
      throw error;
    }
  }
  
  // Retry loop exhausted → high-value terminal event.
  config.logger?.error('Max retries exceeded', { runId: config.runId || config.threadId });
  throw new Error('Max retries exceeded');
}



export async function runAgentLoop(
  config: AgentConfig,
  systemContext: string,
  initialMessages: ChatMessage[],
  executor: AgentToolExecutor,
  callbacks: AgentCallbacks,
  signal: AbortSignal,
  isComplex?: boolean,
): Promise<string> {
  if (!config.gateway) {
    throw new Error('AIGateway is missing from AgentConfig');
  }

  const startTimeMs = Date.now();
  const startTime = performance.now();

  // -------------------------------------------------------------------------
  // Timeline: derive stable IDs and emit the initial 'understanding' event
  // -------------------------------------------------------------------------
  const firstUserMsg = initialMessages.find((m) => m.role === 'user')?.content ?? '';
  const runId = deriveRunId(config.sessionToken, firstUserMsg, startTimeMs);

  const dispatchTimeline = (activity: AgentTimelineActivity): void => {
    callbacks.onTimelineActivity?.(activity);
  };

  // Emit the 'understanding' event immediately so the UI shows the run started.
  dispatchTimeline({
    id: `${runId}:understanding`,
    runId,
    type: 'understanding',
    message: 'Understanding request…',
    status: 'in_progress',
    timestamp: new Date().toISOString(),
  });

  // What the agent did is reported only as timeline activities (the app shows them as a collapsible
  // "Worked for …" list). Text deltas carry the model's answer and nothing else: the chat renders them as
  // markdown, so markup injected here would show up as raw text.

  let currentPhase = 'idle';
  function emitPhase(phase: any) {
    if (phase !== currentPhase) {
      config.logger?.info(`Agent state transitioned: ${currentPhase} -> ${phase}`);
      currentPhase = phase;
    }
    if (callbacks?.onPhaseChange) {
      callbacks.onPhaseChange(phase, config.threadId);
    }
  }

  // Inject Planner directive for complex requests
  let activeContext = systemContext;
  if (isComplex) {
    activeContext += `\n\n[PLANNING MODE ACTIVE] You are faced with a complex software engineering task. First, outline a clear step-by-step checklist of actions and files you will edit. Only then proceed.`;
  }

  let conversationHistory: ChatMessage[] = [
    { role: 'system', content: activeContext },
    ...initialMessages,
  ];

  let effectiveBudget = 100000;
  if (typeof config.gateway.getContextLimit === 'function') {
     effectiveBudget = Math.max(10000, config.gateway.getContextLimit(config.capabilityTier) - 4096 - 2000);
  }

  let accumulatedResponseText = '';
  // Notify observer that LLM thinking begins.
  emitPhase('thinking');

  // Verify-before-claiming state (see RunVerification).
  const verification = new RunVerification();
  let reminded = false;
  let gaveCheckTurn = false;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal.aborted) throw new Error('Cancelled');

    callbacks.onStatus(i === 0 ? 'Thinking…' : 'Continuing…');

    // Truncate dynamically before each LLM call to prevent loop growth token exhaustion
    conversationHistory = truncateConversationHistory(conversationHistory, { maxTokens: effectiveBudget });
    config.logger?.info('Context window truncation completed', { 
      budget: effectiveBudget, 
      retainedMessages: conversationHistory.length 
    });

    const assistantMessage = await callOpenAI(
      config,
      conversationHistory,
      signal,
      (delta) => callbacks.onDelta(delta),
      callbacks.onStatus
    );

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      // Notify observer: entering tool execution phase.
      emitPhase('tool_executing');
      conversationHistory.push(assistantMessage);

      // -----------------------------------------------------------------------
      // Timeline: emit 'in_progress' for each tool call BEFORE execution,
      //           then 'completed'/'failed' AFTER, preserving event ordering.
      // -----------------------------------------------------------------------
      const toolCallsThisIter = assistantMessage.tool_calls;
      const toolResultMessages: ChatMessage[] = [];

      for (let j = 0; j < toolCallsThisIter.length; j++) {
        const call = toolCallsThisIter[j];
        const name = call.function.name;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments); } catch {}

        const activityType = toolNameToActivityType(name);
        // Reuse the LLM-supplied call.id as the stable anchor; it is already
        // deterministic per turn because the model generates it consistently.
        const inProgressId = deriveActivityId(runId, i, call.id, 'in_progress');
        const resolvedId   = deriveActivityId(runId, i, call.id, 'resolved');

        // Build a human-readable message for the in-progress event.
        let inProgressMsg = `Running ${name}…`;
        let fileHint: string | undefined;
        let cmdHint: string | undefined;
        if (name === 'read_file')          { inProgressMsg = `Reading ${args.path || ''}`; fileHint = String(args.path || ''); }
        else if (name === 'propose_file_edit' || name === 'patch_file') { inProgressMsg = `Editing ${args.path || ''}`; fileHint = String(args.path || ''); }
        else if (name === 'search_files')  { inProgressMsg = `Searching files: "${args.query || ''}"`; }
        else if (name === 'search_content'){ inProgressMsg = `Searching codebase: "${args.query || ''}"`; }
        else if (name === 'list_dir')      { inProgressMsg = `Exploring: ${args.path || '.'}`; fileHint = String(args.path || '.'); }
        else if (name === 'run_command')   { inProgressMsg = `Running: ${args.command || ''}`; cmdHint = String(args.command || ''); }
        else if (name === 'delete_file')   { inProgressMsg = `Deleting: ${args.path || ''}`; fileHint = String(args.path || ''); }
        else if (name === 'rename_file')   { inProgressMsg = `Renaming: ${args.oldPath || ''} → ${args.newPath || ''}`; }

        // Dispatch 'in_progress' before execution.
        dispatchTimeline({
          id: inProgressId,
          runId,
          type: activityType,
          message: inProgressMsg,
          status: 'in_progress',
          timestamp: new Date().toISOString(),
          ...(fileHint ? { file: fileHint } : {}),
          ...(cmdHint  ? { command: cmdHint } : {}),
        });

        // Execute the single tool call.
        const singleCallMsg = await (async () => {
          const singleCallName = call.function.name;
          const singleCallArgs = args;
          callbacks.onStatus(inProgressMsg);
          try {
            const output = await executor.execute(singleCallName, singleCallArgs);
            return { role: 'tool' as const, tool_call_id: call.id, name: singleCallName, content: output };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { role: 'tool' as const, tool_call_id: call.id, name: singleCallName, content: `Error: ${message}` };
          }
        })();

        toolResultMessages.push(singleCallMsg);

        verification.record(verificationRole(name, args), singleCallMsg.content);

        // Determine outcome.
        const toolFailed = singleCallMsg.content.startsWith('Error:');

        // Dispatch 'completed' or 'failed' AFTER execution.
        dispatchTimeline({
          id: resolvedId,
          runId,
          type: activityType,
          message: toolFailed ? `Failed: ${singleCallMsg.content.slice(0, 120)}` : inProgressMsg,
          status: toolFailed ? 'failed' : 'completed',
          timestamp: new Date().toISOString(),
          ...(fileHint ? { file: fileHint } : {}),
          ...(cmdHint  ? { command: cmdHint } : {}),
        });
      }

      // First change to the app in this run: say how to finish, long before the model writes its answer.
      if (verification.hasChanges && !reminded && toolResultMessages.length > 0) {
        const last = toolResultMessages[toolResultMessages.length - 1];
        last.content = `${last.content}\n\n${VERIFY_REMINDER}`;
        reminded = true;
      }

      conversationHistory.push(...toolResultMessages);
      // Return to thinking phase for next LLM call.
      emitPhase('thinking');
      continue;
    }

    const text = assistantMessage.content?.trim();
    const gaps = verification.gaps();
    if (text && gaps.length > 0 && !gaveCheckTurn) {
      // It answered with a check missing or failing: one more turn to check and fix (its answer is already on screen).
      gaveCheckTurn = true;
      accumulatedResponseText += `${text}\n\n`;
      callbacks.onDelta('\n\n');
      conversationHistory.push({ role: 'assistant', content: text });
      conversationHistory.push({ role: 'user', content: `[Atomvs] Not done yet: ${gaps.join('; ')}.\n\n${VERIFY_REMINDER}` });
      continue;
    }
    if (text) {
      accumulatedResponseText += text;
      if (gaps.length > 0) {
        const notice = unverifiedNotice(gaps, verification.lastFailure);
        accumulatedResponseText += notice;
        callbacks.onDelta(notice);
      }
      // Timeline: emit 'completed' for the whole run (zero-tool conversational path).
      dispatchTimeline({
        id: `${runId}:completed`,
        runId,
        type: 'completed',
        message: 'Done.',
        status: 'completed',
        timestamp: new Date().toISOString(),
      });
      emitPhase('done');
      const durationMs = performance.now() - startTime; config.logger?.info('Agent run completed', { durationMs, runId }); callbacks.onDone();
      return accumulatedResponseText;
    }

    break;
  }

  callbacks.onStatus('Summarizing changes…');
  // Notify observer: entering summarization phase.
  emitPhase('summarizing');
  let summaryContent = '';
  await callOpenAI(
    config,
    [
      ...conversationHistory,
      {
        role: 'user',
        content: 'Summarize what you did and what the user should review. Be concise.',
      },
    ],
    signal,
    (delta) => {
      summaryContent += delta;
      callbacks.onDelta(delta);
    }
  );

  // Timeline: emit final 'completed' event for the whole run.
  dispatchTimeline({
    id: `${runId}:completed`,
    runId,
    type: 'completed',
    message: 'Done.',
    status: 'completed',
    timestamp: new Date().toISOString(),
  });

  callbacks.onPhaseChange?.('done');
  const durationMs = performance.now() - startTime; config.logger?.info('Agent run completed', { durationMs, runId }); callbacks.onDone();
  return summaryContent;
}
