import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createTwoFilesPatch } from 'diff';
import type { AgentMessage, AgentTimelineActivity, ProposedEdit } from '@peep/shared';
import { useChatStore } from '../stores/chat-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useDiagnosticsStore, usePreviewStore } from '../stores/preview-store';
import { Virtuoso } from 'react-virtuoso';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MentionIcon, MentionPicker, type MentionItem, type MentionPickerHandle } from '../features/chat/MentionPicker';
import { SlashCommandPicker, type SlashCommandResult } from '../features/chat/SlashCommandPicker';
import { imageFilesFrom, MAX_IMAGES, readChatImage, type PendingImage } from '../features/chat/chat-images';
import { MODELS, useCanPickModel } from '../features/chat/models';
import { openWebPage } from '../config/web';
import './ChatPane.css';

interface ChatPaneProps {
  onOpenSettings: () => void;
}

const REVIEW_TAB_PATH = 'peep://proposed-changes';
const WELCOME_ID = 'welcome';


const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Line counts and the first few changed lines, for edit cards. */
function diffSummary(original: string, proposed: string) {
  let added = 0;
  let removed = 0;
  const preview: { kind: '+' | '-'; text: string }[] = [];
  try {
    const lines = createTwoFilesPatch('a', 'b', original, proposed).split('\n').slice(4);
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added++;
        if (preview.length < 4) preview.push({ kind: '+', text: line.slice(1) });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removed++;
        if (preview.length < 4) preview.push({ kind: '-', text: line.slice(1) });
      }
    }
  } catch (e) {
    console.error(e);
  }
  return { added, removed, preview };
}

/** One line per agent step; the resolved event replaces its in-progress twin. */
function stepsForRun(activities: AgentTimelineActivity[], runId: string | undefined) {
  if (!runId) return [];
  const byKey = new Map<string, AgentTimelineActivity>();
  for (const a of activities) {
    if (a.runId !== runId || a.type === 'understanding' || a.type === 'completed') continue;
    byKey.set(a.id.replace(/:(in_progress|resolved)$/, ''), a);
  }
  return [...byKey.values()];
}

function stepLabel(a: AgentTimelineActivity): { verb: string; target: string } {
  const done = a.status !== 'in_progress';
  const target = a.file ? fileName(a.file) : a.command ?? '';
  switch (a.type) {
    case 'reading': return { verb: done ? 'Read' : 'Reading', target };
    case 'editing': return { verb: done ? 'Edited' : 'Editing', target };
    case 'creating': return { verb: done ? 'Created' : 'Creating', target };
    case 'deleting': return { verb: done ? 'Deleted' : 'Deleting', target };
    case 'running': return { verb: done ? 'Ran' : 'Running', target };
    case 'exploring': return { verb: done ? 'Explored' : 'Exploring', target: target || '.' };
    case 'searching': return { verb: done ? 'Searched' : 'Searching', target: a.message.replace(/^Searching (files|codebase): /, '') };
    default: return { verb: a.message, target: '' };
  }
}

function Icon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const ICON = {
  plus: 'M12 5v14M5 12h14',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  close: 'M18 6 6 18M6 6l12 12',
  panel: 'M3 4h18v16H3zM15 4v16',
  image: 'M21 15l-5-5L5 21M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3',
  send: 'M12 19V5M5 12l7-7 7 7',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
};

export function ChatPane({ onOpenSettings: _onOpenSettings }: ChatPaneProps) {
  const {
    messages,
    input,
    isStreaming,
    streamStatus,
    streamingMessageId,
    proposedEdits,
    timelineActivities,
    ipcError,
    threads,
    activeThreadId,
    setInput,
    addMessage,
    startStreaming,
    setProposedEdits,
    switchThread,
    newThread,
    deleteThread,
  } = useChatStore();

  const project = useWorkspaceStore((s) => s.project);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const activeFile = openFiles.find((f) => f.path === activeFilePath) ?? null;
  const activeSelection = useWorkspaceStore((s) => s.activeSelection);
  const diagnostics = useDiagnosticsStore((s) => s.items);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  /* ── Chat tabs (like Cursor's open agents) + history ── */
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeThreadId && !openTabIds.includes(activeThreadId)) setOpenTabIds((prev) => [...prev, activeThreadId]);
  }, [activeThreadId, openTabIds]);

  // Drop tabs whose thread was deleted.
  useEffect(() => {
    setOpenTabIds((prev) => prev.filter((id) => id === activeThreadId || threads.some((t) => t.id === id)));
  }, [threads, activeThreadId]);

  const firstUserText = messages.find((m) => m.role === 'user')?.content;
  const threadTitle = (id: string) => {
    const t = threads.find((x) => x.id === id);
    if (t?.title && t.title !== 'New Chat') return t.title;
    if (id === activeThreadId && firstUserText) return firstUserText.split('\n')[0].slice(0, 40);
    return 'New Chat';
  };

  const closeTab = (id: string) => {
    if (isStreaming && id === activeThreadId) return;
    const remaining = openTabIds.filter((t) => t !== id);
    setOpenTabIds(remaining);
    if (id !== activeThreadId) return;
    if (remaining.length > 0) void switchThread(remaining[remaining.length - 1]);
    else void newThread();
  };

  useEffect(() => {
    if (!historyOpen) return;
    const onDown = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [historyOpen]);

  /* ── Model ── */
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelRef = useRef<HTMLDivElement>(null);
  const canPickModel = useCanPickModel();
  // Free plans always run on Auto (the server ignores a picked model), so show that.
  const effectiveModel = canPickModel ? selectedModel : undefined;
  const modelLabel = MODELS.find((m) => m.id === effectiveModel)?.label ?? effectiveModel ?? 'Auto';
  const [upsellOpen, setUpsellOpen] = useState(false);

  useEffect(() => {
    const fetchSettings = () => void window.peep.getSettings().then((s) => setSelectedModel(s.apiModel || undefined));
    fetchSettings();
    window.addEventListener('peep:settings-closed', fetchSettings);
    return () => window.removeEventListener('peep:settings-closed', fetchSettings);
  }, []);

  useEffect(() => {
    if (!modelMenuOpen) {
      setUpsellOpen(false);
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [modelMenuOpen]);

  const chooseModel = async (id: string | undefined) => {
    setSelectedModel(id);
    setModelMenuOpen(false);
    await window.peep.setSettings({ apiModel: id });
  };

  /* ── Checkpoints: restore files to before an agent message ── */
  const [checkpointFiles, setCheckpointFiles] = useState<Record<string, number>>({});
  useEffect(() => window.peep.onAgentCheckpoint(({ id, fileCount }) => {
    setCheckpointFiles((prev) => ({ ...prev, [id]: fileCount }));
  }), []);

  const restoreCheckpoint = async (id: string) => {
    const count = checkpointFiles[id] ?? 0;
    if (!window.confirm(`Restore ${count} file(s) to how they were before this message?\n\nThis also undoes the agent's changes from every later message.`)) return;
    try {
      const restored = await window.peep.restoreCheckpoint(id);
      await syncEditorsFromDisk(restored);
      addMessage({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `↺ Restored ${restored.length} file(s) to the checkpoint before this message.`,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      window.alert(`Could not restore checkpoint: ${(err as Error).message}`);
    }
  };

  /** Reloads open editors from disk; closes ones whose file no longer exists. */
  const syncEditorsFromDisk = async (paths: string[]) => {
    const ws = useWorkspaceStore.getState();
    for (const path of paths) {
      if (!ws.openFiles.some((f) => f.path === path)) continue;
      try {
        ws.syncFileContent(path, await window.peep.readFile(path));
      } catch {
        ws.closeFile(path);
      }
    }
  };

  /* ── Images: paste, drop or pick screenshots ── */
  const [images, setImages] = useState<PendingImage[]>([]);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const addImages = async (files: File[]) => {
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      window.alert(`You can attach up to ${MAX_IMAGES} images per message.`);
      return;
    }
    for (const file of files.slice(0, room)) {
      try {
        const image = await readChatImage(file);
        setImages((prev) => (prev.length < MAX_IMAGES ? [...prev, image] : prev));
      } catch (err) {
        window.alert((err as Error).message);
      }
    }
  };

  /* ── @ mentions (attached context) and / commands ── */
  const [attachments, setAttachments] = useState<MentionItem[]>([]);
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null);
  const pickerRef = useRef<MentionPickerHandle>(null);
  const slashRef = useRef<MentionPickerHandle>(null);
  /** `/command` typed as the whole input so far. */
  const slashQuery = /^\/(\w*)$/.exec(input)?.[1] ?? null;
  const [slashDismissed, setSlashDismissed] = useState(false);

  const resizeTextarea = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 250)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 250 ? 'auto' : 'hidden';
  };

  const runSlashCommand = (result: SlashCommandResult | null) => {
    if (!result) {
      setInput('');
      return;
    }
    setInput(result.prompt);
    setAttachments((prev) => [...prev, ...result.attachments.filter((a) => !prev.some((p) => p.id === a.id))]);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(result.prompt.length, result.prompt.length);
      resizeTextarea();
    });
  };

  /** Finds an `@query` token ending at the caret (the `@` must start a word). */
  const updateMentionQuery = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const match = /(^|\s)@([^\s@]*)$/.exec(before);
    setMentionQuery(match ? { start: caret - match[2].length - 1, query: match[2] } : null);
  };

  const selectMention = (item: MentionItem) => {
    const textarea = textareaRef.current;
    if (!mentionQuery || !textarea) return;
    const caret = textarea.selectionStart;
    const token = `@${item.label} `;
    const next = input.slice(0, mentionQuery.start) + token + input.slice(caret);
    setInput(next);
    setAttachments((prev) => (prev.some((a) => a.id === item.id) ? prev : [...prev, item]));
    setMentionQuery(null);
    const nextCaret = mentionQuery.start + token.length;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  /** The "@" button: starts a mention at the caret, like typing `@`. */
  const startMention = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const caret = textarea.selectionStart ?? input.length;
    const needsSpace = caret > 0 && !/\s/.test(input[caret - 1]);
    const insert = needsSpace ? ' @' : '@';
    setInput(input.slice(0, caret) + insert + input.slice(caret));
    const nextCaret = caret + insert.length;
    setMentionQuery({ start: nextCaret - 1, query: '' });
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  /* ── Sending ── */
  useEffect(() => {
    const handleTriggerAgent = (e: Event) => {
      const customEvent = e as CustomEvent<{ message: string; previewError?: string }>;
      const { message, previewError } = customEvent.detail;

      const userMessageId = crypto.randomUUID();
      addMessage({
        id: userMessageId,
        role: 'user',
        content: message,
        createdAt: new Date().toISOString(),
      });
      setInput('');

      const assistantId = crypto.randomUUID();
      startStreaming(assistantId);

      void window.peep.sendAgentMessage({
        threadId: useChatStore.getState().activeThreadId ?? undefined,
        message,
        history: messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        projectPath: project?.path,
        openFilePath: activeFile?.path,
        openFileContent: activeFile?.content,
        selectedCode: activeSelection ?? undefined,
        diagnostics,
        previewError,
        checkpointId: userMessageId,
      });
    };

    window.addEventListener('peep:trigger-agent', handleTriggerAgent as EventListener);
    return () => window.removeEventListener('peep:trigger-agent', handleTriggerAgent as EventListener);
  }, [messages, project, activeFile, activeSelection, diagnostics]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const typed = input.trim();
    if ((!typed && images.length === 0) || isStreaming) return;
    const trimmed = typed || 'See the attached image.';

    const userMessageId = crypto.randomUUID();
    addMessage({
      id: userMessageId,
      role: 'user',
      content: images.length > 0 ? `${trimmed}\n\n🖼 ${images.length} image${images.length === 1 ? '' : 's'} attached` : trimmed,
      createdAt: new Date().toISOString(),
    });
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    const assistantId = crypto.randomUUID();
    startStreaming(assistantId);

    void window.peep.sendAgentMessage({
      threadId: useChatStore.getState().activeThreadId ?? undefined,
      message: trimmed,
      history: messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      projectPath: project?.path,
      openFilePath: activeFile?.path,
      openFileContent: activeFile?.content,
      selectedCode: activeSelection ?? undefined,
      diagnostics,
      mentions: attachments.map((a) => a.mention),
      checkpointId: userMessageId,
      images: images.map(({ mimeType, data }) => ({ mimeType, data })),
      autoApplyEdits: true,
    });
    setAttachments([]);
    setImages([]);
    setMentionQuery(null);
  };

  /* ── Pending edits: Keep / Undo / Review ── */
  const [changesExpanded, setChangesExpanded] = useState(false);
  const editSummaries = useMemo(
    () => proposedEdits.map((edit) => ({ edit, ...diffSummary(edit.originalContent, edit.proposedContent) })),
    [proposedEdits],
  );

  const handleKeep = (editIds: string[]) => {
    const applied = proposedEdits.filter((e) => editIds.includes(e.id));
    void window.peep.applyAgentEdits(editIds).then(async () => {
      for (const edit of applied) {
        const existing = useWorkspaceStore.getState().openFiles.find((f) => f.path === edit.path);
        if (existing) {
          const content = await window.peep.readFile(edit.path);
          openFile({ ...existing, content, dirty: false });
        }
      }
      void window.peep.getPendingEdits().then(setProposedEdits);
      usePreviewStore.getState().bumpIframe();
    });
  };

  const handleUndo = (editIds: string[]) => {
    const rejected = proposedEdits.filter((e) => editIds.includes(e.id)).map((e) => e.path);
    void window.peep.rejectAgentEdits(editIds).then(async () => {
      // Editors were showing the proposed text; put them back to what is on disk.
      await syncEditorsFromDisk(rejected);
      void window.peep.getPendingEdits().then(setProposedEdits);
    });
  };

  const openReview = () => {
    openFile({ path: REVIEW_TAB_PATH, name: 'Review Changes', content: '', dirty: false });
  };

  const openEditPreview = (edit: ProposedEdit) => {
    openFile({ path: edit.path, name: fileName(edit.path), content: edit.proposedContent, dirty: true });
  };

  /* ── Rendering ── */
  const visibleMessages = messages.filter((m) => m.id !== WELCOME_ID);
  const lastAssistantId = [...visibleMessages].reverse().find((m) => m.role === 'assistant')?.id;

  const renderMessage = (message: AgentMessage) => {
    if (message.role === 'user') {
      const files = checkpointFiles[message.id] ?? 0;
      return (
        <div className="cx-turn cx-turn--user">
          <div className="cx-user-msg">{message.content}</div>
          {files > 0 && (
            <button
              type="button"
              className="cx-restore"
              disabled={isStreaming}
              title={isStreaming ? 'Stop the agent first' : 'Undo every file change the agent made from this message onward'}
              onClick={() => void restoreCheckpoint(message.id)}
            >
              ↺ Restore checkpoint
            </button>
          )}
        </div>
      );
    }

    const steps = stepsForRun(timelineActivities, message.runId);
    const isLive = message.id === streamingMessageId;
    const showEdits = message.id === lastAssistantId && editSummaries.length > 0;

    return (
      <div className="cx-turn cx-turn--assistant">
        {steps.length > 0 && (
          <div className="cx-steps">
            {steps.map((a) => {
              const { verb, target } = stepLabel(a);
              return (
                <div key={a.id} className={`cx-step cx-step--${a.status}`} title={a.message}>
                  <span className="cx-step__verb">{verb}</span>
                  {target && <span className="cx-step__target">{target}</span>}
                  {a.status === 'failed' && <span className="cx-step__failed">failed</span>}
                </div>
              );
            })}
          </div>
        )}

        {message.content ? (
          // Rendered as markdown, never raw HTML: model output can contain injected markup.
          <div className="cx-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        ) : isLive ? (
          <div className="cx-thinking">{streamStatus || 'Thinking…'}</div>
        ) : null}

        {showEdits && (
          <div className="cx-edits">
            {editSummaries.map(({ edit, added, removed, preview }) => (
              <button key={edit.id} type="button" className="cx-edit-card" onClick={() => openEditPreview(edit)} title={edit.path}>
                <div className="cx-edit-card__head">
                  <Icon d={ICON.file} size={13} />
                  <span className="cx-edit-card__name">{fileName(edit.path)}</span>
                  {added > 0 && <span className="cx-add">+{added}</span>}
                  {removed > 0 && <span className="cx-del">-{removed}</span>}
                </div>
                {preview.length > 0 && (
                  <div className="cx-edit-card__diff">
                    {preview.map((line, i) => (
                      <div key={i} className={`cx-diff-line cx-diff-line--${line.kind === '+' ? 'add' : 'del'}`}>
                        <span className="cx-diff-line__sign">{line.kind}</span>
                        <span>{line.text || ' '}</span>
                      </div>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="agent-panel cx">
      {/* ── Tabs ── */}
      <div className="cx-tabs">
        <div className="cx-tabs__list">
          {openTabIds.map((id) => (
            <div
              key={id}
              className={`cx-tab ${id === activeThreadId ? 'cx-tab--active' : ''}`}
              onClick={() => { if (!isStreaming && id !== activeThreadId) void switchThread(id); }}
              title={threadTitle(id)}
            >
              <span className="cx-tab__title">{threadTitle(id)}</span>
              <button
                type="button"
                className="cx-tab__close"
                title="Close"
                disabled={isStreaming && id === activeThreadId}
                onClick={(e) => { e.stopPropagation(); closeTab(id); }}
              >
                <Icon d={ICON.close} size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="cx-tabs__actions">
          <button type="button" className="cx-icon-btn" title="New Chat" disabled={isStreaming} onClick={() => void newThread()}>
            <Icon d={ICON.plus} />
          </button>
          <div className="cx-popover-anchor" ref={historyRef}>
            <button type="button" className={`cx-icon-btn ${historyOpen ? 'cx-icon-btn--on' : ''}`} title="Chat History" onClick={() => setHistoryOpen((v) => !v)}>
              <Icon d={ICON.history} />
            </button>
            {historyOpen && (
              <div className="cx-menu cx-menu--right">
                <div className="cx-menu__label">Chat history</div>
                {threads.length === 0 && <div className="cx-menu__empty">No chats yet</div>}
                {threads.map((t) => (
                  <div
                    key={t.id}
                    className={`cx-menu__item ${t.id === activeThreadId ? 'cx-menu__item--active' : ''}`}
                    onClick={() => { setHistoryOpen(false); if (!isStreaming && t.id !== activeThreadId) void switchThread(t.id); }}
                  >
                    <span className="cx-menu__text">{threadTitle(t.id)}</span>
                    <span className="cx-menu__meta">{new Date(t.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                    <button
                      type="button"
                      className="cx-menu__delete"
                      title="Delete chat"
                      disabled={isStreaming}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete "${threadTitle(t.id)}"?`)) void deleteThread(t.id);
                      }}
                    >
                      <Icon d={ICON.trash} size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="cx-icon-btn" title="Close Chat (Ctrl+Alt+B)" onClick={() => useWorkspaceStore.getState().toggleAgentPane()}>
            <Icon d={ICON.panel} />
          </button>
        </div>
      </div>

      {ipcError && (
        <div className="cx-banner">
          <span><strong>Backend unreachable:</strong> {ipcError}. History can't be synced.</span>
          <button type="button" className="cx-icon-btn" title="Dismiss" onClick={() => useChatStore.getState().setIpcError(null)}>
            <Icon d={ICON.close} size={12} />
          </button>
        </div>
      )}

      {/* ── Conversation ── */}
      <div className="cx-messages">
        {visibleMessages.length === 0 ? (
          <div className="cx-empty">
            <div className="cx-empty__title">Plan, build, fix anything</div>
            <div className="cx-empty__hint">
              <kbd>@</kbd> to add files and context · <kbd>/</kbd> for commands · paste images to show the agent your screen
            </div>
          </div>
        ) : (
          <Virtuoso
            style={{ height: '100%' }}
            data={visibleMessages}
            followOutput="smooth"
            computeItemKey={(_, m) => m.id}
            itemContent={(_, message) => renderMessage(message)}
          />
        )}
      </div>

      {/* ── Pending changes bar ── */}
      {editSummaries.length > 0 && (
        <div className="cx-changes">
          {changesExpanded && (
            <div className="cx-changes__list">
              {editSummaries.map(({ edit, added, removed }) => (
                <div key={edit.id} className="cx-changes__row" onClick={() => openEditPreview(edit)} title={edit.path}>
                  <Icon d={ICON.file} size={12} />
                  <span className="cx-changes__name">{fileName(edit.path)}</span>
                  <span className="cx-add">+{added}</span>
                  <span className="cx-del">-{removed}</span>
                  <span className="cx-changes__row-actions">
                    <button type="button" className="cx-text-btn" onClick={(e) => { e.stopPropagation(); handleUndo([edit.id]); }}>Undo</button>
                    <button type="button" className="cx-text-btn" onClick={(e) => { e.stopPropagation(); handleKeep([edit.id]); }}>Keep</button>
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="cx-changes__bar">
            <button type="button" className="cx-changes__toggle" onClick={() => setChangesExpanded((v) => !v)}>
              <span className={`cx-chevron ${changesExpanded ? 'cx-chevron--open' : ''}`}><Icon d={ICON.chevron} size={12} /></span>
              {editSummaries.length} File{editSummaries.length === 1 ? '' : 's'}
            </button>
            <div className="cx-changes__actions">
              <button type="button" className="cx-text-btn" onClick={() => handleUndo(proposedEdits.map((e) => e.id))}>Undo All</button>
              <button type="button" className="cx-text-btn" onClick={() => handleKeep(proposedEdits.map((e) => e.id))}>Keep All</button>
              <button type="button" className="cx-review-btn" onClick={openReview}>Review</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Composer ── */}
      <div className="cx-composer-wrap">
        {slashQuery !== null && !slashDismissed && (
          <SlashCommandPicker
            ref={slashRef}
            query={slashQuery}
            onRun={runSlashCommand}
            onClose={() => setSlashDismissed(true)}
          />
        )}
        {mentionQuery && (
          <MentionPicker
            ref={pickerRef}
            query={mentionQuery.query}
            onSelect={selectMention}
            onClose={() => setMentionQuery(null)}
          />
        )}
        <form
          className={`cx-composer ${isDraggingImage ? 'cx-composer--drop' : ''}`}
          onSubmit={handleSubmit}
          onDragOver={(e) => {
            if (![...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) return;
            e.preventDefault();
            setIsDraggingImage(true);
          }}
          onDragLeave={() => setIsDraggingImage(false)}
          onDrop={(e) => {
            setIsDraggingImage(false);
            const files = imageFilesFrom(e.dataTransfer);
            if (files.length === 0) return;
            e.preventDefault();
            void addImages(files);
          }}
        >
          {(attachments.length > 0 || activeFile || images.length > 0) && (
            <div className="cx-context">
              {images.map((img) => (
                <div key={img.id} className="cx-image-thumb">
                  <img src={img.previewUrl} alt="Attached" />
                  <button type="button" title="Remove image" onClick={() => setImages((prev) => prev.filter((i) => i.id !== img.id))}>
                    <Icon d={ICON.close} size={10} />
                  </button>
                </div>
              ))}
              {attachments.map((a) => (
                <span key={a.id} className="cx-pill" title={a.detail ?? a.label}>
                  <MentionIcon icon={a.icon} name={a.label} />
                  <span>{a.label}</span>
                  <button type="button" title="Remove" onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}>
                    <Icon d={ICON.close} size={10} />
                  </button>
                </span>
              ))}
              {activeFile && (
                <span className="cx-pill cx-pill--auto" title={`${activeFile.path} (current file, sent automatically)`}>
                  <Icon d={ICON.file} size={11} />
                  <span>{activeFile.name}</span>
                </span>
              )}
            </div>
          )}

          <textarea
            ref={textareaRef}
            className="cx-textarea"
            placeholder={isStreaming ? 'Agent is working…' : 'Plan, build, @ for context'}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              setSlashDismissed(false);
              updateMentionQuery(e.target.value, e.target.selectionStart);
              resizeTextarea();
            }}
            onClick={(e) => updateMentionQuery(e.currentTarget.value, e.currentTarget.selectionStart)}
            onPaste={(e) => {
              const files = imageFilesFrom(e.clipboardData);
              if (files.length === 0) return;
              e.preventDefault();
              void addImages(files);
            }}
            onBlur={() => setMentionQuery(null)}
            onKeyDown={(e) => {
              if (mentionQuery && pickerRef.current?.handleKeyDown(e)) return;
              if (slashQuery !== null && !slashDismissed && slashRef.current?.handleKeyDown(e)) return;
              // Backspace in an empty input removes the last attached context.
              if (e.key === 'Backspace' && !input && attachments.length > 0) {
                setAttachments((prev) => prev.slice(0, -1));
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e as unknown as FormEvent);
              }
            }}
          />

          <div className="cx-composer__bar">
            <div className="cx-composer__left">
              <div className="cx-popover-anchor" ref={modelRef}>
                <button type="button" className="cx-chip" title="Model" onClick={() => setModelMenuOpen((v) => !v)}>
                  {modelLabel}
                  <Icon d={ICON.down} size={11} />
                </button>
                {modelMenuOpen && (
                  <div className="cx-menu cx-menu--up">
                    {upsellOpen ? (
                      <div className="cx-upsell">
                        <div className="cx-upsell__title">Upgrade to unlock premium models</div>
                        <div className="cx-upsell__text">Choosing a model is available on paid plans. On the Free plan, Auto picks a fast model for each task.</div>
                        <div className="cx-upsell__actions">
                          <button type="button" className="cx-text-btn" onClick={() => setUpsellOpen(false)}>Back</button>
                          <button type="button" className="cx-upsell__btn" onClick={() => { setModelMenuOpen(false); setUpsellOpen(false); openWebPage('pricing'); }}>Upgrade to Pro</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="cx-menu__label">Model</div>
                        {MODELS.map((m) => {
                          const locked = !canPickModel && m.id !== undefined;
                          return (
                            <div
                              key={m.label}
                              className={`cx-menu__item ${m.id === effectiveModel ? 'cx-menu__item--active' : ''} ${locked ? 'cx-menu__item--locked' : ''}`}
                              title={locked ? 'Available on paid plans' : undefined}
                              onClick={() => (locked ? setUpsellOpen(true) : void chooseModel(m.id))}
                            >
                              <span className="cx-menu__text">{m.label}</span>
                              {locked ? <span className="cx-menu__lock" aria-label="Locked"><Icon d={ICON.lock} size={12} /></span> : <span className="cx-menu__meta">{m.hint}</span>}
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="cx-composer__right">
              <button type="button" className="cx-icon-btn" title="Add context (@)" onMouseDown={(e) => e.preventDefault()} onClick={startMention}>
                <span className="cx-at">@</span>
              </button>
              <button type="button" className="cx-icon-btn" title="Attach image" onClick={() => imageInputRef.current?.click()}>
                <Icon d={ICON.image} />
              </button>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = '';
                  if (files.length) void addImages(files);
                }}
              />
              {isStreaming ? (
                <button type="button" className="cx-send cx-send--stop" title="Stop" onClick={() => void window.peep.cancelAgent()}>
                  <span className="cx-stop-square" />
                </button>
              ) : (
                <button type="submit" className="cx-send" title="Send (Enter)" disabled={!input.trim() && images.length === 0}>
                  <Icon d={ICON.send} size={14} />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
