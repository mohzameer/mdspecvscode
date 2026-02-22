import * as vscode from 'vscode';
import { startBrowserLogin } from './BrowserLogin';
import { MdspecClient } from '../api/mdspecClient';

const ACCESS_TOKEN_KEY = 'mdspec.accessToken';
const REFRESH_TOKEN_KEY = 'mdspec.refreshToken';
const USER_EMAIL_KEY = 'mdspec.userEmail';

export class AuthManager {
  private secretStorage: vscode.SecretStorage;
  private globalState: vscode.Memento;
  private _onDidChangeAuth = new vscode.EventEmitter<boolean>();
  readonly onDidChangeAuth = this._onDidChangeAuth.event;
  /** Single refresh in flight; concurrent 401s await this to avoid refresh-token race. */
  private refreshPromise: Promise<string | undefined> | null = null;
  /** In-memory access token so getToken() returns the latest after refresh/login even if secret storage is briefly stale. */
  private cachedAccessToken: string | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.secretStorage = context.secrets;
    this.globalState = context.globalState;
  }

  async saveSession(
    accessToken: string,
    refreshToken: string,
    email: string,
    options?: { skipAuthEvent?: boolean }
  ): Promise<void> {
    console.log('[mdspec] Saving NEW refresh token:', refreshToken);
    this.cachedAccessToken = accessToken;
    await this.secretStorage.store(ACCESS_TOKEN_KEY, accessToken);
    await this.secretStorage.store(REFRESH_TOKEN_KEY, refreshToken);
    await this.globalState.update(USER_EMAIL_KEY, email);
    if (!options?.skipAuthEvent) {
      this._onDidChangeAuth.fire(true);
    }
  }

  async getUserEmail(): Promise<string | undefined> {
    return this.globalState.get<string>(USER_EMAIL_KEY);
  }

  async logout(): Promise<void> {
    this.cachedAccessToken = undefined;
    await this.secretStorage.delete(ACCESS_TOKEN_KEY);
    await this.secretStorage.delete(REFRESH_TOKEN_KEY);
    await this.globalState.update(USER_EMAIL_KEY, undefined);
    this._onDidChangeAuth.fire(false);
    vscode.window.showInformationMessage('mdspec: Signed out.');
  }

  async getToken(): Promise<string | undefined> {
    if (this.cachedAccessToken !== undefined) {
      return this.cachedAccessToken;
    }
    const token = await this.secretStorage.get(ACCESS_TOKEN_KEY);
    if (token) {
      this.cachedAccessToken = token;
    }
    return token;
  }

  async isAuthenticated(): Promise<boolean> {
    const token = await this.getToken();
    return !!token;
  }

  async requireToken(): Promise<string | undefined> {
    let token = await this.getToken();
    if (!token) {
      try {
        await startBrowserLogin(this);
        token = await this.getToken();
      } catch (err) {
        if (err instanceof Error && err.message !== 'Login cancelled') {
          vscode.window.showErrorMessage(`mdspec: Login failed — ${err.message}`);
        }
        return undefined;
      }
    }
    return token;
  }

  async refreshAccessToken(client: MdspecClient): Promise<string | undefined> {
    if (this.refreshPromise) {
      console.log('[mdspec] Refresh token: waiting for in-flight refresh');
      return this.refreshPromise;
    }
    console.log('[mdspec] Refresh token attempt');
    this.refreshPromise = this.doRefresh(client);
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(client: MdspecClient): Promise<string | undefined> {
    const refreshToken = await this.secretStorage.get(REFRESH_TOKEN_KEY);
    console.log('[mdspec] Reading refresh token:', refreshToken);
    if (!refreshToken) {
      console.log('[mdspec] No refresh token stored, cannot refresh');
      return undefined;
    }
    try {
      console.log('[mdspec] Using refresh token:', refreshToken);
      console.log('[mdspec] Attempting token refresh...');
      const response = await client.refreshSession(refreshToken);
      await this.saveSession(
        response.session.access_token,
        response.session.refresh_token,
        response.user.email,
        { skipAuthEvent: true }
      );
      console.log('[mdspec] Token refreshed successfully');
      console.log('[mdspec] New refresh token:', response.session.refresh_token);
      return response.session.access_token;
    } catch (err) {
      console.error('[mdspec] Token refresh failed:', err);
      return undefined;
    }
  }

  dispose(): void {
    this._onDidChangeAuth.dispose();
  }
}
