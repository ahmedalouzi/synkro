/** Window of the chat-design harness: the real AgentRun with a run like a real one (test only). */
import { createRoot } from 'react-dom/client';
import type { AgentTimelineActivity, ApprovalRequest, ProposedEdit } from '@peep/shared';
import { AgentRun } from '../../../../../apps/desktop/src/renderer/src/features/agent-run/AgentRun';

const t0 = Date.parse('2026-11-19T10:00:00Z');
let n = 0;
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
const act = (type: AgentTimelineActivity['type'], s: number, extra: Partial<AgentTimelineActivity>): AgentTimelineActivity => ({
  id: `run1:${n++}:resolved`, runId: 'run1', type, message: '', status: 'completed', timestamp: at(s), ...extra,
});
const files = Array.from({ length: 15 }, (_, i) => `lib/screens/screen_${i}.dart`);
const activities: AgentTimelineActivity[] = [
  { id: 'run1:u', runId: 'run1', type: 'understanding', message: 'Understanding', status: 'completed', timestamp: at(0) },
  act('reading', 4, { message: 'Reading lib/main.dart', file: 'lib/main.dart' }),
  act('searching', 5, { message: 'Searching codebase: "NavigationBar"' }),
  act('running', 6, { message: 'Running: npx expo install expo-camera', command: 'npx expo install expo-camera', packages: ['expo-camera'] }),
  act('running', 7, { message: 'Blocked: Stopping processes by name would also stop them outside Atomvs.', command: 'taskkill /F /IM dart.exe', status: 'blocked' }),
  ...files.map((f, i) => act('creating', 8 + i, { message: `Editing ${f}`, file: f })),
  { id: 'run1:w:in_progress', runId: 'run1', type: 'running', message: 'Running: git checkout -b demo', command: 'git checkout -b demo', status: 'in_progress', timestamp: at(30) },
];
const pendingEdits: ProposedEdit[] = files.map((f, i) => ({ id: `e${i}`, path: `C:/proj/${f}`, originalContent: '', proposedContent: 'x\n'.repeat(10) }));
const counts = Object.fromEntries(pendingEdits.map((e) => [e.path, { added: 10, removed: 0 }]));
const approvals: ApprovalRequest[] = [{ id: 'a1', kind: 'command', subject: 'git checkout -b demo', reason: 'Not on the list.', alwaysAllowKey: 'git checkout' }];
const calls: string[] = [];
(window as any).__calls = calls;

createRoot(document.getElementById('root')!).render(
  <div style={{ width: 420 }}>
    <AgentRun
      activities={activities}
      isLive
      projectPath="C:/proj"
      pendingEdits={pendingEdits}
      counts={counts}
      resolutions={{}}
      refresh={{ kind: 'fast-refresh', ms: 412, device: 'iPhone 15' } as any}
      onOpenFile={(p) => calls.push(`open ${p}`)}
      onUndo={(e) => calls.push(`undo ${e.length}`)}
      onKeep={(e) => calls.push(`keep ${e.length}`)}
      onReview={() => calls.push('review')}
      plan="I'll add the camera screen and its tab."
      approvals={approvals}
    />
  </div>,
);
(window as any).__harnessReady = true;
