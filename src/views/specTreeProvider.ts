import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MdspecClient, SpecEntry } from '../api/mdspecClient';
import { AuthManager } from '../auth/authManager';
import { ConfigManager } from '../config/configManager';
import { FileScanner } from '../scanner/fileScanner';
import { computeHash } from '../utils/hashUtils';

type TreeItemType =
  | 'project'
  | 'localSection'
  | 'remoteSection'
  | 'trackedFile'
  | 'changedFile'
  | 'untrackedFile'
  | 'remoteOnlySpec'
  | 'remoteError'
  | 'info'
  | 'openInWeb';

export class SpecTreeItem extends vscode.TreeItem {
  public remoteSpec?: SpecEntry;

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
      case 'untrackedFile':
        this.iconPath = new vscode.ThemeIcon('file');
        this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
        break;
      case 'remoteOnlySpec':
        this.iconPath = new vscode.ThemeIcon('cloud-download');
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

    return items;
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
          // Never synced yet — show sync button
          hasChanges = true;
        }

        const itemType = hasChanges ? 'changedFile' : 'trackedFile';
        items.push(new SpecTreeItem(path.basename(relativePath), itemType, relativePath));
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

    if (this.remoteFetchError !== null) {
      return [
        new SpecTreeItem(
          'Could not load remote specs — click Refresh to retry',
          'remoteError'
        ),
      ];
    }

    // Fetch from API
    try {
      const token = await this.authManager.getToken();
      if (!token) {
        return [new SpecTreeItem('Sign in to view remote specs', 'info')];
      }

      const response = await this.client.listSpecs(token);
      this.cachedRemoteSpecs = response.specs;
      this.remoteFetchError = null;

      // Defer a root refresh so the section label count updates
      setTimeout(() => this._onDidChangeTreeData.fire(), 0);

      return this.buildRemoteItems(response.specs);
    } catch (err) {
      this.remoteFetchError = err instanceof Error ? err.message : 'Unknown error';
      return [
        new SpecTreeItem(
          'Could not load remote specs — click Refresh to retry',
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

  private buildRemoteItems(allSpecs: SpecEntry[]): SpecTreeItem[] {
    const unlinked = this.getUnlinkedSpecs(allSpecs);

    if (unlinked.length === 0) {
      return [new SpecTreeItem('All remote specs are linked locally', 'info')];
    }

    return unlinked.map(spec => {
      const item = new SpecTreeItem(spec.name, 'remoteOnlySpec');
      item.remoteSpec = spec;
      item.description = spec.slug;
      item.tooltip = new vscode.MarkdownString(
        [
          `**${spec.name}**`,
          `Slug: \`${spec.slug}\``,
          `Revision: ${spec.latest_revision?.revision_number ?? 'N/A'}`,
          `Updated: ${new Date(spec.updated_at).toLocaleDateString()}`,
        ].join('\n\n')
      );
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
