import { useWorkspaceStore } from '../../stores/workspace-store';

/** Sends a message to the agent chat from anywhere (Problems, terminal…), opening the chat if needed. */
export function askAgent(message: string): void {
  const ws = useWorkspaceStore.getState();
  const wasOpen = ws.agentPaneOpen;
  if (!wasOpen) ws.toggleAgentPane();
  // Give the chat pane a moment to mount its listener when it was closed.
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('peep:trigger-agent', { detail: { message } }));
  }, wasOpen ? 0 : 50);
}

/** Cursor's Ctrl+L: attach the editor selection to the chat input and focus it. */
export function addSelectionToChat(): void {
  const ws = useWorkspaceStore.getState();
  const wasOpen = ws.agentPaneOpen;
  if (!wasOpen) ws.toggleAgentPane();
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('peep:chat-add-selection'));
  }, wasOpen ? 0 : 50);
}
