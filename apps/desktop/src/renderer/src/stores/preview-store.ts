import { create } from 'zustand';
import type { Diagnostic, PreviewSession } from '@peep/shared';

/** The frame finish picked per device model, remembered in this browser profile (also seen by the detached window). */
const FINISH_KEY = 'atomvs.preview.frameFinish';
function loadFinishes(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(FINISH_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

interface PreviewState {
  session: PreviewSession | null;
  logs: string[];
  iframeKey: number;
  deviceId: string;
  /** Device frame turned to landscape. */
  landscape: boolean;
  /** Frame finish per device model (devices.ts finishes), e.g. { 'iphone-15-pro': 'black' }. */
  finishes: Record<string, string>;
  selectedElement: any | null;
  promptInput: string;

  setSession: (session: PreviewSession) => void;
  addLog: (line: string) => void;
  bumpIframe: () => void;
  clearLogs: () => void;
  setDeviceId: (id: string) => void;
  setLandscape: (landscape: boolean) => void;
  setFinish: (deviceId: string, finishId: string) => void;
  setSelectedElement: (el: any | null) => void;
  setPromptInput: (txt: string) => void;
}

export const usePreviewStore = create<PreviewState>((set) => ({
  session: null,
  logs: [],
  iframeKey: 0,
  deviceId: 'iphone-17-pro',
  landscape: false,
  finishes: loadFinishes(),
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
  setFinish: (deviceId, finishId) => set((state) => {
    const finishes = { ...state.finishes, [deviceId]: finishId };
    try {
      localStorage.setItem(FINISH_KEY, JSON.stringify(finishes));
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
    return { finishes };
  }),
  setSelectedElement: (el) => set({ selectedElement: el }),
  setPromptInput: (txt) => set({ promptInput: txt }),
}));

// Another window (main ↔ detached preview) picked a finish: follow it.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === FINISH_KEY) usePreviewStore.setState({ finishes: loadFinishes() });
  });
}

interface DiagnosticsState {
  items: Diagnostic[];
  setItems: (items: Diagnostic[]) => void;
}

export const useDiagnosticsStore = create<DiagnosticsState>((set) => ({
  items: [],
  setItems: (items) => set({ items }),
}));
