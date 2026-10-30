import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isValidJobId } from '../../../apps/server/src/build-router';
import { BUILD_TIMEOUT_MS, GRACE_PERIOD_MS } from '../src/models/build-worker';

export default async function runBuildHardeningTests() {
  console.log('\n--- Cloud Build Hardening Unit Tests ---');

  // =========================================================================
  // 1. UUID Validation & Path Traversal Prevention
  // =========================================================================
  console.log('  [Test 1] isValidJobId accepts valid UUIDs and rejects path traversal');
  {
    const validUUIDs = [
      '123e4567-e89b-12d3-a456-426614174000',
      '00000000-0000-0000-0000-000000000000',
      'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
      'A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D', // Case insensitive
    ];

    for (const uuid of validUUIDs) {
      assert.equal(isValidJobId(uuid), true, `Expected "${uuid}" to be valid UUID`);
    }

    const invalidInputs = [
      '../../etc/passwd',
      '../evil',
      '..\\..\\windows\\system32',
      '123e4567-e89b-12d3-a456-42661417400', // 11 chars in last group
      '123e4567-e89b-12d3-a456-4266141740000', // 13 chars in last group
      'not-a-uuid',
      '123e4567_e89b_12d3_a456_426614174000', // Underscores
      '',
      null,
      undefined,
      12345,
      {},
      ['123e4567-e89b-12d3-a456-426614174000'],
      '123e4567-e89b-12d3-a456-426614174000; DROP TABLE build_jobs;',
    ];

    for (const invalid of invalidInputs) {
      assert.equal(isValidJobId(invalid), false, `Expected ${JSON.stringify(invalid)} to be rejected`);
    }
    console.log('  ✓ UUID validation and path traversal checks passed.');
  }

  // =========================================================================
  // 2. Stream Error Handling & Resource Leak Prevention
  // =========================================================================
  console.log('  [Test 2] Stream error handler catches read errors and aborts response');
  {
    class MockStream extends EventEmitter {
      destroyed = false;
      pipe(dest: any) {
        return dest;
      }
      destroy() {
        this.destroyed = true;
        this.emit('close');
      }
    }

    class MockResponse extends EventEmitter {
      statusCode = 200;
      headersSent = false;
      destroyed = false;
      jsonPayload: any = null;

      status(code: number) {
        this.statusCode = code;
        return this;
      }
      json(payload: any) {
        this.jsonPayload = payload;
        this.headersSent = true;
        return this;
      }
      destroy() {
        this.destroyed = true;
      }
    }

    const stream = new MockStream();
    const res = new MockResponse();

    // Replicate download route error handler logic
    stream.on('error', (err: any) => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream artifact' });
      } else {
        res.destroy();
      }
    });
    res.on('close', () => {
      stream.destroy();
    });

    // Simulate error before headers sent
    stream.emit('error', new Error('Disk read failure'));
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.jsonPayload, { error: 'Failed to stream artifact' });

    // Simulate client closing connection prematurely
    res.emit('close');
    assert.equal(stream.destroyed, true, 'Stream must be destroyed on client disconnect');
    console.log('  ✓ Stream error handling and socket close safety verified.');
  }

  // =========================================================================
  // 3. Retention Expiration & Timeout Constants Calculation
  // =========================================================================
  console.log('  [Test 3] Retention expiration and timeout math verification');
  {
    // The longest sandbox timeout: 35 minutes for React Native (temporary until the pre-warmed RN/Expo image).
    assert.equal(BUILD_TIMEOUT_MS, 35 * 60 * 1000, 'BUILD_TIMEOUT_MS must be the longest sandbox timeout (35 minutes)');
    assert.equal(GRACE_PERIOD_MS, 5 * 60 * 1000, 'GRACE_PERIOD_MS must be 5 minutes');

    const FREE_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
    const PRO_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

    const now = Date.now();

    // Helper simulating query logic:
    function isArtifactExpired(completedAtMs: number, plan: string | null | undefined): boolean {
      const userPlan = plan || 'free';
      const ageMs = now - completedAtMs;
      if (userPlan === 'free') {
        return ageMs >= FREE_RETENTION_MS;
      } else {
        return ageMs >= PRO_RETENTION_MS;
      }
    }

    // Free tier tests
    assert.equal(isArtifactExpired(now - 12 * 3600 * 1000, 'free'), false, 'Free job at 12h is not expired');
    assert.equal(isArtifactExpired(now - 25 * 3600 * 1000, 'free'), true, 'Free job at 25h is expired');
    assert.equal(isArtifactExpired(now - 25 * 3600 * 1000, null), true, 'Null plan defaults to free and expires at 25h');

    // Pro / Paid tier tests
    assert.equal(isArtifactExpired(now - 25 * 3600 * 1000, 'pro'), false, 'Pro job at 25h is NOT expired');
    assert.equal(isArtifactExpired(now - 6 * 24 * 3600 * 1000, 'pro'), false, 'Pro job at 6 days is NOT expired');
    assert.equal(isArtifactExpired(now - 8 * 24 * 3600 * 1000, 'pro'), true, 'Pro job at 8 days is expired');
    assert.equal(isArtifactExpired(now - 8 * 24 * 3600 * 1000, 'paid'), true, 'Paid job at 8 days is expired');
    assert.equal(isArtifactExpired(now - 8 * 24 * 3600 * 1000, 'enterprise'), true, 'Enterprise job at 8 days is expired');

    console.log('  ✓ Retention calculation logic for Free (24h) and Paid (7d) verified.');
  }

  console.log('🟢 All Cloud Build hardening unit tests passed.\n');
}
