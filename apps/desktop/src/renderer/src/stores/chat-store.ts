import * as Sentry from '@sentry/electron/renderer';
import { create } from 'zustand';
import type { AgentMessage, ProposedEdit, AgentTimelineActivity, AgentPhase } from '@peep/shared';

interface ThreadInfo {
  id: string;
  title: string;
  updated_at: string;
}

interface ChatState {
  threads: ThreadInfo[];
  activeThreadId: string | null;

  messages: AgentMessage[];
  input: string;
  isStreaming: boolean;
  streamStatus: string;
  streamingMessageId: string | null;
  proposedEdits: ProposedEdit[];
  agentTask: any | null;
  timelineActivities: AgentTimelineActivity[];
  runs: any[];
  currentRunId: string | null;
  selectedRunId: string | null;
  agentPhase: AgentPhase;

  ipcError: string | null;

  setInput: (input: string) => void;
  addMessage: (message: AgentMessage) => void;
  appendToStreamingMessage: (delta: string) => void;
  startStreaming: (messageId: string) => void;
  setStreamStatus: (status: string) => void;
  finishStreaming: () => void;
  setStreaming: (streaming: boolean) => void;
  setProposedEdits: (edits: ProposedEdit[]) => void;
  setAgentTask: (task: any | null) => void;
  clearMessages: () => void;
  upsertTimelineActivity: (activity: AgentTimelineActivity) => void;
  clearTimelineActivities: () => void;
  selectRun: (runId: string) => void;
  setAgentPhase: (phase: AgentPhase) => void;
  setIpcError: (error: string | null) => void;
  loadHistory: (projectPath: string) => Promise<void>;
  
  loadThreads: () => Promise<void>;
  switchThread: (threadId: string) => Promise<void>;
  newThread: () => Promise<void>;
  deleteActiveThread: () => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
/** Chats created locally that have no user message yet, so the backend doesn't know them. */
const unsavedThreadIds = new Set<string>();
/** Conversations already open this session, so switching chat tabs is instant and works offline. */
const sessionThreads = new Map<string, Pick<ChatState, 'messages' | 'timelineActivities' | 'runs'>>();

function rememberActiveThread(state: ChatState) {
  if (state.activeThreadId) {
    sessionThreads.set(state.activeThreadId, { messages: state.messages, timelineActivities: state.timelineActivities, runs: state.runs });
  }
}

const welcomeMessage = (): AgentMessage => ({
  id: 'welcome',
  role: 'assistant',
  content: 'Ask anything, @ to mention, / for actions.',
  createdAt: new Date().toISOString(),
});
let currentProjectPath: string | null = null;
let flushPendingSave: (() => void) | null = null;

function triggerSave(state: ChatState) {
  if (!currentProjectPath) return;
  if (saveTimeout) clearTimeout(saveTimeout);
  
  const payload = {
    messages: state.messages,
    timelineActivities: state.timelineActivities,
    updatedAt: new Date().toISOString()
  };
  
  const targetProject = currentProjectPath; // capture for closure
  const threadId = state.activeThreadId;
  
  flushPendingSave = () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = null;
    flushPendingSave = null;
    
    if (threadId) {
      if (payload.messages.some((m) => m.role === 'user')) unsavedThreadIds.delete(threadId);
      const runsMap = new Map<string, any>();
      for (const act of state.timelineActivities) {
        if (!runsMap.has(act.runId)) {
          runsMap.set(act.runId, {
            run_id: act.runId,
            thread_id: threadId,
            started_at: act.timestamp,
            status: act.status || 'in_progress',
            timeline_activities: []
          });
        }
        const run = runsMap.get(act.runId);
        run.timeline_activities.push(act);
        if (act.type === 'completed' || act.type === 'error') {
          run.completed_at = act.timestamp;
          run.status = act.status;
        }
      }
      const runs = Array.from(runsMap.values());
      const title = state.threads.find((t) => t.id === threadId)?.title;
      (window as any).peep?.saveChatThread?.(threadId, payload.messages, title, runs).catch((err: any) => {
        console.error('Save failed:', err);
        Sentry.captureException(err);
        useChatStore.getState().setIpcError('Failed to save to backend');
      });
    } else {
      (window as any).peep?.saveChatHistory?.(targetProject, payload).catch((err: any) => {
        console.error('Save history failed:', err);
        Sentry.captureException(err);
        useChatStore.getState().setIpcError('Failed to save history to backend');
      });
    }
  };

  saveTimeout = setTimeout(flushPendingSave, 750);
}

/** Unstripped text of the reply being streamed. */
let streamingRaw = { id: '', text: '' };

function stripCodeBlocks(text: string): string {
  // Strip introductory lines pointing to code files
  let cleaned = text.replace(
    /(?:Here's the updated content for|Here are the proposed contents|Proposed Code for|### Updated|### Proposed Code)[^:\n]*:?/gi,
    ''
  );
  // Replace complete code blocks with empty string
  cleaned = cleaned.replace(/```[a-zA-Z]*[\s\S]*?```/g, '');
  // Handle streaming state: if there is an open code block, truncate it
  const openBlockIndex = cleaned.indexOf('```');
  if (openBlockIndex >= 0) {
    cleaned = cleaned.slice(0, openBlockIndex);
  }
  return cleaned.trim();
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Ask anything, @ to mention, / for actions.',
      createdAt: new Date().toISOString(),
    },
  ],
  threads: [],
  activeThreadId: null,
  input: '',
  isStreaming: false,
  streamStatus: '',
  streamingMessageId: null,
  proposedEdits: [],
  agentTask: null,
  timelineActivities: [],
  runs: [],
  currentRunId: null,
  selectedRunId: null,
  agentPhase: 'idle',
  ipcError: null,

  selectRun: (runId) => set({ selectedRunId: runId }),
  setInput: (input) => set({ input }),
  setAgentTask: (task) => set({ agentTask: task }),
  setIpcError: (ipcError) => set({ ipcError }),
  addMessage: (message) =>
    set((state) => {
      // The first user message names the chat (shown in tabs and history, saved with the thread).
      const isFirstUserMessage = message.role === 'user' && !state.messages.some((m) => m.role === 'user');
      const title = isFirstUserMessage ? message.content.split('\n')[0].trim().slice(0, 60) : '';
      return {
        messages: [
          ...state.messages,
          message.role === 'assistant'
            ? { ...message, content: stripCodeBlocks(message.content) }
            : message,
        ],
        threads: title
          ? state.threads.map((t) => (t.id === state.activeThreadId && (!t.title || t.title === 'New Chat') ? { ...t, title } : t))
          : state.threads,
      };
    }),

  startStreaming: (messageId) =>
    set({
      isStreaming: true,
      streamingMessageId: messageId,
      streamStatus: 'Thinking…',
      messages: [...get().messages, { id: messageId, role: 'assistant', content: '', createdAt: new Date().toISOString() }],
    }),

  appendToStreamingMessage: (delta) => {
    const { streamingMessageId, messages } = get();
    if (!streamingMessageId) return;
    // Strip from the full raw text each time: stripping already-stripped text trimmed the
    // spaces between chunks and let code from a half-received block leak into the reply.
    if (streamingRaw.id !== streamingMessageId) streamingRaw = { id: streamingMessageId, text: '' };
    streamingRaw.text += delta;
    const content = stripCodeBlocks(streamingRaw.text);
    set({
      messages: messages.map((m) => (m.id === streamingMessageId ? { ...m, content } : m)),
    });
  },

  setStreamStatus: (streamStatus) => set({ streamStatus }),
  finishStreaming: () => set({ isStreaming: false, streamStatus: '', streamingMessageId: null }),
  setStreaming: (isStreaming) => set({ isStreaming }),
  setProposedEdits: (proposedEdits) => set({ proposedEdits }),
  clearMessages: () => set({ messages: [] }),
  upsertTimelineActivity: (activity) => set((state) => {
    let newRuns = [...state.runs];

    // If we receive a new runId
    if (state.currentRunId !== activity.runId) {
      newRuns.push({
        run_id: activity.runId,
        started_at: activity.timestamp,
        status: 'in_progress',
      });
      return {
        currentRunId: activity.runId,
        selectedRunId: activity.runId,
        timelineActivities: [...state.timelineActivities, activity],
        runs: newRuns,
        // Tie the run to the reply being streamed so its steps render inside that message.
        messages: state.streamingMessageId
          ? state.messages.map((m) => (m.id === state.streamingMessageId ? { ...m, runId: activity.runId } : m))
          : state.messages,
      };
    }

    // Update the live run's status if this activity is a terminal one
    if (activity.type === 'completed' || activity.type === 'error' || activity.status === 'failed') {
      const runIndex = newRuns.findIndex(r => r.run_id === activity.runId);
      if (runIndex >= 0) {
        newRuns[runIndex] = {
          ...newRuns[runIndex],
          status: (activity.status === 'failed' || activity.type === 'error') ? 'failed' : 'completed',
          completed_at: activity.timestamp
        };
      }
    }

    const index = state.timelineActivities.findIndex(a => a.id === activity.id);
    if (index >= 0) {
      const newActivities = [...state.timelineActivities];
      newActivities[index] = activity;
      return { timelineActivities: newActivities, runs: newRuns };
    }
    return { timelineActivities: [...state.timelineActivities, activity], runs: newRuns };
  }),
  clearTimelineActivities: () => set({ timelineActivities: [], currentRunId: null }),
  setAgentPhase: (agentPhase) => set({ agentPhase }),
  loadHistory: async (projectPath: string) => {
    if (flushPendingSave && currentProjectPath && currentProjectPath !== projectPath) {
      flushPendingSave();
    }
    if (currentProjectPath !== projectPath) {
      sessionThreads.clear();
      unsavedThreadIds.clear();
    }
    currentProjectPath = projectPath;
    try {
      get().setIpcError(null);
      const threads = await (window as any).peep?.listChatThreads?.(projectPath);
      if (threads && threads.length > 0) {
        set({ threads });
        await get().switchThread(threads[0].id);
        return;
      }
      
      const history = await (window as any).peep?.loadChatHistory?.(projectPath);
      if (history) {
        set({
          messages: history.messages || [
            {
              id: 'welcome',
              role: 'assistant',
              content: 'Ask anything, @ to mention, / for actions.',
              createdAt: new Date().toISOString(),
            },
          ],
          timelineActivities: history.timelineActivities || [],
          currentRunId: null,
          threads: [],
          activeThreadId: null,
        });
      } else {
        await get().newThread();
      }
    } catch (err) {
      console.error('Failed to load chat history:', err);
        Sentry.captureException(err);
      get().setIpcError('Failed to load chat history');
      await get().newThread();
    }
  },

  loadThreads: async () => {
    if (!currentProjectPath) return;
    try {
      get().setIpcError(null);
      const threads = await (window as any).peep?.listChatThreads?.(currentProjectPath);
      set({ threads: threads || [] });
    } catch (e) {
      console.error('Failed to load threads via IPC:', e);
        Sentry.captureException(e);
      get().setIpcError('Failed to load threads');
    }
  },

  switchThread: async (threadId: string) => {
    const { agentPhase } = get();
    if (agentPhase !== 'idle' && agentPhase !== 'done' && agentPhase !== 'cancelled' && agentPhase !== 'error') {
      console.warn('Cannot switch thread while agent is active');
      return;
    }
    if (flushPendingSave) flushPendingSave();
    rememberActiveThread(get());
    // Re-selecting the current chat reloads it from the backend; other tabs come from memory.
    const cached = threadId !== get().activeThreadId ? sessionThreads.get(threadId) : undefined;
    if (cached) {
      set({
        activeThreadId: threadId,
        ...cached,
        selectedRunId: cached.runs.length > 0 ? cached.runs[cached.runs.length - 1].run_id : null,
        currentRunId: null,
        agentPhase: 'idle',
      });
      return;
    }
    if (unsavedThreadIds.has(threadId)) {
      // Never sent a message, so there is nothing to load.
      set({
        activeThreadId: threadId,
        messages: [welcomeMessage()],
        runs: [],
        selectedRunId: null,
        timelineActivities: [],
        currentRunId: null,
        agentPhase: 'idle',
      });
      return;
    }
    try {
      get().setIpcError(null);
      const data = await (window as any).peep?.loadChatThread?.(threadId);
      if (!data) throw new Error('Received empty data from backend');
      
      const messages = data?.messages || [];
      const runs = data?.runs || [];
      const timelineActivities = [];
      for (const run of runs) {
        if (run.timeline_activities && Array.isArray(run.timeline_activities)) {
          timelineActivities.push(...run.timeline_activities);
        }
      }
      set({ 
        activeThreadId: threadId, 
        messages,
        runs,
        selectedRunId: runs.length > 0 ? runs[runs.length - 1].run_id : null,
        timelineActivities,
        currentRunId: null,
        agentPhase: 'idle'
      });
    } catch (e) {
      console.error(`Failed to load thread ${threadId} via IPC:`, e);
        Sentry.captureException(e);
      get().setIpcError('Failed to load thread');
    }
  },

  newThread: async () => {
    const { agentPhase } = get();
    if (agentPhase !== 'idle' && agentPhase !== 'done' && agentPhase !== 'cancelled' && agentPhase !== 'error') {
      console.warn('Cannot create thread while agent is active');
      return;
    }
    // Already on an empty new chat: reuse it instead of piling up empty ones.
    const current = get();
    if (current.activeThreadId && unsavedThreadIds.has(current.activeThreadId) && !current.messages.some((m) => m.role === 'user')) return;
    if (flushPendingSave) flushPendingSave();
    rememberActiveThread(current);
    
    // Create local thread placeholder, will be saved on first message
    const threadId = crypto.randomUUID();
    unsavedThreadIds.add(threadId);
    const newThread = { id: threadId, title: 'New Chat', updated_at: new Date().toISOString() };
    set({
      activeThreadId: threadId,
      threads: [newThread, ...get().threads],
      messages: [{
        id: 'welcome',
        role: 'assistant',
        content: 'Ask anything, @ to mention, / for actions.',
        createdAt: new Date().toISOString(),
      }],
      runs: [],
      selectedRunId: null,
      timelineActivities: [],
      currentRunId: null,
      agentPhase: 'idle'
    });
  },

  deleteThread: async (threadId: string) => {
    sessionThreads.delete(threadId);
    if (threadId === get().activeThreadId) return get().deleteActiveThread();
    try {
      await (window as any).peep?.deleteChatThread?.(threadId);
      set({ threads: get().threads.filter((t) => t.id !== threadId) });
    } catch (e) {
      console.error('Failed to delete thread', e);
      Sentry.captureException(e);
    }
  },

  deleteActiveThread: async () => {
    const { activeThreadId, agentPhase } = get();
    if (!activeThreadId) return;
    if (agentPhase !== 'idle' && agentPhase !== 'done' && agentPhase !== 'cancelled' && agentPhase !== 'error') {
      console.warn('Cannot delete active thread while agent is executing');
      return;
    }
    try {
      await (window as any).peep?.deleteChatThread?.(activeThreadId);
      const remaining = get().threads.filter(t => t.id !== activeThreadId);
      sessionThreads.delete(activeThreadId);
      unsavedThreadIds.delete(activeThreadId);
      // Cleared so the switch below doesn't cache the deleted chat again.
      set({ threads: remaining, activeThreadId: null });
      if (remaining.length > 0) {
        await get().switchThread(remaining[0].id);
      } else {
        await get().newThread();
      }
    } catch (e) {
      console.error('Failed to delete thread', e);
        Sentry.captureException(e);
    }
  },
}));

// Subscribe to state changes to trigger debounced saves
useChatStore.subscribe((state, prevState) => {
  if (!currentProjectPath) return;
  // Only save if durable state changed
  if (
    state.messages !== prevState.messages ||
    state.timelineActivities !== prevState.timelineActivities
  ) {
    triggerSave(state);
  }
});
