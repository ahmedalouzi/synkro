import * as Sentry from '@sentry/electron/renderer';
import { create } from 'zustand';
import type { Settings } from '@peep/shared';

export type AuthState = 'BOOTING' | 'AUTHENTICATING' | 'LOGIN' | 'AUTHENTICATED_HOME' | 'WORKSPACE';

export interface UserAccount {
  email: string;
  tier?: string;
  plan?: string;
  emailVerified?: boolean;
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
  pendingVerificationEmail: string | null;
  setAuthState: (state: AuthState) => void;
  setUser: (user: UserAccount | null) => void;
  setPendingVerificationEmail: (email: string | null) => void;
  checkSession: () => Promise<void>;
  login: (email: string, password: string, mode: 'signin' | 'signup') => Promise<{ success: boolean; error?: string; verificationRequired?: boolean }>;
  verifyEmail: (code: string) => Promise<{ success: boolean; error?: string }>;
  resendVerification: () => Promise<{ success: boolean; error?: string }>;
  cancelVerification: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  authState: 'BOOTING',
  user: null,
  settings: null,
  pendingVerificationEmail: null,

  setAuthState: (authState) => set({ authState }),
  setUser: (user) => set({ user }),
  setPendingVerificationEmail: (pendingVerificationEmail) => set({ pendingVerificationEmail }),

  checkSession: async () => {
    set({ authState: 'AUTHENTICATING' });
    try {
      const settings = await window.peep.getSettings();
      set({ settings });

      if (!settings.sessionConfigured) {
        set({ authState: 'LOGIN', user: null, pendingVerificationEmail: null });
        return;
      }

      const account = await window.peep.authGetAccount();
      if (account) {
        set({ user: account });
        if (account.emailVerified === false) {
          set({ authState: 'LOGIN', pendingVerificationEmail: account.email });
          return;
        }
        set({ pendingVerificationEmail: null });
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
        set({ authState: 'LOGIN', user: null, pendingVerificationEmail: null });
      }
    } catch (err) {
      console.error('Failed to restore auth session:', err);
      Sentry.captureException(err);
      set({ authState: 'LOGIN', user: null, pendingVerificationEmail: null });
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
        
        if (res.verificationRequired || res.emailVerified === false || account?.emailVerified === false) {
          set({ pendingVerificationEmail: email, authState: 'LOGIN' });
          return { success: true, verificationRequired: true };
        }

        set({ pendingVerificationEmail: null, authState: 'AUTHENTICATED_HOME' });
        return { success: true };
      }
      return { success: false, error: res.error || 'Authentication failed' };
    } catch (err: any) {
      return { success: false, error: err.message || 'Authentication failed' };
    }
  },

  verifyEmail: async (code: string) => {
    try {
      const res = await window.peep.authVerifyEmail(code);
      if (res.success) {
        const account = await window.peep.authGetAccount();
        set({ user: account, pendingVerificationEmail: null, authState: 'AUTHENTICATED_HOME' });
        return { success: true };
      }
      return { success: false, error: res.error || 'Verification failed' };
    } catch (err: any) {
      return { success: false, error: err.message || 'Verification failed' };
    }
  },

  resendVerification: async () => {
    try {
      const res = await window.peep.authResendVerification();
      return res;
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to resend code' };
    }
  },

  cancelVerification: async () => {
    try {
      await window.peep.authLogout();
    } catch (err) {
      console.error('Cancel verification logout error:', err);
    } finally {
      set({ pendingVerificationEmail: null, authState: 'LOGIN', user: null });
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

      set({ authState: 'LOGIN', user: null, settings: null, pendingVerificationEmail: null });
    }
  }
}));

if (typeof window !== 'undefined' && window.peep?.onAuthSessionExpired) {
  window.peep.onAuthSessionExpired(() => {
    console.warn('[AUTH] Session expired event received from main process. Redirecting to login.');
    useAuthStore.getState().logout();
  });
}
