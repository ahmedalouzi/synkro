import { useRef, useState } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { languageForPath } from '../editor/MonacoEditor';
import { useClaudeDiffStore } from './claude-diff-store';
import { acceptClaudeDiff, rejectClaudeDiff } from './claude-ide';
import './ClaudeDiffView.css';

/** Shows a change Claude Code proposed; the right side stays editable before accepting. */
export function ClaudeDiffView({ requestId }: { requestId: string }) {
  const diff = useClaudeDiffStore((s) => s.diffs[requestId]);
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!diff) {
    return <div className="claude-diff__empty">This change was already accepted or rejected.</div>;
  }

  const onMount: DiffOnMount = (ed) => {
    editorRef.current = ed;
  };

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await acceptClaudeDiff(requestId, editorRef.current?.getModifiedEditor().getValue() ?? diff.newContents);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="claude-diff">
      <div className="claude-diff__bar">
        <span className="claude-diff__mark">✻</span>
        <span className="claude-diff__title">
          Claude Code wants to edit <b>{diff.filePath.split(/[\\/]/).pop()}</b>
        </span>
        <span className="claude-diff__path">{diff.filePath}</span>
        {error && <span className="claude-diff__error">{error}</span>}
        <span className="claude-diff__actions">
          <button type="button" className="claude-diff__btn" disabled={busy} onClick={() => rejectClaudeDiff(requestId)}>
            Reject
          </button>
          <button type="button" className="claude-diff__btn claude-diff__btn--primary" disabled={busy} onClick={() => void accept()}>
            Accept
          </button>
        </span>
      </div>
      <div className="claude-diff__editor">
        <DiffEditor
          original={diff.oldContents}
          modified={diff.newContents}
          language={languageForPath(diff.filePath)}
          theme="peep-theme"
          onMount={onMount}
          options={{
            renderSideBySide: true,
            readOnly: false,
            originalEditable: false,
            automaticLayout: true,
            minimap: { enabled: false },
            fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
            fontSize: 13,
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    </div>
  );
}
