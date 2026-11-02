import { useEffect } from 'react';
import { usePreviewStore, useDiagnosticsStore } from '../stores/preview-store';
import { useChatStore } from '../stores/chat-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useComposerStore } from '../stores/composer-store';
import { findNode, foldersToRefresh, samePath, type WatchEvent } from '../features/explorer/live-tree';

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

    const unsubEdits = window.peep.onProposedEdits((edits, threadId) => {
      // Edits from another chat's run don't belong in this one (same rule as the timeline above).
      if (threadId && threadId !== useChatStore.getState().activeThreadId) return;
      const isComposer = useComposerStore.getState().isOpen;
      const workspaceStore = useWorkspaceStore.getState();

      // The agent has already written these files: open tabs show the new content as saved. A tab with the
      // user's own unsaved edits keeps them and shows the "changed on disk" notice instead.
      for (const edit of edits) {
        const existing = workspaceStore.openFiles.find((f) => samePath(f.path, edit.path));
        if (!existing) continue;
        if (existing.dirty && existing.content !== edit.proposedContent) {
          workspaceStore.setFileExternallyModified(existing.path, true);
        } else {
          workspaceStore.syncFileContent(existing.path, edit.proposedContent);
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

    // A file changed on disk (the agent, a terminal command, another editor): an open tab reloads it, or, if it
    // has unsaved edits, shows the "changed on disk" notice. The watcher's path uses "/", the tab's may use "\".
    const unsubFileChanged = window.peep.onFileChanged((path: string) => {
      const workspaceStore = useWorkspaceStore.getState();
      const existing = workspaceStore.openFiles.find((f) => samePath(f.path, path));
      if (!existing) return;
      void window.peep.readFile(existing.path).then((newContent) => {
        const current = useWorkspaceStore.getState().openFiles.find((f) => f.path === existing.path);
        if (!current || current.content === newContent) return;
        if (current.dirty) useWorkspaceStore.getState().setFileExternallyModified(current.path, true);
        else useWorkspaceStore.getState().syncFileContent(current.path, newContent);
      }).catch(() => {});
    });

    // Files added, removed or renamed in the project (by the agent, a command, or outside Atomvs): the Explorer
    // re-lists the folders that changed, if they are loaded. A folder not loaded yet lists itself when opened.
    const unsubTree = window.peep.onWorkspaceChangedBatch?.((payload: { events?: WatchEvent[] }) => {
      const events = Array.isArray(payload?.events) ? payload.events : [];
      const project = useWorkspaceStore.getState().project;
      if (!project || events.length === 0) return;
      void (async () => {
        for (const dir of foldersToRefresh(events)) {
          try {
            if (samePath(dir, project.path)) {
              useWorkspaceStore.getState().mergeRootChildren(await window.peep.listDir(project.path, 1));
              continue;
            }
            const node = findNode(useWorkspaceStore.getState().fileTree, dir);
            if (!node || node.type !== 'directory' || !node.children) continue;
            useWorkspaceStore.getState().mergeDirectoryChildren(node.path, await window.peep.listDir(node.path, 0));
          } catch {
            // The folder went away too: its parent's listing (also in this batch) removes it.
          }
        }
      })();
    }) ?? (() => {});

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
      unsubTree();
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
