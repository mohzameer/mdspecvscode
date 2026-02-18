import * as vscode from 'vscode';
import { startBrowserLogin } from './BrowserLogin';

const ACCESS_TOKEN_KEY = 'mdspec.accessToken';
const REFRESH_TOKEN_KEY = 'mdspec.refreshToken';
const USER_EMAIL_KEY = 'mdspec.userEmail';

export class AuthManager {
  private secretStorage: vscode.SecretStorage;
  private globalState: vscode.Memento;
  private _onDidChangeAuth = new vscode.EventEmitter<boolean>();
  readonly onDidChangeAuth = this._onDidChangeAuth.event;

  constructor(context: vscode.ExtensionContext) {
    this.secretStorage = context.secrets;
    this.globalState = context.globalState;
  }

  async saveSession(
    accessToken: string,
    refreshToken: string,
    email: string
  ): Promise<void> {
    await this.secretStorage.store(ACCESS_TOKEN_KEY, accessToken);
    await this.secretStorage.store(REFRESH_TOKEN_KEY, refreshToken);
    await this.globalState.update(USER_EMAIL_KEY, email);
    this._onDidChangeAuth.fire(true);
  }

  async getUserEmail(): Promise<string | undefined> {
    return this.globalState.get<string>(USER_EMAIL_KEY);
  }

  async logout(): Promise<void> {
    await this.secretStorage.delete(ACCESS_TOKEN_KEY);
    await this.secretStorage.delete(REFRESH_TOKEN_KEY);
    await this.globalState.update(USER_EMAIL_KEY, undefined);
    this._onDidChangeAuth.fire(false);
    vscode.window.showInformationMessage('mdspec: Signed out.');
  }

  async getToken(): Promise<string | undefined> {
    return this.secretStorage.get(ACCESS_TOKEN_KEY);
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

  dispose(): void {
    this._onDidChangeAuth.dispose();
  }
}
