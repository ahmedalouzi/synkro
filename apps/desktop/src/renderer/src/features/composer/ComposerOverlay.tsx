import { useState, useEffect, useRef } from 'react';
import { createTwoFilesPatch } from 'diff';
import { useComposerStore } from '../../stores/composer-store';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { usePreviewStore } from '../../stores/preview-store';
import { useChatStore } from '../../stores/chat-store';
import { getLocale } from '../../i18n';
import './ComposerOverlay.css';

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function ComposerOverlay() {
  const {
    isOpen,
    prompt,
    stagedFiles,
    isStreaming,
    streamStatus,
    proposedEdits,
    setOpen,
    setPrompt,
    stageFile,
    unstageFile,
    setStreaming,
    setStreamStatus,
    setProposedEdits,
    reset,
  } = useComposerStore();

  const { project, openFiles, openFile, activeSelection } = useWorkspaceStore();
  const [showAddMenu, setShowAddMenu] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus input area when overlay opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Click outside to close the stage menu
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowAddMenu(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  if (!isOpen) return null;

  const handleStageSelect = (filePath: string) => {
    stageFile(filePath);
    setShowAddMenu(false);
  };

  const handleSubmit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || isStreaming) return;

    setStreaming(true);
    setStreamStatus('Initializing Composer...');

    // Find the currently open file if any
    const activeFile = openFiles.find(f => stagedFiles.includes(f.path)) ?? openFiles[0] ?? null;

    try {
      void window.peep.sendAgentMessage({
        threadId: useChatStore.getState().activeThreadId ?? undefined,
        message: trimmed + `\n\nPlease apply changes to: ${stagedFiles.join(', ')}`,
        history: [],
        projectPath: project?.path,
        openFilePath: activeFile?.path,
        openFileContent: activeFile?.content,
        selectedCode: activeSelection ?? undefined,
        diagnostics: [],
        locale: getLocale(),
      });
    } catch (err) {
      setStreamStatus(`Error: ${err}`);
      setStreaming(false);
    }
  };

  const handleApply = (editIds: string[]) => {
    const applied = proposedEdits.filter((e) => editIds.includes(e.id));
    void window.peep.applyAgentEdits(editIds).then(async () => {
      for (const edit of applied) {
        const existing = openFiles.find((f) => f.path === edit.path);
        if (existing) {
          const content = await window.peep.readFile(edit.path);
          openFile({ ...existing, content, dirty: false });
        }
      }
      const nextEdits = proposedEdits.filter((e) => !editIds.includes(e.id));
      setProposedEdits(nextEdits);
      usePreviewStore.getState().bumpIframe();
      if (nextEdits.length === 0) {
        reset();
        setOpen(false);
      }
    });
  };

  const handleReject = (editIds: string[]) => {
    const rejected = proposedEdits.filter((e) => editIds.includes(e.id));
    void window.peep.rejectAgentEdits(editIds).then(async () => {
      for (const edit of rejected) {
        const existing = openFiles.find((f) => f.path === edit.path);
        if (existing) {
          const content = await window.peep.readFile(edit.path);
          openFile({ ...existing, content, dirty: false });
        }
      }
      const nextEdits = proposedEdits.filter((e) => !editIds.includes(e.id));
      setProposedEdits(nextEdits);
      if (nextEdits.length === 0) {
        reset();
        setOpen(false);
      }
    });
  };

  return (
    <div className="composer-mask">
      <div className="composer-container">
        
        {/* Header */}
        <div className="composer-header">
          <div className="composer-title-wrap">
            <span className="composer-icon">🎹</span>
            <h3 className="composer-title">Composer</h3>
          </div>
          <button type="button" className="composer-close-btn" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>

        {/* Staging Bar */}
        <div className="composer-staging-bar">
          <div className="composer-staged-chips">
            {stagedFiles.map((file) => (
              <span key={file} className="composer-chip">
                📄 {fileName(file)}
                <button type="button" className="composer-chip-remove" onClick={() => unstageFile(file)}>
                  ✕
                </button>
              </span>
            ))}
            {stagedFiles.length === 0 && (
              <span className="composer-empty-chips">No files staged. Add files to restrict context.</span>
            )}
          </div>
          
          <div className="composer-add-stage-wrap" ref={dropdownRef}>
            <button
              type="button"
              className="composer-add-chip-btn"
              onClick={() => setShowAddMenu(!showAddMenu)}
            >
              ➕ Add File
            </button>
            {showAddMenu && (
              <div className="composer-add-dropdown">
                {openFiles
                  .filter((f) => !stagedFiles.includes(f.path))
                  .map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      className="composer-dropdown-option"
                      onClick={() => handleStageSelect(file.path)}
                    >
                      📄 {file.name}
                    </button>
                  ))}
                {openFiles.filter((f) => !stagedFiles.includes(f.path)).length === 0 && (
                  <div className="composer-dropdown-empty">No additional open files.</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Input */}
        <div className="composer-input-area">
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            placeholder="Type instructions to modify staged files..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={isStreaming}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <div className="composer-input-footer">
            <span className="composer-status">
              {isStreaming && <span className="composer-spinner">◌</span>}
              {streamStatus || 'Idle'}
            </span>
            <button
              type="button"
              className="composer-submit-btn"
              onClick={handleSubmit}
              disabled={!prompt.trim() || isStreaming}
            >
              Submit
            </button>
          </div>
        </div>

        {/* Proposed Changes list */}
        {proposedEdits.length > 0 && (
          <div className="composer-diff-list">
            <div className="composer-diff-header">
              <span>Proposed Changes ({proposedEdits.length})</span>
              <div className="composer-diff-global-actions">
                <button
                  type="button"
                  className="composer-btn-secondary"
                  onClick={() => handleReject(proposedEdits.map((e) => e.id))}
                >
                  Reject All
                </button>
                <button
                  type="button"
                  className="composer-btn-primary"
                  onClick={() => handleApply(proposedEdits.map((e) => e.id))}
                >
                  Accept All
                </button>
              </div>
            </div>

            <div className="composer-diff-scroll">
              {proposedEdits.map((edit) => {
                const patch = createTwoFilesPatch(
                  fileName(edit.path),
                  fileName(edit.path),
                  edit.originalContent,
                  edit.proposedContent
                );

                return (
                  <div key={edit.id} className="composer-diff-card">
                    <div className="composer-diff-card-header">
                      <div>
                        <strong className="composer-diff-card-filename">{fileName(edit.path)}</strong>
                        {edit.description && <p className="composer-diff-card-desc">{edit.description}</p>}
                      </div>
                      <div className="composer-diff-card-actions">
                        <button
                          type="button"
                          className="composer-btn-small-secondary"
                          onClick={() => handleReject([edit.id])}
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          className="composer-btn-small-primary"
                          onClick={() => handleApply([edit.id])}
                        >
                          Accept
                        </button>
                      </div>
                    </div>
                    <pre className="composer-diff-card-patch">{patch}</pre>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
