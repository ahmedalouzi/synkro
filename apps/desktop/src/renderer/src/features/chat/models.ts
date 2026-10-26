import { useAuthStore } from '../../stores/auth-store';

/** Models the user can pick (chat composer and Settings › Models). "Auto" lets the server choose per task. */
export const MODELS: { id: string | undefined; label: string; hint: string }[] = [
  { id: undefined, label: 'Auto', hint: 'Picks the best model for each task' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', hint: 'Fast' },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', hint: 'Most capable' },
];

export const isFreePlan = (plan?: string) => /^free( plan)?$/i.test(plan ?? 'free');

/**
 * Picking a specific model is a paid feature, like Cursor's premium models. The server enforces
 * it too (free requests always run on Auto); this only decides what the UI offers.
 */
export function useCanPickModel(): boolean {
  const user = useAuthStore((s) => s.user);
  return !!user && !isFreePlan(user.tier || user.plan);
}
