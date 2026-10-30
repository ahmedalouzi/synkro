import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const workspacePackages = [
  '@peep/shared',
  '@peep/platform-core',
  '@peep/agent',
  '@peep/flutter-adapter',
];

// Production server URL and Sentry DSN, baked into the main process by `electron-vite build`
// (installed builds don't read .env; see src/main/build-config.ts). Set them in the CI
// environment or in apps/desktop/.env.production. Dev runs bake nothing and use .env.
function releaseValues(command: string) {
  if (command !== 'build') return { gatewayUrl: '', sentryDsn: '' };
  const file = resolve(__dirname, '.env.production');
  const fromFile = existsSync(file) ? parse(readFileSync(file)) : {};
  const gatewayUrl = process.env.SYNKRO_GATEWAY_URL || fromFile.SYNKRO_GATEWAY_URL || '';
  const sentryDsn = process.env.SENTRY_DSN || fromFile.SENTRY_DSN || '';
  if (!gatewayUrl) console.warn('[build] SYNKRO_GATEWAY_URL not set: the app will use the default https://api.atomvs.com');
  if (!sentryDsn) console.warn('[build] SENTRY_DSN not set: crash reports are disabled in this build');
  return { gatewayUrl, sentryDsn };
}

export default defineConfig(({ command }) => {
  const release = releaseValues(command);
  return {
    main: {
      define: {
        __SYNKRO_GATEWAY_URL__: JSON.stringify(release.gatewayUrl),
        __SYNKRO_SENTRY_DSN__: JSON.stringify(release.sentryDsn),
      },
      plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
      build: {
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/main/index.ts'),
          },
        },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
      build: {
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/preload/index.ts'),
            inspector: resolve(__dirname, 'src/preload/inspector.ts'),
          },
        },
      },
    },
    renderer: {
      envDir: resolve(__dirname, '.'),
      resolve: {
        alias: {
          '@renderer': resolve(__dirname, 'src/renderer/src'),
        },
      },
      plugins: [react()],
      build: {
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/renderer/index.html'),
          },
        },
      },
    },
  };
});
