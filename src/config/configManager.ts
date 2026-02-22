import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface TrackedFileEntry {
  slug?: string;
  specId?: string;
  lastHash?: string;
  isLinked?: boolean;
}

export interface MdspecConfig {
  orgSlug?: string;
  projectSlug?: string;
  specRoot?: string;
  trackedFiles: Record<string, TrackedFileEntry>;
}

const CONFIG_DIR = '.mdspec';
const CONFIG_FILE = 'config.json';

export class ConfigManager {
  private config: MdspecConfig;
  private configPath: string;

  constructor() {
    this.config = { trackedFiles: {} };
    this.configPath = '';
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  async load(): Promise<MdspecConfig> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      this.config = { trackedFiles: {} };
      return this.config;
    }

    this.configPath = path.join(root, CONFIG_DIR, CONFIG_FILE);

    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      this.config = JSON.parse(raw);
      if (!this.config.trackedFiles) {
        this.config.trackedFiles = {};
      }
    } catch {
      this.config = { trackedFiles: {} };
    }

    return this.config;
  }

  async save(): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return;
    }

    const dirPath = path.join(root, CONFIG_DIR);
    this.configPath = path.join(dirPath, CONFIG_FILE);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  getConfig(): MdspecConfig {
    return this.config;
  }

  /**
   * Returns orgSlug/projectSlug. Config file takes priority,
   * falls back to the mdspec.project VS Code setting.
   */
  getProject(): { orgSlug: string; projectSlug: string } | undefined {
    // Config file first
    if (this.config.orgSlug && this.config.projectSlug) {
      return { orgSlug: this.config.orgSlug, projectSlug: this.config.projectSlug };
    }

    // Fallback to VS Code setting
    const setting = vscode.workspace.getConfiguration('mdspec').get<string>('project', '');
    if (setting) {
      const parts = setting.split('/');
      if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
        return { orgSlug: parts[0].trim(), projectSlug: parts[1].trim() };
      }
    }

    return undefined;
  }

  getOrgSlug(): string | undefined {
    return this.getProject()?.orgSlug;
  }

  getProjectSlug(): string | undefined {
    return this.getProject()?.projectSlug;
  }

  async setProject(orgSlug: string, projectSlug: string): Promise<void> {
    this.config.orgSlug = orgSlug;
    this.config.projectSlug = projectSlug;
    await this.save();
  }

  getSpecRoot(): string | undefined {
    return this.config.specRoot;
  }

  getTrackedFile(relativePath: string): TrackedFileEntry | undefined {
    return this.config.trackedFiles[relativePath];
  }

  getTrackedFiles(): Record<string, TrackedFileEntry> {
    return this.config.trackedFiles;
  }

  isTracked(relativePath: string): boolean {
    return relativePath in this.config.trackedFiles;
  }

  async setTrackedFile(relativePath: string, entry: TrackedFileEntry): Promise<void> {
    this.config.trackedFiles[relativePath] = entry;
    await this.save();
  }

  async trackFile(relativePath: string): Promise<void> {
    if (!this.config.trackedFiles[relativePath]) {
      this.config.trackedFiles[relativePath] = {};
    }
    await this.save();
  }

  async untrackFile(relativePath: string): Promise<void> {
    // We never delete from config. We remove the entry from trackedFiles
    // but per spec: "no deletions ever". However, untracking means the file
    // is no longer in trackedFiles. The spec says "unchecked files are ignored
    // entirely" and state is saved to config. We remove from trackedFiles
    // since this is user-initiated untrack, not a deletion of data.
    // The mapping (slug, specId) is lost — but the spec on mdspec platform remains.
    // Per the spec's "no deletions" principle, we keep the entry but could mark it.
    // For simplicity and spec compliance, we'll keep the entry with its data
    // but the tree view will check trackedFiles membership for display.
    // Actually, re-reading the spec: "User checks/unchecks files" and
    // "Unchecked files are ignored entirely" — the cleanest approach is
    // to remove from trackedFiles. The "no deletions" principle refers to
    // not deleting local files, remote specs, or config mappings for
    // deleted/renamed files. Untracking is an explicit user action.
    delete this.config.trackedFiles[relativePath];
    await this.save();
  }
}
