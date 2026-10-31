import assert from 'node:assert/strict';
import { fetchProductionSecrets } from '../../../apps/server/src/secrets';

/** The server reads its secrets from env vars unless SYNKRO_SECRETS_SOURCE=aws, also in production: no AWS call, no error log. */
export default async function run() {
  const saved = { NODE_ENV: process.env.NODE_ENV, SOURCE: process.env.SYNKRO_SECRETS_SOURCE, KEY: process.env.GOOGLE_API_KEY };
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.SYNKRO_SECRETS_SOURCE;
    process.env.GOOGLE_API_KEY = 'test-google-key';

    const secrets = await fetchProductionSecrets();
    assert.equal(secrets.GOOGLE_API_KEY, 'test-google-key', 'secrets come from env vars');
    assert.deepEqual(errors, [], 'no AWS error is logged');
  } finally {
    console.error = originalError;
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('NODE_ENV', saved.NODE_ENV);
    restore('SYNKRO_SECRETS_SOURCE', saved.SOURCE);
    restore('GOOGLE_API_KEY', saved.KEY);
  }
}
