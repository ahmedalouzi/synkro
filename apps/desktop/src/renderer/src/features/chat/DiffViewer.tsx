import { createTwoFilesPatch } from 'diff';
import type { ProposedEdit } from '@peep/shared';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { useChatStore } from '../../stores/chat-store';
import { usePreviewStore } from '../../stores/preview-store';
import './DiffViewer.css';

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function DiffViewer() {
  const edits = useChatStore((s) => s.proposedEdits);
  const setProposedEdits = useChatStore((s) => s.setProposedEdits);
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const closeFile = useWorkspaceStore((s) => s.closeFile);

  if (edits.length === 0) {
    return (
      <div className="diff-viewer__empty">
        <h3>🎉 All changes reviewed!</h3>
        <p>There are no pending edits to apply.</p>
      </div>
    );
  }

  const handleApply = (editIds: string[]) => {
    const applied = edits.filter((e) => editIds.includes(e.id));
    void window.peep.applyAgentEdits(editIds).then(async () => {
      for (const edit of applied) {
        const existing = openFiles.find((f) => f.path === edit.path);
        if (existing) {
          const content = await window.peep.readFile(edit.path);
          useWorkspaceStore.getState().syncFileContent(existing.path, content);
        }
      }
      const nextEdits = await window.peep.getPendingEdits();
      setProposedEdits(nextEdits);
      if (nextEdits.length === 0) {
        closeFile('peep://proposed-changes');
      }
      usePreviewStore.getState().bumpIframe();
    });
  };

  const handleReject = (editIds: string[]) => {
    void window.peep.rejectAgentEdits(editIds).then(async () => {
      const nextEdits = await window.peep.getPendingEdits();
      setProposedEdits(nextEdits);
      if (nextEdits.length === 0) {
        closeFile('peep://proposed-changes');
      }
    });
  };

  const handleFocusFile = (edit: ProposedEdit) => {
    openFile({
      path: edit.path,
      name: fileName(edit.path),
      content: edit.proposedContent,
      dirty: true,
    });
  };

  const handleCopyCode = (content: string) => {
    void navigator.clipboard.writeText(content).then(() => {
      alert('Proposed code copied to clipboard!');
    });
  };

  const handleDownloadCode = (path: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(path);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="diff-viewer diff-viewer--full-height">
      <div className="diff-viewer__header">
        <span>Proposed changes ({edits.length})</span>
        <div className="diff-viewer__actions">
          <button type="button" className="btn btn-ghost" onClick={() => handleReject(edits.map((e) => e.id))}>
            Reject all
          </button>
          <button type="button" className="btn btn-primary" onClick={() => handleApply(edits.map((e) => e.id))}>
            Apply all
          </button>
        </div>
      </div>

      <div className="diff-viewer__list">
        {edits.map((edit) => {
          const patch = createTwoFilesPatch(
            fileName(edit.path),
            fileName(edit.path),
            edit.originalContent,
            edit.proposedContent,
          );

          return (
            <div key={edit.id} className="diff-card">
              <div className="diff-card__header">
                <div>
                  <strong>{fileName(edit.path)}</strong>
                  {edit.description && <p className="diff-card__desc">{edit.description}</p>}
                  
                  {/* Visual Review Actions Row */}
                  <div className="diff-card__review-actions">
                    <button type="button" className="btn-action-small" onClick={() => handleFocusFile(edit)}>
                      👁 Focus File
                    </button>
                    <button type="button" className="btn-action-small" onClick={() => handleCopyCode(edit.proposedContent)}>
                      📋 Copy Code
                    </button>
                    <button type="button" className="btn-action-small" onClick={() => handleDownloadCode(edit.path, edit.proposedContent)}>
                      📥 Download
                    </button>
                  </div>
                </div>
                <div className="diff-card__actions">
                  <button type="button" className="btn btn-ghost" onClick={() => handleReject([edit.id])}>
                    Reject
                  </button>
                  <button type="button" className="btn btn-primary" onClick={() => handleApply([edit.id])}>
                    Apply
                  </button>
                </div>
              </div>
              <pre className="diff-card__patch">{patch}</pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}
