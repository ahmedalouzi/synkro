import type { AgentTimelineActivity, FileEntry } from '@peep/shared';
import { findNode, foldersToRefresh, samePath } from '../../../apps/desktop/src/renderer/src/features/explorer/live-tree';
import { planState, stepsDone } from '../../../apps/desktop/src/renderer/src/features/plan/plan-status';

/** The Explorer follows file changes on disk; the plan tab offers Proceed only when the agent stopped to ask. */
export default async function run() {
  console.log('  [live-tree] Which folders re-list after the agent adds, removes or renames files...');
  const dirs = foldersToRefresh([
    { type: 'add', path: 'C:/p/app/src/types/study.ts' },
    { type: 'add', path: 'C:/p/app/src/data/mockData.ts' },
    { type: 'addDir', path: 'C:/p/app/src/components/srs' },
    { type: 'add', path: 'C:/p/app/src/components/srs/SpacedRepetitionView.tsx' },
    { type: 'unlink', path: 'C:/p/app/src/old.ts' },
    { type: 'change', path: 'C:/p/app/App.tsx' }, // content only: no folder changes
    { type: 'add', path: 'C:/p/app/src/types/other.ts' }, // same folder once
  ]).sort();
  const expected = ['C:/p/app/src', 'C:/p/app/src/components', 'C:/p/app/src/components/srs', 'C:/p/app/src/data', 'C:/p/app/src/types'];
  if (JSON.stringify(dirs) !== JSON.stringify(expected)) throw new Error(`foldersToRefresh: ${dirs.join(', ')}`);

  console.log('  [live-tree] Watcher paths ("/") match tree and tab paths ("\\")...');
  if (!samePath('C:/p/app/src/a.ts', 'C:\\p\\app\\src\\a.ts')) throw new Error('slashes');
  if (!samePath('c:/p/App/src/a.ts', 'C:\\p\\app\\src\\a.ts')) throw new Error('Windows case');
  if (samePath('/home/u/A.ts', '/home/u/a.ts')) throw new Error('POSIX paths must keep case');
  const tree: FileEntry[] = [
    { name: 'src', path: 'C:\\p\\app\\src', type: 'directory', children: [
      { name: 'types', path: 'C:\\p\\app\\src\\types', type: 'directory', children: [] },
    ] },
  ] as FileEntry[];
  if (findNode(tree, 'C:/p/app/src/types')?.name !== 'types' || findNode(tree, 'C:/p/app/src/missing')) throw new Error('findNode');

  console.log('  [plan] Proceed only when the agent wrote the plan and stopped...');
  const act = (type: AgentTimelineActivity['type'], file: string): AgentTimelineActivity =>
    ({ id: `${type}-${file}`, runId: 'r', type, file, message: '', status: 'completed', timestamp: '' } as AgentTimelineActivity);
  const wrotePlan = [act('reading', 'App.tsx'), act('editing', '.peep/plan.md')];
  const builtIt = [...wrotePlan, act('editing', 'src/types/study.ts'), act('editing', '.peep/walkthrough.md')];
  const cases: Array<[string, string]> = [
    [planState({ busy: true, lastRun: wrotePlan, plan: null }), 'in_progress'],
    [planState({ busy: false, lastRun: builtIt, plan: null }), 'done'],
    [planState({ busy: false, lastRun: wrotePlan, plan: null }), 'waiting'],
    [planState({ busy: false, lastRun: wrotePlan, plan: { status: 'completed' } }), 'done'],
    [planState({ busy: false, lastRun: [], plan: null }), 'unknown'],
    [planState({ busy: false, lastRun: [act('editing', '.peep\\walkthrough.md')], plan: null }), 'unknown'],
  ];
  cases.forEach(([got, want], i) => { if (got !== want) throw new Error(`planState case ${i}: ${got}, expected ${want}`); });
  if (stepsDone({ steps: [{ status: 'completed' }, { status: 'pending' }, { status: 'completed' }] }) !== '2 of 3 steps done') throw new Error('stepsDone');
  if (stepsDone(null) !== null) throw new Error('stepsDone null');

  console.log('  v Live tree and plan status tests passed.');
}
