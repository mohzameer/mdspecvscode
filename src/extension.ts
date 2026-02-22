import * as vscode from 'vscode';
import { MdspecClient } from './api/mdspecClient';
import { AuthManager } from './auth/authManager';
import { startBrowserLogin } from './auth/BrowserLogin';
import { ConfigManager } from './config/configManager';
import { SyncEngine } from './sync/syncEngine';
import { SpecTreeProvider, SpecTreeItem } from './views/specTreeProvider';

export function activate(context: vscode.ExtensionContext) {
  // Core services
  const client = new MdspecClient();
  const authManager = new AuthManager(context);
  const configManager = new ConfigManager();
  const syncEngine = new SyncEngine(client, authManager, configManager);
  const treeProvider = new SpecTreeProvider(configManager, client, authManager);

  // Register tree view
  const treeView = vscode.window.createTreeView('mdspecSidebar', {
    treeDataProvider: treeProvider,
    manageCheckboxStateManually: true,
  });

  // Handle checkbox changes (track/untrack files)
  treeView.onDidChangeCheckboxState(async (e) => {
    await treeProvider.handleCheckboxChange(e.items);
  });

  // --- Commands ---

  // Login
  context.subscriptions.push(
    vscode.commands.registerCommand('mdspec.login', async () => {
      if (await authManager.isAuthenticated()) {
        const email = await authManager.getUserEmail();
        vscode.window.showInformationMessage(
          `mdspec: Already signed in as ${email ?? 'unknown'}`
        );
        return;
      }
      try {
        await startBrowserLogin(authManager);
        treeProvider.refresh();
      } catch (err) {
        if (err instanceof Error && err.message !== 'Login cancelled') {
          vscode.window.showErrorMessage(`mdspec: Login failed — ${err.message}`);
        }
      }
    })
  );

  // Logout
  context.subscriptions.push(
    vscode.commands.registerCommand('mdspec.logout', async () => {
      await authManager.logout();
      treeProvider.refresh();
    })
  );

  // Sync single file (triggered from tree item inline button)
  context.subscriptions.push(
    vscode.commands.registerCommand('mdspec.syncFile', async (item?: SpecTreeItem) => {
      if (!item?.relativePath) {
        vscode.window.showWarningMessage('mdspec: No file selected to sync.');
        return;
      }

      const result = await syncEngine.syncFile(item.relativePath);
      if (result.status === 'success' || result.status === 'no-change') {
        treeProvider.refresh();
      }
    })
  );

  // Download spec (triggered from tree item inline button)
  context.subscriptions.push(
    vscode.commands.registerCommand('mdspec.downloadSpec', async (item?: SpecTreeItem) => {
      if (!item?.relativePath) {
        vscode.window.showWarningMessage('mdspec: No file selected to download.');
        return;
      }

      const result = await syncEngine.downloadSpec(item.relativePath);
      if (result.status === 'success') {
        treeProvider.refresh();
      }
    })
  );

  // Unlink (remove link on server, untrack locally; local file is kept)
  context.subscriptions.push(
    vscode.commands.registerCommand('mdspec.unlinkSpec', async (item?: SpecTreeItem) => {
      if (!item?.relativePath) {
        vscode.window.showWarningMessage('mdspec: No file selected.');
        return;
      }
      const result = await syncEngine.unlinkSpec(item.relativePath);
      if (result.status === 'success') {
        treeProvider.refresh();
      }
    })
  );

  // Link remote spec — prompt user for local path, download, add to config
  context.subscriptions.push(
    vscode.commands.registerCommand('mdspec.linkRemoteSpec', async (item?: SpecTreeItem) => {
      if (!item?.remoteSpec) {
        vscode.window.showWarningMessage('mdspec: No remote spec selected.');
        return;
      }

      const { slug, id: specId, name: specName, project_id: projectId } = item.remoteSpec;
      console.log('[mdspec] linkRemoteSpec selected:', { slug, specId, specName, projectId });

      await configManager.load();
      const specRoot = configManager.getSpecRoot() ?? '.';
      const suggested = `${specRoot}/${slug}.md`.replace(/^\.\//, '');

      const localPath = await vscode.window.showInputBox({
        prompt: `Save "${specName}" as (relative to workspace root)`,
        value: suggested,
        ignoreFocusOut: true,
        validateInput: (val) => {
          if (!val.trim()) { return 'Path cannot be empty'; }
          if (!val.endsWith('.md')) { return 'File must have a .md extension'; }
          return null;
        },
      });

      if (!localPath) {
        return;
      }

      const result = await syncEngine.linkRemoteSpec(slug, specId, specName, localPath.trim(), projectId);
      if (result.status === 'success') {
        treeProvider.refresh();
      }
    })
  );

  // Refresh tree
  context.subscriptions.push(
    vscode.commands.registerCommand('mdspec.refresh', () => {
      treeProvider.refresh();
    })
  );

  // Open in Web
  context.subscriptions.push(
    vscode.commands.registerCommand('mdspec.openInWeb', async () => {
      await configManager.load();
      const project = configManager.getProject();
      const baseUrl = vscode.workspace
        .getConfiguration('mdspec')
        .get<string>('apiBaseUrl', 'https://mdspec.dev/api');

      // Strip /api from base URL to get the web URL
      const webUrl = baseUrl.replace(/\/api$/, '');

      if (project) {
        vscode.env.openExternal(vscode.Uri.parse(`${webUrl}/${project.orgSlug}/${project.projectSlug}`));
      } else {
        vscode.env.openExternal(vscode.Uri.parse(webUrl));
      }
    })
  );

  // Set Project
  context.subscriptions.push(
    vscode.commands.registerCommand('mdspec.setProject', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter your mdspec project (org-slug/project-slug)',
        placeHolder: 'my-org/my-project',
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value) { return null; }
          const parts = value.split('/');
          if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
            return 'Format must be org-slug/project-slug';
          }
          return null;
        },
      });

      if (!input) {
        return;
      }

      const [orgSlug, projectSlug] = input.split('/').map(s => s.trim());
      await configManager.load();
      await configManager.setProject(orgSlug, projectSlug);
      treeProvider.refresh();
      vscode.window.showInformationMessage(`mdspec: Project set to ${orgSlug}/${projectSlug}`);
    })
  );

  // --- File watcher: refresh tree on .md file save ---
  const mdWatcher = vscode.workspace.createFileSystemWatcher('**/*.md');
  mdWatcher.onDidChange(() => treeProvider.refresh());
  mdWatcher.onDidCreate(() => treeProvider.refresh());

  // --- Auth change: refresh tree ---
  authManager.onDidChangeAuth(() => treeProvider.refresh());

  // --- Initial load ---
  configManager.load().then(() => treeProvider.refresh());

  // Register disposables
  context.subscriptions.push(treeView);
  context.subscriptions.push(mdWatcher);
  context.subscriptions.push({
    dispose: () => {
      treeProvider.dispose();
      authManager.dispose();
    },
  });
}

export function deactivate() {
  // Nothing to clean up
}
