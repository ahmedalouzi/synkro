import { useEffect } from 'react';
import { usePreviewStore, useDiagnosticsStore } from '../stores/preview-store';
import { useChatStore } from '../stores/chat-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useComposerStore } from '../stores/composer-store';

export function usePeepEvents(): void {
  const setSession = usePreviewStore((s) => s.setSession);
  const addLog = usePreviewStore((s) => s.addLog);
  const bumpIframe = usePreviewStore((s) => s.bumpIframe);
  const setDiagnostics = useDiagnosticsStore((s) => s.setItems);

  const appendDelta = useChatStore((s) => s.appendToStreamingMessage);
  const setStreamStatus = useChatStore((s) => s.setStreamStatus);
  const finishStreaming = useChatStore((s) => s.finishStreaming);
  const setProposedEdits = useChatStore((s) => s.setProposedEdits);
  const setAgentPhase = useChatStore((s) => s.setAgentPhase);

  useEffect(() => {
    void window.peep.getPendingEdits().then(setProposedEdits);

    const unsubPreview = window.peep.onPreviewStatus((session) => {
      setSession(session);
      if (session.status === 'running') bumpIframe();
    });

    const unsubDiagnostics = window.peep.onDiagnostics(setDiagnostics);
    const unsubLog = window.peep.onPreviewLog(addLog);

    const unsubAgent = window.peep.onAgentStream((event) => {
      const activeThreadId = useChatStore.getState().activeThreadId;
      if (event.threadId && event.threadId !== activeThreadId) {
        return; // Ignore events from other threads
      }

      const isComposer = useComposerStore.getState().isOpen;
      if (isComposer) {
        const composerStore = useComposerStore.getState();
        if (event.type === 'status') {
          composerStore.setStreamStatus(event.content);
        } else if (event.type === 'done') {
          composerStore.setStreaming(false);
          composerStore.setStreamStatus('Done!');
        } else if (event.type === 'error') {
          composerStore.setStreamStatus(`Error: ${event.content}`);
          composerStore.setStreaming(false);
        }
      } else {
        if (event.type === 'status') {
          setStreamStatus(event.content);
        } else if (event.type === 'delta') {
          appendDelta(event.content);
        } else if (event.type === 'done') {
          finishStreaming();
        } else if (event.type === 'error') {
          appendDelta(`\n\n⚠️ ${event.content}`);
          finishStreaming();
        }
      }
    });

    // Agent steps (read / edit / run …) shown inline in the reply that produced them.
    const unsubTimeline = window.peep.onAgentTimeline((activity: import('@peep/shared').AgentTimelineActivity) => {
      if (activity.threadId && activity.threadId !== useChatStore.getState().activeThreadId) return;
      if (useComposerStore.getState().isOpen) return;
      useChatStore.getState().upsertTimelineActivity(activity);
    });

    const unsubEdits = window.peep.onProposedEdits((edits) => {
      const isComposer = useComposerStore.getState().isOpen;
      const workspaceStore = useWorkspaceStore.getState();

      // Sync active editor tabs immediately so changes reflect on screen
      for (const edit of edits) {
        const existing = workspaceStore.openFiles.find((f) => f.path === edit.path);
        if (existing) {
          workspaceStore.openFile({ ...existing, content: edit.proposedContent, dirty: true });
        }
      }

      if (isComposer) {
        useComposerStore.getState().setProposedEdits(edits);
      } else {
        setProposedEdits(edits);
        
        if (edits.length > 0) {
          const workspaceStore = useWorkspaceStore.getState();
          const planFile = workspaceStore.openFiles.find(
            (f) => f.path.endsWith('.peep/plan.md') || f.path.endsWith('.peep\\plan.md')
          );
          if (planFile) {
            workspaceStore.setActiveFile(planFile.path);
          } else if (workspaceStore.project) {
            const planPath = `${workspaceStore.project.path}/.peep/plan.md`.replace(/\\/g, '/');
            void window.peep.readFile(planPath).then((content) => {
              workspaceStore.openFile({
                path: planPath,
                name: '📋 Implementation Plan',
                content,
                dirty: false,
              });
            }).catch(() => {});
          }
        }
      }
    });

    const unsubOpenFile = window.peep.onOpenFile((file) => {
      const workspaceStore = useWorkspaceStore.getState();
      workspaceStore.openFile({
        path: file.path,
        name: file.name,
        content: file.content,
        dirty: file.dirty
      });
    });

    const unsubFileChanged = window.peep.onFileChanged((path: string) => {
      const workspaceStore = useWorkspaceStore.getState();
      const existing = workspaceStore.openFiles.find((f) => f.path === path);
      if (existing) {
        if (existing.dirty) {
          workspaceStore.setFileExternallyModified(path, true);
        } else {
          void window.peep.readFile(path).then((newContent) => {
            workspaceStore.syncFileContent(path, newContent);
          }).catch(() => {});
        }
      }
    });

    const unsubPlan = (window.peep as any).onPlanUpdated?.(() => {
      const workspaceStore = useWorkspaceStore.getState();
      if (!workspaceStore.project) return;
      const planPath = `${workspaceStore.project.path}/.peep/plan.md`.replace(/\\/g, '/');
      void window.peep.readFile(planPath).then((content) => {
        const existing = workspaceStore.openFiles.find((f) => f.path === planPath);
        if (existing) {
          workspaceStore.openFile({ ...existing, content, dirty: false });
        }
      }).catch(() => {});
    });

    const unsubPhase = window.peep.onAgentPhase((phase: import('@peep/shared').AgentPhase, threadId?: string) => {
      const activeThreadId = useChatStore.getState().activeThreadId;
      // Phase event from IPC might have { phase, threadId } if updated in shared, wait it's just passing event
      const ev = (typeof phase === 'object' && phase !== null) ? (phase as any) : { phase, threadId };
      if (ev.threadId && ev.threadId !== activeThreadId) return;
      setAgentPhase(ev.phase);
    });

    return () => {
      unsubPreview();
      unsubDiagnostics();
      unsubLog();
      unsubAgent();
      unsubEdits();
      unsubTimeline();
      unsubOpenFile();
      unsubFileChanged();
      unsubPlan?.();
      unsubPhase();
    };
  }, [
    setSession,
    addLog,
    bumpIframe,
    setDiagnostics,
    appendDelta,
    setStreamStatus,
    finishStreaming,
    setProposedEdits,
    setAgentPhase,
  ]);
}
