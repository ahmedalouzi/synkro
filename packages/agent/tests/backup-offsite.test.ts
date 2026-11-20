import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Off-site database backups (scripts/synkro-backup-offsite.sh + the restore test). The earlier script encrypted with
 * SYNKRO_SIGNING_ENC_KEY as a fallback password (on the command line), uploaded unencrypted when no key was set,
 * wrote the plaintext dump to disk first, and deleted old backups with the server's key. Now: age with a public key,
 * plaintext only in a pipe, a write-only upload key passed on stdin, retention by the bucket.
 *
 * Static checks always; with SYNKRO_RUN_BACKUP_TESTS=1 (Docker): the full run against Postgres, an S3 server with a
 * write-only identity and a real age key pair, then the restore test (fixtures/backup/e2e.sh).
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

export default async function run() {
  console.log('  [backup] The backup script: age public key only, never unencrypted, never the signing key...');
  const script = read('scripts/synkro-backup-offsite.sh');
  const code = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /SYNKRO_SIGNING_ENC_KEY|BACKUP_ENCRYPTION_KEY/, 'the signing key is never used (only mentioned in comments)');
  assert.doesNotMatch(code, /openssl|\s-k\s/, 'no symmetric password on a command line');
  assert.match(code, /pg_dump --format=custom --no-owner --no-privileges "\$DATABASE_URL" \| age -r "\$AGE_RECIPIENT" -o "\$PARTIAL"/, 'plaintext only in the pipe');
  assert.match(code, /age1\*\) ;;\s*\*\) fail "BACKUP_AGE_RECIPIENT is not an age public key \(age1\.\.\.\): refusing to make an unencrypted backup"/);
  assert.match(code, /printf 'user = "%s:%s"\\n' "\$S3_KEY_ID" "\$S3_SECRET" \| curl [^\n]*-K -/, 'the key on stdin, not the command line');
  assert.match(code, /--aws-sigv4 "aws:amz:\$\{S3_REGION\}:s3"/);
  assert.doesNotMatch(code, /-X DELETE|list-type|aws s3 (ls|rm)/, 'never lists or deletes remotely (retention is the bucket\'s)');
  assert.match(code, /https:\/\/\*\) ;;/, 'HTTPS only (plain HTTP only with the test switch)');
  assert.doesNotMatch(code, /^\s*(\.|source)\s+"\$/m, 'the .env files are read, never run as shell code');
  assert.match(script, /^set -euo pipefail$/m);

  console.log('  [backup] systemd: daily, as synkro, low priority, settings outside the repo...');
  const service = read('infra/systemd/synkro-backup.service');
  assert.match(service, /^User=synkro$/m);
  assert.match(service, /^Environment=BACKUP_ENV_FILE=\/etc\/synkro\/backup\.env$/m);
  assert.match(service, /^ExecStart=\/usr\/local\/bin\/synkro-backup-offsite\.sh$/m);
  assert.match(service, /^Nice=10$/m);
  assert.match(service, /^ReadWritePaths=\/var\/backups\/synkro$/m);
  const timer = read('infra/systemd/synkro-backup.timer');
  assert.match(timer, /^OnCalendar=\*-\*-\* 03:00:00 UTC$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(read('.gitattributes'), /^\*\.sh text eol=lf$/m, 'shell scripts stay LF in Windows checkouts');

  console.log('  [backup] The restore test: private key on stdin, temporary database, row counts, dropped...');
  const restore = read('scripts/synkro-backup-restore-test.sh');
  assert.match(restore, /cat > \/dev\/shm\/identity/);
  assert.match(restore, /pg_restore -h 127\.0\.0\.1 --no-owner --no-privileges --exit-on-error -d restore_test \/tmp\/db\.dump/);
  assert.match(restore, /dropdb -h 127\.0\.0\.1 restore_test/);
  assert.match(restore, /docker run --rm -i/);
  const runbook = read('docs/BACKUP_AND_MONITORING_RUNBOOK.md');
  for (const text of ['Write Only', 'Object Lock', 'age-keygen', 'synkro-backup-restore-test.sh', 'So that key must also be in the password manager']) {
    assert.ok(runbook.includes(text), `runbook: ${text}`);
  }

  if (process.env.SYNKRO_RUN_BACKUP_TESTS !== '1') {
    console.log('  (skipped the Docker end-to-end run: set SYNKRO_RUN_BACKUP_TESTS=1)');
    console.log('  🟢 Backup tests passed.');
    return;
  }
  console.log('  [backup] End to end: Postgres -> backup -> S3 (write-only) -> restore test...');
  const e2e = spawnSync('bash', [path.join(root, 'packages/agent/tests/fixtures/backup/e2e.sh')], { encoding: 'utf8', timeout: 900_000 });
  const out = `${e2e.stdout}\n${e2e.stderr}`;
  assert.equal(e2e.status, 0, out.split('\n').filter((l) => !/Failed to connect/.test(l)).slice(-40).join('\n'));
  assert.match(out, /E2E OK/);
  assert.match(out, /public\.users +42/);
  console.log('  🟢 Backup tests passed.');
}
