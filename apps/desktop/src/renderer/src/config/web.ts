/**
 * The Atomvs website (https://www.atomvs.com, source in the synkro-web repo): pricing/checkout,
 * account & billing, docs. VITE_SYNKRO_WEB_URL in apps/desktop/.env overrides it (baked in at
 * build time, so it also applies to installed builds).
 */
export const SYNKRO_WEB_URL = (
  ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_SYNKRO_WEB_URL || 'https://www.atomvs.com')
).replace(/\/+$/, '');

/** Pages the app links to; the website needs to serve these paths. */
export const WEB_PAGES = {
  pricing: '/pricing',
  account: '/account',
  billing: '/account/billing',
  docs: '/docs',
  privacy: '/privacy',
  terms: '/terms',
} as const;

export type WebPage = keyof typeof WEB_PAGES;

export const webUrl = (page: WebPage) => `${SYNKRO_WEB_URL}${WEB_PAGES[page]}`;

/** Opens a website page in the default browser (the main process routes window.open there). */
export function openWebPage(page: WebPage): void {
  window.open(webUrl(page), '_blank', 'noopener');
}
