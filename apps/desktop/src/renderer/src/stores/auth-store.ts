import * as Sentry from '@sentry/electron/renderer';
import { create } from 'zustand';
import type { Settings } from '@peep/shared';

export type AuthState = 'BOOTING' | 'AUTHENTICATING' | 'LOGIN' | 'AUTHENTICATED_HOME' | 'WORKSPACE';

export interface UserAccount {
  email: string;
  tier?: string;
  plan?: string;
  usedCost?: number;
  budgetCost?: number;
  usedTokens?: number;
  budgetTokens?: number;
  usage?: number;
  limit?: number;
}

interface AuthStore {
  authState: AuthState;
  user: UserAccount | null;
  settings: Settings | null;
  setAuthState: (state: AuthState) => void;
  setUser: (user: UserAccount | null) => void;
  checkSession: () => Promise<void>;
  login: (email: string, password: string, mode: 'signin' | 'signup') => Promise<{ success: boolean; error?: string }>;
  loginWithOAuth: (provider: 'google' | 'github') => Promise<{ success: boolean; error?: string }>;
  cancelOAuth: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  authState: 'BOOTING',
  user: null,
  settings: null,

  setAuthState: (authState) => set({ authState }),
  setUser: (user) => set({ user }),

  checkSession: async () => {
    set({ authState: 'AUTHENTICATING' });
    try {
      const settings = await window.peep.getSettings();
      set({ settings });

      if (!settings.sessionConfigured) {
        set({ authState: 'LOGIN', user: null });
        return;
      }

      const account = await window.peep.authGetAccount();
      if (account) {
        set({ user: account });
        // Check if there is an active project loaded
        const { project } = (await import('./workspace-store')).useWorkspaceStore.getState();
        if (project) {
          set({ authState: 'WORKSPACE' });
        } else {
          set({ authState: 'AUTHENTICATED_HOME' });
        }
      } else {
        // Session token expired or invalid
        await window.peep.authLogout();
        set({ authState: 'LOGIN', user: null });
      }
    } catch (err) {
      console.error('Failed to restore auth session:', err);
        Sentry.captureException(err);
      set({ authState: 'LOGIN', user: null });
    }
  },

  login: async (email, password, mode) => {
    try {
      const res = mode === 'signin'
        ? await window.peep.authSignIn(email, password)
        : await window.peep.authSignUp(email, password);

      if (res.success) {
        const account = await window.peep.authGetAccount();
        const settings = await window.peep.getSettings();
        set({ user: account, settings });
        
        // On success, go to AUTHENTICATED_HOME (we don't have a project loaded yet)
        set({ authState: 'AUTHENTICATED_HOME' });
        return { success: true };
      }
      return { success: false, error: res.error || 'Authentication failed' };
    } catch (err: any) {
      return { success: false, error: err.message || 'Authentication failed' };
    }
  },

  loginWithOAuth: async (provider: 'google' | 'github') => {
    try {
      const res = await window.peep.authStartOAuth(provider);
      if (res.success) {
        const account = await window.peep.authGetAccount();
        const settings = await window.peep.getSettings();
        set({ user: account, settings });
        set({ authState: 'AUTHENTICATED_HOME' });
        return { success: true };
      }
      return { success: false, error: res.error || 'Authentication failed' };
    } catch (err: any) {
      return { success: false, error: err.message || 'Authentication failed' };
    }
  },

  cancelOAuth: async () => {
    try {
      await window.peep.authCancelOAuth();
    } catch {
      // ignore
    }
  },

  logout: async () => {
    try {
      await window.peep.authLogout();
    } catch (err) {
      console.error('Logout request failed:', err);
        Sentry.captureException(err);
    } finally {
      const wsStore = (await import('./workspace-store')).useWorkspaceStore.getState();
      wsStore.setProject(null);
      wsStore.setFileTree([]);
      // Close all files
      for (const file of wsStore.openFiles) {
        wsStore.closeFile(file.path);
      }

      set({ authState: 'LOGIN', user: null, settings: null });
    }
  }
}));

if (typeof window !== 'undefined' && window.peep?.onAuthSessionExpired) {
  window.peep.onAuthSessionExpired(() => {
    console.warn('[AUTH] Session expired event received from main process. Redirecting to login.');
    useAuthStore.getState().logout();
  });
}
