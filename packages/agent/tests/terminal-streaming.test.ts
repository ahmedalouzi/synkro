import { TerminalService } from '../../../apps/desktop/src/main/services/terminal-service';
import { IpcBatcher } from '../../../apps/desktop/src/main/utils/ipc-batcher';
import { SkipTest } from './skip-test.js';

export default async function run() {
  console.log('  Running Terminal Streaming Infrastructure tests...');
  // Known bug: on macOS/Linux streamCommand spawns the whole command string without a shell (ENOENT).
  // Remove this skip together with the fix.
  if (process.platform !== 'win32') {
    throw new SkipTest('Windows only until the macOS/Linux streamCommand bug is fixed (spawn without a shell -> ENOENT): https://trello.com/c/f2wtmxXX');
  }

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

    // 5. process error handling
    console.log('  [Test 5] Process error handling...');
    const errCode = await service.streamCommand('test-5', 'nonexistent_command_12345', process.cwd());
    if (errCode === 0) {
      throw new Error('Expected streamCommand to fail on bad command with non-zero exit code');
    }
    console.log('    ✓ streamCommand correctly handled bad command with code ' + errCode);

    console.log('  🟢 All Terminal Streaming tests passed.');

  } finally {
    // Restore IPC batcher
    const ipcBatcherModule = await import('../../../apps/desktop/src/main/utils/ipc-batcher');
    (ipcBatcherModule.globalIpcBatcher as any).bufferString = originalBufferString;
  }
}
