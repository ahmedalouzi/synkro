import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { serializeDesignManifest } from '../src/design/design-retrieval';

const FULL = {
  brandPersonality: 'Calm and precise', visualDirection: 'Soft cards',
  colors: { primary: '#0A84FF', secondary: '#5E5CE6', accent: '#FF9F0A', background: '#FFFFFF', surface: '#F2F2F7', onBackground: '#111111' },
  typography: { scaleBase: 16 },
  iconography: 'Rounded line icons', loadingState: 'Skeletons', emptyState: 'Illustration + action', errorState: 'Inline retry',
  accessibilityRules: '44 pt targets',
};

export default async function runTest() {
  console.log('  [send-crash] A design.json without colors or typography never throws (brand.json owns them)...');
  // Exactly what the brand identity passes: colors removed, the font removed.
  const layoutOnly = { ...FULL, colors: undefined, typography: { ...FULL.typography, fontFamily: undefined } };
  const text = serializeDesignManifest(layoutOnly as any);
  assert.doesNotMatch(text, /Primary Color|undefined/);
  assert.match(text, /- \*\*Brand Personality\*\*: Calm and precise/);
  assert.match(text, /- \*\*Typography Scale Base\*\*: 16dp/);
  assert.equal(serializeDesignManifest({ brandPersonality: 'x' } as any), '### App Design DNA\n- **Brand Personality**: x', 'a hand-written partial file');
  assert.equal(serializeDesignManifest(null), '### App Design DNA');
  // A complete manifest reads as before.
  assert.equal(serializeDesignManifest(FULL as any), `### App Design DNA
- **Brand Personality**: Calm and precise
- **Visual Direction**: Soft cards
- **Primary Color**: #0A84FF
- **Secondary Color**: #5E5CE6
- **Accent Color**: #FF9F0A
- **Background**: #FFFFFF
- **Surface**: #F2F2F7
- **Text Color**: #111111
- **Typography Scale Base**: 16dp
- **Iconography Concept**: Rounded line icons
- **Loading State Strategy**: Skeletons
- **Empty State Strategy**: Illustration + action
- **Error State Strategy**: Inline retry
- **Accessibility Minimum Target**: 44 pt targets`);

  console.log('  [send-crash] A failure while the request is prepared is an error in the chat, never an IPC rejection...');
  // (agent-service is checked by its source: importing it here would load the real Sentry SDK into the test run.)
  const service = fs.readFileSync(path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..'), 'apps/desktop/src/main/services/agent-service.ts'), 'utf8');
  assert.match(service, /async send\(options: AgentSendOptions\): Promise<void> \{\s+try \{\s+await this\.runSend\(options\);\s+\} catch \(err\) \{/,
    'every failure inside send() is caught');
  assert.match(service, /this\.emitStream\(\{ type: 'error', content: `The request could not be prepared: \$\{message\}` \}, options\.threadId\);/, 'shown in the chat');
  assert.match(service, /IPC_EVENTS\.AGENT_PHASE_CHANGED, \{ phase: 'idle', threadId: options\.threadId \}\)/, 'the chat returns to idle');
  assert.match(service, /this\.abortController = null;\s+this\.mainWindow\?\.webContents\.send\(IPC_EVENTS\.AGENT_PHASE_CHANGED/, 'not left "running"');
  assert.equal((service.match(/private async runSend\(options: AgentSendOptions\)/g) ?? []).length, 1);
  console.log('  🟢 Passed');
}
