#!/usr/bin/env node
// Dev-time tool (not run by users): downloads / refreshes the brand fonts bundled with the desktop app.
//
//   node scripts/fetch-brand-fonts.mjs            all families in CURATED_FONTS
//   node scripts/fetch-brand-fonts.mjs "Inter"    only these families
//
// For each family in CURATED_FONTS (read from packages/agent/src/brand/brand.ts, so the list and the bundle cannot
// drift), it writes apps/desktop/resources/brand-fonts/<slug>/{400,600,700}.ttf and OFL.txt:
// - the TTFs are Google Fonts' static instances of the family (the official css2 API, plain TTF), one per weight;
//   a family without a weight gets the nearest one it has (recorded in manifest.json);
// - OFL.txt is the family's license from Google's official repository (github.com/google/fonts, ofl/<name>/).
// manifest.json lists every family, its folder, the weight actually used for each file, and where it came from.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'apps/desktop/resources/brand-fonts');
const WEIGHTS = [400, 600, 700];

const source = await readFile(join(ROOT, 'packages/agent/src/brand/brand.ts'), 'utf8');
const list = /export const CURATED_FONTS = \[([\s\S]*?)\] as const;/.exec(source);
if (!list) throw new Error('CURATED_FONTS not found in brand.ts');
const families = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const only = process.argv.slice(2);

/** Folder name of a family: "Plus Jakarta Sans" -> "plus-jakarta-sans" (also used by the app; keep in sync). */
const slug = (family) => family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function ttfFor(family, weight) {
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weight}`;
  // A plain user agent gets plain TTF (not WOFF2).
  const css = await fetch(url, { headers: { 'User-Agent': 'Mozilla/4.0' } });
  if (!css.ok) return null;
  const src = /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+\.ttf)\)/.exec(await css.text())?.[1];
  if (!src) return null;
  const res = await fetch(src);
  if (!res.ok) throw new Error(`${family} ${weight}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (!['00010000', '4f54544f', '74727565'].includes(data.subarray(0, 4).toString('hex'))) throw new Error(`${family} ${weight}: not a TTF`);
  return data;
}

async function license(family) {
  const dir = family.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const kind of ['ofl', 'apache', 'ufl']) {
    const file = kind === 'ofl' ? 'OFL.txt' : 'LICENSE.txt';
    const res = await fetch(`https://raw.githubusercontent.com/google/fonts/main/${kind}/${dir}/${file}`);
    if (res.ok) return { kind, text: await res.text(), url: `https://github.com/google/fonts/tree/main/${kind}/${dir}` };
  }
  throw new Error(`${family}: no license file found in google/fonts`);
}

const manifestPath = join(OUT, 'manifest.json');
let manifest = {};
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { /* first run */ }

for (const family of families) {
  if (only.length && !only.includes(family)) continue;
  const dir = join(OUT, slug(family));
  await mkdir(dir, { recursive: true });
  const weights = {};
  for (const weight of WEIGHTS) {
    // The weight itself, else the nearest the family has (e.g. Tajawal has no 600).
    const tries = [weight, ...[100, 200, 300, 400, 500, 600, 700, 800, 900].sort((a, b) => Math.abs(a - weight) - Math.abs(b - weight) || b - a)]
      .filter((w, i, a) => a.indexOf(w) === i);
    let used = null;
    for (const w of tries) {
      const data = await ttfFor(family, w);
      if (data) { await writeFile(join(dir, `${weight}.ttf`), data); used = w; break; }
    }
    if (used === null) throw new Error(`${family}: no weight available`);
    weights[weight] = used;
    if (used !== weight) console.log(`  ${family}: ${weight} -> uses ${used} (the family has no ${weight})`);
  }
  const lic = await license(family);
  if (lic.kind !== 'ofl') throw new Error(`${family} is ${lic.kind}, expected OFL`);
  await writeFile(join(dir, 'OFL.txt'), lic.text);
  manifest[family] = { dir: slug(family), weights, license: 'OFL-1.1', source: lic.url, fetched: new Date().toISOString().slice(0, 10) };
  console.log(`${family}: ok`);
}

const sorted = Object.fromEntries(families.filter((f) => manifest[f]).map((f) => [f, manifest[f]]));
await writeFile(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`\n${Object.keys(sorted).length} families in ${OUT}`);
