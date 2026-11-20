import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DesignManifest } from './design-types';

export async function loadDesignManifest(projectRoot: string): Promise<DesignManifest | null> {
  try {
    const filePath = join(projectRoot, '.peep', 'design.json');
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as DesignManifest;
  } catch {
    return null;
  }
}

export async function saveDesignManifest(projectRoot: string, manifest: DesignManifest): Promise<void> {
  const dirPath = join(projectRoot, '.peep');
  await mkdir(dirPath, { recursive: true });
  const filePath = join(dirPath, 'design.json');
  await writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * The manifest for the agent's context. Every field is optional here: a design.json written by hand, by an older
 * version, or without colors (brand.json owns them since the brand identity) must never throw, since this runs
 * before the agent's request is sent. Missing fields are left out.
 */
export function serializeDesignManifest(manifest: Partial<DesignManifest> | null | undefined): string {
  const m = (manifest ?? {}) as Partial<DesignManifest>;
  const colors = (m.colors ?? {}) as Partial<DesignManifest['colors']>;
  const typography = (m.typography ?? {}) as Partial<DesignManifest['typography']>;
  const line = (label: string, value: unknown, unit = '') =>
    value === undefined || value === null || value === '' ? null : `- **${label}**: ${String(value)}${unit}`;
  return ['### App Design DNA',
    line('Brand Personality', m.brandPersonality),
    line('Visual Direction', m.visualDirection),
    line('Primary Color', colors.primary),
    line('Secondary Color', colors.secondary),
    line('Accent Color', colors.accent),
    line('Background', colors.background),
    line('Surface', colors.surface),
    line('Text Color', colors.onBackground),
    line('Typography Scale Base', typography.scaleBase, 'dp'),
    line('Iconography Concept', m.iconography),
    line('Loading State Strategy', m.loadingState),
    line('Empty State Strategy', m.emptyState),
    line('Error State Strategy', m.errorState),
    line('Accessibility Minimum Target', m.accessibilityRules),
  ].filter((l): l is string => l !== null).join('\n');
}
