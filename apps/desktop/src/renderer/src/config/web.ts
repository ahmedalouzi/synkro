/**
 * The Synkro website: pricing/checkout, account & billing, docs.
 * Set VITE_SYNKRO_WEB_URL in apps/desktop/.env (it is baked in at build time, so it also
 * applies to installed builds); the fallback is only a placeholder until the site exists.
 */
export const SYNKRO_WEB_URL = (
  ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_SYNKRO_WEB_URL || 'https://synkro.com')
).replace(/\/+$/, '');

/** Pages the app links to; the website needs to serve these paths. */
export const WEB_PAGES = {
  pricing: '/pricing',
  account: '/account',
  billing: '/account/billing',
  docs: '/docs',
} as const;

export type WebPage = keyof typeof WEB_PAGES;

export const webUrl = (page: WebPage) => `${SYNKRO_WEB_URL}${WEB_PAGES[page]}`;

/** Opens a website page in the default browser (the main process routes window.open there). */
export function openWebPage(page: WebPage): void {
  window.open(webUrl(page), '_blank', 'noopener');
}
