import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlatformAdapter } from '@peep/platform-core';
import type { Diagnostic, PreviewSession } from '@peep/shared';

export { PROJECT_TEMPLATES, getTemplate } from './templates';
export type { ProjectTemplate, TemplateFile } from './templates';

export function parseFlutterAnalyze(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const patterns = [
    // `flutter analyze` right-aligns the severity: "  error • …", "warning • …" (Flutter 3.44), so leading spaces.
    /^[ \t]*(error|warning|info)\s*•\s*(.+?)\s*•\s*(.+?):(\d+):(\d+)\s*•/gm,
    /^[ \t]*(error|warning|info)\s*•\s*(.+?)\s*•\s*(.+?):(\d+):(\d+)\s*$/gm,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      const entry: Diagnostic = {
        severity: match[1] as Diagnostic['severity'],
        message: match[2].trim(),
        file: match[3].trim(),
        line: Number(match[4]),
        column: Number(match[5]),
      };

      const duplicate = diagnostics.some(
        (d) =>
          d.file === entry.file &&
          d.line === entry.line &&
          d.column === entry.column &&
          d.message === entry.message,
      );

      if (!duplicate) diagnostics.push(entry);
    }
  }

  return diagnostics;
}

export function createFlutterAdapter(): PlatformAdapter {
  return {
    id: 'flutter',

    async detectProject(root: string): Promise<boolean> {
      try {
        await readFile(join(root, 'pubspec.yaml'), 'utf-8');
        return true;
      } catch {
        return false;
      }
    },

    async analyze(_root: string): Promise<Diagnostic[]> {
      return [];
    },

    async startPreview(_root: string): Promise<PreviewSession> {
      return {
        url: 'http://localhost:0',
        processId: 0,
        status: 'stopped',
      };
    },

    async stopPreview(_processId: number): Promise<void> {
      // Implemented in desktop FlutterService
    },

    async getAgentContext(root: string) {
      let pubspec: string | undefined;
      let mainDart: string | undefined;

      try {
        pubspec = await readFile(join(root, 'pubspec.yaml'), 'utf-8');
      } catch {
        /* optional */
      }

      try {
        mainDart = await readFile(join(root, 'lib', 'main.dart'), 'utf-8');
      } catch {
        /* optional */
      }

      return {
        projectRoot: root,
        treeSummary: 'lib/',
        pubspec,
        mainDart,
        recentErrors: [],
      };
    },
  };
}
