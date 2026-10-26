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
