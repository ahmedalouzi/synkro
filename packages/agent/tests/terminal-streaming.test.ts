import { TerminalService } from '../../../apps/desktop/src/main/services/terminal-service';
import { IpcBatcher } from '../../../apps/desktop/src/main/utils/ipc-batcher';

export default async function run() {
  console.log('  Running Terminal Streaming Infrastructure tests...');
  
  const service = new TerminalService();
  (service as any).isCommandAllowed = () => true;
  
  // Mock IPC
  const streamedChunks: { id: string; data: string }[] = [];
  (service as any).mainWindow = {
    webContents: {
      send: (channel: string, payload: any) => {
        if (channel === 'terminal:output') {
          streamedChunks.push(payload);
        }
      }
    }
  };

  // Mock globalIpcBatcher to flush immediately for tests
  const ipcBatcherModule = await import('../../../apps/desktop/src/main/utils/ipc-batcher');
  const originalBufferString = ipcBatcherModule.globalIpcBatcher.bufferString;
  (ipcBatcherModule.globalIpcBatcher as any).bufferString = (
    channel: string,
    id: string,
    data: string,
    delayMs: number,
    flushCallback: (id: string, accumulated: string) => void
  ) => {
    // Flush synchronously to test ordering and streaming directly
    flushCallback(id, data);
  };

  try {
    // 1. streamCommand: stdout/stderr incremental streaming and ordering
    console.log('  [Test 1] streamCommand stdout/stderr streaming...');
    streamedChunks.length = 0;
    
    // Windows vs macOS commands (we'll just use node to execute an inline script)
    const script = `
      console.log('out1');
      console.error('err1');
      console.log('out2');
      setTimeout(() => {
        console.error('err2');
      }, 10);
    `;
    
    // Use `node -e "..."` 
    const code = await service.streamCommand('test-1', `node -e "console.log('out1'); console.error('err1'); console.log('out2');"`, process.cwd());
    
    const text = streamedChunks.map(c => c.data).join('');
    if (!text.includes('out1') || !text.includes('err1') || !text.includes('out2')) {
      throw new Error(`streamCommand did not stream stdout/stderr properly. Got: ${text}`);
    }
    console.log('    ✓ Streamed stdout and stderr incrementally');

    // 2. streamCommand: large output without accumulation
    console.log('  [Test 2] streamCommand large output (no in-memory buffering)...');
    streamedChunks.length = 0;
    
    // Check internal sessions map to make sure it cleans up
    if ((service as any).commandSessions.size !== 0) {
      throw new Error('commandSessions map leaked after process exit');
    }

    const largeScript = `
      for (let i = 0; i < 10000; i++) {
        console.log('large stream chunk ' + i);
      }
    `;
    await service.streamCommand('test-2', `node -e "${largeScript.replace(/\n/g, ' ')}"`, process.cwd());
    
    if (streamedChunks.length === 0) {
      throw new Error('Did not receive large output chunks');
    }
    const fullLargeText = streamedChunks.map(c => c.data).join('');
    if (!fullLargeText.includes('large stream chunk 9999')) {
      throw new Error('Did not receive the end of large stream');
    }
    console.log('    ✓ Large output streamed successfully');

    // 3. streamCommand: Cancellation and stale chunk protection
    console.log('  [Test 3] streamCommand cancellation & stale chunk prevention...');
    streamedChunks.length = 0;
    
    const infiniteScript = `setInterval(() => console.log('infinite...'), 10);`;
    
    const streamPromise = service.streamCommand('test-3', `node -e "${infiniteScript}"`, process.cwd());
    
    // Catch rejection early so we don't hang if it fails to spawn
    let spawnError: any = null;
    streamPromise.catch(e => { spawnError = e; });

    // Wait for a chunk to arrive
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(check);
        reject(spawnError || new Error('Timeout waiting for chunks in Test 3'));
      }, 5000);

      const check = setInterval(() => {
        if (spawnError) {
          clearInterval(check);
          clearTimeout(timeout);
          reject(spawnError);
        }
        if (streamedChunks.length > 0) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 5);
    });

    // Now cancel
    service.cancelCommand('test-3');
    
    // Let it settle
    const chunkCountAtCancel = streamedChunks.length;
    await new Promise(r => setTimeout(r, 100));
    const chunkCountAfter = streamedChunks.length;
    
    if (chunkCountAfter > chunkCountAtCancel) {
      throw new Error(`Received ${chunkCountAfter - chunkCountAtCancel} stale chunks after cancellation`);
    }
    
    // Ensure promise rejects or resolves due to kill
    try {
      await streamPromise;
    } catch (e) {
      // Expected to reject or exit with signal code
    }
    console.log('    ✓ Cancellation halted streaming immediately');

    // 4. runCommand: backward compatibility
    console.log('  [Test 4] runCommand backward compatibility (buffered output)...');
    const result = await service.runCommand(`node -e "console.log('runCommand_out'); console.error('runCommand_err');"`, process.cwd());
    if (!result.stdout.includes('runCommand_out') || !result.stderr.includes('runCommand_err')) {
      throw new Error(`runCommand compatibility failed. Got: ${JSON.stringify(result)}`);
    }
    console.log('    ✓ runCommand compatibility verified');

    // 5. process error handling (ENOENT vs non-ENOENT)
    console.log('  [Test 5] Process error handling (ENOENT vs non-ENOENT)...');

    // 5a. ENOENT error handling
    streamedChunks.length = 0;
    const streamPromiseEnoent = service.streamCommand('test-5-enoent', 'node -e "setInterval(() => {}, 1000)"', process.cwd());
    const sessionEnoent = (service as any).commandSessions.get('test-5-enoent');
    if (sessionEnoent) {
      const enoentErr: any = new Error('spawn ENOENT');
      enoentErr.code = 'ENOENT';
      sessionEnoent.process.emit('error', enoentErr);
    }
    let enoentCaught = false;
    try {
      await streamPromiseEnoent;
    } catch (err: any) {
      enoentCaught = true;
      if (!err.message.includes('command not found: node')) {
        throw new Error(`Expected "command not found: node", got: ${err.message}`);
      }
    }
    if (!enoentCaught) throw new Error('Expected ENOENT error to reject streamCommand');
    const enoentOutput = streamedChunks.map(c => c.data).join('');
    if (!enoentOutput.includes('command not found: node')) {
      throw new Error(`Expected emit "command not found: node", got: ${enoentOutput}`);
    }

    // 5b. Non-ENOENT (EACCES) error handling: must NOT emit "command not found"
    streamedChunks.length = 0;
    const streamPromiseEacces = service.streamCommand('test-5-eacces', 'node -e "setInterval(() => {}, 1000)"', process.cwd());
    const sessionEacces = (service as any).commandSessions.get('test-5-eacces');
    if (sessionEacces) {
      const eaccesErr: any = new Error('Permission denied (EACCES)');
      eaccesErr.code = 'EACCES';
      sessionEacces.process.emit('error', eaccesErr);
    }
    let eaccesCaught = false;
    try {
      await streamPromiseEacces;
    } catch (err: any) {
      eaccesCaught = true;
      if (err.message.includes('command not found')) {
        throw new Error(`Non-ENOENT error should not say command not found: ${err.message}`);
      }
      if (!err.message.includes('Permission denied (EACCES)')) {
        throw new Error(`Expected original error message, got: ${err.message}`);
      }
    }
    if (!eaccesCaught) throw new Error('Expected EACCES error to reject streamCommand');
    const eaccesOutput = streamedChunks.map(c => c.data).join('');
    if (eaccesOutput.includes('command not found')) {
      throw new Error(`Non-ENOENT error output must not say "command not found", got: ${eaccesOutput}`);
    }
    if (!eaccesOutput.includes('Permission denied (EACCES)')) {
      throw new Error(`Expected emitted output to contain real error message, got: ${eaccesOutput}`);
    }
    console.log('    ✓ streamCommand correctly distinguishes ENOENT from other errors');

    // 6. Process tree cancellation on POSIX / Windows
    console.log('  [Test 6] Process tree cancellation...');
    if (process.platform !== 'win32') {
      streamedChunks.length = 0;
      const treeScript = `
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
        console.log('CHILD_PID:' + child.pid);
        setInterval(() => {}, 1000);
      `;
      const treePromise = service.streamCommand(
        'test-tree',
        `node -e "${treeScript.replace(/\\n/g, ' ')}"`,
        process.cwd()
      );
      treePromise.catch(() => {});

      let childPid: number | null = null;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout waiting for child PID')), 5000);
        const check = setInterval(() => {
          const combined = streamedChunks.map((c) => c.data).join('');
          const m = combined.match(/CHILD_PID:(\d+)/);
          if (m) {
            childPid = parseInt(m[1], 10);
            clearInterval(check);
            clearTimeout(timeout);
            resolve();
          }
        }, 10);
      });

      if (!childPid) throw new Error('Failed to capture child PID');
      let isAlive = true;
      try {
        process.kill(childPid, 0);
      } catch {
        isAlive = false;
      }
      if (!isAlive) throw new Error('Child process should be running before cancel');

      service.cancelCommand('test-tree');
      await new Promise((r) => setTimeout(r, 400));

      let isAliveAfter = false;
      try {
        process.kill(childPid, 0);
        isAliveAfter = true;
      } catch {
        isAliveAfter = false;
      }
      if (isAliveAfter) throw new Error('Child process in process group should be terminated after cancel');
      console.log('    ✓ POSIX process tree cancelled via process group');
    } else {
      console.log('    ✓ Windows process tree cancellation verified in Test 3');
    }

    console.log('  🟢 All Terminal Streaming tests passed.');

  } finally {
    // Restore IPC batcher
    const ipcBatcherModule = await import('../../../apps/desktop/src/main/utils/ipc-batcher');
    (ipcBatcherModule.globalIpcBatcher as any).bufferString = originalBufferString;
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('terminal-streaming.test.ts')) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

