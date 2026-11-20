import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BRAND_FILE, FONT_WEIGHTS, brandFromDesignManifest, fallbackLogoPng, fontSlug, brandProblems, brandSignature, closestTooSimilar, finalizeBrand,
  flutterBrandTheme, mergeBrand, pubspecWithBrand, reactNativeBrandTheme, type Brand, type BrandSignature,
} from '@peep/agent/brand';

/** A project's stored brand signature (the project record in the desktop's local store). */
export interface StoredBrand extends BrandSignature {
  projectPath: string;
  projectName: string;
  updatedAt: string;
}

export interface BrandStore {
  /** The most recent brands on this device (newest first), without the given project. */
  recent(excludePath: string, limit: number): StoredBrand[];
  save(projectPath: string, signature: BrandSignature): void;
}

export interface BrandDeps {
  store: BrandStore;
  /** The logo as a square PNG (transparent background, the mark centred). */
  rasterize: (svg: string, size: number) => Promise<Buffer>;
  /**
   * The folder of the fonts bundled with the desktop app (resources/brand-fonts: <slug>/{400,600,700}.ttf and OFL.txt
   * for every curated family). Fonts are copied from here into the project; there is no network call for fonts.
   */
  fontsDir: string;
}

export type BrandOutcome =
  | { status: 'saved'; brand: Brand; files: string[]; contrastChanges: string[]; warnings: string[] }
  | { status: 'too-similar'; similarTo: StoredBrand; message: string }
  | { status: 'invalid'; problems: string[] };

/** A failure's reason for a warning: one short line, without URLs (they could carry keys or tokens). */
function short(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').replace(/\s+/g, ' ').trim().slice(0, 120) || 'unknown error';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The project's brand.json, or null (none, or not valid). */
export async function readBrand(projectPath: string): Promise<Brand | null> {
  try {
    const brand = JSON.parse(await readFile(join(projectPath, BRAND_FILE), 'utf8'));
    return brandProblems(brand, { requireFingerprint: true }).length === 0 ? (brand as Brand) : null;
  } catch {
    return null;
  }
}

type Framework = 'flutter' | 'react-native' | null;
async function frameworkOf(projectPath: string): Promise<Framework> {
  if (await exists(join(projectPath, 'pubspec.yaml'))) return 'flutter';
  if (await exists(join(projectPath, 'package.json'))) return 'react-native';
  return null;
}

/**
 * Creates the brand (no brand.json yet) or changes it (only the given fields): validates, fixes WCAG contrast,
 * fingerprints, and writes brand.json, the theme file, the logo and the fonts. A new brand too close to one of the
 * last 20 on this device is refused once (`attempt` 0) so the agent picks another preset; the second attempt saves.
 */
export async function setBrand(
  projectPath: string, fields: Record<string, unknown>, deps: BrandDeps, attempt = 0,
): Promise<BrandOutcome> {
  const existing = await readBrand(projectPath);
  const proposal = existing ? mergeBrand(existing, fields) : { ...fields, origin: 'generated' };
  // A migrated brand becomes a full one as soon as the agent gives it the missing parts.
  if (existing?.origin === 'design.json' && fields.illustration_style && fields.logo_svg) (proposal as any).origin = 'generated';
  let finalized: ReturnType<typeof finalizeBrand>;
  try {
    finalized = finalizeBrand(proposal);
  } catch (err) {
    return { status: 'invalid', problems: brandProblems(proposal).length ? brandProblems(proposal) : [String((err as Error).message)] };
  }
  const { brand, contrastChanges } = finalized;
  const signature = brandSignature(brand);

  if (!existing && attempt === 0) {
    const similar = closestTooSimilar(signature, deps.store.recent(projectPath, 20));
    if (similar) {
      return {
        status: 'too-similar',
        similarTo: similar,
        message: `This brand is too close to "${similar.projectName}" (same font ${similar.font}, primary hue ${similar.hue}° vs ${signature.hue}°). `
          + 'Call set_brand again with a different illustration_style, and a different font or a primary color at least 20° away on the color wheel.',
      };
    }
  }

  const files: string[] = [];
  const warnings: string[] = [];
  const write = async (rel: string, data: string | Buffer) => {
    await mkdir(dirname(join(projectPath, rel)), { recursive: true });
    await writeFile(join(projectPath, rel), data);
    files.push(rel);
  };
  await write(BRAND_FILE, `${JSON.stringify(brand, null, 2)}\n`);

  const framework = await frameworkOf(projectPath);
  // The logo PNG: drawn by Chromium; if that fails, a plain circle in the primary color (pure Node), so logo.png
  // always exists and the native splash and the app's image references never break.
  if (brand.logo_svg) {
    await write('assets/brand/logo.svg', brand.logo_svg);
    let png: Buffer | null = null;
    try {
      png = await deps.rasterize(brand.logo_svg, 1024);
    } catch (err) {
      warnings.push(`The logo could not be drawn (${short(err)}); a plain circle in the primary color is used until set_brand runs again.`);
    }
    await write('assets/brand/logo.png', png ?? fallbackLogoPng(brand.colors.primary));
  } else if (framework && !(await exists(join(projectPath, 'assets/brand/logo.png')))) {
    await write('assets/brand/logo.png', fallbackLogoPng(brand.colors.primary));
  }

  // The font files, copied from the fonts bundled with Atomvs: all three weights or none. A file that is somehow
  // missing never fails the brand or the build: the app uses the platform's default font, brand.json keeps the font,
  // and the next set_brand copies it again.
  const fontFile = (w: number) => join(projectPath, `assets/fonts/brand-${w}.ttf`);
  const haveFonts = async () => (await Promise.all(FONT_WEIGHTS.map((w) => exists(fontFile(w))))).every(Boolean);
  let fontsOk = framework ? await haveFonts() : false;
  if (framework && (!existing || existing.font !== brand.font || !fontsOk)) {
    const bundled = (w: number) => join(deps.fontsDir, fontSlug(brand.font), `${w}.ttf`);
    const missing = (await Promise.all(FONT_WEIGHTS.map(async (w) => ((await exists(bundled(w))) ? null : w)))).filter((w) => w !== null);
    if (missing.length === 0) {
      for (const w of FONT_WEIGHTS) {
        await mkdir(dirname(fontFile(w)), { recursive: true });
        await copyFile(bundled(w), fontFile(w));
        files.push(`assets/fonts/brand-${w}.ttf`);
      }
      fontsOk = true;
    } else {
      // No stale files from a previous font: they would show the wrong typeface under the new name.
      await Promise.all(FONT_WEIGHTS.map((w) => rm(fontFile(w), { force: true })));
      fontsOk = false;
      warnings.push(`The ${brand.font} font files are missing from this Atomvs installation (weight ${missing.join(', ')}); the app uses the platform's default font for now, and set_brand will try again next time.`);
    }
  }

  if (framework === 'flutter') {
    await write('lib/theme/brand.dart', flutterBrandTheme(brand, { fonts: fontsOk }));
    const pubspecPath = join(projectPath, 'pubspec.yaml');
    const pubspec = await readFile(pubspecPath, 'utf8');
    const next = pubspecWithBrand(pubspec, brand, { fonts: fontsOk });
    if (next !== pubspec) await write('pubspec.yaml', next);
  } else if (framework === 'react-native') {
    await write('src/theme/brand.ts', reactNativeBrandTheme(brand, { fonts: fontsOk }));
    // Expo's own native splash (no extra package): the brand's color and logo.
    const appJsonPath = join(projectPath, 'app.json');
    if (await exists(appJsonPath)) {
      try {
        const appJson = JSON.parse(await readFile(appJsonPath, 'utf8'));
        if (appJson?.expo && typeof appJson.expo === 'object') {
          appJson.expo.splash = { ...(appJson.expo.splash ?? {}), image: './assets/brand/logo.png', resizeMode: 'contain', backgroundColor: brand.colors.primary };
          await write('app.json', `${JSON.stringify(appJson, null, 2)}\n`);
        }
      } catch {
        warnings.push('app.json could not be read; the native splash was not updated.');
      }
    }
  }

  deps.store.save(projectPath, signature);
  return { status: 'saved', brand, files, contrastChanges, warnings };
}

/**
 * An older project (design.json with colors, no brand.json): brand.json once, from the colors, font and radii it
 * already has (never new ones). design.json is left as it is. Returns true when it created brand.json.
 */
export async function migrateBrandFromDesignManifest(
  projectPath: string, projectName: string, manifest: unknown, store: BrandStore,
): Promise<boolean> {
  if (await exists(join(projectPath, BRAND_FILE))) return false;
  const proposal = brandFromDesignManifest(manifest, projectName);
  if (!proposal) return false;
  let brand: Brand;
  try {
    brand = finalizeBrand(proposal).brand;
  } catch {
    return false;
  }
  await writeFile(join(projectPath, BRAND_FILE), `${JSON.stringify(brand, null, 2)}\n`);
  store.save(projectPath, brandSignature(brand));
  return true;
}

/** The brand for the agent's context: identity in one block, so screens use the theme and never invent colors. */
export function brandContext(brand: Brand | null): string {
  if (!brand) return '';
  const theme = '`lib/theme/brand.dart` (Flutter: Theme.of(context), Brand.*) / `src/theme/brand.ts` (React Native: brand.*)';
  return `[PROJECT BRAND — brand.json, the single source of the app's identity]
name: ${brand.name}${brand.tagline ? ` — ${brand.tagline}` : ''}
colors: ${Object.entries(brand.colors).map(([k, v]) => `${k} ${v}`).join(', ')}
font: ${brand.font} · radius card ${brand.radius.card} / button ${brand.radius.button} / sheet ${brand.radius.sheet}
illustration style: ${brand.illustration_style ?? '(not set)'} · splash: ${brand.splash_motion || '(not set)'}
Screens read colors, font and radii from ${theme}; never hard-code them. To change the identity, call set_brand.`;
}

// A literal color or font NAME (fontFamily: 'Roboto'); fontFamily: Brand.fontFamily / brand.font.bold is the theme.
const DART_LITERALS = /\bColor\(0x[0-9a-fA-F]{8}\)|\bColors\.(?!transparent\b)[a-z]\w*|\bfontFamily\s*:\s*['"]/;
const TS_LITERALS = /['"`]#[0-9a-fA-F]{3,8}['"`]|\brgba?\(|\bfontFamily\s*:\s*['"`]/;

/**
 * A screen that hard-codes colors or fonts instead of reading the brand theme, or null. For the agent's file tools:
 * Dart under lib/ and TS/JS under src/ or app/, except the generated theme. Exported for tests.
 */
export function hardcodedStyleWarning(relPath: string, content: string): string | null {
  const p = relPath.replace(/\\/g, '/');
  if (/(^|\/)theme\/brand\.(dart|ts)$/.test(p)) return null;
  const dart = /(^|\/)lib\/.*\.dart$/.test(p) && DART_LITERALS.test(content);
  const ts = /(^|\/)(src|app)\/.*\.(tsx?|jsx?)$/.test(p) && TS_LITERALS.test(content);
  if (!dart && !ts) return null;
  return dart
    ? `${relPath} hard-codes colors or fonts (Color(0x…), Colors.*, fontFamily). Read them from the brand instead: Theme.of(context).colorScheme / textTheme, or Brand.* in lib/theme/brand.dart, so a brand change restyles every screen.`
    : `${relPath} hard-codes colors or fonts ('#…', rgb(), fontFamily). Read them from the brand instead: brand.colors / brand.font in src/theme/brand.ts, so a brand change restyles every screen.`;
}
