import { useEffect, useState } from 'react';
import type { AgentInfo } from '@peep/shared';
import { useExtensionsStore } from '../../stores/extensions-store';
import { openAgentTab, useAgentsStore } from './agents-store';

export function AgentIcon({ agent, className }: { agent: AgentInfo | undefined; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (agent?.iconUrl && !broken) {
    return <img className={className} src={agent.iconUrl} alt="" draggable={false} onError={() => setBroken(true)} />;
  }
  return <span className="agent-launcher__fallback">{agent?.name.charAt(0) ?? '✻'}</span>;
}

/** One button per installed agent; appears as soon as its extension is installed. */
export function AgentLaunchers() {
  const agents = useAgentsStore((s) => s.agents);
  const refresh = useAgentsStore((s) => s.refresh);
  const installed = useExtensionsStore((s) => s.installedExtensions);

  useEffect(() => {
    void refresh();
  }, [installed, refresh]);

  if (agents.length === 0) return null;
  return (
    <div className="agent-launchers">
      {agents.map((agent) => (
        <button
          key={agent.extensionId}
          type="button"
          className="agent-launcher"
          title={`Open ${agent.name}`}
          onClick={() => openAgentTab(agent)}
        >
          <AgentIcon agent={agent} />
        </button>
      ))}
    </div>
  );
}
