/**
 * Command Safety Layer
 *
 * Backed by the unified `command-policy.ts` engine.
 * Classifies commands as:
 * - 'safe': auto-executed without confirmation
 * - 'dangerous': requires explicit user confirmation
 * - 'blocked': hard blocked, never executed
 */

import { evaluateCommandPolicy, isCommandAllowed, type CommandPolicyResult, type SafetyLevel } from './command-policy';

export type { SafetyLevel };

export interface CommandSafetyResult {
  level: SafetyLevel;
  reason?: string;
  policy?: CommandPolicyResult;
}

export { isCommandAllowed, evaluateCommandPolicy };

export function classifyCommand(command: string): CommandSafetyResult {
  const policy = evaluateCommandPolicy(command);
  return {
    level: policy.level,
    reason: policy.reason,
    policy,
  };
}
