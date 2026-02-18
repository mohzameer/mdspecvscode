import * as vscode from 'vscode';
import * as http from 'http';

export interface SessionRecipient {
  saveSession(accessToken: string, refreshToken: string, email: string): Promise<void>;
}

function getWebBaseUrl(): string {
  const apiBaseUrl = vscode.workspace
    .getConfiguration('mdspec')
    .get<string>('apiBaseUrl', 'https://mdspec.dev/api');
  return apiBaseUrl.replace(/\/api$/, '');
}

export async function startBrowserLogin(recipient: SessionRecipient): Promise<void> {
  return new Promise((resolve, reject) => {
    const webBaseUrl = getWebBaseUrl();

    const server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', webBaseUrl);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url === '/callback') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const { token, refreshToken, email } = JSON.parse(body);
            if (!token || !email) {
              res.writeHead(400);
              res.end('Bad request');
              reject(new Error('Invalid callback: missing token or email'));
              return;
            }
            await recipient.saveSession(token, refreshToken ?? '', email);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));

            vscode.window.showInformationMessage(`mdspec: Logged in as ${email}`);
            cleanup();
            resolve();
          } catch (err) {
            res.writeHead(400);
            res.end('Bad request');
            reject(err);
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const ephemeralPort = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152;
    let timeoutId: NodeJS.Timeout | undefined;
    let resolved = false;

    function cleanup() {
      if (resolved) return;
      resolved = true;
      if (timeoutId) clearTimeout(timeoutId);
      server.close();
    }

    server.listen(ephemeralPort, '127.0.0.1', () => {
      const loginUrl = `${webBaseUrl}/auth/vscode?port=${ephemeralPort}`;
      vscode.env.openExternal(vscode.Uri.parse(loginUrl));

      vscode.window
        .showInformationMessage('mdspec: A browser window has opened. Please sign in.', 'Cancel')
        .then((selection) => {
          if (selection === 'Cancel') {
            cleanup();
            reject(new Error('Login cancelled'));
          }
        });

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Login timed out'));
      }, 5 * 60 * 1000);
    });

    server.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        if (timeoutId) clearTimeout(timeoutId);
        reject(err);
      }
    });
  });
}
