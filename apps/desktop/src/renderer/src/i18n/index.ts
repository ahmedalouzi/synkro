import { useSyncExternalStore } from 'react';
import type { Locale } from './types';
import en from './locales/en.json';
import ar from './locales/ar.json';
import tr from './locales/tr.json';

export * from './types';

const DICTIONARIES: Record<Locale, Record<string, any>> = {
  en,
  ar,
  tr,
};

const STORAGE_KEY = 'synkro_locale';

function getInitialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'ar' || saved === 'tr') {
      return saved;
    }
  } catch {
    // LocalStorage unavailable in certain environments
  }
  return 'en';
}

let currentLocale: Locale = getInitialLocale();
const listeners = new Set<() => void>();

function applyDomLocale(loc: Locale) {
  if (typeof document === 'undefined') return;
  const dir = loc === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.lang = loc;
  document.documentElement.dir = dir;
  if (document.body) {
    document.body.dir = dir;
  }
}

// Apply immediately on load
applyDomLocale(currentLocale);

// Sync across windows live
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && (e.newValue === 'en' || e.newValue === 'ar' || e.newValue === 'tr')) {
      setLocale(e.newValue, false);
    }
  });
  if (window.peep?.onSettingsUpdated) {
    window.peep.onSettingsUpdated((partial) => {
      if (partial.locale && (partial.locale === 'en' || partial.locale === 'ar' || partial.locale === 'tr')) {
        setLocale(partial.locale, false);
      }
    });
  }
}

// Sync with backend settings on boot
if (typeof window !== 'undefined' && window.peep?.getSettings) {
  void window.peep.getSettings().then((s) => {
    if (s.locale && (s.locale === 'en' || s.locale === 'ar' || s.locale === 'tr')) {
      if (s.locale !== currentLocale) {
        setLocale(s.locale, false);
      }
    }
  }).catch(() => {});
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(next: Locale, persistToSettings = true): void {
  if (next !== 'en' && next !== 'ar' && next !== 'tr') return;
  if (currentLocale === next) return;

  currentLocale = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {}

  applyDomLocale(next);

  if (persistToSettings && typeof window !== 'undefined' && window.peep?.setSettings) {
    void window.peep.setSettings({ locale: next }).catch(() => {});
  }

  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Type-safe path lookup into nested dictionary objects.
 * Falls back strictly to English, and then to the key itself.
 */
function resolvePath(obj: Record<string, any>, path: string): string | undefined {
  if (obj && typeof obj === 'object' && path in obj && typeof obj[path] === 'string') {
    return obj[path];
  }
  const parts = path.split('.');
  let current: any = obj;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (current && typeof current === 'object') {
      if (part in current) {
        current = current[part];
      } else {
        const remainder = parts.slice(i).join('.');
        if (remainder in current && typeof current[remainder] === 'string') {
          return current[remainder];
        }
        return undefined;
      }
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

export function t(key: string, params?: Record<string, string | number>): string {
  let raw: string | undefined;

  // 1. Look in active locale
  if (currentLocale !== 'en') {
    raw = resolvePath(DICTIONARIES[currentLocale], key);
  }

  // 2. Fall back to English
  if (!raw) {
    raw = resolvePath(DICTIONARIES.en, key);
  }

  // 3. Fall back to key itself if not found
  if (!raw) {
    return key;
  }

  // Parameter interpolation: {param}
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      raw = raw.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }

  return raw;
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, () => 'en');
  const dir: 'ltr' | 'rtl' = locale === 'ar' ? 'rtl' : 'ltr';

  return {
    locale,
    dir,
    isRTL: dir === 'rtl',
    setLocale,
    t,
  };
}
