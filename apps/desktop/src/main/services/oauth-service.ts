import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { shell, type BrowserWindow } from 'electron';
import type { DatabaseService } from './db';
import { resolveGatewayUrl } from '../build-config';

export interface OAuthResult {
  success: boolean;
  error?: string;
}

export class OAuthService {
  private activeServer: http.Server | null = null;
  private activeTimeout: NodeJS.Timeout | null = null;
  private cancelCurrent: (() => void) | null = null;

  constructor(
    private db: DatabaseService,
    private getMainWindow: () => BrowserWindow | null
  ) {}

  private cleanUp(): void {
    if (this.activeTimeout) {
      clearTimeout(this.activeTimeout);
      this.activeTimeout = null;
    }
    if (this.activeServer) {
      try {
        this.activeServer.close();
      } catch {
        // ignore
      }
      this.activeServer = null;
    }
    this.cancelCurrent = null;
  }

  cancelOAuth(): void {
    if (this.cancelCurrent) {
      this.cancelCurrent();
    }
  }

  async startOAuth(provider: 'google' | 'github'): Promise<OAuthResult> {
    // Cancel any existing pending flow
    this.cleanUp();

    const providerName = provider === 'google' ? 'Google' : 'GitHub';
    const settings = this.db.getSettingsRaw();
    const gatewayUrl = resolveGatewayUrl(settings.gatewayUrl);

    return new Promise<OAuthResult>((resolve) => {
      let isResolved = false;
      const safeResolve = (res: OAuthResult) => {
        if (isResolved) return;
        isResolved = true;
        this.cleanUp();
        resolve(res);
      };

      this.cancelCurrent = () => {
        safeResolve({ success: false, error: 'Sign in was cancelled.' });
      };

      // 1. Create loopback HTTP server
      const server = http.createServer(async (req, res) => {
        const reqUrl = req.url || '/';

        // Ignore background noise like favicon.ico without shutting down the listener
        if (!reqUrl.startsWith('/callback')) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }

        try {
          const parsed = new URL(reqUrl, 'http://127.0.0.1');
          const code = parsed.searchParams.get('code');
          const error = parsed.searchParams.get('error');

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.renderHtml('Authentication Failed', error, false));
            safeResolve({ success: false, error });
            return;
          }

          if (!code) {
            const msg = 'Missing authorization code in callback.';
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.renderHtml('Authentication Failed', msg, false));
            safeResolve({ success: false, error: msg });
            return;
          }

          // Exchange one-time code with server
          const exchangeRes = await fetch(`${gatewayUrl}/v1/auth/oauth/exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
          });

          const data = await exchangeRes.json();
          if (!exchangeRes.ok) {
            const err = data.error || 'Failed to exchange authentication code.';
            res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.renderHtml('Authentication Failed', err, false));
            safeResolve({ success: false, error: err });
            return;
          }

          // Save session tokens to database
          await this.db.setSettings({
            sessionToken: data.sessionToken,
            refreshToken: data.refreshToken,
          });

          // Focus the application window
          const win = this.getMainWindow();
          if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.renderHtml('Signed in successfully', 'You can close this tab and return to Atomvs.', true));
          safeResolve({ success: true });
        } catch (err: any) {
          console.error('[OAuth Loopback Request Error]', err);
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.renderHtml('Authentication Error', 'An unexpected error occurred.', false));
          safeResolve({ success: false, error: err.message || 'Authentication failed.' });
        }
      });

      server.on('error', (err) => {
        console.error('[OAuth Loopback Server Error]', err);
        safeResolve({ success: false, error: 'Failed to start local authentication listener.' });
      });

      // Bind to 127.0.0.1 on ephemeral port 0
      server.listen(0, '127.0.0.1', async () => {
        this.activeServer = server;
        const addr = server.address() as AddressInfo;
        const port = addr.port;
        const clientReturnUrl = `http://127.0.0.1:${port}/callback`;

        // 120s timeout
        this.activeTimeout = setTimeout(() => {
          safeResolve({ success: false, error: 'Sign in timed out. Please try again.' });
        }, 120 * 1000);

        const startUrl = `${gatewayUrl}/v1/auth/oauth/${provider}/start?client_return_url=${encodeURIComponent(clientReturnUrl)}`;

        // Preflight probe to gracefully catch 503 or server errors before opening the browser
        try {
          const probeRes = await fetch(startUrl, { redirect: 'manual' });
          if (probeRes.status === 503) {
            const errData = await probeRes.json().catch(() => ({}));
            safeResolve({
              success: false,
              error: errData.error || `${providerName} sign-in is not configured on this server.`,
            });
            return;
          }
          if (probeRes.status >= 400 && probeRes.status !== 404) {
            const errData = await probeRes.json().catch(() => ({}));
            safeResolve({
              success: false,
              error: errData.error || `Server rejected sign-in request (status ${probeRes.status}).`,
            });
            return;
          }
        } catch (probeErr: any) {
          // If server is unreachable
          safeResolve({
            success: false,
            error: `Cannot connect to server at ${gatewayUrl}. Please ensure the backend is running.`,
          });
          return;
        }

        // Open system browser to start URL
        shell.openExternal(startUrl).catch((err) => {
          console.error('[OAuth shell.openExternal error]', err);
          safeResolve({ success: false, error: 'Failed to open system browser.' });
        });
      });
    });
  }

  private renderHtml(title: string, message: string, success: boolean): string {
    const accent = success ? '#58a6ff' : '#f85149';
    const border = success ? '#30363d' : '#da3633';
    const escapedMsg = message
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Atomvs — ${title}</title>
  <style>
    body {
      background: #0d1117;
      color: #c9d1d9;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      padding: 16px;
      box-sizing: border-box;
    }
    .card {
      text-align: center;
      padding: 40px 32px;
      background: #161b22;
      border: 1px solid ${border};
      border-radius: 12px;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    h1 {
      color: ${accent};
      font-size: 22px;
      margin: 0 0 12px;
      font-weight: 600;
    }
    p {
      color: #8b949e;
      font-size: 14px;
      line-height: 1.6;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${escapedMsg}</p>
  </div>
</body>
</html>`;
  }
}

