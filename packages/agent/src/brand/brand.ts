import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/**
 * Per-project brand identity: every generated app gets its own name, mark, palette, font, radii, art direction and
 * splash motion, in brand.json at the project root. It is the single source of identity: the app's theme
 * (lib/theme/brand.dart, src/theme/brand.ts) is generated from it, and screens only read the theme, so "make it
 * darker" edits brand.json and nothing else. .peep/design.json keeps layout patterns only.
 *
 * Pure functions (no I/O): schema validation, WCAG contrast auto-fix, the fingerprint and the similarity rule, the
 * migration from an older design.json, and the theme files.
 */

export const BRAND_FILE = 'brand.json';

/** Fonts a brand may use: Google Fonts (OFL / Apache), each readable on phones and with 400 / 600 / 700 weights. */
export const CURATED_FONTS = [
  'Inter', 'Manrope', 'DM Sans', 'Plus Jakarta Sans', 'Outfit', 'Sora', 'Urbanist', 'Figtree', 'Lexend', 'Work Sans',
  'Nunito', 'Poppins', 'Rubik', 'Space Grotesk', 'Lora', 'Playfair Display', 'Fraunces', 'Merriweather',
  'Josefin Sans', 'Quicksand', 'Cairo', 'Tajawal', 'IBM Plex Sans Arabic', 'Noto Sans',
] as const;

/**
 * The folder of a curated font in the desktop app's bundle (apps/desktop/resources/brand-fonts/<slug>/), e.g.
 * "Plus Jakarta Sans" -> "plus-jakarta-sans". scripts/fetch-brand-fonts.mjs uses the same rule.
 */
export function fontSlug(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The six art-direction presets for illustrations and imagery. */
export const ILLUSTRATION_PRESETS = {
  'flat-geometric': 'Flat geometric shapes, bold solid fills, no outlines',
  'soft-3d': 'Soft 3D clay-like objects, gentle shadows, rounded forms',
  'line-art': 'Single-weight line drawings with sparse accent fills',
  'hand-drawn': 'Loose hand-drawn ink and marker, imperfect organic strokes',
  'duotone-photo': 'Photography in two brand tones, high contrast crops',
  'isometric': 'Isometric scenes, 30° grid, crisp edges and long shadows',
} as const;
export type IllustrationPreset = keyof typeof ILLUSTRATION_PRESETS;

export const COLOR_KEYS = ['primary', 'primaryOn', 'secondary', 'surface', 'ink', 'muted', 'success', 'danger'] as const;
export type BrandColorKey = typeof COLOR_KEYS[number];
export type BrandColors = Record<BrandColorKey, string>;

export interface Brand {
  name: string;
  tagline: string;
  /** An original vector mark: inline SVG, no scripts, no external references. */
  logo_svg: string;
  colors: BrandColors;
  font: string;
  radius: { card: number; button: number; sheet: number };
  illustration_style: IllustrationPreset;
  splash_motion: string;
  /** v1:<sha256 hex> of palette + font + preset (see brandFingerprint). */
  fingerprint: string;
  /** "design.json": migrated once from an older project's design manifest (its font may be outside the list). */
  origin?: 'generated' | 'design.json';
}

// ── Colors ──────────────────────────────────────────────────────────────────

const HEX = /^#[0-9a-fA-F]{6}$/;

export function normalizeHex(value: string): string {
  const v = value.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return `#${v.slice(1).split('').map((c) => c + c).join('')}`.toUpperCase();
  return v.toUpperCase();
}

function rgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex).slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

/** The hue of a color, 0–359°. */
export function hue(hex: string): number {
  return Math.round(toHsl(hex)[0]) % 360;
}

/**
 * `fg` adjusted in lightness only (same hue and saturation), as little as needed, until it reaches `min` contrast
 * on `bg`: darker on a light background, lighter on a dark one (the other way if that cannot reach it). Black or
 * white as a last resort. Exported for tests.
 */
export function fixContrast(fg: string, bg: string, min: number): string {
  const color = normalizeHex(fg);
  if (contrastRatio(color, bg) >= min) return color;
  const [h, s, l0] = toHsl(color);
  const bgIsLight = luminance(bg) > 0.18;
  for (const dir of bgIsLight ? [-1, 1] : [1, -1]) {
    for (let step = 1; step <= 100; step++) {
      const l = l0 + dir * step * 0.01;
      if (l < 0 || l > 1) break;
      const candidate = fromHsl(h, s, l);
      if (contrastRatio(candidate, bg) >= min) return candidate;
    }
  }
  return contrastRatio('#000000', bg) >= contrastRatio('#FFFFFF', bg) ? '#000000' : '#FFFFFF';
}

/**
 * The text / background pairs of a palette, with the WCAG AA minimum each needs: 4.5:1 for body text, 3:1 for large
 * text and UI (buttons, icons, badges). The first color of a pair is the one adjusted.
 */
export const CONTRAST_PAIRS: Array<{ fg: BrandColorKey; bg: BrandColorKey; min: number; use: string }> = [
  { fg: 'ink', bg: 'surface', min: 4.5, use: 'body text' },
  { fg: 'muted', bg: 'surface', min: 4.5, use: 'secondary text' },
  { fg: 'primary', bg: 'surface', min: 3, use: 'buttons, links, large text' },
  { fg: 'primaryOn', bg: 'primary', min: 4.5, use: 'text on primary buttons' },
  { fg: 'secondary', bg: 'surface', min: 3, use: 'accents, icons' },
  { fg: 'success', bg: 'surface', min: 3, use: 'success states' },
  { fg: 'danger', bg: 'surface', min: 3, use: 'error states' },
];

/** The palette with every pair passing WCAG AA, and what was changed. Exported for tests. */
export function fixPaletteContrast(colors: BrandColors): { colors: BrandColors; changed: string[] } {
  const out = Object.fromEntries(COLOR_KEYS.map((k) => [k, normalizeHex(colors[k])])) as BrandColors;
  const changed: string[] = [];
  // In order: primary on surface first, so primaryOn is checked against the final primary.
  for (const { fg, bg, min, use } of CONTRAST_PAIRS) {
    const fixed = fixContrast(out[fg], out[bg], min);
    if (fixed !== out[fg]) {
      changed.push(`${fg} ${out[fg]} → ${fixed} (${contrastRatio(fixed, out[bg]).toFixed(2)}:1 on ${bg}, ${use})`);
      out[fg] = fixed;
    }
  }
  return { colors: out, changed };
}

/** Pairs below their minimum (empty when the palette passes). */
export function contrastFailures(colors: BrandColors): string[] {
  return CONTRAST_PAIRS.filter(({ fg, bg, min }) => contrastRatio(colors[fg], colors[bg]) < min)
    .map(({ fg, bg, min }) => `${fg} on ${bg}: ${contrastRatio(colors[fg], colors[bg]).toFixed(2)}:1 < ${min}:1`);
}

// ── Fingerprint and similarity ──────────────────────────────────────────────

/**
 * v1:<sha256 hex> of the palette, the font and the art-direction preset. Stable and sortable-independent, so a
 * server can store and compare the same values later.
 */
export function brandFingerprint(b: Pick<Brand, 'colors' | 'font' | 'illustration_style'>): string {
  const palette = COLOR_KEYS.map((k) => `${k}=${normalizeHex(b.colors[k])}`).join(',');
  const input = `v1|${palette}|font=${b.font.trim().toLowerCase()}|preset=${b.illustration_style}`;
  return `v1:${createHash('sha256').update(input).digest('hex')}`;
}

/** What each project stores to compare brands later (the same fields a server sync would use). */
export interface BrandSignature {
  fingerprint: string;
  font: string;
  /** Hue of the primary color, 0–359°. */
  hue: number;
}

export function brandSignature(b: Pick<Brand, 'colors' | 'font' | 'illustration_style'>): BrandSignature {
  return { fingerprint: brandFingerprint(b), font: b.font, hue: hue(b.colors.primary) };
}

/** Distance between two hues on the color wheel, 0–180°. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Too close to another brand: the same font AND a primary hue within 20°. Exported for tests. */
export function tooSimilar(a: BrandSignature, b: BrandSignature): boolean {
  return a.font.trim().toLowerCase() === b.font.trim().toLowerCase() && hueDistance(a.hue, b.hue) <= 20;
}

/** The first of `others` (the user's last 20 brands) that `candidate` is too close to, or null. */
export function closestTooSimilar<T extends BrandSignature>(candidate: BrandSignature, others: T[]): T | null {
  return others.slice(0, 20).find((o) => o.fingerprint !== candidate.fingerprint && tooSimilar(candidate, o))
    ?? others.slice(0, 20).find((o) => o.fingerprint === candidate.fingerprint) ?? null;
}

// ── Schema ──────────────────────────────────────────────────────────────────

const NAME_CHARS = /^[\p{L}\p{N} .,'&!?:+\-]+$/u;
const KEYS = ['name', 'tagline', 'logo_svg', 'colors', 'font', 'radius', 'illustration_style', 'splash_motion', 'fingerprint', 'origin'];

/** A logo that is a plain inline SVG: no scripts, event handlers, external or embedded content. Exported for tests. */
export function logoProblem(svg: string): string | null {
  const s = svg.trim();
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return 'logo_svg must be one <svg>…</svg> element';
  if (s.length > 20_000) return 'logo_svg is larger than 20 KB';
  if (/<script|<foreignObject|<iframe|<image|<use[\s>]|<!ENTITY|<!DOCTYPE/i.test(s)) return 'logo_svg may not contain scripts, images, <use> or external content';
  if (/\son[a-z]+\s*=/i.test(s)) return 'logo_svg may not contain event handlers';
  if (/(href|src)\s*=\s*["']?\s*(https?:|data:|javascript:|\/\/)/i.test(s) || /url\(\s*["']?\s*(https?:|data:|\/\/)/i.test(s)) {
    return 'logo_svg may not reference external or embedded resources';
  }
  return null;
}

/**
 * Validates a brand (as the agent proposes it, or as brand.json holds it). Strict: unknown fields, wrong types, out
 * of range numbers, colors that are not #RRGGBB, fonts outside the list (except a migrated legacy font) and unsafe
 * logos are rejected. Returns the problems (empty = valid). Exported for tests.
 */
export function brandProblems(input: unknown, opts: { requireFingerprint?: boolean } = {}): string[] {
  const p: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['brand must be an object'];
  const b = input as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!KEYS.includes(k)) p.push(`unknown field: ${k}`);
  const migrated = b.origin === 'design.json';
  if (b.origin !== undefined && b.origin !== 'generated' && b.origin !== 'design.json') p.push('origin must be "generated" or "design.json"');

  const text = (key: string, max: number, required: boolean, pattern?: RegExp) => {
    const v = b[key];
    if (v === undefined || v === '') { if (required) p.push(`${key} is required`); return; }
    if (typeof v !== 'string') { p.push(`${key} must be a string`); return; }
    if (v.length > max) p.push(`${key} is longer than ${max} characters`);
    if (pattern && !pattern.test(v)) p.push(`${key} has characters that are not allowed`);
  };
  text('name', 40, true, NAME_CHARS);
  text('tagline', 90, !migrated);
  text('splash_motion', 240, !migrated);

  if (b.logo_svg === undefined || b.logo_svg === '') {
    if (!migrated) p.push('logo_svg is required');
  } else if (typeof b.logo_svg !== 'string') {
    p.push('logo_svg must be a string');
  } else {
    const problem = logoProblem(b.logo_svg);
    if (problem) p.push(problem);
  }

  const colors = b.colors as Record<string, unknown> | undefined;
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) {
    p.push('colors is required');
  } else {
    for (const k of Object.keys(colors)) if (!(COLOR_KEYS as readonly string[]).includes(k)) p.push(`unknown color: ${k}`);
    for (const k of COLOR_KEYS) {
      const v = colors[k];
      if (typeof v !== 'string' || !HEX.test(normalizeHex(v))) p.push(`colors.${k} must be a #RRGGBB color`);
    }
  }

  if (typeof b.font !== 'string' || !b.font.trim()) {
    p.push('font is required');
  } else if (!(CURATED_FONTS as readonly string[]).includes(b.font)) {
    if (!migrated) p.push(`font must be one of: ${CURATED_FONTS.join(', ')}`);
    else if (b.font.length > 40 || !/^[A-Za-z0-9 \-]+$/.test(b.font)) p.push('font is not a valid font family name');
  }

  const radius = b.radius as Record<string, unknown> | undefined;
  if (!radius || typeof radius !== 'object' || Array.isArray(radius)) {
    p.push('radius is required');
  } else {
    for (const k of Object.keys(radius)) if (!['card', 'button', 'sheet'].includes(k)) p.push(`unknown radius: ${k}`);
    for (const k of ['card', 'button', 'sheet']) {
      const v = radius[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 48) p.push(`radius.${k} must be a number from 0 to 48`);
    }
  }

  if (b.illustration_style === undefined && migrated) {
    // An older project's design.json has no preset; the agent sets one later.
  } else if (typeof b.illustration_style !== 'string' || !(b.illustration_style in ILLUSTRATION_PRESETS)) {
    p.push(`illustration_style must be one of: ${Object.keys(ILLUSTRATION_PRESETS).join(', ')}`);
  }

  if (b.fingerprint !== undefined && (typeof b.fingerprint !== 'string' || !/^v1:[0-9a-f]{64}$/.test(b.fingerprint))) {
    p.push('fingerprint must be v1:<sha256 hex>');
  } else if (opts.requireFingerprint && b.fingerprint === undefined) {
    p.push('fingerprint is required');
  }
  return p;
}

/**
 * A brand proposal made ready to save: validated, colors normalized and fixed for WCAG AA, fingerprint computed.
 * Throws with every problem when the proposal is invalid.
 */
export function finalizeBrand(input: unknown): { brand: Brand; contrastChanges: string[] } {
  const problems = brandProblems(input);
  if (problems.length) throw new Error(`Invalid brand: ${problems.join('; ')}`);
  const b = input as Brand;
  const { colors, changed } = fixPaletteContrast(b.colors);
  const brand: Brand = {
    name: b.name.trim(),
    tagline: (b.tagline ?? '').trim(),
    logo_svg: (b.logo_svg ?? '').trim(),
    colors,
    font: b.font.trim(),
    radius: { card: Math.round(b.radius.card), button: Math.round(b.radius.button), sheet: Math.round(b.radius.sheet) },
    illustration_style: b.illustration_style,
    splash_motion: (b.splash_motion ?? '').trim(),
    fingerprint: '',
    ...(b.origin ? { origin: b.origin } : {}),
  };
  brand.fingerprint = brandFingerprint(brand);
  return { brand, contrastChanges: changed };
}

/** An update ("make it darker", "change the color to green"): the existing brand with these fields replaced. */
export function mergeBrand(existing: Brand, patch: Record<string, unknown>): Record<string, unknown> {
  const { fingerprint: _f, ...rest } = existing;
  return {
    ...rest,
    ...patch,
    colors: { ...existing.colors, ...((patch.colors as object) ?? {}) },
    radius: { ...existing.radius, ...((patch.radius as object) ?? {}) },
  };
}

// ── Migration from an older design.json ─────────────────────────────────────

/**
 * brand.json for an older project, from the colors, font and radii its .peep/design.json already has, never new
 * ones. Missing slots take the nearest existing color (muted: the neutral grey, else ink). null when design.json
 * has no palette to migrate. Contrast is still fixed (lightness only) so no failing pair ships.
 */
export function brandFromDesignManifest(manifest: any, projectName: string): Record<string, unknown> | null {
  const c = manifest?.colors;
  if (!c || typeof c !== 'object') return null;
  const pick = (...values: unknown[]) => values.find((v): v is string => typeof v === 'string' && HEX.test(normalizeHex(v)));
  const neutral = c.neutral && typeof c.neutral === 'object' ? c.neutral : {};
  const primary = pick(c.primary);
  const surface = pick(c.surface, c.background);
  const ink = pick(c.onBackground, c.onSurface, c.text, neutral['900'], neutral['800']);
  if (!primary || !surface || !ink) return null;
  const colors = {
    primary,
    primaryOn: pick(c.onPrimary) ?? ink,
    secondary: pick(c.secondary, c.accent) ?? primary,
    surface,
    ink,
    muted: pick(neutral['500'], neutral['600'], neutral['400'], c.muted) ?? ink,
    success: pick(c.success) ?? primary,
    danger: pick(c.error, c.danger) ?? primary,
  };
  const r = manifest?.borderRadius ?? {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(48, Math.max(0, v)) : d);
  const family = typeof manifest?.typography?.fontFamily === 'string' ? manifest.typography.fontFamily.split(',')[0].replace(/["']/g, '').trim() : '';
  const name = projectName.replace(/[^\p{L}\p{N} .,'&!?:+\-]/gu, ' ').trim().slice(0, 40) || 'App';
  return {
    name,
    colors,
    font: family || 'Inter',
    radius: { card: num(r.lg ?? r.md, 16), button: num(r.md ?? r.sm, 12), sheet: num(r.lg, 24) },
    origin: 'design.json',
  };
}

// ── Generated theme files ───────────────────────────────────────────────────

function dartColor(hex: string): string {
  return `Color(0xFF${normalizeHex(hex).slice(1)})`;
}

function dartString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$').replace(/\n/g, ' ')}'`;
}

/**
 * lib/theme/brand.dart: the app's ThemeData, ColorScheme and TextTheme from brand.json, plus the Brand constants
 * (name, tagline, radii, logo asset, splash motion). Screens read Theme.of(context) and Brand.*, never literals.
 */
export function flutterBrandTheme(b: Brand, opts: { fonts?: boolean } = {}): string {
  const c = b.colors;
  const fonts = opts.fonts !== false;
  return `// GENERATED from brand.json by Atomvs. Do not edit: change brand.json (or ask the agent) and it is rebuilt.
// Every screen reads its colors, font and radii from here (Theme.of(context) and Brand), never literals.
import 'package:flutter/material.dart';

class Brand {
  Brand._();

  static const String name = ${dartString(b.name)};
  static const String tagline = ${dartString(b.tagline)};
${fonts
    ? `  /// ${b.font} (Google Fonts), bundled as assets/fonts/brand-*.ttf.
  static const String? fontFamily = 'BrandFont';`
    : `  /// ${b.font} could not be downloaded yet: the platform's default font until set_brand runs again.
  static const String? fontFamily = null;`}
  static const String logoAsset = 'assets/brand/logo.png';
  static const String illustrationStyle = ${dartString(b.illustration_style ?? '')};
  /// What the animated in-app splash does (from brand.json).
  static const String splashMotion = ${dartString(b.splash_motion)};

  static const Color primary = ${dartColor(c.primary)};
  static const Color primaryOn = ${dartColor(c.primaryOn)};
  static const Color secondary = ${dartColor(c.secondary)};
  static const Color surface = ${dartColor(c.surface)};
  static const Color ink = ${dartColor(c.ink)};
  static const Color muted = ${dartColor(c.muted)};
  static const Color success = ${dartColor(c.success)};
  static const Color danger = ${dartColor(c.danger)};

  static const double radiusCard = ${b.radius.card}.0;
  static const double radiusButton = ${b.radius.button}.0;
  static const double radiusSheet = ${b.radius.sheet}.0;

  static ThemeData theme() {
    final isDark = ThemeData.estimateBrightnessForColor(surface) == Brightness.dark;
    final scheme = ColorScheme.fromSeed(
      seedColor: primary,
      brightness: isDark ? Brightness.dark : Brightness.light,
    ).copyWith(
      primary: primary,
      onPrimary: primaryOn,
      secondary: secondary,
      onSecondary: surface,
      surface: surface,
      onSurface: ink,
      onSurfaceVariant: muted,
      error: danger,
      onError: primaryOn,
    );
    final base = ThemeData(useMaterial3: true, colorScheme: scheme, fontFamily: fontFamily, scaffoldBackgroundColor: surface);
    return base.copyWith(
      textTheme: base.textTheme.apply(fontFamily: fontFamily, bodyColor: ink, displayColor: ink),
      cardTheme: CardThemeData(
        color: surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusCard)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: primary,
          foregroundColor: primaryOn,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusButton)),
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: primary,
          foregroundColor: primaryOn,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusButton)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: primary,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusButton)),
        ),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(radiusSheet))),
      ),
      appBarTheme: AppBarTheme(backgroundColor: surface, foregroundColor: ink, elevation: 0),
    );
  }
}
`;
}

/** src/theme/brand.ts: the same tokens for React Native / Expo screens. */
export function reactNativeBrandTheme(b: Brand, opts: { fonts?: boolean } = {}): string {
  const c = b.colors;
  const q = (s: string) => JSON.stringify(s);
  const fonts = opts.fonts !== false;
  return `// GENERATED from brand.json by Atomvs. Do not edit: change brand.json (or ask the agent) and it is rebuilt.
// Every screen reads its colors, font and radii from here, never literals.
export const brand = {
  name: ${q(b.name)},
  tagline: ${q(b.tagline)},
  illustrationStyle: ${q(b.illustration_style ?? '')},
  /** What the animated in-app splash does (from brand.json). */
  splashMotion: ${q(b.splash_motion)},
  logo: require('../../assets/brand/logo.png'),
  colors: {
    primary: ${q(c.primary)},
    primaryOn: ${q(c.primaryOn)},
    secondary: ${q(c.secondary)},
    surface: ${q(c.surface)},
    ink: ${q(c.ink)},
    muted: ${q(c.muted)},
    success: ${q(c.success)},
    danger: ${q(c.danger)},
  },
${fonts ? `  font: {
    /** ${b.font} (Google Fonts), bundled as assets/fonts/brand-*.ttf. */
    name: ${q(b.font)},
    regular: 'BrandFont-Regular' as string | undefined,
    semibold: 'BrandFont-SemiBold' as string | undefined,
    bold: 'BrandFont-Bold' as string | undefined,
  },` : `  font: {
    /** ${b.font} could not be downloaded yet: the platform's default font until set_brand runs again. */
    name: ${q(b.font)},
    regular: undefined as string | undefined,
    semibold: undefined as string | undefined,
    bold: undefined as string | undefined,
  },`}
  radius: { card: ${b.radius.card}, button: ${b.radius.button}, sheet: ${b.radius.sheet} },
} as const;

/** The font files to load at startup (expo-font, which ships with Expo): useFonts(brandFonts). */
${fonts ? `export const brandFonts: Record<string, number> = {
  'BrandFont-Regular': require('../../assets/fonts/brand-400.ttf'),
  'BrandFont-SemiBold': require('../../assets/fonts/brand-600.ttf'),
  'BrandFont-Bold': require('../../assets/fonts/brand-700.ttf'),
};` : `export const brandFonts: Record<string, number> = {};`}

export type Brand = typeof brand;
`;
}

/**
 * The flutter_native_splash settings for pubspec.yaml: the brand's primary color and logo, also for Android 12+.
 * Exported for tests.
 */
export function nativeSplashConfig(b: Brand): string {
  const color = normalizeHex(b.colors.primary);
  return `flutter_native_splash:
  color: "${color}"
  image: assets/brand/logo.png
  android_12:
    color: "${color}"
    image: assets/brand/logo.png
  web: false
`;
}

/** The flutter_native_splash version added to generated apps (the only package this feature adds). */
export const NATIVE_SPLASH_VERSION = '^2.4.6';

/** The font files a brand bundles, by weight (downloaded from Google Fonts, OFL / Apache). */
export const FONT_WEIGHTS = [400, 600, 700] as const;

/**
 * pubspec.yaml with the brand wired in, idempotent: flutter_native_splash in dev_dependencies, its settings
 * (primary color + logo), the brand assets folder and the BrandFont family. Text edits on the standard
 * `flutter create` layout (top-level keys at column 0, two-space indents); comments and other entries are kept.
 * Exported for tests.
 */
export function pubspecWithBrand(pubspec: string, b: Brand, opts: { fonts?: boolean } = {}): string {
  const withFonts = opts.fonts !== false;
  const eol = /\r\n/.test(pubspec) ? '\r\n' : '\n';
  let lines = pubspec.replace(/\r\n/g, '\n').split('\n');
  const topLevel = (i: number) => /^[A-Za-z_][\w-]*:/.test(lines[i] ?? '');
  const blockEnd = (start: number) => {
    let i = start + 1;
    while (i < lines.length && !topLevel(i)) i++;
    // Trailing blank lines belong after the block.
    while (i - 1 > start && lines[i - 1].trim() === '') i--;
    return i;
  };
  const find = (re: RegExp) => lines.findIndex((l) => re.test(l));

  // 1. dev_dependencies: flutter_native_splash.
  let dev = find(/^dev_dependencies:\s*(#.*)?$/);
  if (dev === -1) {
    lines.push('', 'dev_dependencies:');
    dev = lines.length - 1;
  }
  const devEnd = blockEnd(dev);
  if (!lines.slice(dev + 1, devEnd).some((l) => /^ {2}flutter_native_splash:/.test(l))) {
    lines.splice(dev + 1, 0, `  flutter_native_splash: ${NATIVE_SPLASH_VERSION}`);
  }

  // 2. The flutter_native_splash settings (replaced as a whole).
  const splash = find(/^flutter_native_splash:\s*$/);
  if (splash !== -1) lines.splice(splash, blockEnd(splash) - splash);

  // 3. flutter: assets/brand/ and the BrandFont family.
  let fl = find(/^flutter:\s*(#.*)?$/);
  if (fl === -1) {
    lines.push('', 'flutter:', '  uses-material-design: true');
    fl = lines.length - 2;
  }
  const inFlutter = (re: RegExp) => {
    const end = blockEnd(fl);
    for (let i = fl + 1; i < end; i++) if (re.test(lines[i])) return i;
    return -1;
  };
  const assets = inFlutter(/^ {2}assets:\s*$/);
  if (assets === -1) {
    lines.splice(blockEnd(fl), 0, '  assets:', '    - assets/brand/');
  } else {
    let i = assets + 1;
    let has = false;
    while (i < lines.length && /^ {4}- /.test(lines[i])) { if (/^ {4}- assets\/brand\/?\s*$/.test(lines[i])) has = true; i++; }
    if (!has) lines.splice(assets + 1, 0, '    - assets/brand/');
  }
  const fontBlock = ['    - family: BrandFont', '      fonts:',
    ...FONT_WEIGHTS.flatMap((w) => [`        - asset: assets/fonts/brand-${w}.ttf`, `          weight: ${w}`])];
  const family = inFlutter(/^ {4}- family: BrandFont\s*$/);
  if (!withFonts) {
    // No font files (download failed): declaring them would fail the build. The platform font is used instead.
    if (family !== -1) {
      let end = family + 1;
      while (end < lines.length && /^ {6,}\S/.test(lines[end])) end++;
      lines.splice(family, end - family);
      const fontsKey = inFlutter(/^ {2}fonts:\s*$/);
      if (fontsKey !== -1 && !/^ {4}- /.test(lines[fontsKey + 1] ?? '')) lines.splice(fontsKey, 1);
    }
  } else {
    const fonts = inFlutter(/^ {2}fonts:\s*$/);
    if (fonts === -1) {
      lines.splice(blockEnd(fl), 0, '  fonts:', ...fontBlock);
    } else if (family === -1) {
      lines.splice(fonts + 1, 0, ...fontBlock);
    }
  }

  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  lines = [...lines, '', ...nativeSplashConfig(b).trimEnd().split('\n'), ''];
  return lines.join(eol);
}

// ── Fallback logo (no Chromium needed) ──────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A plain logo when the real one cannot be drawn: a filled circle in the brand's primary color, transparent
 * around it, same size and margin as the drawn logo. So assets/brand/logo.png always exists and neither the native
 * splash nor the app's require()/Image.asset break. Exported for tests.
 */
export function fallbackLogoPng(primary: string, size = 1024): Buffer {
  const [r, g, b] = rgb(primary);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2;
  const radius = size * 0.35;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      // Anti-aliased edge: coverage over the last pixel of the radius.
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const alpha = Math.max(0, Math.min(1, radius - d + 0.5));
      const i = row + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = Math.round(alpha * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
