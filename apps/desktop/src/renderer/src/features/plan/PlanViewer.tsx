import { useChatStore } from '../../stores/chat-store';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { useDiagnosticsStore } from '../../stores/preview-store';
import './PlanViewer.css';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AgentTimelineActivity } from '@peep/shared';
import { planState, stepsDone, type PlanFile, type PlanState } from './plan-status';

const NO_ACTIVITIES: AgentTimelineActivity[] = [];

const PLAN_TEXT: Record<PlanState, string> = {
  in_progress: 'The agent is working through these tasks.',
  done: 'The agent implemented this plan.',
  waiting: 'The agent wrote this plan and is waiting for you: click Proceed, or reply in the chat.',
  unknown: 'To build or change it, ask the agent in the chat.',
};

interface PlanViewerProps {
  content: string;
  mode?: 'plan' | 'walkthrough';
}

export function PlanViewer({ content, mode = 'plan' }: PlanViewerProps) {
  const project = useWorkspaceStore((s) => s.project);
  // The agent usually builds its plan in the same turn; Proceed is only for when it stopped to ask.
  const agentBusy = useChatStore((s) => s.isStreaming);
  const lastRun = useChatStore(useShallow((s) => {
    const runId = s.currentRunId ?? s.runs[s.runs.length - 1]?.run_id;
    return runId ? s.timelineActivities.filter((a) => a.runId === runId) : NO_ACTIVITIES;
  }));
  const [plan, setPlan] = useState<PlanFile | null>(null);
  useEffect(() => {
    if (!project || mode !== 'plan') return;
    const path = `${project.path}/.peep/plan.json`.replace(/\\/g, '/');
    const load = () => void window.peep.readFile(path).then((text) => setPlan(JSON.parse(text))).catch(() => setPlan(null));
    load();
    return (window.peep as any).onPlanUpdated?.(load);
  }, [project?.path, mode, content]);
  const state = planState({ busy: agentBusy, lastRun, plan });
  const progress = stepsDone(plan);

  const handleProceed = () => {
    const chatStore = useChatStore.getState();
    // @ts-ignore
    const diagnostics = useDiagnosticsStore.getState().items;

    if (!project) return;

    const msgId = crypto.randomUUID();
    chatStore.addMessage({
      id: msgId,
      role: 'user',
      content: 'Proceed with implementation',
      createdAt: new Date().toISOString(),
    });

    chatStore.startStreaming(crypto.randomUUID());

    // @ts-ignore
    void window.peep.approvePlan(project.path);
  };

  // Simple Markdown parsing for bullet points, headers, and checkboxes
  const renderContent = () => {
    const lines = content.split('\n');
    return lines.map((line, index) => {
      const trimmed = line.trim();

      if (trimmed.startsWith('# ')) {
        return <h1 key={index} className="plan-h1">{trimmed.substring(2)}</h1>;
      }
      if (trimmed.startsWith('## ')) {
        return <h2 key={index} className="plan-h2">{trimmed.substring(3)}</h2>;
      }
      if (trimmed.startsWith('### ')) {
        return <h3 key={index} className="plan-h3">{trimmed.substring(4)}</h3>;
      }
      if (trimmed.startsWith('- [ ] ') || trimmed.startsWith('- [  ] ')) {
        const text = trimmed.replace(/- \[\s*\]\s*/, '');
        return (
          <div key={index} className="plan-checkbox-item">
            <span className="checkbox checkbox--empty">☐</span>
            <span className="checkbox-text">{text}</span>
          </div>
        );
      }
      if (trimmed.startsWith('- [/] ')) {
        const text = trimmed.replace(/- \[\/\]\s*/, '');
        return (
          <div key={index} className="plan-checkbox-item plan-checkbox-item--in-progress">
            <span className="checkbox checkbox--in-progress" style={{ color: '#60a5fa' }}>⏳</span>
            <span className="checkbox-text" style={{ color: '#93c5fd', fontWeight: '500' }}>{text}</span>
          </div>
        );
      }
      if (trimmed.startsWith('- [!] ')) {
        const text = trimmed.replace(/- \[!\]\s*/, '');
        return (
          <div key={index} className="plan-checkbox-item plan-checkbox-item--failed">
            <span className="checkbox checkbox--failed" style={{ color: '#f87171' }}>❌</span>
            <span className="checkbox-text" style={{ color: '#fca5a5', fontWeight: '500' }}>{text}</span>
          </div>
        );
      }
      if (trimmed.startsWith('- [x] ') || trimmed.startsWith('- [X] ')) {
        const text = trimmed.replace(/- \[[xX]\]\s*/, '');
        return (
          <div key={index} className="plan-checkbox-item plan-checkbox-item--checked">
            <span className="checkbox checkbox--checked">☑</span>
            <span className="checkbox-text">{text}</span>
          </div>
        );
      }
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        return (
          <div key={index} className="plan-bullet-item">
            <span className="bullet-dot">•</span>
            <span className="bullet-text">{trimmed.substring(2)}</span>
          </div>
        );
      }
      if (trimmed) {
        return <p key={index} className="plan-paragraph">{trimmed}</p>;
      }
      return <div key={index} className="plan-empty-line" />;
    });
  };

  const isWalkthrough = mode === 'walkthrough';

  return (
    <div className="plan-viewer">
      <div className="plan-viewer__header">
        <div className="plan-title-block">
          <h2>{isWalkthrough ? '📋 Walkthrough' : '📋 Implementation Plan'}</h2>
          <p>
            {isWalkthrough
              ? 'Review the completed feature checklist and manual verification steps below.'
              : PLAN_TEXT[state]}
            {!isWalkthrough && progress && state !== 'waiting' ? ` · ${progress}` : ''}
          </p>
        </div>
        {!isWalkthrough && state === 'waiting' && (
          <button type="button" className="btn-proceed" onClick={handleProceed} disabled={!project}>
            Proceed with Implementation ➔
          </button>
        )}
        {!isWalkthrough && (state === 'in_progress' || state === 'done') && (
          <span className={`plan-status plan-status--${state}`} data-testid="plan-status">
            {state === 'in_progress' ? 'In progress' : 'Done'}
          </span>
        )}
      </div>
      <div className="plan-viewer__body">
        {content ? renderContent() : (
          <div className="plan-viewer__empty">
            <h3>{isWalkthrough ? 'No walkthrough found' : 'No implementation plan found'}</h3>
            <p>
              {isWalkthrough
                ? 'Wait for the agent to complete implementation to generate a walkthrough.'
                : 'Write an implementation plan or ask the agent to create one.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
