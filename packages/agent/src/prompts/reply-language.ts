/**
 * The language the agent answers in: the language of the user's LATEST message, not the app's interface
 * language. The old instruction told the model "the user's language is Turkish, you MUST answer in Turkish"
 * whenever the interface was Turkish, so an Arabic question got a Turkish answer.
 */

export type ReplyLanguage = 'ar' | 'tr' | 'en';

const NAMES: Record<ReplyLanguage, string> = { ar: 'Arabic (العربية)', tr: 'Turkish (Türkçe)', en: 'English' };

// Letters only matter in prose: code, paths and quoted identifiers do not say what language the user writes in.
const NOT_PROSE = /```[\s\S]*?```|`[^`]*`|\b[\w./\\-]+\.(tsx?|jsx?|dart|json|md|ya?ml)\b|https?:\/\/\S+/g;
const ARABIC_WORD = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const TURKISH_LETTERS = /[ğĞışŞİ]/;

/*
 * A message's language comes from its grammar words, not from how many words it has in each language: mobile
 * requests are full of English tech terms ("login page", "button", "screen") that say nothing about the language
 * the user writes in. "bana bir login page yapa bilirmisin" is Turkish. Tech terms are on neither list.
 */
const TURKISH_WORDS = new Set([
  'bana', 'sana', 'beni', 'benim', 'bunu', 'şunu', 'onu', 'bir', 've', 'veya', 'ile', 'için', 'gibi', 'kadar', 'daha', 'çok',
  'bu', 'şu', 'ne', 'neden', 'nasıl', 'nerede', 'hangi', 'lütfen', 'değil', 'var', 'yok', 'olsun', 'olarak', 'olan', 'ama', 'fakat',
  'şimdi', 'tüm', 'hepsi', 'her', 'yeni', 'eski', 'yap', 'yapar', 'yapa', 'yapın', 'ekle', 'sil', 'düzelt', 'değiştir', 'göster',
  'getir', 'oluştur', 'istiyorum', 'lazım', 'gerek', 'mı', 'mi', 'mu', 'mü', 'de', 'da', 'ki', 'sayfa', 'sayfası', 'ekran',
  'ekranı', 'uygulama', 'uygulamaya', 'renk', 'renkleri', 'tamam', 'evet', 'hayır', 'teşekkürler',
]);
// Question particles and verb endings, also when written together with the verb ("bilirmisin", "yaparmısın").
// No plural -lar/-ler: "controller", "handler", "regular" are English tech words.
const TURKISH_SUFFIX = /(m[ıiuü]s[ıiuü]n(ız)?|m[ıiuü]y[ıiuü]m|[ae]bil[ıi]r|[ıiuü]yor(um|sun|uz)?)$/;
const ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'into', 'about',
  'please', 'can', 'could', 'would', 'should', 'will', 'you', 'your', 'my', 'me', 'i', 'it', 'its', 'this', 'that', 'these',
  'is', 'are', 'was', 'be', 'do', 'does', 'not', "don't", 'all', 'some', 'more', 'when', 'what', 'how', 'why', 'where', 'which',
  'add', 'make', 'create', 'build', 'fix', 'change', 'show', 'remove', 'delete', 'use', 'want', 'need', 'let', 'so', 'then',
]);

/** The language of a message, or null when it has no prose to tell (only code, a path, tech terms, an emoji). */
export function detectMessageLanguage(text: string): ReplyLanguage | null {
  const prose = text.replace(NOT_PROSE, ' ');
  const raw = prose.match(/[\p{L}']+/gu) || [];
  const arabic = raw.filter((w) => ARABIC_WORD.test(w)).length;
  const english = raw.filter((w) => ENGLISH_WORDS.has(w.toLowerCase())).length;
  const turkish = raw.map((w) => w.toLocaleLowerCase('tr'))
    .filter((w) => TURKISH_WORDS.has(w) || (w.length > 4 && TURKISH_SUFFIX.test(w))).length
    + (TURKISH_LETTERS.test(prose) ? 2 : 0);
  if (arabic > 0 && arabic >= english) return 'ar';
  if (turkish === 0 && english === 0) return null;
  if (turkish > english) return 'tr';
  if (english > turkish) return 'en';
  return TURKISH_LETTERS.test(text) ? 'tr' : 'en';
}

/**
 * The system-prompt section about language: answer in the latest message's language; the interface language is
 * only a fallback when the message has none (e.g. only code). Code, names, paths and commits stay in English.
 */
export function replyLanguageInstruction(latestUserMessage: string, interfaceLocale?: string): string {
  const detected = detectMessageLanguage(latestUserMessage);
  const fallback: ReplyLanguage = interfaceLocale === 'ar' || interfaceLocale === 'tr' ? interfaceLocale : 'en';
  const lang = detected ?? fallback;
  const why = detected ? "The user's latest message is in" : "The user's latest message has no clear language; the app is set to";
  return `\n\n[REPLY LANGUAGE]\n${why} ${NAMES[lang]}. Write every reply, plan and question in ${NAMES[lang]}, `
    + 'whatever language earlier messages or the app use; if a later message switches language, switch with it. '
    + 'Code, variable and function names, file paths, terminal commands, commit messages and code comments stay in English.\n';
}
