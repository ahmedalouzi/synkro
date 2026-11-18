import { useEffect, useRef } from 'react';
import { useChatStore } from '../stores/chat-store';

const ICONS: Record<string, string> = {
  understanding: '🧠',
  reading: '📖',
  exploring: '🔍',
  searching: '🔎',
  editing: '✏️',
  running: '▶️',
  validating: '🧪',
  error: '❌',
  completed: '✅',
};

export function AgentTimeline() {
  const activities = useChatStore((s) => s.timelineActivities);
  const runs = useChatStore((s) => s.runs);
  const selectedRunId = useChatStore((s) => s.selectedRunId);
  const selectRun = useChatStore((s) => s.selectRun);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const endRef = useRef<HTMLDivElement>(null);

  const displayedActivities = activities.filter(a => a.runId === selectedRunId);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [displayedActivities]);

  if (activities.length === 0 && (!runs || runs.length === 0)) return null;

  return (
    <div className="agent-timeline" style={{
      margin: '12px 16px',
      padding: '12px',
      background: 'var(--bg-secondary)',
      borderRadius: '8px',
      border: '1px solid var(--border)',
      fontFamily: 'var(--font-system)'
    }}>
      {runs && runs.length > 0 && (
        <div className="agent-timeline-runs" style={{
          display: 'flex',
          gap: '8px',
          overflowX: 'auto',
          marginBottom: '16px',
          paddingBottom: '8px',
          borderBottom: '1px solid var(--border)'
        }}>
          {runs.map(run => {
            const isActive = run.run_id === selectedRunId;
            let statusIcon = '◌';
            if (run.status === 'completed') statusIcon = '✅';
            if (run.status === 'error' || run.status === 'failed') statusIcon = '❌';
            if (run.status === 'cancelled') statusIcon = '⚠️';
            
            const date = new Date(run.started_at);
            const dateStr = `${date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
            
            return (
              <div 
                key={run.run_id}
                className={`run-item ${isActive ? 'active' : ''}`}
                onClick={() => {
                  if (!isStreaming) selectRun(run.run_id);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px 10px',
                  borderRadius: '12px',
                  fontSize: '11px',
                  background: isActive ? 'var(--bg-active, rgba(255,255,255,0.1))' : 'transparent',
                  border: `1px solid ${isActive ? 'var(--text-secondary)' : 'transparent'}`,
                  cursor: isStreaming ? 'not-allowed' : 'pointer',
                  opacity: isStreaming && !isActive ? 0.5 : 1,
                  whiteSpace: 'nowrap'
                }}
              >
                <span>{dateStr}</span>
                <span style={{ fontSize: '12px' }}>{statusIcon}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="agent-timeline-header" style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '12px',
        fontSize: '12px',
        color: 'var(--text-secondary)',
        fontWeight: 'bold',
        textTransform: 'uppercase',
        letterSpacing: '0.05em'
      }}>
        <span className="agent-timeline-title">Agent Execution Timeline</span>
        {isStreaming && <span className="agent-timeline-spinner spinner">◌</span>}
      </div>
      <div className="agent-timeline-list" style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        maxHeight: '300px',
        overflowY: 'auto'
      }}>
        {displayedActivities.map((act) => {
          const icon = ICONS[act.type] || '⚙️';
          const isError = act.status === 'failed' || act.status === 'blocked' || act.type === 'error';
          const isDone = act.status === 'completed' || act.type === 'completed';
          const isInProgress = act.status === 'in_progress';
          
          return (
            <div key={act.id} className={`agent-timeline-item ${act.status}`} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              fontSize: '13px',
              color: isError ? '#f85149' : (isDone ? '#8b949e' : '#c9d1d9'),
              opacity: isDone ? 0.8 : 1,
            }}>
              <div className="agent-timeline-icon" style={{ 
                width: '16px', 
                textAlign: 'center',
                filter: isDone && act.type !== 'completed' ? 'grayscale(100%) opacity(0.7)' : 'none'
              }}>
                {isError ? '❌' : (isDone && act.type !== 'completed' ? '✓' : icon)}
              </div>
              <div className="agent-timeline-content" style={{
                display: 'flex',
                flexDirection: 'column',
                flex: 1
              }}>
                <span className="agent-timeline-message" style={{
                  textDecoration: isDone && act.type !== 'completed' ? 'line-through' : 'none',
                  textDecorationColor: 'rgba(255,255,255,0.2)'
                }}>
                  {act.message}
                </span>
                {(act.file || act.command) && (
                  <span className="agent-timeline-detail" style={{
                    fontSize: '11px',
                    color: '#8b949e',
                    fontFamily: 'var(--font-code)',
                    marginTop: '2px',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: '300px'
                  }}>
                    {act.file ? `📄 ${act.file.split(/[\\/]/).pop()}` : ''}
                    {act.command ? `> ${act.command}` : ''}
                  </span>
                )}
              </div>
              {isInProgress && (
                <div className="agent-timeline-pulse spinner" style={{ color: 'var(--gold)' }}>◌</div>
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}
