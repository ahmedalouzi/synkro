import { create } from 'zustand';
import type { Diagnostic, PreviewSession } from '@peep/shared';

interface PreviewState {
  session: PreviewSession | null;
  logs: string[];
  iframeKey: number;
  deviceId: string;
  /** Device frame turned to landscape. */
  landscape: boolean;
  selectedElement: any | null;
  promptInput: string;

  setSession: (session: PreviewSession) => void;
  addLog: (line: string) => void;
  bumpIframe: () => void;
  clearLogs: () => void;
  setDeviceId: (id: string) => void;
  setLandscape: (landscape: boolean) => void;
  setSelectedElement: (el: any | null) => void;
  setPromptInput: (txt: string) => void;
}

export const usePreviewStore = create<PreviewState>((set) => ({
  session: null,
  logs: [],
  iframeKey: 0,
  deviceId: 'iphone-15',
  landscape: false,
  selectedElement: null,
  promptInput: '',

  setSession: (session) => set({ session }),
  addLog: (line) =>
    set((state) => ({
      logs: [...state.logs.slice(-200), line],
    })),
  bumpIframe: () => set((state) => ({ iframeKey: state.iframeKey + 1 })),
  clearLogs: () => set({ logs: [] }),
  setDeviceId: (id) => set({ deviceId: id }),
  setLandscape: (landscape) => set({ landscape }),
  setSelectedElement: (el) => set({ selectedElement: el }),
  setPromptInput: (txt) => set({ promptInput: txt }),
}));

interface DiagnosticsState {
  items: Diagnostic[];
  setItems: (items: Diagnostic[]) => void;
}

export const useDiagnosticsStore = create<DiagnosticsState>((set) => ({
  items: [],
  setItems: (items) => set({ items }),
}));
