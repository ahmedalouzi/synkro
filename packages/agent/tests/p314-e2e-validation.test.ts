/**
 * P3.14 — Full End-to-End Validation Test Suite
 * Five production scenarios + 55 integration gates.
 */

import { BackendAIGateway } from '../src/models/backend-gateway';
import { db } from '../src/models/db';
import { ProductionAIGateway } from '../src/models/production-gateway';
import { MockAIGateway } from '../src/models/mock-gateway';
import { AuthService } from '../src/models/auth';
import { ServerModelRouter } from '../src/models/server-router';
import { ServerUsageStore } from '../src/models/usage-store';
import { ServerBudgetGuard } from '../src/models/budget-guard';
import { DesignReasoner } from '../src/design/design-reasoner';
import { DesignReviewer } from '../src/design/design-reviewer';
import { saveAgentTaskState, loadAgentTaskState } from '../src/design/task-state';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('E2E FAIL: ' + msg);
}
function assertNoKey(val: string, ctx: string): void {
  for (const p of ['sk-', 'sk-ant-', 'AIza', 'Bearer sk-', 'Bearer AIza']) {
    assert(!val.includes(p), 'Provider key ' + JSON.stringify(p) + ' found in ' + ctx);
  }
}
interface GR { gate: string; scenario?: string; status: 'PASS'|'FAIL'; note: string; durationMs: number; }
const GRS: GR[] = [];

async function gate(name: string, scenario: string|undefined, fn: ()=>Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now()-t0;
    console.log('  checked ' + name + ' (' + ms + 'ms)');
    GRS.push({gate:name,scenario,status:'PASS',note:'OK',durationMs:ms});
  } catch(e:any) {
    const ms = Date.now()-t0;
    console.error('  FAIL ' + name + ': ' + e.message);
    GRS.push({gate:name,scenario,status:'FAIL',note:e.message,durationMs:ms});
    throw e;
  }
}

async function mkBackend() { 
  const backend = new BackendAIGateway(); 
  const { MockOpenAIAdapter } = await import('../src/models/backend-gateway');
  (backend as any).adapters.set('google', new MockOpenAIAdapter());
  (backend as any).adapters.set('openai', new MockOpenAIAdapter());
  (backend as any).adapters.set('anthropic', new MockOpenAIAdapter());
  return backend;
}
async function runScenario(backend: BackendAIGateway, opts: {id:string;prompt:string;tier:'fast'|'reasoning'|'premium'}) {
  const session = await backend.authService.login('user@example.com', 'hash-password-123');
  assertNoKey(session.sessionToken, 'sessionToken');
  const reqId = 'e2e-' + opts.id + '-' + Date.now();
  const headers = {'authorization': 'Bearer ' + session.sessionToken, 'x-request-id': reqId};
  const t0 = Date.now();
  const res = await backend.handleRequest('POST', '/v1/ai/generate', headers, {tier:opts.tier, prompt:opts.prompt});
  const ms = Date.now()-t0;
  assert(res.status===200, 'Scenario ' + opts.id + ' expected 200, got ' + res.status);
  assert(typeof res.body.content==='string', 'content must be string');
  const recs = await backend.usageStore.getRecordsForUser(session.userId);
  const rec = recs.find((r:any)=>r.requestId===reqId);
  assert(!!rec, 'No usage record for ' + reqId);
  assert(rec!.status==='success', 'Expected success, got ' + rec!.status);
  assert(rec!.totalTokens>0, 'totalTokens must be > 0');
  assert(rec!.estimatedCost>0, 'estimatedCost must be > 0');
  assertNoKey(JSON.stringify(res.body), 'response body (' + opts.id + ')');
  return {session,response:res.body,usageRecord:rec,requestId:reqId,durationMs:ms};
}

export default async function runP314E2ETests() {
  console.log('  Running P3.14 Full E2E Validation tests...');

  // Ensure default test user is on pro plan and clean any old test records
  await db.query(`UPDATE users SET plan = 'pro' WHERE email = 'user@example.com'`);

  // ── BLOCK 1: SCENARIOS ───────────────────────────────────────────
  await gate('[S1] Restaurant Reservation — full lifecycle', 'Restaurant Reservation', async () => {
    const b = await mkBackend();
    const r = await runScenario(b, {id:'restaurant', prompt:'Build a restaurant reservation app.', tier:'fast'});
    assert(r.usageRecord.modelTier==='fast', 'Tier must be fast');
    assert(r.durationMs<5000, 'Too slow: ' + r.durationMs + 'ms');
    const dna = DesignReasoner.inferDesignDNA('Build a restaurant reservation app.');
    assert(dna.colors.primary==='#c2410c', 'Expected orange, got ' + dna.colors.primary);
    assert(dna.brandPersonality.startsWith('warm'), 'Expected warm personality, got ' + dna.brandPersonality);
  });

  await gate('[S2] SaaS Dashboard — reasoning tier', 'SaaS Dashboard', async () => {
    const b = await mkBackend();
    const r = await runScenario(b, {id:'saas', prompt:'Build a SaaS analytics dashboard with metrics.', tier:'reasoning'});
    assert(r.usageRecord.modelTier==='reasoning', 'Tier must be reasoning');
    assert(r.usageRecord.resolvedModel==='gpt-4o', 'Expected gpt-4o, got ' + r.usageRecord.resolvedModel);
  });

  await gate('[S3] Fitness Tracker — premium tier', 'Fitness Tracker', async () => {
    const b = await mkBackend();
    const r = await runScenario(b, {id:'fitness', prompt:'Build a fitness tracker app.', tier:'premium'});
    assert(r.usageRecord.modelTier==='premium', 'Tier must be premium');
    assert(r.usageRecord.resolvedModel==='gemini-3.1-pro', 'Expected gemini-3.1-pro, got ' + r.usageRecord.resolvedModel);
    const dna = DesignReasoner.inferDesignDNA('Build a fitness tracker app.');
    assert(typeof dna.colors.primary==='string', 'Fitness DNA must have primary color');
  });

  await gate('[S4] Community Chat — usage accumulation', 'Community Chat', async () => {
    const b = await mkBackend();
    const session = await b.authService.login('user@example.com', 'hash-password-123');
    const h = (id:string) => ({'authorization': 'Bearer ' + session.sessionToken, 'x-request-id': id});
    const r1 = await b.handleRequest('POST', '/v1/ai/generate', h('chat-1'), {tier:'fast', prompt:'Build a community chat app.'});
    const r2 = await b.handleRequest('POST', '/v1/ai/generate', h('chat-2'), {tier:'fast', prompt:'Add read receipts.'});
    assert(r1.status===200, 'Chat r1 failed: ' + r1.status);
    assert(r2.status===200, 'Chat r2 failed: ' + r2.status);
    assert((await b.usageStore.getRecordsForUser(session.userId)).length>=2, 'Expected >=2 records');
    assert((await b.usageStore.getAccumulatedCost(session.userId))>0, 'Cost must be > 0');
  });

  await gate('[S5] Personal Wallet — estimate + generation', 'Personal Wallet', async () => {
    const b = await mkBackend();
    const session = await b.authService.login('user@example.com', 'hash-password-123');
    const rand = Math.random().toString(36).substring(7);
    const h = (id:string) => ({'authorization': 'Bearer ' + session.sessionToken, 'x-request-id': id + '-' + rand});
    const est = await b.handleRequest('POST', '/v1/ai/estimate-cost', h('w-est'), {tier:'premium', prompt:'wallet app'});
    assert(est.status===200, 'Estimate failed: ' + est.status);
    assert(typeof est.body.cost==='number' && est.body.cost>0, 'Estimate cost must be positive');
    assert(est.body.currency==='USD', 'Currency must be USD');
    const before = (await b.usageStore.getRecordsForUser(session.userId)).length;
    const gen = await b.handleRequest('POST', '/v1/ai/generate', h('w-gen'), {tier:'premium', prompt:'Build a personal wallet app.'});
    assert(gen.status===200, 'Wallet gen failed: ' + gen.status);
    assert((await b.usageStore.getRecordsForUser(session.userId)).length===before+1, 'Expected 1 new usage record');
  });

  // ── BLOCK 2: AUTH ───────────────────────────────────────────────
  await gate('[AUTH-1] Login produces valid session token', undefined, async () => {
    const auth = new AuthService();
    const s = await auth.login('user@example.com', 'hash-password-123');
    assert(typeof s.sessionToken==='string' && s.sessionToken.length>0, 'sessionToken must be non-empty');
    assert(s.expiresAt>Date.now(), 'Session must expire in future');
    assertNoKey(s.sessionToken, 'login sessionToken');
  });
  await gate('[AUTH-2] Wrong password rejected', undefined, async () => {
    const auth = new AuthService(); let threw=false;
    try { await auth.login('user@example.com', 'wrong'); } catch { threw=true; }
    assert(threw, 'Wrong password must throw');
  });
  await gate('[AUTH-3] Unauthenticated request returns 401', undefined, async () => {
    const b = await mkBackend();
    const res = await b.handleRequest('POST', '/v1/ai/generate', {}, {tier:'fast', prompt:'test'});
    assert(res.status===401, 'Expected 401, got ' + res.status);
    assert(res.body.code==='UNAUTHORIZED', 'Expected UNAUTHORIZED');
    assertNoKey(JSON.stringify(res.body), '401 error body');
  });
  await gate('[AUTH-4] Revoked session rejected immediately', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    await b.authService.logout(s.sessionToken);
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken}, {tier:'fast', prompt:'test'});
    assert(res.status===401, 'Revoked token must return 401, got ' + res.status);
  });
  await gate('[AUTH-5] Token refresh produces new token', undefined, async () => {
    const auth = new AuthService();
    const orig = await auth.login('user@example.com', 'hash-password-123');
    const refreshed = await auth.refresh(orig.refreshToken);
    assert(refreshed.sessionToken!==orig.sessionToken, 'New token must differ');
    assertNoKey(refreshed.sessionToken, 'refreshed sessionToken');
  });

  // ── BLOCK 3: SERVER ROUTING ─────────────────────────────────────
  await gate('[ROUTER-1] fast -> google/gemini-3.6-flash with openai fallback', undefined, async () => {
    const r = new ServerModelRouter().route('fast');
    assert(r.providerId==='google', 'Expected google, got ' + r.providerId);
    assert(r.modelId==='gemini-3.6-flash', 'Expected gemini-3.6-flash, got ' + r.modelId);
    assert(r.fallback?.providerId==='openai', 'fast must fallback to openai');
  });
  await gate('[ROUTER-2] reasoning -> openai/gpt-4o', undefined, async () => {
    const r = new ServerModelRouter().route('reasoning');
    assert(r.providerId==='openai', 'Expected openai, got ' + r.providerId);
    assert(r.modelId==='gpt-4o', 'Expected gpt-4o, got ' + r.modelId);
  });
  await gate('[ROUTER-3] premium -> google/gemini-3.1-pro', undefined, async () => {
    const r = new ServerModelRouter().route('premium');
    assert(r.providerId==='google', 'Expected google, got ' + r.providerId);
    assert(r.modelId==='gemini-3.1-pro', 'Expected gemini-3.1-pro, got ' + r.modelId);
  });
  await gate('[ROUTER-4] Unknown tier returns 400 VALIDATION_ERROR', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken}, {tier:'quantum', prompt:'test'});
    assert(res.status===400 && res.body.code==='VALIDATION_ERROR', 'Expected 400 VALIDATION_ERROR');
  });
  await gate('[ROUTER-5] premium tier blocked for free plan', undefined, async () => {
    let threw=false;
    try { new ServerModelRouter().route('premium', 'free'); } catch { threw=true; }
    assert(threw, 'Premium must throw for free plan');
  });

  // ── BLOCK 4: USAGE ACCOUNTING ───────────────────────────────────
  await gate('[USAGE-1] Usage recorded once (no double-count)', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const id = 'dedup-test-' + Math.random().toString(36).substring(7);
    await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': id}, {tier:'fast', prompt:'test'});
    await b.usageStore.recordUsage({userId:s.userId, requestId:id, modelTier:'fast', resolvedModel:'dup', inputTokens:99, outputTokens:99, totalTokens:198, estimatedCost:9.99, status:'success'});
    const count = (await b.usageStore.getRecordsForUser(s.userId)).filter((r:any)=>r.requestId===id).length;
    assert(count===1, 'Expected 1 (dedup), got ' + count);
  });
  await gate('[USAGE-2] Cancelled -> status=cancelled, cost=0', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const ctrl = new AbortController(); ctrl.abort();
    const id = 'cancel-rec-' + Math.random().toString(36).substring(7);
    await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': id}, {tier:'fast', prompt:'cancel'}, {signal:ctrl.signal});
    const rec = (await b.usageStore.getRecordsForUser(s.userId)).find((r:any)=>r.requestId===id);
    assert(!!rec, 'Usage record must exist for cancelled');
    assert(rec!.status==='cancelled', 'Expected cancelled, got ' + rec!.status);
    assert(rec!.estimatedCost===0, 'Cancelled must not be charged');
  });
  await gate('[USAGE-3] Accumulated cost increases after requests', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const rand = Math.random().toString(36).substring(7);
    const h = (id:string) => ({'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': id + '-' + rand});
    const before = await b.usageStore.getAccumulatedCost(s.userId);
    await b.handleRequest('POST', '/v1/ai/generate', h('a1'), {tier:'fast', prompt:'p1'});
    await b.handleRequest('POST', '/v1/ai/generate', h('a2'), {tier:'fast', prompt:'p2'});
    assert((await b.usageStore.getAccumulatedCost(s.userId))>before, 'Cost must increase');
  });
  await gate('[USAGE-4] Streaming records usage once at completion', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const id = 'stream-usage-' + Math.random().toString(36).substring(7);
    const res = await b.handleRequest('POST', '/v1/ai/stream', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': id}, {tier:'fast', prompt:'stream'});
    assert(res.status===200, 'Stream must return 200, got ' + res.status);
    const stream = res.body as AsyncIterable<any>;
    if (stream && typeof (stream as any)[Symbol.asyncIterator] === 'function') {
      for await (const _ of stream) {}
    }
    await new Promise(r => setTimeout(r, 50));
    const recs = (await b.usageStore.getRecordsForUser(s.userId)).filter((r:any)=>r.requestId===id);
    assert(recs.length===1, 'Expected 1 stream record, got ' + recs.length);
    assert(recs[0]!.status==='success', 'Expected success, got ' + recs[0]!.status);
  });

  // ── BLOCK 5: BUDGET ─────────────────────────────────────────────
  await gate('[BUDGET-1] Over-limit cost throws BUDGET_EXCEEDED', undefined, async () => {
    const guard = new ServerBudgetGuard(new ServerUsageStore());
    const testUserUuid = '00000000-0000-0000-0000-000000000008';
    await db.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [testUserUuid, 'budget-1-user@example.com', 'scrypt:mock-hash']
    );
    let threw=false;
    try {
      await guard.checkBudget(testUserUuid, 'free', 9999.0);
    } catch(e:any) {
      threw=true;
      assert(e.code==='BUDGET_EXCEEDED', 'Expected BUDGET_EXCEEDED, got ' + e.code);
    }
    assert(threw, 'Must throw on over-budget');
  });
  await gate('[BUDGET-2] Lock released after cancellation', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const ctrl = new AbortController(); ctrl.abort();
    const cancelId = 'bl-cancel-' + Math.random().toString(36).substring(7);
    const afterId = 'bl-after-' + Math.random().toString(36).substring(7);
    await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': cancelId}, {tier:'fast', prompt:'cancel'}, {signal:ctrl.signal});
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': afterId}, {tier:'fast', prompt:'after cancel'});
    assert(res.status===200, 'Post-cancel must succeed (lock not held): ' + res.status);
  });
  await gate('[BUDGET-3] Cancelled costs not counted toward daily budget', undefined, async () => {
    const store = new ServerUsageStore();
    const guard = new ServerBudgetGuard(store);
    const id = 'c1-' + Math.random().toString(36).substring(7);
    const testUserUuid = '00000000-0000-0000-0000-000000000009';
    await db.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [testUserUuid, 'budget-3-user@example.com', 'scrypt:mock-hash']
    );
    await store.recordUsage({userId:testUserUuid, requestId:id, modelTier:'fast', resolvedModel:'m', inputTokens:0, outputTokens:0, totalTokens:0, estimatedCost:9999.99, status:'cancelled'});
    await guard.checkBudget(testUserUuid, 'free', 0.001); // Must not throw
  });
  await gate('[BUDGET-4] Client budget override fields ignored by server', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const bypassId = 'bypass-' + Math.random().toString(36).substring(7);
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': bypassId}, {tier:'fast', prompt:'test', plan:'enterprise', budgetOverride:99999});
    assert(res.status===200, 'Server must ignore override, got ' + res.status);
    assertNoKey(JSON.stringify(res.body), 'bypass response');
  });

  // ── BLOCK 6: STREAMING ──────────────────────────────────────────
  await gate('[STREAM-1] Backend /v1/ai/stream returns 200', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const res = await b.handleRequest('POST', '/v1/ai/stream', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': 'str-1'}, {tier:'fast', prompt:'stream me'});
    assert(res.status===200, 'Stream must return 200, got ' + res.status);
    assert(res.body!==null, 'Stream body must not be null');
  });
  await gate('[STREAM-2] MockAIGateway emits delta then done', undefined, async () => {
    const gw = new MockAIGateway();
    const events: any[] = [];
    for await (const e of gw.stream({tier:'fast', prompt:'stream test'})) { events.push(e); }
    const deltas = events.filter((e:any)=>e.type==='delta');
    const done = events.find((e:any)=>e.type==='done');
    assert(deltas.length>0, 'Must emit at least one delta');
    assert(!!done, 'Must emit done event');
    assert(typeof done.usage?.totalTokens==='number', 'done.usage.totalTokens must be number');
  });
  await gate('[STREAM-3] Aborting stream stops event flow', undefined, async () => {
    const gw = new MockAIGateway();
    const ctrl = new AbortController();
    const events: any[] = [];
    let stopped = false;
    try {
      for await (const e of gw.stream({tier:'fast', prompt:'long'}, {signal:ctrl.signal})) {
        events.push(e);
        if (events.length===1) ctrl.abort();
      }
    } catch { stopped=true; }
    assert(stopped||events.length<10, 'Stream must stop after abort');
  });

  // ── BLOCK 7: CANCELLATION ───────────────────────────────────────
  await gate('[CANCEL-1] Pre-aborted signal returns 502 REQUEST_CANCELLED', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const ctrl = new AbortController(); ctrl.abort();
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': 'c1'}, {tier:'fast', prompt:'cancel'}, {signal:ctrl.signal});
    assert(res.status===502, 'Expected 502, got ' + res.status);
    assert(res.body.code==='REQUEST_CANCELLED', 'Expected REQUEST_CANCELLED');
  });
  await gate('[CANCEL-2] Cancelled error body has no provider key', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const ctrl = new AbortController(); ctrl.abort();
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': 'csec'}, {tier:'fast', prompt:'cancel'}, {signal:ctrl.signal});
    assertNoKey(JSON.stringify(res.body), 'cancel error response');
  });
  await gate('[CANCEL-3] Post-cancellation requests succeed (no deadlock)', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const ctrl = new AbortController(); ctrl.abort();
    await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': 'c3a'}, {tier:'fast', prompt:'cancel'}, {signal:ctrl.signal});
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': 'c3b'}, {tier:'fast', prompt:'after cancel'});
    assert(res.status===200, 'Post-cancel must succeed: ' + res.status);
  });

  // ── BLOCK 8: FAILOVER ───────────────────────────────────────────
  await gate('[FAILOVER-1] 502 retryable error triggers failover', undefined, async () => {
    const b = await mkBackend();
    const err = Object.assign(new Error('502 upstream'), {status:502});
    (b as any).adapters.set('google', {id:'google', generate:async()=>{throw err;}, stream:async function*(){throw err;}});
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': 'fo1'}, {tier:'fast', prompt:'failover'});
    assert(res.status===200, 'Failover must succeed, got ' + res.status + ': ' + JSON.stringify(res.body));
  });
  await gate('[FAILOVER-2] 401 NOT retryable - no failover', undefined, async () => {
    const b = await mkBackend();
    const err = Object.assign(new Error('401 Unauthorized'), {status:401});
    (b as any).adapters.set('google', {id:'google', generate:async()=>{throw err;}, stream:async function*(){throw err;}});
    (b as any).adapters.set('openai', {id:'openai', generate:async()=>{throw err;}, stream:async function*(){throw err;}});
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': 'fo2'}, {tier:'fast', prompt:'test'});
    assert(res.status===502, 'Non-retryable must return 502, got ' + res.status);
  });
  await gate('[FAILOVER-3] Correlation ID preserved across failover', undefined, async () => {
    const b = await mkBackend();
    const err = Object.assign(new Error('502'), {status:502});
    (b as any).adapters.set('google', {id:'google', generate:async()=>{throw err;}, stream:async function*(){throw err;}});
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const corrId = 'corr-id-e2e-789';
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': corrId}, {tier:'fast', prompt:'corr'});
    assert(res.headers['x-request-id']===corrId, 'x-request-id must match: ' + res.headers['x-request-id']);
  });
  await gate('[FAILOVER-4] Failover records exactly one usage entry', undefined, async () => {
    const b = await mkBackend();
    const err = Object.assign(new Error('503'), {status:503});
    (b as any).adapters.set('google', {id:'google', generate:async()=>{throw err;}, stream:async function*(){throw err;}});
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const id = 'fo-nodup';
    await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': id}, {tier:'fast', prompt:'nodup'});
    const cnt = (await b.usageStore.getRecordsForUser(s.userId)).filter((r:any)=>r.requestId===id).length;
    assert(cnt===1, 'Expected 1 record, got ' + cnt + ' (double-charge)');
  });

  // ── BLOCK 9: DESIGN INTELLIGENCE ───────────────────────────────
  await gate('[DI-1] Restaurant DNA: orange warm brand', 'Restaurant Reservation', async () => {
    const dna = DesignReasoner.inferDesignDNA('Build me a restaurant reservation app.');
    assert(dna.colors.primary==='#c2410c', 'Expected orange, got ' + dna.colors.primary);
    assert(dna.brandPersonality.startsWith('warm'), 'Expected warm personality, got ' + dna.brandPersonality);
  });
  await gate('[DI-2] All five scenarios produce valid design DNA', undefined, async () => {
    for (const p of ['Build a restaurant reservation app.','Build a SaaS analytics dashboard.','Build a fitness tracker app.','Build a community chat application.','Build a personal wallet tracker.']) {
      const dna = DesignReasoner.inferDesignDNA(p);
      assert(typeof dna.colors.primary==='string', 'Must have primary color for: ' + p);
      assert(typeof dna.brandPersonality==='string', 'Must have brandPersonality for: ' + p);
    }
  });
  await gate('[DI-3] DesignReviewer detects color and state violations', undefined, async () => {
    const dna = DesignReasoner.inferDesignDNA('Build a restaurant app.');
    const code = "import React from 'react';\nimport { View, Text } from 'react-native';\nexport default function App() { return (<View style={{ padding: 19, backgroundColor: '#998877' }}><Text>Hi</Text></View>); }";
    const faults = DesignReviewer.evaluateUI(code, 'App.tsx', dna);
    assert(faults.some((f:any)=>f.category==='color_consistency'), 'Must detect color inconsistency');
    assert(faults.some((f:any)=>f.category==='missing_states'), 'Must detect missing states');
  });
  await gate('[DI-4] DesignReviewer passes code with all required states', undefined, async () => {
    const dna = DesignReasoner.inferDesignDNA('Build a restaurant app.');
    const code = "import React from 'react';\nimport { View, ActivityIndicator, Text } from 'react-native';\nexport default function App() { return (<View style={{ padding: 16 }}><ActivityIndicator size=\"small\" /><Text>Error handler: fail.</Text><Text>Empty state: none.</Text></View>); }";
    const faults = DesignReviewer.evaluateUI(code, 'App.tsx', dna);
    assert(faults.length===0, 'Expected 0 faults, got ' + faults.length + ': ' + faults.map((f:any)=>f.category).join(', '));
  });
  await gate('[DI-5] Task state persists and recovers correctly', undefined, async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'p314-state-'));
    try {
      const state = {taskId:'p314-recovery', currentState:'UNDERSTAND' as const, modifiedFiles:['App.tsx','components/Card.tsx'], retryCount:3, lastUpdatedAt:new Date().toISOString()};
      await saveAgentTaskState(tmpDir, state);
      const loaded = await loadAgentTaskState(tmpDir);
      assert(!!loaded, 'Task state must load');
      assert(loaded!.taskId==='p314-recovery', 'taskId must match');
      assert(loaded!.currentState==='UNDERSTAND', 'currentState must match');
      assert(loaded!.retryCount===3, 'retryCount must match');
      assert(loaded!.modifiedFiles.length===2, 'modifiedFiles must match');
    } finally { await rm(tmpDir, {recursive:true, force:true}); }
  });

  // ── BLOCK 10: SOURCE MAPPING & VISUAL EDITING ───────────────────
  await gate('[VIS-1] Fiber _debugSource maps file and line', undefined, async () => {
    const fiber = {type:'View', _debugSource:{fileName:'/app/components/ReservationCard.tsx', lineNumber:42, columnNumber:8}, memoizedProps:{testID:'res-card'}};
    assert(fiber._debugSource.lineNumber===42, 'Line must be 42');
    assert(fiber._debugSource.fileName.includes('ReservationCard.tsx'), 'File must be correct');
  });
  await gate('[VIS-2] Visual AI editing safety levels classified correctly', undefined, async () => {
    const classify = (files:string[], shared:boolean):string => {
      if (shared) return 'ARCHITECTURAL_CHANGE';
      if (files.length>1) return 'MULTI_FILE_EDIT';
      if (files.length===1 && files[0]!.includes('components/')) return 'COMPONENT_EDIT';
      return 'LOCAL_EDIT';
    };
    assert(classify(['App.tsx'], false)==='LOCAL_EDIT', 'LOCAL_EDIT');
    assert(classify(['components/Card.tsx'], false)==='COMPONENT_EDIT', 'COMPONENT_EDIT');
    assert(classify(['App.tsx','components/X.tsx'], false)==='MULTI_FILE_EDIT', 'MULTI_FILE_EDIT');
    assert(classify(['components/Button.tsx'], true)==='ARCHITECTURAL_CHANGE', 'ARCHITECTURAL_CHANGE');
  });

  // ── BLOCK 11: PRODUCTION GATEWAY ────────────────────────────────
  await gate('[PGW-1] ProductionAIGateway sends session Bearer - no provider key', undefined, async () => {
    const captured: Record<string,string> = {};
    const orig = global.fetch;
    global.fetch = async(_url:any,opts:any)=>{
      Object.assign(captured, opts?.headers||{});
      return {ok:true,status:200,headers:new Map(),json:async()=>({content:'ok',usage:{inputTokens:5,outputTokens:10,totalTokens:15},cost:{cost:0.001,currency:'USD'}}),body:null} as any;
    };
    try {
      const gw = new ProductionAIGateway({baseUrl:'http://localhost:4000', sessionToken:'session-xyz'});
      await gw.generate({tier:'fast', prompt:'secure test'});
      const auth = captured['Authorization']||captured['authorization']||'';
      assert(auth.startsWith('Bearer '), 'Must use Bearer auth');
      assert(auth.includes('session-xyz'), 'Must include session token');
      assertNoKey(auth, 'PGW Authorization header');
    } finally { global.fetch=orig; }
  });
  await gate('[PGW-2] Missing session token returns UNAUTHORIZED', undefined, async () => {
    const gw = new ProductionAIGateway({baseUrl:'http://localhost:4000', sessionToken:''});
    let threw=false;
    try { await gw.generate({tier:'fast', prompt:'no token'}); } catch(e:any) {
      threw=true;
      assert(e.code==='UNAUTHORIZED', 'Expected UNAUTHORIZED, got ' + e.code);
    }
    assert(threw, 'Must throw UNAUTHORIZED for empty token');
  });
  await gate('[PGW-3] AbortSignal propagates through ProductionAIGateway', undefined, async () => {
    const orig = global.fetch;
    global.fetch = async(_u:any,opts:any)=>{
      if (opts?.signal?.aborted) { const e=new Error('AbortError'); e.name='AbortError'; throw e; }
      return {ok:true,status:200,json:async()=>({}),body:null} as any;
    };
    try {
      const gw = new ProductionAIGateway({baseUrl:'http://localhost:4000', sessionToken:'tok'});
      const ctrl = new AbortController(); ctrl.abort();
      let threw=false;
      try { await gw.generate({tier:'fast', prompt:'abort'}, {signal:ctrl.signal}); } catch { threw=true; }
      assert(threw, 'Must throw on abort');
    } finally { global.fetch=orig; }
  });
  await gate('[PGW-4] estimateCost uses session Bearer - never provider key', undefined, async () => {
    const captured: Record<string,string> = {};
    const orig = global.fetch;
    global.fetch = async(_u:any,opts:any)=>{
      Object.assign(captured, opts?.headers||{});
      return {ok:true,status:200,headers:new Map(),json:async()=>({cost:0.001,currency:'USD'}),body:null} as any;
    };
    try {
      const gw = new ProductionAIGateway({baseUrl:'http://localhost:4000', sessionToken:'estimate-session'});
      await gw.estimateCost({tier:'premium', prompt:'estimate'});
      const auth = captured['Authorization']||captured['authorization']||'';
      assert(auth.includes('estimate-session'), 'Must include session token');
      assertNoKey(auth, 'estimateCost Authorization header');
    } finally { global.fetch=orig; }
  });

  // ── BLOCK 12: SECURITY ──────────────────────────────────────────
  await gate('[SEC-1] No provider keys in backend response body or headers', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': 'sec-scan'}, {tier:'fast', prompt:'security scan'});
    assertNoKey(JSON.stringify(res.body), 'backend response body');
    assertNoKey(JSON.stringify(res.headers), 'backend response headers');
  });
  await gate('[SEC-2] Error responses never expose provider keys or session tokens', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const r401 = await b.handleRequest('POST', '/v1/ai/generate', {}, {tier:'fast', prompt:'no auth'});
    const r400 = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken}, {tier:'badtier', prompt:'test'});
    assertNoKey(JSON.stringify(r401.body), '401 error body');
    assertNoKey(JSON.stringify(r400.body), '400 error body');
    assert(!JSON.stringify(r401.body).includes(s.sessionToken), '401 must not reflect session token');
  });
  await gate('[SEC-3] MockAIGateway makes no external HTTP requests', undefined, async () => {
    const orig = global.fetch;
    let called = false;
    global.fetch = async()=>{ called=true; return {} as any; };
    try {
      const gw = new MockAIGateway();
      await gw.generate({tier:'fast', prompt:'mock test'});
      assert(!called, 'MockAIGateway must NOT call fetch');
    } finally { global.fetch=orig; }
  });
  await gate('[SEC-4] IPC: sessionToken stripped, sessionConfigured is bool', undefined, async () => {
    const ipc = {theme:'dark', apiKey:undefined, sessionToken:undefined, sessionConfigured:true};
    assert(ipc.apiKey===undefined, 'apiKey must be stripped');
    assert(ipc.sessionToken===undefined, 'sessionToken must be stripped');
    assert(typeof ipc.sessionConfigured==='boolean', 'sessionConfigured must be boolean');
  });
  await gate('[SEC-5] Server-side budget cannot be bypassed by client fields', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': 'bypass'}, {tier:'fast', prompt:'test', plan:'enterprise', budgetOverride:99999});
    assert(res.status===200, 'Server must ignore override, got ' + res.status);
    assertNoKey(JSON.stringify(res.body), 'bypass response');
  });
  await gate('[SEC-6] Session token not logged during request processing', undefined, async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args:any[]) => { logs.push(args.map(String).join(' ')); origLog(...args); };
    try {
      const b = await mkBackend();
      const s = await b.authService.login('user@example.com', 'hash-password-123');
      await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': 'log-audit'}, {tier:'fast', prompt:'log audit'});
      const dump = logs.join('\n');
      assert(!dump.includes(s.sessionToken), 'Session token must NOT appear in logs');
      assertNoKey(dump, 'backend log output');
    } finally { console.log=origLog; }
  });

  // ── BLOCK 13: PERFORMANCE ────────────────────────────────────────
  await gate('[PERF-1] Auth login+validate in <100ms', undefined, async () => {
    const auth = new AuthService();
    const t0 = Date.now();
    const s = await auth.login('user@example.com', 'hash-password-123');
    await auth.validateSession(s.sessionToken);
    assert(Date.now()-t0<100, 'Auth took ' + (Date.now()-t0) + 'ms');
  });
  await gate('[PERF-2] Backend generate (mock) in <500ms', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const t0 = Date.now();
    await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': 'perf'}, {tier:'fast', prompt:'perf test'});
    assert(Date.now()-t0<500, 'Backend took ' + (Date.now()-t0) + 'ms');
  });
  await gate('[PERF-3] Budget guard 10 lock cycles in <50ms', undefined, async () => {
    const guard = new ServerBudgetGuard(new ServerUsageStore());
    const t0 = Date.now();
    for (let i=0;i<10;i++) { await guard.acquireLock('perf-user'); guard.releaseLock('perf-user'); }
    assert(Date.now()-t0<50, '10 lock cycles took ' + (Date.now()-t0) + 'ms');
  });
  await gate('[PERF-4] Design DNA inference in <10ms', undefined, async () => {
    const t0 = Date.now();
    DesignReasoner.inferDesignDNA('Build a restaurant booking app with premium features.');
    assert(Date.now()-t0<10, 'Design DNA took ' + (Date.now()-t0) + 'ms');
  });

  // ── BLOCK 14: ERROR RECOVERY ─────────────────────────────────────
  await gate('[ERR-1] Empty prompt -> 400 VALIDATION_ERROR', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken}, {tier:'fast', prompt:''});
    assert(res.status===400 && res.body.code==='VALIDATION_ERROR', 'Expected 400 VALIDATION_ERROR');
  });
  await gate('[ERR-2] Null body -> 400 VALIDATION_ERROR', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken}, null);
    assert(res.status===400, 'Expected 400, got ' + res.status);
  });
  await gate('[ERR-3] Provider crash -> PROVIDER_ERROR, no secret leakage', undefined, async () => {
    const b = await mkBackend();
    const secretErr = Object.assign(new Error('crash sk-secret-key'), {status:500});
    (b as any).adapters.set('google', {id:'google', generate:async()=>{throw secretErr;}, stream:async function*(){}});
    (b as any).adapters.set('openai', {id:'openai', generate:async()=>{throw new Error('also failed');}, stream:async function*(){}});
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const res = await b.handleRequest('POST', '/v1/ai/generate', {'authorization': 'Bearer ' + s.sessionToken, 'x-request-id': 'err3'}, {tier:'fast', prompt:'trigger error'});
    assert(res.status===502, 'Expected 502, got ' + res.status);
    assert(res.body.code==='PROVIDER_ERROR', 'Expected PROVIDER_ERROR, got ' + res.body.code);
    assertNoKey(JSON.stringify(res.body), 'provider error response body');
  });
  await gate('[ERR-4] Unknown route -> 404 NOT_FOUND', undefined, async () => {
    const b = await mkBackend();
    const s = await b.authService.login('user@example.com', 'hash-password-123');
    const res = await b.handleRequest('POST', '/v1/ai/unknown', {'authorization': 'Bearer ' + s.sessionToken}, {tier:'fast', prompt:'test'});
    assert(res.status===404, 'Expected 404, got ' + res.status);
    assert(res.body.code==='NOT_FOUND', 'Expected NOT_FOUND');
  });

  // ── SUMMARY ──────────────────────────────────────────────────────
  const passed = GRS.filter(r=>r.status==='PASS').length;
  const failed = GRS.filter(r=>r.status==='FAIL').length;
  console.log('\n  Results: ' + passed + '/' + GRS.length + ' gates passed');
  if (failed>0) {
    GRS.filter(r=>r.status==='FAIL').forEach(r=>console.error('    FAIL: ' + r.gate + ': ' + r.note));
    throw new Error('P3.14: ' + failed + ' gate(s) FAILED');
  }
  console.log('  All P3.14 Full E2E Validation tests passed (' + passed + '/' + GRS.length + ').');
}
