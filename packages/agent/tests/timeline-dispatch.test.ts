/**
 * timeline-dispatch.test.ts
 *
 * Task 2: Timeline / Orchestrator Dispatch
 */

import { runAgentLoop, type AgentToolExecutor } from '../src/orchestrator';
import { MockAIGateway } from '../src/models/mock-gateway';
import type { AgentTimelineActivity } from '@peep/shared';

export default async function runTests() {
  console.log('  Running Timeline Dispatch unit tests...');

  // Test 1: Timeline events are created for a conversational run
  {
    console.log('  [Test 1] Timeline event creation...');
    const gateway = new MockAIGateway();
    gateway.setScenario('success');
    const activities: AgentTimelineActivity[] = [];
    const executor: AgentToolExecutor = { execute: async () => 'out' };
    await runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'tok_test', gateway },
      'System prompt.',
      [{ role: 'user', content: 'Hello!' }],
      executor,
      { onStatus: () => {}, onDelta: () => {}, onError: () => {}, onDone: () => {},
        onTimelineActivity: (a) => activities.push(a) },
      new AbortController().signal,
    );
    if (activities.length < 2) throw new Error(`Expected >=2 events, got ${activities.length}`);
    const types = activities.map(a => a.type);
    if (!types.includes('understanding')) throw new Error(`Missing 'understanding'. Got: ${types}`);
    if (!types.includes('completed')) throw new Error(`Missing 'completed'. Got: ${types}`);
    console.log(`    v ${activities.length} events: [${types.join(', ')}]`);
  }

  // Test 2: Stable ID semantics
  //   A. All activities within a single run share the same runId.
  //   B. Two separate runAgentLoop invocations receive different runIds.
  //   C. Activity IDs within a run remain unique.
  {
    console.log('  [Test 2] Stable ID semantics (intra-run same, inter-run different)...');
    const executor: AgentToolExecutor = { execute: async () => 'out' };

    // ── Run 1 ──
    const gateway1 = new MockAIGateway();
    gateway1.setCustomToolCall({ id: 'callA', name: 'search_files', arguments: JSON.stringify({ query: 'foo' }) });
    const run1Activities: AgentTimelineActivity[] = [];
    await runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'stable_tok', gateway: gateway1 },
      'sys',
      [{ role: 'user', content: 'Run 1 message.' }],
      { execute: async () => { gateway1.setScenario('success'); return 'r1'; } },
      { onStatus: () => {}, onDelta: () => {}, onError: () => {}, onDone: () => {},
        onTimelineActivity: (a) => run1Activities.push(a) },
      new AbortController().signal,
    );

    // ── Run 2 — separate invocation ──
    const gateway2 = new MockAIGateway();
    gateway2.setScenario('success');
    const run2Activities: AgentTimelineActivity[] = [];
    await runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'stable_tok', gateway: gateway2 },
      'sys',
      [{ role: 'user', content: 'Run 2 message.' }],
      executor,
      { onStatus: () => {}, onDelta: () => {}, onError: () => {}, onDone: () => {},
        onTimelineActivity: (a) => run2Activities.push(a) },
      new AbortController().signal,
    );

    if (run1Activities.length === 0) throw new Error('Run 1 produced no activities');
    if (run2Activities.length === 0) throw new Error('Run 2 produced no activities');

    // A. Intra-run stability: every event in run 1 has the same runId
    const run1RunIds = new Set(run1Activities.map(a => a.runId));
    if (run1RunIds.size !== 1) {
      throw new Error(`Run 1 has multiple runIds — intra-run unstable: ${[...run1RunIds].join(', ')}`);
    }
    const run2RunIds = new Set(run2Activities.map(a => a.runId));
    if (run2RunIds.size !== 1) {
      throw new Error(`Run 2 has multiple runIds — intra-run unstable: ${[...run2RunIds].join(', ')}`);
    }

    // B. Inter-run uniqueness: the two separate runs have different runIds
    const runId1 = [...run1RunIds][0];
    const runId2 = [...run2RunIds][0];
    if (runId1 === runId2) {
      throw new Error(`Two separate invocations produced the same runId "${runId1}" — inter-run not unique`);
    }

    // Format check: must follow 'run:...' deterministic format, no random UUID
    if (!runId1.startsWith('run:')) throw new Error(`runId "${runId1}" does not follow 'run:' format`);
    if (!runId2.startsWith('run:')) throw new Error(`runId "${runId2}" does not follow 'run:' format`);

    // C. Activity IDs within each run are unique
    const run1Ids = run1Activities.map(a => a.id);
    if (new Set(run1Ids).size !== run1Ids.length) throw new Error(`Duplicate activity IDs in run 1: ${run1Ids}`);
    const run2Ids = run2Activities.map(a => a.id);
    if (new Set(run2Ids).size !== run2Ids.length) throw new Error(`Duplicate activity IDs in run 2: ${run2Ids}`);

    console.log(`    v Run 1 runId="${runId1}" (${run1Activities.length} events, all same runId)`);
    console.log(`    v Run 2 runId="${runId2}" (${run2Activities.length} events, all same runId)`);
    console.log(`    v Inter-run runIds are different — correct`);
  }

  // Test 3: Correct event ordering (understanding before completed)
  {
    console.log('  [Test 3] Correct event ordering...');
    const gateway = new MockAIGateway(); gateway.setScenario('success');
    const received: string[] = [];
    const executor: AgentToolExecutor = { execute: async () => 'out' };
    await runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'order_tok', gateway }, 'sys',
      [{ role: 'user', content: 'Hello' }], executor,
      { onStatus: () => {}, onDelta: () => {}, onError: () => {}, onDone: () => {},
        onTimelineActivity: (a) => received.push(`${a.type}:${a.status}`) },
      new AbortController().signal,
    );
    const ui = received.findIndex(e => e.startsWith('understanding'));
    const ci = received.findIndex(e => e.startsWith('completed'));
    if (ui === -1) throw new Error('No understanding event');
    if (ci === -1) throw new Error('No completed event');
    if (ui >= ci) throw new Error(`ordering wrong: understanding=${ui}, completed=${ci}`);
    console.log(`    v Order verified: [${received.join(', ')}]`);
  }

  // Test 4: Zero-tool conversational — IPC callbacks intact
  {
    console.log('  [Test 4] Zero-tool conversational — IPC callbacks...');
    const gateway = new MockAIGateway(); gateway.setScenario('success');
    const executor: AgentToolExecutor = { execute: async () => 'out' };
    let doneCalled = false;
    const deltas: string[] = [];
    await runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'conv_tok', gateway }, 'sys',
      [{ role: 'user', content: 'What is TypeScript?' }], executor,
      { onStatus: () => {}, onDelta: (d) => deltas.push(d), onError: () => {}, onDone: () => { doneCalled = true; } },
      new AbortController().signal,
    );
    if (!doneCalled) throw new Error('onDone was not called');
    if (deltas.length < 1) throw new Error('No delta chunks received');
    console.log(`    v doneCalled=true, ${deltas.length} delta chunks`);
  }

  // Test 5: Tool-call — in_progress before resolved, IDs contain call.id
  {
    console.log('  [Test 5] Tool-call execution events with stable IDs...');
    const gateway = new MockAIGateway();
    gateway.setCustomToolCall({ id: 'callid-42', name: 'search_files', arguments: JSON.stringify({ query: 'widget' }) });
    const activities: AgentTimelineActivity[] = [];
    let toolExecuted = false;
    const executor: AgentToolExecutor = {
      execute: async () => { toolExecuted = true; gateway.setScenario('success'); return 'Found: lib/widget.dart'; },
    };
    await runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'tool_tok', gateway }, 'sys',
      [{ role: 'user', content: 'Search widget files.' }], executor,
      { onStatus: () => {}, onDelta: () => {}, onError: () => {}, onDone: () => {},
        onTimelineActivity: (a) => activities.push(a) },
      new AbortController().signal,
    );
    if (!toolExecuted) throw new Error('Tool was not executed');
    const ipEvents  = activities.filter(a => a.status === 'in_progress' && a.type === 'searching');
    const resEvents = activities.filter(a => a.status === 'completed'   && a.type === 'searching');
    if (ipEvents.length === 0)  throw new Error(`Missing in_progress 'searching'. Got: ${JSON.stringify(activities.map(a => `${a.type}:${a.status}`))}`);
    if (resEvents.length === 0) throw new Error(`Missing completed 'searching'. Got: ${JSON.stringify(activities.map(a => `${a.type}:${a.status}`))}`);
    const ipIdx  = activities.indexOf(ipEvents[0]);
    const resIdx = activities.indexOf(resEvents[0]);
    if (ipIdx >= resIdx) throw new Error(`in_progress must precede resolved: ${ipIdx} >= ${resIdx}`);
    if (!ipEvents[0].id.includes('callid-42'))  throw new Error(`in_progress ID "${ipEvents[0].id}" missing callid-42`);
    if (!resEvents[0].id.includes('callid-42')) throw new Error(`resolved ID "${resEvents[0].id}" missing callid-42`);
    console.log(`    v in_progress "${ipEvents[0].id}" -> resolved "${resEvents[0].id}"`);
  }

  // Test 6: Streaming delta dispatch continuity (Task 1 regression)
  {
    console.log('  [Test 6] Streaming delta dispatch — Task 1 regression...');
    const gateway = new MockAIGateway(); gateway.setScenario('streaming');
    const executor: AgentToolExecutor = { execute: async () => 'out' };
    const chunks: string[] = [];
    const activities: AgentTimelineActivity[] = [];
    let doneCalled = false;
    const result = await runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'delta_tok', gateway }, 'sys',
      [{ role: 'user', content: 'Stream something.' }], executor,
      { onStatus: () => {}, onDelta: (d) => chunks.push(d), onError: () => {}, onDone: () => { doneCalled = true; },
        onTimelineActivity: (a) => activities.push(a) },
      new AbortController().signal,
    );
    if (chunks.length < 2) throw new Error(`Expected >=2 chunks, got ${chunks.length}`);
    if (!doneCalled) throw new Error('onDone not called');
    if (result !== chunks.join('')) throw new Error(`Streamed content mismatch`);
    if (activities.length === 0) throw new Error('No timeline activities during streaming');
    console.log(`    v ${chunks.length} chunks, ${activities.length} timeline events`);
  }

  // Test 7: Cancellation propagation
  {
    console.log('  [Test 7] Cancellation propagation...');
    const gateway = new MockAIGateway(); gateway.setScenario('streaming');
    const executor: AgentToolExecutor = { execute: async () => 'out' };
    const controller = new AbortController();
    const activities: AgentTimelineActivity[] = [];
    const promise = runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'cancel_tok', gateway }, 'sys',
      [{ role: 'user', content: 'Long stream.' }], executor,
      { onStatus: () => {}, onDelta: () => { controller.abort(); }, onError: () => {}, onDone: () => {},
        onTimelineActivity: (a) => activities.push(a) },
      controller.signal,
    );
    try {
      await promise;
      throw new Error('Expected rejection on cancellation');
    } catch (err: any) {
      if (!err.message.includes('Cancelled') && !err.message.includes('aborted') && !err.message.includes('Aborted')) throw err;
    }
    if (!activities.some(a => a.type === 'understanding')) throw new Error('No understanding event before cancel');
    console.log('    v Cancellation propagated, understanding event dispatched before abort');
  }

  // Test 8: Error propagation through dispatch layer
  {
    console.log('  [Test 8] Error propagation...');
    const gateway = new MockAIGateway(); gateway.setScenario('provider_error');
    const executor: AgentToolExecutor = { execute: async () => 'out' };
    let errorThrown = false;
    try {
      await runAgentLoop(
        { capabilityTier: 'fast', sessionToken: 'err_tok', gateway }, 'sys',
        [{ role: 'user', content: 'Trigger error.' }], executor,
        { onStatus: () => {}, onDelta: () => {}, onError: () => {}, onDone: () => {} },
        new AbortController().signal,
      );
    } catch { errorThrown = true; }
    if (!errorThrown) throw new Error('Expected error to propagate');
    console.log('    v Error propagated correctly');
  }

  // Test 9: All IPC callbacks fire alongside timeline
  {
    console.log('  [Test 9] IPC callbacks alongside timeline...');
    const gateway = new MockAIGateway(); gateway.setScenario('success');
    const executor: AgentToolExecutor = { execute: async () => 'out' };
    const statuses: string[] = [];
    const deltas: string[] = [];
    let doneCount = 0;
    const activities: AgentTimelineActivity[] = [];
    await runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'ipc_tok', gateway }, 'sys',
      [{ role: 'user', content: 'IPC test.' }], executor,
      { onStatus: (s) => statuses.push(s), onDelta: (d) => deltas.push(d), onError: () => {}, onDone: () => { doneCount++; },
        onTimelineActivity: (a) => activities.push(a) },
      new AbortController().signal,
    );
    if (statuses.length === 0) throw new Error('onStatus never called');
    if (deltas.length === 0) throw new Error('onDelta never called');
    if (doneCount !== 1) throw new Error(`onDone called ${doneCount} times`);
    if (activities.length === 0) throw new Error('onTimelineActivity never called');
    console.log(`    v ${statuses.length} status, ${deltas.length} delta, ${doneCount} done, ${activities.length} timeline`);
  }

  // Test 10: No duplicate event IDs within a single run
  {
    console.log('  [Test 10] No duplicate event IDs...');
    const gateway = new MockAIGateway();
    gateway.setCustomToolCall({ id: 'call-alpha', name: 'search_files', arguments: JSON.stringify({ query: 'alpha' }) });
    const ids: string[] = [];
    const executor: AgentToolExecutor = {
      execute: async () => { gateway.setScenario('success'); return 'results'; },
    };
    await runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'nodup_tok', gateway }, 'sys',
      [{ role: 'user', content: 'Search alpha.' }], executor,
      { onStatus: () => {}, onDelta: () => {}, onError: () => {}, onDone: () => {},
        onTimelineActivity: (a) => ids.push(a.id) },
      new AbortController().signal,
    );
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      const dups = ids.filter((id, idx) => ids.indexOf(id) !== idx);
      throw new Error(`Duplicate IDs: ${dups.join(', ')}`);
    }
    console.log(`    v ${ids.length} events, all IDs unique`);
  }

  // Test 11: what the agent did is reported only as timeline activities. The chat renders text as markdown,
  // so an HTML block in the streamed text (the old "Worked for …" <details>) showed up as raw markup.
  {
    console.log('  [Test 11] No markup in the streamed text of a run with tools...');
    const gateway = new MockAIGateway();
    gateway.setCustomToolCall({ id: 'call-read', name: 'read_file', arguments: JSON.stringify({ path: 'App.tsx' }) });
    const deltas: string[] = [];
    const activities: AgentTimelineActivity[] = [];
    await runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'markup_tok', gateway }, 'sys',
      [{ role: 'user', content: 'Read App.tsx' }],
      { execute: async () => { gateway.setScenario('success'); return 'export default function App() {}'; } },
      { onStatus: () => {}, onDelta: (d) => deltas.push(d), onError: () => {}, onDone: () => {},
        onTimelineActivity: (a) => activities.push(a) },
      new AbortController().signal,
    );
    const text = deltas.join('');
    if (!text) throw new Error('No streamed answer');
    for (const markup of ['<details', '<summary', '<br/>', '<code>', 'Worked for']) {
      if (text.includes(markup)) throw new Error(`Streamed text contains "${markup}"`);
    }
    const read = activities.filter((a) => a.type === 'reading' && a.file === 'App.tsx').map((a) => a.status);
    if (read.join(',') !== 'in_progress,completed') throw new Error(`read_file activities: ${read.join(',')}`);
    console.log('    v text has no markup; the tool call is in the timeline');
  }

  console.log('  v All Timeline Dispatch unit tests passed.');
}
