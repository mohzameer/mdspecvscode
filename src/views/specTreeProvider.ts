import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MdspecClient, MdspecApiError, SpecEntry } from '../api/mdspecClient';
import { AuthManager } from '../auth/authManager';
import { startBrowserLogin } from '../auth/BrowserLogin';
import { ConfigManager } from '../config/configManager';
import { FileScanner } from '../scanner/fileScanner';
import { computeHash } from '../utils/hashUtils';

type TreeItemType =
  | 'project'
  | 'localSection'
  | 'remoteSection'
  | 'remoteProject'
  | 'trackedFile'
  | 'changedFile'
  | 'linkedFile'
  | 'untrackedFile'
  | 'remoteOnlySpec'
  | 'remoteLinkedSpec'
  | 'remoteError'
  | 'info'
  | 'openInWeb';

export class SpecTreeItem extends vscode.TreeItem {
  public remoteSpec?: SpecEntry;
  public projectSpecs?: SpecEntry[];

  constructor(
    public readonly label: string,
    public readonly itemType: TreeItemType,
    public readonly relativePath?: string,
    collapsibleState?: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState ?? vscode.TreeItemCollapsibleState.None);
    this.contextValue = itemType;

    switch (itemType) {
      case 'project':
        this.iconPath = new vscode.ThemeIcon('project');
        break;
      case 'localSection':
        this.iconPath = new vscode.ThemeIcon('folder-opened');
        break;
      case 'remoteSection':
        this.iconPath = new vscode.ThemeIcon('cloud');
        break;
      case 'trackedFile':
        this.iconPath = new vscode.ThemeIcon('file');
        this.checkboxState = vscode.TreeItemCheckboxState.Checked;
        break;
      case 'changedFile':
        this.iconPath = new vscode.ThemeIcon('file');
        this.description = '●';
        this.checkboxState = vscode.TreeItemCheckboxState.Checked;
        break;
      case 'linkedFile':
        this.iconPath = new vscode.ThemeIcon('link');
        this.checkboxState = vscode.TreeItemCheckboxState.Checked;
        break;
      case 'untrackedFile':
        this.iconPath = new vscode.ThemeIcon('file');
        this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
        break;
      case 'remoteProject':
        this.iconPath = new vscode.ThemeIcon('folder');
        break;
      case 'remoteOnlySpec':
        this.iconPath = new vscode.ThemeIcon('cloud-download');
        break;
      case 'remoteLinkedSpec':
        this.iconPath = new vscode.ThemeIcon('link');
        break;
      case 'remoteError':
        this.iconPath = new vscode.ThemeIcon('warning');
        break;
      case 'info':
        this.iconPath = new vscode.ThemeIcon('info');
        break;
      case 'openInWeb':
        this.iconPath = new vscode.ThemeIcon('link-external');
        break;
    }
  }
}

export class SpecTreeProvider implements vscode.TreeDataProvider<SpecTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SpecTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private fileScanner: FileScanner;
  private cachedRemoteSpecs: SpecEntry[] | null = null;
  private remoteFetchError: string | null = null;
  private remoteFetchUnauthorized = false;

  constructor(
    private configManager: ConfigManager,
    private client: MdspecClient,
    private authManager: AuthManager
  ) {
    this.fileScanner = new FileScanner();
  }

  refresh(): void {
    this.cachedRemoteSpecs = null;
    this.remoteFetchError = null;
    this.remoteFetchUnauthorized = false;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SpecTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SpecTreeItem): Promise<SpecTreeItem[]> {
    if (!element) {
      return this.getRootItems();
    }

    if (element.itemType === 'localSection') {
      return this.getLocalFileItems();
    }

    if (element.itemType === 'remoteSection') {
      return this.getRemoteOnlyItems();
    }

    if (element.itemType === 'remoteProject') {
      return this.buildSpecItems(element.projectSpecs ?? []);
    }

    return [];
  }

  private async getRootItems(): Promise<SpecTreeItem[]> {
    await this.configManager.load();
    const items: SpecTreeItem[] = [];

    // Project node
    const project = this.configManager.getProject();
    const projectLabel = project
      ? `Project: ${project.orgSlug}/${project.projectSlug}`
      : 'Project: Not linked';
    items.push(new SpecTreeItem(projectLabel, 'project'));

    // Local Specs section — always expanded
    items.push(
      new SpecTreeItem(
        'Local Specs',
        'localSection',
        undefined,
        vscode.TreeItemCollapsibleState.Expanded
      )
    );

    // Remote Only section — only shown when authenticated
    const isAuth = await this.authManager.isAuthenticated();
    if (isAuth) {
      const unlinkedCount = this.cachedRemoteSpecs
        ? this.getUnlinkedSpecs(this.cachedRemoteSpecs).length
        : undefined;

      const sectionLabel =
        unlinkedCount !== undefined && unlinkedCount > 0
          ? `Remote Only  (${unlinkedCount})`
          : 'Remote Only';

      items.push(
        new SpecTreeItem(
          sectionLabel,
          'remoteSection',
          undefined,
          vscode.TreeItemCollapsibleState.Collapsed
        )
      );
    }

    // Open in Web
    items.push(new SpecTreeItem('Open in Web', 'openInWeb'));

    // Prefetch remote specs in background when authenticated (so expand is instant)
    if (isAuth) {
      this.prefetchRemoteSpecs();
    }

    return items;
  }

  /** Best-effort background fetch of remote specs. Does not open login or retry on 401. */
  private prefetchRemoteSpecs(): void {
    if (this.cachedRemoteSpecs !== null) return;
    this.authManager.getToken().then(token => {
      if (!token) return;
      this.client.listSpecs(token).then(response => {
        this.cachedRemoteSpecs = response.specs;
        this.remoteFetchError = null;
        this.remoteFetchUnauthorized = false;
        const projectIds = [...new Set(response.specs.map(s => s.project_id))];
        console.log('[mdspec] listSpecs (prefetch):', response.specs.length, 'specs,', projectIds.length, 'projects:', projectIds);
        this._onDidChangeTreeData.fire();
      }).catch(() => {
        // Leave cache null and error for getRemoteOnlyItems to handle on expand
      });
    });
  }

  private async getLocalFileItems(): Promise<SpecTreeItem[]> {
    const config = this.configManager.getConfig();
    const allFiles = await this.fileScanner.scan(config.specRoot);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const items: SpecTreeItem[] = [];

    for (const relativePath of allFiles) {
      const tracked = this.configManager.isTracked(relativePath);

      if (tracked) {
        const entry = this.configManager.getTrackedFile(relativePath);
        let hasChanges = false;

        if (entry?.lastHash && workspaceRoot) {
          try {
            const fullPath = path.join(workspaceRoot, relativePath);
            const content = fs.readFileSync(fullPath, 'utf-8');
            const currentHash = computeHash(content);
            hasChanges = currentHash !== entry.lastHash;
          } catch {
            // File deleted — show as tracked without change indicator
          }
        } else if (!entry?.lastHash) {
          // Never synced yet — show sync button (unless linked)
          hasChanges = true;
        }

        const isLinked = entry?.isLinked === true;
        let itemType: 'trackedFile' | 'changedFile' | 'linkedFile';
        if (isLinked) {
          itemType = 'linkedFile';
        } else {
          itemType = hasChanges ? 'changedFile' : 'trackedFile';
        }
        const item = new SpecTreeItem(path.basename(relativePath), itemType, relativePath);
        if (isLinked) {
          item.description = 'linked';
        }
        items.push(item);
      } else {
        items.push(
          new SpecTreeItem(path.basename(relativePath), 'untrackedFile', relativePath)
        );
      }
    }

    return items;
  }

  private async getRemoteOnlyItems(): Promise<SpecTreeItem[]> {
    // Serve from cache
    if (this.cachedRemoteSpecs !== null) {
      return this.buildRemoteItems(this.cachedRemoteSpecs);
    }

    // If we had an error but user may have logged in, clear error and retry when we have a token
    let token = await this.authManager.getToken();
    if (this.remoteFetchError !== null && token) {
      this.remoteFetchError = null;
      this.remoteFetchUnauthorized = false;
    }
    if (this.remoteFetchError !== null) {
      const message = this.remoteFetchUnauthorized
        ? 'Session expired — sign in again'
        : 'Could not load remote specs — click Refresh to retry';
      return [new SpecTreeItem(message, 'remoteError')];
    }

    // Same as other features: ensure we have a token (opens browser login if needed)
    token = await this.authManager.requireToken();
    if (!token) {
      return [new SpecTreeItem('Sign in to view remote specs', 'info')];
    }

    // Fetch from API — no project_slug so backend returns all projects
    try {
      let response: Awaited<ReturnType<MdspecClient['listSpecs']>>;
      try {
        response = await this.client.listSpecs(token); // no 2nd arg = all projects
      } catch (err) {
        if (err instanceof MdspecApiError && err.statusCode === 401) {
          const newToken = await this.authManager.refreshAccessToken(this.client);
          if (newToken) {
            response = await this.client.listSpecs(newToken);
          } else {
            // Refresh failed (e.g. Already Used) — open browser login like sync/download
            try {
              await startBrowserLogin(this.authManager);
              token = await this.authManager.getToken();
              if (token) {
                response = await this.client.listSpecs(token);
              } else {
                throw err;
              }
            } catch (loginErr) {
              if (loginErr instanceof Error && loginErr.message === 'Login cancelled') {
                // Don't fire refresh here: it would re-call getChildren and requireToken() again, keeping loading on
                return [new SpecTreeItem('Sign in to view remote specs', 'info')];
              }
              throw err;
            }
          }
        } else {
          throw err;
        }
      }

      this.cachedRemoteSpecs = response.specs;
      this.remoteFetchError = null;
      this.remoteFetchUnauthorized = false;

      const projectIds = [...new Set(response.specs.map(s => s.project_id))];
      console.log('[mdspec] listSpecs response:', response.specs.length, 'specs,', projectIds.length, 'projects:', projectIds);

      // Refresh tree so section label and list update
      this._onDidChangeTreeData.fire();

      return this.buildRemoteItems(response.specs);
    } catch (err) {
      const is401 = err instanceof MdspecApiError && err.statusCode === 401;
      this.remoteFetchUnauthorized = is401;
      this.remoteFetchError = err instanceof Error ? err.message : 'Unknown error';
      console.error('[mdspec] Failed to fetch remote specs:', err);
      if (is401) {
        vscode.window
          .showErrorMessage('mdspec: Session expired. Sign in again to view remote specs.', 'Sign In')
          .then(choice => {
            if (choice === 'Sign In') {
              vscode.commands.executeCommand('mdspec.login');
            }
          });
      }
      return [
        new SpecTreeItem(
          this.remoteFetchUnauthorized ? 'Session expired — sign in again' : 'Could not load remote specs — click Refresh to retry',
          'remoteError'
        ),
      ];
    }
  }

  private getUnlinkedSpecs(allSpecs: SpecEntry[]): SpecEntry[] {
    const trackedFiles = this.configManager.getTrackedFiles();
    const linkedSpecIds = new Set(
      Object.values(trackedFiles)
        .map(f => f.specId)
        .filter((id): id is string => !!id)
    );
    return allSpecs.filter(spec => !linkedSpecIds.has(spec.id));
  }

  private getConfiguredProjectId(allSpecs: SpecEntry[]): string | undefined {
    const trackedFiles = this.configManager.getTrackedFiles();
    const linkedSpecIds = new Set(
      Object.values(trackedFiles).map(f => f.specId).filter((id): id is string => !!id)
    );
    return allSpecs.find(s => linkedSpecIds.has(s.id))?.project_id;
  }

  private buildRemoteItems(allSpecs: SpecEntry[]): SpecTreeItem[] {
    const unlinked = this.getUnlinkedSpecs(allSpecs);

    if (unlinked.length === 0) {
      return [new SpecTreeItem('All remote specs are linked locally', 'info')];
    }

    const configuredProjectId = this.getConfiguredProjectId(allSpecs);
    const configuredProject = this.configManager.getProject();

    const byProject = new Map<string, SpecEntry[]>();
    for (const spec of unlinked) {
      const group = byProject.get(spec.project_id) ?? [];
      group.push(spec);
      byProject.set(spec.project_id, group);
    }

    return Array.from(byProject.entries()).map(([projectId, specs]) => {
      const label =
        projectId === configuredProjectId && configuredProject
          ? `${configuredProject.orgSlug}/${configuredProject.projectSlug}`
          : `Project ${projectId.slice(0, 8)}`;

      const folderItem = new SpecTreeItem(
        label,
        'remoteProject',
        undefined,
        vscode.TreeItemCollapsibleState.Expanded
      );
      folderItem.projectSpecs = specs;
      return folderItem;
    });
  }

  private buildSpecItems(specs: SpecEntry[]): SpecTreeItem[] {
    return specs.map(spec => {
      const label = spec.file_name ?? spec.name;
      const itemType = spec.is_linked ? 'remoteLinkedSpec' : 'remoteOnlySpec';
      const item = new SpecTreeItem(label, itemType);
      item.remoteSpec = spec;
      item.description = spec.file_name ? spec.name : spec.slug;
      const tooltipLines = [
        `**${spec.name}**`,
        `Slug: \`${spec.slug}\``,
        `Revision: ${spec.latest_revision?.revision_number ?? 'N/A'}`,
        `Updated: ${new Date(spec.updated_at).toLocaleDateString()}`,
      ];
      if (spec.is_linked) {
        tooltipLines.push('_Linked spec — read only_');
      }
      item.tooltip = new vscode.MarkdownString(tooltipLines.join('\n\n'));
      return item;
    });
  }

  async handleCheckboxChange(
    items: ReadonlyArray<[SpecTreeItem, vscode.TreeItemCheckboxState]>
  ): Promise<void> {
    for (const [item, state] of items) {
      if (!item.relativePath) {
        continue;
      }

      if (state === vscode.TreeItemCheckboxState.Checked) {
        await this.configManager.trackFile(item.relativePath);
      } else {
        await this.configManager.untrackFile(item.relativePath);
      }
    }

    this.refresh();
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
