import { promises as fs } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from 'dotenv';
import { randomBytes } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock electron
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
try {
  const electronMock = {
    app: { getPath: () => '/tmp' },
    ipcMain: { handle: () => {} },
    ipcRenderer: { invoke: () => {} }
  };
  require('module').Module._cache[req.resolve('electron')] = { exports: electronMock };
  
  const sentryMock = {
    init: () => {},
    addBreadcrumb: () => {},
    captureException: () => {}
  };
  require('module').Module._cache[req.resolve('@sentry/electron/main')] = { exports: sentryMock };
  
  const logMock = {
    info: () => {},
    warn: () => {},
    error: () => {},
    initialize: () => {},
    transports: { file: {}, console: {} }
  };
  require('module').Module._cache[req.resolve('electron-log/main')] = { exports: logMock };
} catch (e) {
  // ignore
}

config({ path: resolve(__dirname, '../../../.env') });
process.env.NODE_ENV = 'test';
// The build worker signs every build (signing-keys.ts); tests get a throwaway encryption key.
process.env.SYNKRO_SIGNING_ENC_KEY ??= randomBytes(32).toString('base64');

async function main() {
  const files = await fs.readdir(__dirname);
  const testFiles = files.filter((f) => f.endsWith('.test.ts'));

  console.log(`\n🚀 Running Synkro Unit Tests (${testFiles.length} suites)...\n`);

  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/peep_test';
  
  let dbOffline = false;
  try {
    const { initDbSchema } = await import('../src/models/db');
    console.log('  Running database migrations...');
    await initDbSchema();
    console.log('  Database ready.\n');

    // Seed default user for integration tests
    const { AuthService } = await import('../src/models/auth');
    const auth = new AuthService();
    try {
      await auth.signup('user@example.com', 'hash-password-123');
      console.log('  Default test user seeded.\n');
    } catch (e) {
      // Ignored if already registered
    }
  } catch (dbErr: any) {
    dbOffline = true;
    if (process.env.CI === 'true') {
      console.error(`  ❌ FATAL: Database connection failed in CI mode: ${dbErr.message || dbErr}`);
      process.exit(1);
    }
    console.warn(`  ⚠️ Database connection failed: ${dbErr.message || dbErr}. Running tests with database mock/skip fallback.\n`);
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  const dbDependentSuites = [
    'auth.test.ts',
    'backend-gateway.test.ts',
    'budget-guard.test.ts',
    'build-api-isolation.test.ts',
    'build-hardening.test.ts',
    'cancellation.test.ts',
    'failover.test.ts',
    'p312-settings-gateway.test.ts',
    'p313-security-audit.test.ts',
    'p314-e2e-validation.test.ts',
    'p315-auth-production.test.ts',
    'production-gateway.test.ts',
    'server-router.test.ts',
    'signing-keys-db.test.ts',
    'streaming-usage.test.ts',
    'usage.test.ts',
    'worker-cancel.test.ts',
    'worker-crash-recovery.test.ts',
    'worker-rls-identity.test.ts'
  ];

  for (const file of testFiles) {
    if (dbOffline && dbDependentSuites.includes(file)) {
      console.log(`Suite: ${file}`);
      console.warn(`  🟡 Skipped (Database required but offline)\n`);
      skipped++;
      continue;
    }

    console.log(`Suite: ${file}`);
    try {
      const module = await import(pathToFileURL(join(__dirname, file)).href);
      if (typeof module.default === 'function') {
        await module.default();
        console.log(`  🟢 Passed\n`);
        passed++;
      } else {
        console.log(`  ⚠️ Warning: No default export function\n`);
      }
    } catch (error: any) {
      console.error(`  🔴 Failed:`, error);
      failed++;
    }
  }

  console.log(`----------------------------------------`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log(`----------------------------------------\n`);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
