import { randomBytes, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { IncomingMessage } from 'http';
import type { BrowserWindow } from 'electron';
import { WebSocketServer, WebSocket } from 'ws';
import { IPC_EVENTS, type ClaudeIdeRequest, type ClaudeIdeToolResult } from '@peep/shared';

/**
 * Lets the Claude Code CLI talk to Synkro the way it talks to VS Code and JetBrains: an MCP server
 * over a local WebSocket, discovered through ~/.claude/ide/<port>.lock. Terminals started by Synkro
 * carry CLAUDE_CODE_SSE_PORT, so `claude` run inside them connects automatically and can see the
 * open file and selection, read diagnostics, and show its edits as diffs in our editor.
 */

const PROTOCOL_VERSION = '2025-03-26';
const LOCK_DIR = join(homedir(), '.claude', 'ide');

type JsonRpcMessage = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any };

const text = (value: string): ClaudeIdeToolResult => ({ content: [{ type: 'text', text: value }] });
const json = (value: unknown): ClaudeIdeToolResult => text(JSON.stringify(value, null, 2));

const TOOLS = [
  {
    name: 'openFile',
    description: 'Open a file in the editor and optionally select a range of text',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the file to open' },
        preview: { type: 'boolean', description: 'Whether to open the file in preview mode', default: false },
        startText: { type: 'string', description: 'Text pattern to find the start of the selection range' },
        endText: { type: 'string', description: 'Text pattern to find the end of the selection range' },
        selectToEndOfLine: { type: 'boolean', default: false },
        makeFrontmost: { type: 'boolean', default: true },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'openDiff',
    description: 'Open a diff view comparing the old file with new contents and wait for the user to accept or reject it',
    inputSchema: {
      type: 'object',
      properties: {
        old_file_path: { type: 'string' },
        new_file_path: { type: 'string' },
        new_file_contents: { type: 'string' },
        tab_name: { type: 'string' },
      },
      required: ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name'],
    },
  },
  { name: 'getCurrentSelection', description: 'Get the current text selection in the active editor', inputSchema: { type: 'object', properties: {} } },
  { name: 'getLatestSelection', description: 'Get the most recent text selection, even if the editor lost focus', inputSchema: { type: 'object', properties: {} } },
  { name: 'getOpenEditors', description: 'Get information about the currently open editors', inputSchema: { type: 'object', properties: {} } },
  { name: 'getWorkspaceFolders', description: 'Get all workspace folders currently open in the IDE', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'getDiagnostics',
    description: 'Get language diagnostics (errors, warnings) from the editor',
    inputSchema: { type: 'object', properties: { uri: { type: 'string', description: 'Optional file URI; all files when omitted' } } },
  },
  {
    name: 'checkDocumentDirty',
    description: 'Check whether a document has unsaved changes',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
  },
  {
    name: 'saveDocument',
    description: 'Save a document with unsaved changes',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
  },
  {
    name: 'close_tab',
    description: 'Close a tab by name',
    inputSchema: { type: 'object', properties: { tab_name: { type: 'string' } }, required: ['tab_name'] },
  },
  { name: 'closeAllDiffTabs', description: 'Close all diff tabs in the editor', inputSchema: { type: 'object', properties: {} } },
];

/** Tools answered from the editor state in the renderer. */
const RENDERER_TOOLS = new Set(TOOLS.map((t) => t.name).filter((n) => n !== 'getWorkspaceFolders'));

export class ClaudeIdeServer {
  private wss: WebSocketServer | null = null;
  private port = 0;
  private readonly authToken = randomBytes(16).toString('hex');
  private lockPath: string | null = null;
  private workspaceFolders: string[] = [];
  private mainWindow: BrowserWindow | null = null;
  private readonly clients = new Set<WebSocket>();
  private readonly pending = new Map<string, (result: ClaudeIdeToolResult) => void>();

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /** The port Claude connects to, or 0 before the server is listening. */
  getPort(): number {
    return this.port;
  }

  isConnected(): boolean {
    return this.clients.size > 0;
  }

  async start(): Promise<void> {
    if (this.wss) return;
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: ({ req }: { req: IncomingMessage }) => req.headers['x-claude-code-ide-authorization'] === this.authToken,
    });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    this.wss = wss;
    const address = wss.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    wss.on('connection', (socket) => this.onConnection(socket));
    this.removeStaleLocks();
    this.writeLock();
  }

  stop(): void {
    for (const resolve of this.pending.values()) resolve(text('DIFF_REJECTED'));
    this.pending.clear();
    for (const client of this.clients) client.terminate();
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
    if (this.lockPath) {
      try { unlinkSync(this.lockPath); } catch { /* already gone */ }
      this.lockPath = null;
    }
  }

  setWorkspaceFolders(folders: string[]): void {
    this.workspaceFolders = folders.filter(Boolean);
    if (this.wss) this.writeLock();
  }

  /** Forwards an editor event (selection_changed, at_mentioned) to every connected Claude. */
  notify(method: string, params: unknown): void {
    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  /** The renderer's answer to a tool call it was asked to handle. */
  respond(requestId: string, result: ClaudeIdeToolResult): void {
    const resolve = this.pending.get(requestId);
    if (!resolve) return;
    this.pending.delete(requestId);
    resolve(result);
  }

  private writeLock(): void {
    mkdirSync(LOCK_DIR, { recursive: true });
    this.lockPath = join(LOCK_DIR, `${this.port}.lock`);
    writeFileSync(this.lockPath, JSON.stringify({
      pid: process.pid,
      workspaceFolders: this.workspaceFolders,
      ideName: 'Synkro',
      transport: 'ws',
      runningInWindows: process.platform === 'win32',
      authToken: this.authToken,
    }));
  }

  /** Drops lock files left by Synkro windows that crashed, so Claude doesn't offer dead IDEs. */
  private removeStaleLocks(): void {
    if (!existsSync(LOCK_DIR)) return;
    for (const name of readdirSync(LOCK_DIR)) {
      if (!name.endsWith('.lock')) continue;
      const file = join(LOCK_DIR, name);
      try {
        const lock = JSON.parse(readFileSync(file, 'utf8'));
        if (lock.ideName !== 'Synkro' || typeof lock.pid !== 'number') continue;
        try { process.kill(lock.pid, 0); } catch { unlinkSync(file); }
      } catch { /* unreadable lock: not ours to judge */ }
    }
  }

  private onConnection(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
    socket.on('message', (raw) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      void this.handle(message).then((reply) => {
        if (reply && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply));
      });
    });
  }

  private async handle(message: JsonRpcMessage): Promise<object | null> {
    const { id, method, params } = message;
    // Notifications (no id) need no reply.
    if (id === undefined || id === null) return null;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, msg: string) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'synkro', version: '1.0.0' },
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'prompts/list':
        return ok({ prompts: [] });
      case 'resources/list':
        return ok({ resources: [] });
      case 'tools/call': {
        const name: string = params?.name;
        const args = params?.arguments ?? {};
        try {
          return ok(await this.callTool(name, args));
        } catch (error) {
          return ok({ content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<ClaudeIdeToolResult> {
    if (name === 'getWorkspaceFolders') {
      return json({
        success: true,
        folders: this.workspaceFolders.map((path) => ({
          name: path.split(/[\\/]/).pop() ?? path,
          uri: `file:///${path.replace(/\\/g, '/').replace(/^\//, '')}`,
          path,
        })),
        rootPath: this.workspaceFolders[0] ?? null,
      });
    }
    if (!RENDERER_TOOLS.has(name)) throw new Error(`Unknown tool: ${name}`);
    if (!this.mainWindow || this.mainWindow.isDestroyed()) throw new Error('Synkro window is not available');

    const request: ClaudeIdeRequest = { requestId: randomUUID(), tool: name, args };
    return new Promise<ClaudeIdeToolResult>((resolve) => {
      this.pending.set(request.requestId, resolve);
      this.mainWindow!.webContents.send(IPC_EVENTS.CLAUDE_IDE_REQUEST, request);
      // openDiff waits for the user; everything else should answer right away.
      if (name !== 'openDiff') {
        setTimeout(() => this.respond(request.requestId, text('Error: Synkro did not answer in time')), 15_000);
      }
    });
  }
}
