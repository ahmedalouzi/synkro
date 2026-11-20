import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import {
  CURATED_FONTS, brandFingerprint, brandFromDesignManifest, brandProblems, brandSignature, closestTooSimilar,
  contrastFailures, contrastRatio, fallbackLogoPng, finalizeBrand, fontSlug, fixContrast, fixPaletteContrast, flutterBrandTheme, hue,
  hueDistance, logoProblem, mergeBrand, pubspecWithBrand, reactNativeBrandTheme, tooSimilar, type Brand,
} from '../src/brand/brand';
import { classifyCommand } from '../src/tools/safety';
import { FLUTTER_SYSTEM_PROMPT } from '../src/prompts/flutter-system';
import { SCAFFOLD_SYSTEM_ADDENDUM } from '../src/prompts/scaffold-system';
import { OPENAI_TOOLS } from '../src/tools/definitions';
import {
  brandContext, hardcodedStyleWarning, migrateBrandFromDesignManifest, readBrand, setBrand, type BrandStore, type StoredBrand,
} from '../../../apps/desktop/src/main/services/brand-service';
import { TerminalService } from '../../../apps/desktop/src/main/services/terminal-service';

/**
 * Per-project brand identity: brand.json is the single source of an app's look (palette, font, radii, logo, art
 * direction, splash motion); the theme files are generated from it and screens only read the theme.
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
const BUNDLE = path.join(root, 'apps/desktop/resources/brand-fonts');
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#1B6E5A"/><path d="M20 36 L32 18 L44 36 Z" fill="#F4EFE6"/></svg>';
const GOOD = {
  name: 'Fernleaf', tagline: 'Plant care, gently timed.', logo_svg: LOGO,
  colors: { primary: '#1B6E5A', primaryOn: '#FFFFFF', secondary: '#B5651D', surface: '#F7F4EE', ink: '#1E2522', muted: '#5C6661', success: '#2E7D32', danger: '#C62828' },
  font: 'Fraunces', radius: { card: 18, button: 14, sheet: 28 }, illustration_style: 'hand-drawn',
  splash_motion: 'The leaf mark unfurls from the stem, then the name fades up',
};

export default async function run() {
  console.log('  [brand] (a) Contrast: every pair passes WCAG AA, fixed in lightness only...');
  assert.ok(Math.abs(contrastRatio('#000000', '#FFFFFF') - 21) < 0.01);
  assert.ok(Math.abs(contrastRatio('#777777', '#FFFFFF') - 4.48) < 0.02);
  const good = fixPaletteContrast(GOOD.colors);
  assert.deepEqual(good.changed, [], 'a passing palette is left as it is');
  assert.deepEqual(contrastFailures(good.colors), []);
  const failing = { primary: '#F2C94C', primaryOn: '#FFFFFF', secondary: '#FFE08A', surface: '#FFFFFF', ink: '#B0B0B0', muted: '#D0D0D0', success: '#A5D6A7', danger: '#FF8A80' };
  assert.ok(contrastFailures(failing).length >= 6, 'the test palette really fails');
  const fixed = fixPaletteContrast(failing);
  assert.deepEqual(contrastFailures(fixed.colors), [], `every pair passes after the fix: ${contrastFailures(fixed.colors)}`);
  assert.ok(contrastRatio(fixed.colors.ink, fixed.colors.surface) >= 4.5, 'body text 4.5:1');
  assert.ok(contrastRatio(fixed.colors.muted, fixed.colors.surface) >= 4.5, 'secondary text 4.5:1');
  assert.ok(contrastRatio(fixed.colors.primary, fixed.colors.surface) >= 3, 'primary (large / UI) 3:1');
  assert.ok(contrastRatio(fixed.colors.primaryOn, fixed.colors.primary) >= 4.5, 'text on primary, checked against the FIXED primary');
  assert.equal(fixed.colors.surface, '#FFFFFF', 'backgrounds are not changed');
  assert.ok(hueDistance(hue(fixed.colors.primary), hue(failing.primary)) <= 3, 'same hue, only lightness moves');
  assert.ok(fixed.changed.some((c) => /^primary #F2C94C → #[0-9A-F]{6} \(\d\.\d\d:1 on surface/.test(c)), fixed.changed.join(' | '));
  for (const [fg, bg] of [['#FAFAFA', '#FFFFFF'], ['#101010', '#000000'], ['#808080', '#7F7F7F']]) {
    assert.ok(contrastRatio(fixContrast(fg, bg, 4.5), bg) >= 4.5, `${fg} on ${bg}`);
  }
  assert.equal(fixContrast('#123456', '#FFFFFF', 4.5), '#123456', 'already passing: unchanged');

  console.log('  [brand] (b) Fingerprint and similarity: same font AND primary hue within 20° is too close...');
  const fp = brandFingerprint(GOOD as any);
  assert.match(fp, /^v1:[0-9a-f]{64}$/);
  assert.equal(brandFingerprint({ ...GOOD, colors: { ...GOOD.colors, primary: '#1b6e5a' } } as any), fp, 'hex case does not matter');
  assert.notEqual(brandFingerprint({ ...GOOD, illustration_style: 'line-art' } as any), fp, 'the preset is part of it');
  assert.notEqual(brandFingerprint({ ...GOOD, font: 'Inter' } as any), fp, 'the font is part of it');
  assert.notEqual(brandFingerprint({ ...GOOD, colors: { ...GOOD.colors, muted: '#5C6662' } } as any), fp, 'every palette color is part of it');
  const sig = (font: string, h: number, f = `v1:${'f'.repeat(60)}${String(h).padStart(4, '0')}`) => ({ fingerprint: f, font, hue: h });
  assert.equal(tooSimilar(sig('Fraunces', 160), sig('Fraunces', 175)), true, '15°, same font');
  assert.equal(tooSimilar(sig('Fraunces', 160), sig('Fraunces', 180)), true, 'exactly 20°');
  assert.equal(tooSimilar(sig('Fraunces', 160), sig('Fraunces', 181)), false, '21°');
  assert.equal(tooSimilar(sig('Fraunces', 160), sig('Inter', 160)), false, 'another font');
  assert.equal(tooSimilar(sig('fraunces', 355), sig('Fraunces', 10)), true, 'the hue wheel wraps (15°), font case ignored');
  assert.equal(hueDistance(350, 10), 20);
  const others = Array.from({ length: 25 }, (_, i) => ({ ...sig('Inter', i * 14 % 360, `v1:${String(i).padStart(64, '0')}`), name: `p${i}` }));
  assert.equal(closestTooSimilar(sig('Fraunces', 100), others), null);
  assert.equal(closestTooSimilar(sig('Inter', 3), others)?.name, 'p0');
  assert.equal(closestTooSimilar(sig('Inter', 300), others), null, 'only the last 20 count (300° is close only to p20-p22, the 21st-23rd)');

  console.log('  [brand] (c) Schema: strict...');
  assert.deepEqual(brandProblems(GOOD), []);
  const bad = (patch: Record<string, unknown>, re: RegExp, what: string) => {
    const problems = brandProblems({ ...GOOD, ...patch });
    assert.ok(problems.some((p) => re.test(p)), `${what}: ${problems.join(' | ')}`);
  };
  bad({ extra: 1 }, /unknown field: extra/, 'unknown field');
  bad({ colors: { ...GOOD.colors, primary: 'teal' } }, /colors\.primary must be a #RRGGBB color/, 'named color');
  bad({ colors: { ...GOOD.colors, accent: '#000000' } }, /unknown color: accent/, 'unknown color');
  const { danger: _d, ...noDanger } = GOOD.colors;
  bad({ colors: noDanger }, /colors\.danger must be/, 'missing color');
  bad({ font: 'Comic Sans MS' }, /font must be one of/, 'font outside the list');
  bad({ radius: { card: 99, button: 14, sheet: 28 } }, /radius\.card must be a number from 0 to 48/, 'radius out of range');
  bad({ radius: { card: 8, button: 8, sheet: 8, pill: 8 } }, /unknown radius: pill/, 'unknown radius');
  bad({ illustration_style: 'cyberpunk' }, /illustration_style must be one of/, 'unknown preset');
  bad({ name: 'x'.repeat(41) }, /name is longer than 40/, 'long name');
  bad({ name: 'Fern<script>' }, /name has characters that are not allowed/, 'markup in the name');
  bad({ tagline: '' }, /tagline is required/, 'missing tagline');
  bad({ logo_svg: '<svg><script>alert(1)</script></svg>' }, /scripts/, 'script in the logo');
  bad({ logo_svg: '<svg onload="x()"><path d="M0 0"/></svg>' }, /event handlers/, 'event handler in the logo');
  bad({ logo_svg: '<svg><image href="https://evil.example/x.png"/></svg>' }, /scripts, images|external/, 'remote image in the logo');
  bad({ logo_svg: '<svg><rect style="fill:url(https://x.example/a)"/></svg>' }, /external or embedded/, 'remote url() in the logo');
  bad({ logo_svg: 'not svg' }, /one <svg>…<\/svg> element/, 'not an SVG');
  bad({ fingerprint: 'abc' }, /fingerprint must be v1:<sha256 hex>/, 'bad fingerprint');
  assert.deepEqual(brandProblems('x'), ['brand must be an object']);
  assert.equal(logoProblem(LOGO), null);
  assert.deepEqual(brandProblems({ name: 'Old App', colors: GOOD.colors, font: 'Avenir Next', radius: GOOD.radius, origin: 'design.json' }), [],
    'a migrated brand may keep its legacy font and has no logo or preset yet');
  assert.ok(brandProblems({ name: 'Old App', colors: GOOD.colors, font: 'Avenir Next', radius: GOOD.radius }).length > 0, 'a new brand may not');

  console.log('  [brand] Finalize, update, and the migration from design.json (no invented values)...');
  const { brand, contrastChanges } = finalizeBrand(GOOD);
  assert.equal(brand.fingerprint, fp);
  assert.deepEqual(contrastChanges, []);
  assert.throws(() => finalizeBrand({ ...GOOD, font: 'Papyrus' }), /Invalid brand: font must be one of/);
  const greener = finalizeBrand(mergeBrand(brand, { colors: { primary: '#2E9E48' } })).brand;
  assert.equal(greener.colors.primary, '#2E9E48');
  assert.equal(greener.colors.secondary, GOOD.colors.secondary, 'other colors kept');
  assert.equal(greener.font, 'Fraunces');
  assert.equal(greener.logo_svg, LOGO);
  assert.notEqual(greener.fingerprint, brand.fingerprint);
  const manifest = {
    colors: { primary: '#6C5CE7', secondary: '#00B894', accent: '#FD79A8', background: '#FFFFFF', surface: '#F8F9FA', onPrimary: '#FFFFFF', onBackground: '#2D3436', error: '#D63031', success: '#00B894', warning: '#FDCB6E', neutral: { '500': '#636E72', '900': '#2D3436' } },
    typography: { fontFamily: '"Poppins", sans-serif' },
    borderRadius: { sm: 6, md: 12, lg: 20, full: 999 },
  };
  const migrated = brandFromDesignManifest(manifest, 'Bloom Fit') as any;
  assert.deepEqual(migrated.colors, { primary: '#6C5CE7', primaryOn: '#FFFFFF', secondary: '#00B894', surface: '#F8F9FA', ink: '#2D3436', muted: '#636E72', success: '#00B894', danger: '#D63031' },
    'every color comes from design.json');
  assert.equal(migrated.font, 'Poppins');
  assert.deepEqual(migrated.radius, { card: 20, button: 12, sheet: 20 });
  assert.equal(migrated.origin, 'design.json');
  assert.equal(brandFromDesignManifest({ spacing: { unit: 8 } }, 'x'), null, 'no palette: nothing to migrate');

  console.log('  [brand] Theme files: everything from brand.json, nothing hard-coded elsewhere...');
  const dart = flutterBrandTheme(brand);
  assert.match(dart, /^\/\/ GENERATED from brand\.json by Atomvs\. Do not edit/);
  assert.match(dart, /static const Color primary = Color\(0xFF1B6E5A\);/);
  assert.match(dart, /static const String\? fontFamily = 'BrandFont';/);
  assert.match(dart, /static const double radiusCard = 18\.0;/);
  assert.match(dart, /static ThemeData theme\(\)/);
  assert.match(dart, /static const String splashMotion = 'The leaf mark unfurls from the stem, then the name fades up';/);
  assert.match(flutterBrandTheme({ ...brand, name: "Mama's $5 Café" }), /name = 'Mama\\'s \\\$5 Café';/, 'Dart string escaping');
  const ts = reactNativeBrandTheme(brand);
  assert.match(ts, /primary: "#1B6E5A"/);
  assert.match(ts, /'BrandFont-Regular': require\('\.\.\/\.\.\/assets\/fonts\/brand-400\.ttf'\)/);
  assert.match(ts, /logo: require\('\.\.\/\.\.\/assets\/brand\/logo\.png'\)/);

  console.log('  [brand] pubspec.yaml: native splash, assets and font wired in, idempotent, comments kept...');
  const pubspec = `name: fernleaf
description: "A new Flutter project."
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: ^3.5.0

dependencies:
  flutter:
    sdk: flutter
  cupertino_icons: ^1.0.8

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^5.0.0

# The following section is specific to Flutter packages.
flutter:
  uses-material-design: true

  # To add assets to your application, add an assets section, like this:
  # assets:
  #   - images/a_dot_burr.jpeg
`;
  const once = pubspecWithBrand(pubspec, brand);
  assert.equal(pubspecWithBrand(once, brand), once, 'idempotent');
  assert.match(once, /dev_dependencies:\n {2}flutter_native_splash: \^2\.4\.6\n {2}flutter_test:/);
  assert.match(once, /\n {2}assets:\n {4}- assets\/brand\/\n/);
  assert.match(once, /\n {2}fonts:\n {4}- family: BrandFont\n {6}fonts:\n {8}- asset: assets\/fonts\/brand-400\.ttf\n {10}weight: 400\n/);
  assert.match(once, /\nflutter_native_splash:\n {2}color: "#1B6E5A"\n {2}image: assets\/brand\/logo\.png\n {2}android_12:/);
  assert.match(once, /# To add assets to your application/, 'comments kept');
  assert.match(once, /cupertino_icons: \^1\.0\.8/);
  const recolored = pubspecWithBrand(once, greener);
  assert.match(recolored, /color: "#2E9E48"/);
  assert.equal((recolored.match(/^flutter_native_splash:/gm) ?? []).length, 1, 'one settings block');
  assert.equal(pubspecWithBrand(pubspec.replace(/\n/g, '\r\n'), brand).includes('\r\n'), true, 'CRLF files stay CRLF');

  console.log('  [brand] The desktop service: files, uniqueness (refused once), migration, warnings...');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'));
  try {
    const stored: StoredBrand[] = [{ projectPath: '/other', projectName: 'Leafy', fingerprint: `v1:${'a'.repeat(64)}`, font: 'Fraunces', hue: hue('#1E7A60'), updatedAt: '2026-11-01' }];
    const saved: string[] = [];
    const store: BrandStore = { recent: (ex) => stored.filter((s) => s.projectPath !== ex), save: (p, s) => saved.push(`${p}|${s.fingerprint}`) };
    // The real fonts bundled with the desktop app.
    const deps = { store, rasterize: async () => Buffer.from('89504e47', 'hex'), fontsDir: BUNDLE };

    const flutterApp = path.join(tmp, 'fernleaf');
    fs.mkdirSync(path.join(flutterApp, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(flutterApp, 'pubspec.yaml'), pubspec);
    const first = await setBrand(flutterApp, GOOD, deps, 0);
    assert.equal(first.status, 'too-similar', 'Fraunces and a teal 160° primary like "Leafy"');
    assert.ok(first.status === 'too-similar' && /too close to "Leafy".*different illustration_style/.test(first.message));
    assert.equal(fs.existsSync(path.join(flutterApp, 'brand.json')), false, 'nothing written');
    const second = await setBrand(flutterApp, GOOD, deps, 1);
    assert.equal(second.status, 'saved', 'the second attempt is saved (regenerate once)');
    if (second.status !== 'saved') throw new Error('not saved');
    assert.deepEqual(second.files.sort(), ['assets/brand/logo.png', 'assets/brand/logo.svg', 'assets/fonts/brand-400.ttf', 'assets/fonts/brand-600.ttf', 'assets/fonts/brand-700.ttf', 'brand.json', 'lib/theme/brand.dart', 'pubspec.yaml'].sort());
    assert.equal((await readBrand(flutterApp))?.fingerprint, fp);
    assert.deepEqual(saved, [`${flutterApp}|${fp}`]);
    const update = await setBrand(flutterApp, { colors: { primary: '#2E9E48' } }, deps, 0);
    assert.equal(update.status, 'saved', 'an update is never refused for similarity');
    if (update.status === 'saved') assert.ok(!update.files.some((f) => f.startsWith('assets/fonts/')), 'same font: not downloaded again');
    assert.match(fs.readFileSync(path.join(flutterApp, 'lib/theme/brand.dart'), 'utf8'), /Color\(0xFF2E9E48\)/);
    assert.deepEqual((await setBrand(flutterApp, { font: 'Wingdings' }, deps, 0)), { status: 'invalid', problems: [`font must be one of: ${CURATED_FONTS.join(', ')}`] });

    const expoApp = path.join(tmp, 'expo-app');
    fs.mkdirSync(expoApp);
    fs.writeFileSync(path.join(expoApp, 'package.json'), '{"name":"x"}');
    fs.writeFileSync(path.join(expoApp, 'app.json'), JSON.stringify({ expo: { name: 'X', splash: { backgroundColor: '#ffffff' } } }));
    const rn = await setBrand(expoApp, { ...GOOD, font: 'Sora', illustration_style: 'isometric' }, deps, 0);
    assert.equal(rn.status, 'saved');
    assert.ok(fs.existsSync(path.join(expoApp, 'src/theme/brand.ts')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(expoApp, 'app.json'), 'utf8')).expo.splash,
      { backgroundColor: '#1B6E5A', image: './assets/brand/logo.png', resizeMode: 'contain' }, 'Expo\'s own native splash');

    const oldApp = path.join(tmp, 'old-app');
    fs.mkdirSync(path.join(oldApp, '.peep'), { recursive: true });
    const designJson = JSON.stringify({ ...manifest, spacing: { unit: 8 } }, null, 2);
    fs.writeFileSync(path.join(oldApp, '.peep', 'design.json'), designJson);
    assert.equal(await migrateBrandFromDesignManifest(oldApp, 'Bloom Fit', manifest, store), true);
    const migratedBrand = JSON.parse(fs.readFileSync(path.join(oldApp, 'brand.json'), 'utf8'));
    assert.equal(migratedBrand.colors.primary, '#6C5CE7');
    assert.equal(migratedBrand.origin, 'design.json');
    assert.equal(fs.readFileSync(path.join(oldApp, '.peep', 'design.json'), 'utf8'), designJson, 'design.json untouched');
    assert.equal(await migrateBrandFromDesignManifest(oldApp, 'Bloom Fit', manifest, store), false, 'only once');
    assert.match(brandContext(await readBrand(oldApp)), /PROJECT BRAND — brand\.json/);

    console.log('  [brand] Fonts come from the bundle (no network); a missing file falls back to the platform font, a failed logo to a plain PNG...');
    const sora = await setBrand(path.join(tmp, 'expo-app'), { font: 'Sora' }, deps, 0);
    assert.equal(sora.status, 'saved');
    assert.deepEqual(fs.readFileSync(path.join(tmp, 'expo-app/assets/fonts/brand-600.ttf')), fs.readFileSync(path.join(BUNDLE, 'sora/600.ttf')),
      'the bundled file, copied as it is');
    const offlineApp = path.join(tmp, 'offline-app');
    fs.mkdirSync(path.join(offlineApp, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(offlineApp, 'pubspec.yaml'), pubspec);
    const emptyBundle = path.join(tmp, 'no-fonts');
    fs.mkdirSync(emptyBundle);
    const failing = { store, fontsDir: emptyBundle, rasterize: async () => { throw new Error('GPU process crashed at https://x.example/?token=SECRET123'); } };
    const offline = await setBrand(offlineApp, { ...GOOD, font: 'Sora', illustration_style: 'isometric' }, failing, 0);
    assert.equal(offline.status, 'saved', 'a missing font file or a failed logo never fails the brand');
    if (offline.status !== 'saved') throw new Error('not saved');
    assert.equal((await readBrand(offlineApp))?.font, 'Sora', 'brand.json keeps the font');
    assert.ok(offline.warnings.some((w) => /The Sora font files are missing from this Atomvs installation \(weight 400, 600, 700\); the app uses the platform's default font for now, and set_brand will try again/.test(w)), offline.warnings.join(' | '));
    assert.ok(offline.warnings.some((w) => /The logo could not be drawn \(GPU process crashed at <url>\); a plain circle in the primary color/.test(w)), offline.warnings.join(' | '));
    assert.ok(!offline.warnings.join(' ').includes('SECRET123'), 'no URLs (or tokens) in the warnings');
    assert.equal(fs.existsSync(path.join(offlineApp, 'assets/fonts/brand-400.ttf')), false);
    const offlinePubspec = fs.readFileSync(path.join(offlineApp, 'pubspec.yaml'), 'utf8');
    assert.doesNotMatch(offlinePubspec, /BrandFont|brand-400\.ttf/, 'no missing font files declared (the build would fail)');
    assert.match(offlinePubspec, /flutter_native_splash:\n {2}color:/, 'the rest of the brand is applied');
    assert.match(fs.readFileSync(path.join(offlineApp, 'lib/theme/brand.dart'), 'utf8'), /static const String\? fontFamily = null;/);
    const fallbackPng = fs.readFileSync(path.join(offlineApp, 'assets/brand/logo.png'));
    assert.equal(fallbackPng.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'logo.png exists and is a PNG');
    // The next run, with the fonts in place: copied and declared.
    const next = await setBrand(offlineApp, { tagline: 'Plants, on time.' }, deps, 0);
    assert.equal(next.status, 'saved');
    if (next.status === 'saved') assert.ok(next.files.includes('assets/fonts/brand-400.ttf'), 'tried again and copied');
    assert.match(fs.readFileSync(path.join(offlineApp, 'pubspec.yaml'), 'utf8'), /- family: BrandFont/);
    assert.match(fs.readFileSync(path.join(offlineApp, 'lib/theme/brand.dart'), 'utf8'), /fontFamily = 'BrandFont';/);
    // One weight missing: none is used (no half font), and the old font's files are removed.
    const partialBundle = path.join(tmp, 'partial');
    fs.mkdirSync(path.join(partialBundle, 'manrope'), { recursive: true });
    for (const w of [400, 700]) fs.copyFileSync(path.join(BUNDLE, 'manrope', `${w}.ttf`), path.join(partialBundle, 'manrope', `${w}.ttf`));
    const switched = await setBrand(offlineApp, { font: 'Manrope' }, { ...deps, fontsDir: partialBundle }, 0);
    assert.equal(switched.status, 'saved');
    assert.ok(switched.status === 'saved' && switched.warnings.some((w) => /\(weight 600\)/.test(w)));
    assert.equal(fs.existsSync(path.join(offlineApp, 'assets/fonts/brand-400.ttf')), false, 'no stale Sora files under the new name');
    assert.doesNotMatch(fs.readFileSync(path.join(offlineApp, 'pubspec.yaml'), 'utf8'), /BrandFont/, 'the family is removed again');
    // React Native with a missing file: no require() of missing font files (Metro would fail).
    const rnOffline = path.join(tmp, 'rn-offline');
    fs.mkdirSync(rnOffline);
    fs.writeFileSync(path.join(rnOffline, 'package.json'), '{"name":"y"}');
    assert.equal((await setBrand(rnOffline, { ...GOOD, font: 'Lexend', illustration_style: 'soft-3d' }, failing, 0)).status, 'saved');
    const rnTheme = fs.readFileSync(path.join(rnOffline, 'src/theme/brand.ts'), 'utf8');
    assert.doesNotMatch(rnTheme, /\.ttf/);
    assert.match(rnTheme, /export const brandFonts: Record<string, number> = \{\};/);
    assert.match(rnTheme, /regular: undefined as string \| undefined/);
    assert.ok(fs.existsSync(path.join(rnOffline, 'assets/brand/logo.png')), 'require(logo.png) still works');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('  [brand] The fallback logo PNG: a valid 1024 RGBA image, primary circle, transparent corners...');
  const png = fallbackLogoPng('#1B6E5A');
  assert.equal(png.readUInt32BE(16), 1024, 'width');
  assert.equal(png.readUInt32BE(20), 1024, 'height');
  assert.equal(png[25], 6, 'RGBA');
  const idatLen = png.readUInt32BE(33);
  const pixels = inflateSync(png.subarray(41, 41 + idatLen));
  const px = (x: number, y: number) => { const i = y * (1024 * 4 + 1) + 1 + x * 4; return [...pixels.subarray(i, i + 4)]; };
  assert.deepEqual(px(512, 512), [0x1b, 0x6e, 0x5a, 255], 'centre: the primary color');
  assert.equal(px(4, 4)[3], 0, 'corner: transparent');
  assert.match(hardcodedStyleWarning('lib/screens/home.dart', 'color: Color(0xFF123456)')!, /hard-codes colors or fonts/);
  assert.match(hardcodedStyleWarning('lib/screens/home.dart', "style: TextStyle(fontFamily: 'Roboto')")!, /Theme\.of\(context\)/);
  assert.match(hardcodedStyleWarning('src/screens/Home.tsx', "backgroundColor: '#ff0000'")!, /brand\.colors/);
  assert.equal(hardcodedStyleWarning('lib/screens/home.dart', 'color: Theme.of(context).colorScheme.primary, Colors.transparent'), null);
  assert.equal(hardcodedStyleWarning('lib/theme/brand.dart', 'Color(0xFF123456)'), null, 'the theme itself');
  // Reading the font from the theme is right, not a hard-coded font (a false warning found in the real Expo check).
  assert.equal(hardcodedStyleWarning('src/App.tsx', 'title: { fontFamily: brand.font.bold, color: brand.colors.ink }'), null);
  assert.equal(hardcodedStyleWarning('lib/screens/home.dart', 'TextStyle(fontFamily: Brand.fontFamily)'), null);
  assert.match(hardcodedStyleWarning('src/App.tsx', 'title: { fontFamily: "Roboto" }')!, /hard-codes/);

  console.log('  [brand] The font bundle: every curated family has its 3 weights and OFL.txt; packaged with the app...');
  const manifestJson = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifestJson).sort(), [...CURATED_FONTS].sort(), 'the manifest lists exactly the curated fonts');
  const folders = fs.readdirSync(BUNDLE, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(folders, CURATED_FONTS.map(fontSlug).sort(), 'one folder per curated font, no extra ones');
  for (const family of CURATED_FONTS) {
    const dir = path.join(BUNDLE, fontSlug(family));
    assert.equal(manifestJson[family].dir, fontSlug(family), `${family}: manifest folder`);
    assert.equal(manifestJson[family].license, 'OFL-1.1', `${family}: OFL`);
    const ofl = fs.readFileSync(path.join(dir, 'OFL.txt'), 'utf8');
    assert.match(ofl, /SIL OPEN FONT LICENSE/i, `${family}: OFL.txt is the license`);
    for (const w of [400, 600, 700]) {
      const ttf = fs.readFileSync(path.join(dir, `${w}.ttf`));
      assert.ok(ttf.length > 10_000, `${family} ${w}: a real font file`);
      assert.ok(['00010000', '4f54544f', '74727565'].includes(ttf.subarray(0, 4).toString('hex')), `${family} ${w}: TrueType/OpenType`);
    }
  }
  assert.equal(manifestJson.Tajawal.weights['600'], 700, 'Tajawal has no 600: its 700 is used, and recorded');
  const builder = fs.readFileSync(path.join(root, 'apps/desktop/electron-builder.yml'), 'utf8');
  assert.match(builder, /extraResources:\n {2}- from: resources\/brand-fonts\n {4}to: brand-fonts/, 'in the installer, next to app.asar');
  const assets = fs.readFileSync(path.join(root, 'apps/desktop/src/main/services/brand-assets.ts'), 'utf8');
  assert.match(assets, /app\.isPackaged \? join\(process\.resourcesPath, 'brand-fonts'\) : join\(app\.getAppPath\(\), 'resources', 'brand-fonts'\)/);
  const service = fs.readFileSync(path.join(root, 'apps/desktop/src/main/services/brand-service.ts'), 'utf8');
  for (const code of [assets, service]) assert.doesNotMatch(code, /fetch\(|googleapis|gstatic/, 'no network for fonts');
  const script = fs.readFileSync(path.join(root, 'scripts/fetch-brand-fonts.mjs'), 'utf8');
  assert.match(script, /export const CURATED_FONTS = \\\[/, 'the script reads the list from brand.ts');

  console.log('  [brand] The agent: brand first, theme only, launch flow, changes through set_brand...');
  const tool = OPENAI_TOOLS.find((t) => t.function.name === 'set_brand');
  assert.ok(tool, 'set_brand tool');
  assert.deepEqual((tool!.function.parameters as any).properties.font.enum, [...CURATED_FONTS]);
  assert.match(FLUTTER_SYSTEM_PROMPT, /\*\*BRAND FIRST\*\*: .*call \\?`?set_brand\\?`? FIRST/);
  assert.match(FLUTTER_SYSTEM_PROMPT, /Never draw a fake phone home screen, app icon grid or OS launcher/);
  assert.match(FLUTTER_SYSTEM_PROMPT, /Never hard-code a color \(Color\(0x…\), Colors\.\*, '#…'\), a fontFamily or a radius in a screen/);
  assert.match(FLUTTER_SYSTEM_PROMPT, /call \\?`?set_brand\\?`? with only the fields that change: the theme is rebuilt and every screen follows/);
  assert.match(SCAFFOLD_SYSTEM_ADDENDUM, /Screen files are refused until the app has its brand/);
  // Both permission layers (one decision since #17): exactly this command, nothing broader.
  const terminal = new TerminalService();
  assert.equal(classifyCommand('dart run flutter_native_splash:create').level, 'safe');
  assert.equal(terminal.isCommandAllowed('dart run flutter_native_splash:create'), true, 'the terminal layer allows it too');
  for (const other of ['dart run something_else', 'dart run flutter_native_splash:create --path=../x', 'dart run flutter_native_splash:remove',
    'dart run flutter_native_splash', 'dart run', 'dart run flutter_native_splash:create && del x', 'dart run flutter_native_splash:create; rm -rf .']) {
    assert.notEqual(classifyCommand(other).level, 'safe', `agent layer: ${other}`);
    assert.equal(terminal.isCommandAllowed(other), false, `terminal layer: ${other}`);
  }
  const agentService = fs.readFileSync(path.join(root, 'apps/desktop/src/main/services/agent-service.ts'), 'utf8');
  assert.match(agentService, /if \(options\.scaffoldMode && isScreenCode && !\(await readBrand\(projectPath\)\)\) \{\s*return 'Not written: this is a new app and it has no brand yet/);
  assert.match(agentService, /if \(incoming\.colors\) \{ delete incoming\.colors; brandOwned\.push\('colors'\); \}/, 'design.json no longer gets colors');
  assert.match(agentService, /migrateBrandFromDesignManifest\(projectPath, name, designManifest, this\.brandDeps\.store\)/);

  console.log('  🟢 Brand identity tests passed.');
}
