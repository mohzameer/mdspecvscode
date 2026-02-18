import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config/configManager';
import { FileScanner } from '../scanner/fileScanner';
import { computeHash } from '../utils/hashUtils';

type TreeItemType = 'project' | 'trackedFile' | 'changedFile' | 'untrackedFile' | 'info' | 'openInWeb';

export class SpecTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly itemType: TreeItemType,
    public readonly relativePath?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = itemType;

    switch (itemType) {
      case 'project':
        this.iconPath = new vscode.ThemeIcon('project');
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

  constructor(private configManager: ConfigManager) {
    this.fileScanner = new FileScanner();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SpecTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SpecTreeItem): Promise<SpecTreeItem[]> {
    if (element) {
      return [];
    }

    const items: SpecTreeItem[] = [];

    // Load config
    await this.configManager.load();
    const config = this.configManager.getConfig();

    // Project node
    const project = this.configManager.getProject();
    const projectLabel = project
      ? `Project: ${project.orgSlug}/${project.projectSlug}`
      : 'Project: Not linked';
    items.push(new SpecTreeItem(projectLabel, 'project'));

    // Scan for .md files
    const allFiles = await this.fileScanner.scan(config.specRoot);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

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
            // File may have been deleted; show as tracked without change indicator
          }
        } else if (!entry?.lastHash) {
          // Never synced yet — treat as changed so sync button appears
          hasChanges = true;
        }

        const itemType = hasChanges ? 'changedFile' : 'trackedFile';
        items.push(new SpecTreeItem(path.basename(relativePath), itemType, relativePath));
      } else {
        items.push(new SpecTreeItem(path.basename(relativePath), 'untrackedFile', relativePath));
      }
    }

    // Open in Web node
    items.push(new SpecTreeItem('Open in Web', 'openInWeb'));

    return items;
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
