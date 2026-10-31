import assert from 'node:assert/strict';
import { selectContainersToReap, BUILD_TIMEOUT_MS, GRACE_PERIOD_MS } from '../src/models/build-worker.js';

/** The reaper must never remove the container of a job that is still running or having its APK copied out. */
export default async function run() {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms);
  const minute = 60 * 1000;
  const maxAge = BUILD_TIMEOUT_MS + GRACE_PERIOD_MS;
  const job = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
  const name = (id: string) => `build_sandbox_${id}`;

  const statuses = new Map<string, string>();
  const containers: { name: string; createdAt: Date; running: boolean }[] = [];
  const add = (n: number, status: string | null, running: boolean, age: number) => {
    if (status) statuses.set(job(n), status);
    containers.push({ name: name(job(n)), createdAt: ago(age), running });
  };

  // Stopped containers.
  add(1, 'running', false, maxAge - minute); // build finished, APK being copied out: keep
  add(2, 'queued', false, 1 * minute);     // keep
  add(3, 'success', false, 2 * minute);    // remove
  add(4, 'failed', false, 2 * minute);     // remove
  add(5, 'cancelled', false, 2 * minute);  // remove
  add(6, null, false, 5 * minute);         // unknown job, young: keep
  add(7, 'running', false, maxAge + minute); // worker crashed: remove

  // Running containers: only a cancelled job or an orphan is removed.
  add(8, 'running', true, 30 * minute);    // keep
  add(9, 'success', true, 2 * minute);     // keep (should not happen, but never kill a live build for it)
  add(0, 'failed', true, 2 * minute);      // keep
  containers.push({ name: name('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), createdAt: ago(3 * minute), running: true });
  statuses.set('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cancelled'); // remove
  containers.push({ name: name('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), createdAt: ago(maxAge + minute), running: true });
  statuses.set('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'running'); // hung past the timeout: remove

  // Not jobs (the Linux e2e tests): only removed by age.
  containers.push({ name: 'build_sandbox_expo-e2e-1a2b3c4d', createdAt: ago(10 * minute), running: true });
  containers.push({ name: 'build_sandbox_adv-net-old', createdAt: ago(maxAge + minute), running: false });

  assert.deepEqual(selectContainersToReap(containers, statuses, now).sort(), [
    name(job(3)),
    name(job(4)),
    name(job(5)),
    name(job(7)),
    name('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    name('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    'build_sandbox_adv-net-old',
  ].sort());

  // Right at the limit a running build is still kept; one millisecond past it, it is an orphan.
  const live = (age: number) => [{ name: name(job(8)), createdAt: ago(age), running: true }];
  assert.deepEqual(selectContainersToReap(live(maxAge), statuses, now), []);
  assert.deepEqual(selectContainersToReap(live(maxAge + 1), statuses, now), [name(job(8))]);
}
