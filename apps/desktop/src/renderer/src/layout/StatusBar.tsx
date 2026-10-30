import { useEffect, useState, useSyncExternalStore } from 'react';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useWorkspace } from '../hooks/useWorkspace';
import { useDiagnosticsStore } from '../stores/preview-store';
import { getEditorStatus, subscribeEditorStatus, toggleEndOfLine } from '../commands/editor-registry';
import { runCommand } from '../commands/commands';
import { isAICompletionsEnabled, subscribeAICompletions, toggleAICompletions } from '../features/editor/inline-completions';

const LANGUAGE_NAMES: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', json: 'JSON', html: 'HTML', css: 'CSS',
  scss: 'SCSS', less: 'Less', markdown: 'Markdown', yaml: 'YAML', xml: 'XML', dart: 'Dart',
  python: 'Python', java: 'Java', kotlin: 'Kotlin', swift: 'Swift', go: 'Go', rust: 'Rust',
  csharp: 'C#', cpp: 'C++', c: 'C', php: 'PHP', ruby: 'Ruby', shell: 'Shell Script',
  powershell: 'PowerShell', bat: 'Batch', sql: 'SQL', dockerfile: 'Dockerfile', graphql: 'GraphQL',
  dotenv: 'Environment Variables', plaintext: 'Plain Text', ini: 'TOML',
};

/** Current git branch, refreshed when the repository changes (VS Code's SCM status item). */
function useGitBranch(projectPath: string | undefined): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!projectPath) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      window.peep.getGitStatus(projectPath)
        .then((status) => { if (!cancelled) setBranch(status.isRepo ? status.branch : null); })
        .catch(() => { if (!cancelled) setBranch(null); });
    };
    refresh();
    const unsubscribe = window.peep.onGitChanged(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectPath]);
  return branch;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

export function StatusBar() {
  const { project } = useWorkspace();
  const diagnostics = useDiagnosticsStore((s) => s.items);
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length;
  const editor = useSyncExternalStore(subscribeEditorStatus, getEditorStatus);
  const branch = useGitBranch(project?.path);
  const online = useOnline();
  const aiCompletions = useSyncExternalStore(subscribeAICompletions, isAICompletionsEnabled);

  const handleToggleBottomPanel = () => {
    // On the start page there is no workspace panel; its own panel has a Problems tab.
    if (!project) return void window.dispatchEvent(new CustomEvent('peep:home-terminal', { detail: 'problems' }));
    useWorkspaceStore.getState().setBottomPanelTab('problems');
    if (!useWorkspaceStore.getState().bottomPanelOpen) useWorkspaceStore.getState().toggleBottomPanel();
  };

  const handleSourceControl = () => {
    const store = useWorkspaceStore.getState();
    // Without a folder, the start page side bar offers Open Folder / Clone Repository (like VS Code's SCM view).
    if (!project) return void (store.homeSidebarOpen || store.toggleHomeSidebar());
    store.setSidebarView('git');
  };

  return (
    <div className="statusbar">
      <div className="status-item highlight" style={{ cursor: 'pointer' }} title={branch ? `Branch: ${branch}` : 'Source Control'} onClick={handleSourceControl}>
        <svg style={{width:'12px',height:'12px',stroke:'currentColor',fill:'none',strokeWidth:'2',marginRight:'4px'}} viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="8" r="3"/><path d="M6 9v6M18 11c0 4-6 3-12 4"/></svg>
        {branch ?? 'Git'}
      </div>
      <div className="status-item" style={{ cursor: 'pointer' }} title="Errors" onClick={handleToggleBottomPanel}>
        <svg style={{width:'12px',height:'12px',stroke:'currentColor',fill:'none',strokeWidth:'2',marginRight:'4px', color: errorCount > 0 ? 'var(--red)' : 'inherit'}} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>
        <span style={{ color: errorCount > 0 ? 'var(--red)' : 'inherit' }}>{errorCount}</span>
      </div>
      <div className="status-item" style={{ cursor: 'pointer' }} title="Warnings" onClick={handleToggleBottomPanel}>
        <svg style={{width:'12px',height:'12px',stroke:'currentColor',fill:'none',strokeWidth:'2',marginRight:'4px', color: warningCount > 0 ? 'var(--yellow)' : 'inherit'}} viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span style={{ color: warningCount > 0 ? 'var(--yellow)' : 'inherit' }}>{warningCount}</span>
      </div>
      <span className="status-sep">|</span>
      <div className="status-item">{project ? `Atomvs Ready - ${project.name}` : 'Atomvs Ready'}</div>

      <div className="status-right">
        {editor && (
          <>
            <div className="status-item" style={{ cursor: 'pointer' }} title="Go to Line/Column" onClick={() => runCommand('editor.action.gotoLine')}>
              Ln {editor.line}, Col {editor.column}
              {editor.cursors > 1
                ? ` (${editor.cursors} selections)`
                : editor.selected > 0 ? ` (${editor.selected} selected)` : ''}
            </div>
            <div className="status-item" title="Indentation">
              {editor.insertSpaces ? 'Spaces' : 'Tab Size'}: {editor.tabSize}
            </div>
            <div className="status-item" title="Encoding">UTF-8</div>
            <div className="status-item" style={{ cursor: 'pointer' }} title="Select End of Line Sequence (click to switch)" onClick={toggleEndOfLine}>
              {editor.eol}
            </div>
            <div className="status-item" title="Language Mode">
              {LANGUAGE_NAMES[editor.language] ?? editor.language}
            </div>
          </>
        )}
        <div
          className="status-item"
          style={{ cursor: 'pointer', color: aiCompletions ? 'var(--accent)' : 'var(--text-muted)' }}
          title={aiCompletions ? 'AI Tab autocomplete is on (click to turn off)' : 'AI Tab autocomplete is off (click to turn on)'}
          onClick={toggleAICompletions}
        >
          {aiCompletions ? '✦ Tab' : '✦ Tab (off)'}
        </div>
        <div className="status-item" title={online ? 'Connected to the internet' : 'No internet connection'}>
          <div className={`status-indicator ${online ? 'si-green' : ''}`} style={online ? undefined : { background: 'var(--red)' }}></div>
          {online ? 'Online' : 'Offline'}
        </div>
      </div>
    </div>
  );
}
