import type { NormalizedError, RecoveryErrorCategory } from '@peep/shared';
import type { ProjectIndexer } from '../intelligence/indexer';

const DANGEROUS_COMMANDS = ['rm -rf /', 'format c:', 'sudo rm -rf', 'mkfs'];

export function classifyError(
  toolName: string,
  rawError: string,
  exitCode?: number,
  stdout?: string,
  stderr?: string,
  command?: string
): NormalizedError {
  const text = `${rawError} ${stdout || ''} ${stderr || ''}`.toLowerCase();
  const cmd = (command || '').toLowerCase();

  let category: RecoveryErrorCategory = 'unrecoverable';

  // Check dangerous commands first
  if (DANGEROUS_COMMANDS.some(d => cmd.includes(d))) {
    category = 'unrecoverable';
  } else if (
    text.includes('cannot find module') ||
    text.includes('module_not_found') ||
    text.includes('package not found') ||
    text.includes('npm err! 404') ||
    text.includes('missing dependency') ||
    text.includes('elifecycle')
  ) {
    category = 'missing_dependency';
  } else if (
    text.includes('package.json not found') ||
    text.includes('project not ready') ||
    text.includes('project_root_not_found') ||
    text.includes('wrong working directory')
  ) {
    category = 'wrong_directory';
  } else if (
    text.includes('enoent') ||
    text.includes('no such file or directory') ||
    text.includes('file not found')
  ) {
    category = 'missing_file';
  } else if (
    text.includes('expo preview error') ||
    text.includes('eaddrinuse') ||
    text.includes('port occupied') ||
    text.includes('platformregistry fallback null')
  ) {
    category = 'preview_failure';
  } else if (
    text.includes('ts2339') ||
    text.includes('ts2304') ||
    text.includes('type error') ||
    text.includes('diagnostics')
  ) {
    category = 'type_error';
  } else if (
    text.includes('ettimedout') ||
    text.includes('econnreset') ||
    text.includes('socket hang up') ||
    text.includes('temporary network failure')
  ) {
    category = 'transient';
  } else if (
    text.includes('test failed') ||
    text.includes('expect(') ||
    text.includes('failing tests') ||
    text.includes('validation error') ||
    text.includes('verification failed') ||
    toolName === 'verify_criterion'
  ) {
    category = 'verification_failure';
  } else if (exitCode !== undefined && exitCode !== 0) {
    // General non-zero exit code
    category = 'transient';
  }

  // Extract affected files
  const affectedFiles = new Set<string>();
  const combinedText = `${rawError}\n${stdout || ''}\n${stderr || ''}`;
  
  // Look for typical file paths in errors
  const pathRegex = /(?:^|\s|'|")((?:\.?\.?\/|\\)?[a-zA-Z0-9_\-\./\\]+\.(?:tsx|ts|jsx|js|json|dart))['"]?:?/g;
  let match;
  while ((match = pathRegex.exec(combinedText)) !== null) {
    let extracted = match[1].replace(/\\/g, '/');
    if (extracted.startsWith('./')) extracted = extracted.substring(2);
    if (extracted && extracted.length > 3) {
      affectedFiles.add(extracted);
    }
  }

  return {
    toolName,
    command,
    exitCode,
    stdout,
    stderr,
    message: rawError.substring(0, 500),
    category,
    timestamp: new Date().toISOString(),
    affectedFiles: affectedFiles.size > 0 ? Array.from(affectedFiles) : undefined
  };
}

export function selectRecoveryStrategy(
  error: NormalizedError,
  currentAttempt: number,
  maxRetries: number = 3,
  indexer?: ProjectIndexer
): { strategy: string; actionHint: string; isRecoverable: boolean } {
  if (indexer && error.affectedFiles && error.affectedFiles.length > 0) {
    try {
      const graphBuilder = indexer.getDependencyGraphBuilder();
      const impactRadius = graphBuilder.getImpactRadius(error.affectedFiles, 1); // Depth 1
      if (impactRadius.length > 0) {
        error.impactRadius = impactRadius;
      }
    } catch (e) {
      // Ignore graph resolution errors during recovery selection
    }
  }
  if (currentAttempt >= maxRetries || error.category === 'unrecoverable') {
    return {
      strategy: 'Strategy limits exhausted',
      actionHint: 'Mark step failed and halt retries for this strategy.',
      isRecoverable: false
    };
  }

  switch (error.category) {
    case 'missing_dependency': {
      if (currentAttempt === 1) {
        return {
          strategy: 'Install Missing Dependency',
          actionHint: 'Run package manager install command to install required modules.',
          isRecoverable: true
        };
      }
      // Not --legacy-peer-deps: it hides the conflict on this machine, and the Cloud Build install fails on it later.
      return {
        strategy: 'Fix Conflicting Package Versions',
        actionHint: 'Resolve the conflict instead of forcing it: in an Expo project run "npx expo install --fix", and install '
          + 'the version of the conflicting package whose peer dependencies match the installed ones (check with "npm ls --depth=0"). '
          + 'Do not use --legacy-peer-deps or --force.',
        isRecoverable: true
      };
    }
    case 'wrong_directory': {
      if (currentAttempt === 1) {
        return {
          strategy: 'Locate Nested Project Root',
          actionHint: 'Trace subdirectories for package.json / pubspec.yaml and update working directory.',
          isRecoverable: true
        };
      }
      return {
        strategy: 'Scaffold Missing Workspace Root',
        actionHint: 'Initialize default package.json in workspace root.',
        isRecoverable: true
      };
    }
    case 'preview_failure': {
      if (currentAttempt === 1) {
        return {
          strategy: 'Retry Preview with Resolved CWD',
          actionHint: 'Re-detect project path and spawn preview process in project directory.',
          isRecoverable: true
        };
      }
      return {
        strategy: 'Clear Preview Cache & Restart',
        actionHint: 'Kill stale preview processes and restart dev server.',
        isRecoverable: true
      };
    }
    case 'missing_file': {
      return {
        strategy: 'Create Missing File / Directory',
        actionHint: 'Create parent directory structure and write missing target file.',
        isRecoverable: true
      };
    }
    case 'type_error': {
      return {
        strategy: 'Inspect Diagnostics & Fix Type Symbols',
        actionHint: 'Read compiler diagnostics and update component props or type declarations.',
        isRecoverable: true
      };
    }
    case 'verification_failure': {
      if (currentAttempt === 1) {
        return {
          strategy: 'Analyze Verification Trace & Edit Implementation',
          actionHint: 'Inspect the test output, identify broken logic in affected files, and update implementation.',
          isRecoverable: true
        };
      }
      return {
        strategy: 'Analyze Test Specs & Edit Tests',
        actionHint: 'Inspect the test expectations. If the implementation is correct, update the smoke tests to match the new behavior.',
        isRecoverable: true
      };
    }
    case 'transient': {
      return {
        strategy: `Exponential Backoff Retry (Attempt ${currentAttempt + 1})`,
        actionHint: 'Wait briefly and retry command execution.',
        isRecoverable: true
      };
    }
    default:
      return {
        strategy: 'Manual Inspection Required',
        actionHint: 'Cannot recover automatically.',
        isRecoverable: false
      };
  }
}
