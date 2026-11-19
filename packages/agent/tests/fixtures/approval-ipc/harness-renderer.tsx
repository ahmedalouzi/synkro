/** Window of the approval IPC harness: the real store, subscriptions and ApprovalCard, as the chat uses them. */
import { createRoot } from 'react-dom/client';
import { ApprovalCard } from '../../../../../apps/desktop/src/renderer/src/features/chat/ApprovalCard';
import { useApprovalStore } from '../../../../../apps/desktop/src/renderer/src/stores/approval-store';

function Cards() {
  const pending = useApprovalStore((s) => s.pending);
  return <>{pending.map((r) => <ApprovalCard key={r.id} request={r} />)}</>;
}

// The same three calls as usePeepEvents.
void window.peep.getPendingApprovals().then((pending) => useApprovalStore.getState().setAll(pending));
window.peep.onApprovalRequest((request) => useApprovalStore.getState().add(request));
window.peep.onApprovalResolved(({ id }) => useApprovalStore.getState().remove(id));

createRoot(document.getElementById('root')!).render(<Cards />);
(window as any).__harnessReady = true;
