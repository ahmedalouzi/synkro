import { useEffect } from 'react';
import { subscribeEditorStatus } from '../../commands/editor-registry';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { currentSelection, handleClaudeIdeRequest, rejectClosedDiffTabs } from './claude-ide';

/** Connects the editor to Claude Code: answers its tool calls and streams selection changes to it. */
export function useClaudeIdeBridge(): void {
  // Tool calls from the CLI.
  useEffect(() => window.peep.onClaudeIdeRequest((request) => {
    void handleClaudeIdeRequest(request)
      .catch((error: Error) => ({ content: [{ type: 'text' as const, text: `Error: ${error.message}` }], isError: true }))
      .then((result) => window.peep.claudeIdeRespond(request.requestId, result));
  }), []);

  // The open project is the workspace Claude sees.
  const projectPath = useWorkspaceStore((s) => s.project?.path);
  useEffect(() => {
    void window.peep.claudeIdeSetWorkspace(projectPath ? [projectPath] : []);
  }, [projectPath]);

  // Closing a diff tab rejects the change it shows.
  useEffect(() => useWorkspaceStore.subscribe((state, prev) => {
    if (state.openFiles !== prev.openFiles) rejectClosedDiffTabs(state.openFiles.map((f) => f.path));
  }), []);

  // selection_changed, debounced like VS Code's extension does.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = '';
    const unsubscribe = subscribeEditorStatus(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const selection = currentSelection();
        if (!selection) return;
        const { success: _success, ...params } = selection;
        const key = JSON.stringify(params);
        if (key === last) return;
        last = key;
        void window.peep.claudeIdeNotify('selection_changed', params);
      }, 150);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);
}
