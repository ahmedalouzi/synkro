// Dev tool (not part of the app build): serves the renderer's frame lab and its test fixtures in a normal browser,
// without Electron: `pnpm --filter @peep/desktop frame-lab`, then http://127.0.0.1:5199/frame-lab.html
// (fixtures: /frame-lab-fixtures/…). Used by packages/agent/tests/preview-tab-bar.test.ts.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: { alias: { '@renderer': resolve(__dirname, 'src/renderer/src') } },
  plugins: [react()],
  server: { port: Number(process.env.FRAME_LAB_PORT) || 5199, strictPort: true, host: '127.0.0.1' },
});
