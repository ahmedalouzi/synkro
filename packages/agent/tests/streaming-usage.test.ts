import assert from 'node:assert';
import { db } from '../src/models/db';
import { BackendAIGateway } from '../src/models/backend-gateway';
import { ServerUsageStore } from '../src/models/usage-store';
import { randomUUID } from 'node:crypto';

export default async function runTests() {
  console.log('  Running Streaming Usage unit tests...');

  // Create Gateway
  const gateway = new BackendAIGateway();
  
  // Mock the usage policy and auth
  gateway.budgetGuard.checkUsage = async () => ({ action: 'allow' });
  const testUserId = randomUUID();
  const testEmail = `test-${testUserId}@example.com`;
  gateway.authService.validateSession = async () => ({ userId: testUserId, email: testEmail });

  // Insert a test user
  await db.query(
    `INSERT INTO users (id, email, password_hash, plan) VALUES ($1, $2, 'hash', 'pro') ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, plan = 'pro'`,
    [testUserId, testEmail]
  );

  const reqId = 'req-' + randomUUID();
  const reqId2 = 'req-' + randomUUID();
  const reqId3 = 'req-' + randomUUID();
  const reqId4 = 'req-' + randomUUID();
  const reqId5 = 'req-' + randomUUID();

  console.log('  [Test 1] Stream usage accumulation via wrapped iterator');
  {
    // Mock the adapter stream
    const dummyAdapter = {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'content', delta: 'hello' };
          yield { type: 'done', usage: { inputTokens: 55, outputTokens: 10, totalTokens: 65 } };
        }
      }),
      generate: async () => ({ content: 'test', usage: {} })
    };
    (gateway as any).adapters.set('openai', dummyAdapter);
    (gateway as any).router.route = () => ({ providerId: 'openai', modelId: 'test-model', costInputPerMillion: 1, costOutputPerMillion: 2 });

    const res = await gateway.handleRequest('POST', '/v1/ai/stream', {
      'authorization': 'Bearer token',
      'x-request-id': reqId
    }, { tier: 'fast', messages: [{ role: 'user', content: 'hello' }] });

    const stream = res.body as AsyncIterable<any>;
    for await (const chunk of stream) {
      // Consume stream
    }

    // Wait briefly for the finally block to execute its async DB insert
    await new Promise(r => setTimeout(r, 50));

    const dbRes = await db.query('SELECT * FROM usage_records WHERE request_id = $1', [reqId]);
    assert.strictEqual(dbRes.rows.length, 1);
    const record = dbRes.rows[0];
    assert.strictEqual(record.input_tokens, 55);
    assert.strictEqual(record.output_tokens, 10);
    assert.strictEqual(record.total_tokens, 65);
    assert.strictEqual(record.status, 'success');
    // Cost comes from the real token counts: (55 × $1 + 10 × $2) per million.
    assert.strictEqual(Number(record.estimated_cost), 0.000075);
  }

  console.log('  [Test 2] ON CONFLICT DO NOTHING dedup verified');
  {
    // Try to record usage again with same request_id
    await gateway.usageStore.recordUsage({
      userId: testUserId,
      requestId: reqId,
      modelTier: 'fast',
      resolvedModel: 'test-model',
      inputTokens: 999,
      outputTokens: 999,
      totalTokens: 1998,
      estimatedCost: 0.1,
      status: 'success'
    });

    const dbRes = await db.query('SELECT * FROM usage_records WHERE request_id = $1', [reqId]);
    assert.strictEqual(dbRes.rows.length, 1, 'Duplicate request_id should be ignored');
    assert.strictEqual(dbRes.rows[0].input_tokens, 55, 'Original values should be preserved');
  }

  console.log('  [Test 3] Estimated-fallback path when done.usage is absent');
  {
    const dummyAdapter = {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'content', delta: 'hello' };
          yield { type: 'done' }; // No usage provided
        }
      }),
      generate: async () => ({ content: 'test', usage: {} })
    };
    (gateway as any).adapters.set('openai', dummyAdapter);
    
    // Pass a 20-character message (5 tokens expected fallback)
    const res = await gateway.handleRequest('POST', '/v1/ai/stream', {
      'authorization': 'Bearer token',
      'x-request-id': reqId2
    }, { tier: 'fast', messages: [{ role: 'user', content: '12345678901234567890' }] });

    const stream = res.body as AsyncIterable<any>;
    for await (const chunk of stream) { }
    await new Promise(r => setTimeout(r, 50));

    const dbRes = await db.query('SELECT * FROM usage_records WHERE request_id = $1', [reqId2]);
    assert.strictEqual(dbRes.rows.length, 1);
    const record = dbRes.rows[0];
    
    // Stream yielded { type: 'content', delta: 'hello' } — 5 chars.
    // Accumulator reads chunk.content ?? chunk.delta, so 'hello' = 5 chars → Math.ceil(5/4) = 2.
    assert.strictEqual(record.output_tokens, 2, 'Fallback output_tokens should be Math.ceil(5/4)=2');
    assert.strictEqual(record.input_tokens > 0, true, 'Fallback input tokens should be calculated');
  }

  console.log('  [Test 4] Mid-stream abort logs correctly');
  {
    const dummyAdapter = {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'content', delta: 'hello' };
          const err = new Error('AbortError');
          err.name = 'AbortError';
          throw err;
        }
      }),
      generate: async () => ({ content: 'test', usage: {} })
    };
    (gateway as any).adapters.set('openai', dummyAdapter);

    const res = await gateway.handleRequest('POST', '/v1/ai/stream', {
      'authorization': 'Bearer token',
      'x-request-id': reqId3
    }, { tier: 'fast', messages: [{ role: 'user', content: 'test' }] });

    const stream = res.body as AsyncIterable<any>;
    try {
      for await (const chunk of stream) {}
    } catch (e) {
      // Expected AbortError
    }
    await new Promise(r => setTimeout(r, 50));

    const dbRes = await db.query('SELECT * FROM usage_records WHERE request_id = $1', [reqId3]);
    assert.strictEqual(dbRes.rows.length, 1);
    assert.strictEqual(dbRes.rows[0].status, 'cancelled', 'Status should be cancelled on AbortError');
  }

  console.log('  [Test 5] Zero chunks received before abort — fallback estimate computes cleanly');
  {
    let loggedErrors: string[] = [];
    // Override logger to capture error calls
    (gateway as any).logger = {
      info: () => {},
      warn: () => {},
      error: (msg: string) => loggedErrors.push(msg),
    };

    const dummyAdapter = {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          // Throw immediately — no chunks yielded at all
          const err = new Error('AbortError');
          err.name = 'AbortError';
          throw err;
        }
      }),
      generate: async () => ({ content: 'test', usage: {} })
    };
    (gateway as any).adapters.set('openai', dummyAdapter);

    const res = await gateway.handleRequest('POST', '/v1/ai/stream', {
      'authorization': 'Bearer token',
      'x-request-id': reqId4
    }, { tier: 'fast', messages: [{ role: 'user', content: 'hi' }] });

    const stream = res.body as AsyncIterable<any>;
    try {
      for await (const chunk of stream) {}
    } catch (e) {
      // Expected AbortError
    }
    await new Promise(r => setTimeout(r, 50));

    // No unhandled errors should have been logged
    assert.strictEqual(loggedErrors.length, 0, `No logger.error should fire for clean abort, got: ${loggedErrors}`);

    // DB row should exist with estimated fallback tokens (not null/undefined/NaN)
    const dbRes = await db.query('SELECT * FROM usage_records WHERE request_id = $1', [reqId4]);
    assert.strictEqual(dbRes.rows.length, 1, 'Usage record should be written even with zero chunks');
    const record = dbRes.rows[0];
    assert.strictEqual(typeof record.input_tokens, 'number', 'input_tokens should be a number');
    assert.strictEqual(Number.isNaN(record.input_tokens), false, 'input_tokens should not be NaN');
    assert.ok(record.input_tokens >= 0, 'input_tokens should be non-negative');
    assert.strictEqual(record.output_tokens, 1, 'Zero-chunk abort: fallbackOutputTokens should be 1 (floor for zero chars)');
    assert.strictEqual(record.status, 'cancelled', 'Status should be cancelled');
  }

  console.log('  [Test 6] Partial-stream abort — output token estimate scales with received content');
  {
    // 400-char delta chunks × 3 = 1200 chars → Math.ceil(1200/4) = 300 output tokens
    const DELTA_CHARS = 400;
    const DELTA_COUNT = 3;
    const expectedOutputTokens = Math.ceil((DELTA_CHARS * DELTA_COUNT) / 4); // = 300

    const dummyAdapter = {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < DELTA_COUNT; i++) {
            yield { type: 'delta', content: 'A'.repeat(DELTA_CHARS) };
          }
          // Abort after DELTA_COUNT chunks — no done chunk, no usage
          const err = new Error('AbortError');
          err.name = 'AbortError';
          throw err;
        }
      }),
      generate: async () => ({ content: 'test', usage: {} })
    };
    (gateway as any).adapters.set('openai', dummyAdapter);

    const res = await gateway.handleRequest('POST', '/v1/ai/stream', {
      'authorization': 'Bearer token',
      'x-request-id': reqId5
    }, { tier: 'fast', messages: [{ role: 'user', content: 'test' }] });

    const stream = res.body as AsyncIterable<any>;
    try {
      for await (const chunk of stream) {}
    } catch (e) {
      // Expected AbortError
    }
    await new Promise(r => setTimeout(r, 50));

    const dbRes = await db.query('SELECT * FROM usage_records WHERE request_id = $1', [reqId5]);
    assert.strictEqual(dbRes.rows.length, 1, 'Usage record should be written for partial-stream abort');
    const record = dbRes.rows[0];
    assert.strictEqual(record.output_tokens, expectedOutputTokens,
      `output_tokens should be ${expectedOutputTokens} (Math.ceil(${DELTA_CHARS * DELTA_COUNT} / 4)), got ${record.output_tokens}`);
    assert.notStrictEqual(record.output_tokens, 50, 'output_tokens must NOT be the old hardcoded 50 sentinel');
    assert.strictEqual(record.status, 'cancelled', 'Status should be cancelled');
  }

  console.log('  🟢 Passed');
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTests().catch(console.error);
}
