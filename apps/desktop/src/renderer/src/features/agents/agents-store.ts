import { create } from 'zustand';
import type { AgentInfo } from '@peep/shared';
import { useWorkspaceStore } from '../../stores/workspace-store';

/** Installed coding-agent extensions (Claude Code, Codex, ...) and opening them in editor tabs. */

export const AGENT_TAB_PREFIX = 'agent://';

interface AgentsState {
  agents: AgentInfo[];
  refresh: () => Promise<void>;
}

export const useAgentsStore = create<AgentsState>((set) => ({
  agents: [],
  refresh: async () => {
    try {
      set({ agents: await window.peep.listAgents() });
    } catch {
      set({ agents: [] });
    }
  },
}));

/** The extension id behind an agent tab path (`agent://<extensionId>#<n>`). */
export function agentIdFromTab(path: string): string {
  return path.slice(AGENT_TAB_PREFIX.length).split('#')[0];
}

let tabCounter = 0;

/** Opens a new tab running the agent's CLI in the project folder. */
export function openAgentTab(agent: AgentInfo): void {
  tabCounter += 1;
  const store = useWorkspaceStore.getState();
  const sameAgent = store.openFiles.filter((f) => f.path.startsWith(`${AGENT_TAB_PREFIX}${agent.extensionId}#`)).length;
  store.openFile({
    path: `${AGENT_TAB_PREFIX}${agent.extensionId}#${Date.now()}-${tabCounter}`,
    name: sameAgent ? `${agent.name} ${sameAgent + 1}` : agent.name,
    content: '',
    dirty: false,
  });
}
