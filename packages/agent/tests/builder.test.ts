import { buildAgentContext } from '../src/context/builder';

export default async function run() {
  console.log('  Testing buildAgentContext with previewError...');

  // Test case 1: context without error
  const contextWithoutError = buildAgentContext({
    userMessage: 'Hello world',
  });
  if (contextWithoutError.includes('Active Preview/Build Compilation Error')) {
    throw new Error('Expected context to NOT contain error block when previewError is missing');
  }

  // Test case 2: context with previewError
  const mockError = 'Target of URI does not exist: package:flutter/material.dart';
  const contextWithError = buildAgentContext({
    userMessage: 'Fix the build please',
    previewError: mockError,
  });

  if (!contextWithError.includes('Active Preview/Build Compilation Error')) {
    throw new Error('Expected context to contain the compilation error block title');
  }

  if (!contextWithError.includes(mockError)) {
    throw new Error('Expected context to include the exact mock error message');
  }

  // A clear coding request is planned and built in the same turn; only destructive or ambiguous changes wait.
  console.log('  Testing the plan rule: build in the same turn...');
  if (contextWithoutError.includes('Do NOT edit code files in the same turn as writing/updating the plan')) {
    throw new Error('System prompt still tells the agent to stop after the plan');
  }
  if (!contextWithoutError.includes('Then implement it IN THE SAME TURN') || !/ONLY when \(a\) the change is destructive/.test(contextWithoutError)) {
    throw new Error('System prompt is missing the plan-then-build rule or its destructive/ambiguous exception');
  }

  console.log('  Testing buildAgentContext with selectedCode...');

  // Test case 3: Selection in foo.ts stores filePath = foo.ts, and retains start/end lines
  const contextWithSelection = buildAgentContext({
    userMessage: 'Fix this',
    openFilePath: 'bar.ts', // User switched tabs to bar.ts
    selectedCode: {
      text: 'const x = 42;',
      startLine: 10,
      endLine: 12,
      filePath: 'foo.ts' // Originated from foo.ts
    }
  });

  if (!contextWithSelection.includes('Selected Code (File: foo.ts, Lines: 10-12):')) {
    throw new Error('Expected context to label the selection with its own filePath (foo.ts), not the openFilePath (bar.ts)');
  }
  if (!contextWithSelection.includes('const x = 42;')) {
    throw new Error('Expected context to include the exact selected text');
  }

  // Test case 4: No selection produces no selected-code context
  const contextNoSelection = buildAgentContext({
    userMessage: 'Hello',
    openFilePath: 'foo.ts',
  });

  if (contextNoSelection.includes('Selected Code')) {
    throw new Error('Expected no Selected Code block when selectedCode is undefined');
  }

  console.log('  Testing buildAgentContext successfully passed!');
}
