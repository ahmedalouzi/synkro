import { create } from 'zustand';
import type { ApprovalDecision, ApprovalRequest } from '@peep/shared';

/**
 * The agent's requests waiting for the user (approval cards in the chat): a command to run or a file to delete.
 * Filled from main (onApprovalRequest / onApprovalResolved, usePeepEvents); answered with respond().
 */
interface ApprovalState {
  pending: ApprovalRequest[];
  add: (request: ApprovalRequest) => void;
  remove: (id: string) => void;
  setAll: (requests: ApprovalRequest[]) => void;
  respond: (id: string, decision: ApprovalDecision) => Promise<void>;
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  pending: [],
  add: (request) => set((s) => (s.pending.some((p) => p.id === request.id) ? s : { pending: [...s.pending, request] })),
  remove: (id) => set((s) => ({ pending: s.pending.filter((p) => p.id !== id) })),
  setAll: (requests) => set({ pending: requests }),
  respond: async (id, decision) => {
    // Off the screen at once; main confirms with onApprovalResolved.
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
    await window.peep.respondApproval(id, decision);
  },
}));
