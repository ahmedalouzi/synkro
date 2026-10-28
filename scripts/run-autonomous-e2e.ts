import Module from 'node:module';
import { EventEmitter } from 'node:events';

const mockIpcMain = new EventEmitter();
const originalRequire = Module.prototype.require;
(Module.prototype as any).require = function(id: string) {
  if (id === 'electron') {
    return {
      app: { getPath: () => __dirname },
      ipcMain: mockIpcMain,
      shell: { openPath: () => {} }
    };
  }
  return originalRequire.apply(this, arguments as any);
};

import { AgentService } from '../apps/desktop/src/main/services/agent-service';
import { DatabaseService } from '../apps/desktop/src/main/services/db';
import { WorkspaceManager } from '../apps/desktop/src/main/services/workspace-manager';
import { PlatformRegistry } from '../apps/desktop/src/main/services/platform-registry';
import { spawn } from 'node:child_process';
import * as path from 'path';
import * as fs from 'fs';

async function run() {
  console.log('=== AUTONOMOUS LLM E2E READINESS TEST ===\n');

  const wsPath = path.join(__dirname, '..', 'test-autonomous-workspace');
  if (fs.existsSync(wsPath)) {
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
  fs.mkdirSync(wsPath, { recursive: true });

  // Start Dev Proxy
  console.log('[SYSTEM] Starting local test gateway server on port 3000...');
  const tsxCli = path.resolve(__dirname, '..', 'packages', 'agent', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const proxyProcess = spawn('node', [tsxCli, 'scripts/test-gateway-server.ts'], {
    stdio: 'inherit',
    env: { ...process.env, DEV_ONLY_AUTH: 'true' },
    shell: true,
    cwd: path.resolve(__dirname, '..')
  });

  // Wait a moment for proxy to start
  await new Promise(r => setTimeout(r, 5000));

  const db = new DatabaseService();
  await db.init();
  await db.setSettings({ sessionToken: 'dev-mode-token', apiProvider: 'google', gatewayUrl: 'http://127.0.0.1:3000' });
  const workspace = new WorkspaceManager(db);
  (workspace as any).project = { path: wsPath };
  const registry = new PlatformRegistry();
  
  const agent = new AgentService(db, workspace, registry);
  
  let resolveDone: (() => void) | null = null;
  const donePromise = new Promise<void>(r => { resolveDone = r; });

  agent.setMainWindow({
    webContents: {
      send: (channel: string, data: any) => {
        if (channel === 'agent:stream') {
          if (data.type === 'delta') {
            process.stdout.write(data.content || '');
          } else if (data.type === 'tool_call') {
            console.log(`\n\n[LLM TOOL DECISION] -> ${data.toolCall.name}`);
            console.log(`[LLM TOOL ARGUMENTS] -> ${data.toolCall.arguments}\n`);
          } else if (data.type === 'error') {
            console.error(`\n[AGENT ERROR] -> ${data.content}\n`);
          } else if (data.type === 'status') {
            console.log(`\n[AGENT STATUS] -> ${data.content}\n`);
          } else if (data.type === 'done') {
            console.log(`\n[AGENT DONE] Iteration complete.\n`);
          }
        } else if (channel === 'agent:proposed-edits') {
          const editIds = data.map((e: any) => e.id);
          if (editIds.length > 0) {
            console.log(`[INFRASTRUCTURE] Automatically applying ${editIds.length} file edits proposed by LLM...`);
            agent.applyEdits(editIds).catch(console.error);
          }
        } else if (channel === 'agent:confirm-command') {
          console.log(`[INFRASTRUCTURE] Auto-confirming command for autonomous test: ${data.command}`);
          const { ipcMain } = require('electron');
          ipcMain.emit(`agent:confirm-command-response:${data.id}`, null, true);
        }
      }
    }
  } as any);

  // Note: the test must wait for .peep/plan.json to reach "completed", not just wait for one "done" stream, 
  // because the loop might take multiple iterations, or it might just finish.
  // Wait, runAgentLoop will loop automatically up to MAX_ITERATIONS!
  // If runAgentLoop finishes, the Promise from agent.send() resolves!
  // Wait, agent.send() does NOT return a Promise for the loop, it's fire-and-forget inside its try block!
  // Ah, let's look at agent-service.ts line 880: await runAgentLoop(...).
  // But agent.send is async! So we can just await agent.send()!

  console.log('\n[E2E] Submitting single natural-language user prompt:\n');
  const userPrompt = `Create a React Native Expo application named TestFlow. Build a modern counter app with increment, decrement, and reset buttons. Create it in the current workspace and install dependencies. 
IMPORTANT TEST INSTRUCTIONS:
1. Initialize a plan using manage_plan with explicit Acceptance Criteria.
2. When creating the initial App.tsx, intentionally introduce a minor type or syntax error (e.g., using an undeclared variable).
3. Attempt to verify the code by running 'npx tsc --noEmit'. It MUST fail to trigger Phase 2 Error Recovery.
4. Diagnose the error and use propose_file_edit to fix it autonomously.
5. Re-run 'npx tsc --noEmit' and then explicitly use the 'verify_criterion' tool to record the verified evidence.
6. Only mark the plan as completed once all criteria are verified via verify_criterion.`;
  console.log(`> "${userPrompt}"\n`);

  try {
    await agent.send({ message: userPrompt, projectPath: wsPath, history: [] });
    console.log('\n[E2E] agent.send() resolved. Agent loop has completed.');
  } catch (e) {
    console.error('\n[E2E] Agent loop crashed:', e);
  }

  proxyProcess.kill();

  const planPath = path.join(wsPath, '.peep', 'plan.json');
  if (fs.existsSync(planPath)) {
    const planJson = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    console.log('\n[FINAL VERDICT CHECK]');
    console.log(`Plan Status: ${planJson.status}`);
    
    if (planJson.status === 'completed') {
      console.log('\nAUTONOMOUS_AI_E2E: PASS');
    } else {
      console.log('\nAUTONOMOUS_AI_E2E: FAIL (Plan did not reach completed state)');
    }
  } else {
    console.log('\nAUTONOMOUS_AI_E2E: FAIL (plan.json not found)');
  }
}

run().catch(console.error);
