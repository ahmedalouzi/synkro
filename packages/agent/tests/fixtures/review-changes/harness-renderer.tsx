/** Window of the review-changes harness: the real DiffViewer, in an editor-sized box, with N new files from the agent. */
import { createRoot } from 'react-dom/client';
import type { ProposedEdit } from '@peep/shared';
import { DiffViewer } from '../../../../../apps/desktop/src/renderer/src/features/chat/DiffViewer';
import { useChatStore } from '../../../../../apps/desktop/src/renderer/src/stores/chat-store';

const count = Number(new URLSearchParams(location.search).get('files') ?? '15');
const edits: ProposedEdit[] = Array.from({ length: count }, (_, i) => ({
  id: `e${i}`,
  path: `C:\\proj\\lib\\screens\\screen_${i}.dart`,
  originalContent: '',
  proposedContent: Array.from({ length: 40 }, (_, l) => `// screen ${i} line ${l}`).join('\n'),
}));
useChatStore.getState().setProposedEdits(edits);

// The editor area: a positioned box of a typical height, as EditorPane gives the tab.
createRoot(document.getElementById('root')!).render(
  <div id="editor" style={{ position: 'absolute', left: 0, top: 0, width: 900, height: 700 }}>
    <DiffViewer />
  </div>,
);
(window as any).__harnessReady = true;
