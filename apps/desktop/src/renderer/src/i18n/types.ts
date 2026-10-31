export type Locale = 'en' | 'ar' | 'tr';

export interface LocaleDefinition {
  code: Locale;
  label: string;
  nativeName: string;
  dir: 'ltr' | 'rtl';
}

export const SUPPORTED_LOCALES: LocaleDefinition[] = [
  { code: 'en', label: 'English', nativeName: 'English', dir: 'ltr' },
  { code: 'ar', label: 'Arabic', nativeName: 'العربية', dir: 'rtl' },
  { code: 'tr', label: 'Turkish', nativeName: 'Türkçe', dir: 'ltr' },
];

