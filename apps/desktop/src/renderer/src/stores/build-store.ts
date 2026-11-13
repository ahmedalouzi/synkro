import { create } from 'zustand';
import { CloudBuildJob } from '@peep/shared';

/** The dependency check before a Cloud Build upload (commands.ts buildApk): running, or problems to show. */
export interface DepsCheckState {
  state: 'checking' | 'problems' | 'fixing';
  problems: string[];
  /** The problems are what is left after `npx expo install --fix`. */
  afterFix?: boolean;
  fixError?: string;
}

interface BuildState {
  currentBuild: CloudBuildJob | null;
  setCurrentBuild: (build: CloudBuildJob | null) => void;
  updateCurrentBuild: (updates: Partial<CloudBuildJob>) => void;
  isBuildPanelOpen: boolean;
  setBuildPanelOpen: (isOpen: boolean) => void;
  depsCheck: DepsCheckState | null;
  setDepsCheck: (depsCheck: DepsCheckState | null) => void;
}

export const useBuildStore = create<BuildState>((set) => ({
  currentBuild: null,
  setCurrentBuild: (build) => set({ currentBuild: build }),
  updateCurrentBuild: (updates) => set((state) => ({
    currentBuild: state.currentBuild ? { ...state.currentBuild, ...updates } : null
  })),
  isBuildPanelOpen: false,
  setBuildPanelOpen: (isOpen) => set({ isBuildPanelOpen: isOpen }),
  depsCheck: null,
  setDepsCheck: (depsCheck) => set({ depsCheck }),
}));
