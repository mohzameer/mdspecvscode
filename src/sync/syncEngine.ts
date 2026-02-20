import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MdspecClient, MdspecApiError } from '../api/mdspecClient';
import { AuthManager } from '../auth/authManager';
import { ConfigManager } from '../config/configManager';
import { computeHash } from '../utils/hashUtils';

export type SyncResult =
  | { status: 'success'; revisionNumber?: number }
  | { status: 'no-change' }
  | { status: 'error'; message: string };

/**
 * Extract the first # heading from markdown content to use as spec name.
 * Returns undefined if no heading found.
 */
function extractTitle(content: string): string | undefined {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : undefined;
}

export class SyncEngine {
  constructor(
    private client: MdspecClient,
    private authManager: AuthManager,
    private configManager: ConfigManager
  ) {}

  async syncFile(relativePath: string): Promise<SyncResult> {
    const token = await this.authManager.requireToken();
    if (!token) {
      return { status: 'error', message: 'Not authenticated. Please login first.' };
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return { status: 'error', message: 'No workspace folder open.' };
    }

    const fullPath = path.join(workspaceRoot, relativePath);

    // Read file content
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return { status: 'error', message: `Cannot read file: ${relativePath}` };
    }

    const currentHash = computeHash(content);
    const entry = this.configManager.getTrackedFile(relativePath);

    if (!entry) {
      return { status: 'error', message: 'File is not tracked.' };
    }

    // First sync — no slug yet
    if (!entry.slug) {
      return this.firstSync(relativePath, content, currentHash, token);
    }

    // Subsequent sync — check for changes
    if (entry.lastHash === currentHash) {
      vscode.window.showInformationMessage(`mdspec: No changes in ${relativePath}`);
      return { status: 'no-change' };
    }

    return this.subsequentSync(relativePath, entry.slug, content, currentHash, token);
  }

  private async firstSync(
    relativePath: string,
    content: string,
    hash: string,
    token: string
  ): Promise<SyncResult> {
    try {
      const fileName = path.basename(relativePath);
      const name = extractTitle(content) || path.basename(relativePath, '.md');
      const projectSlug = this.configManager.getProjectSlug();
      const orgSlug = this.configManager.getOrgSlug();

      const response = await this.client.createSpec(token, {
        name,
        content,
        file_name: fileName,
        project_slug: projectSlug,
        org_slug: orgSlug,
      });

      await this.configManager.setTrackedFile(relativePath, {
        slug: response.spec.slug,
        specId: response.spec.id,
        lastHash: hash,
      });

      vscode.window.showInformationMessage(
        `mdspec: Created spec "${response.spec.name}" (${response.spec.slug})`
      );

      return { status: 'success', revisionNumber: response.spec.latest_revision_number };
    } catch (err) {
      return this.handleSyncError(err, relativePath);
    }
  }

  private async subsequentSync(
    relativePath: string,
    slug: string,
    content: string,
    hash: string,
    token: string
  ): Promise<SyncResult> {
    try {
      const response = await this.client.uploadRevision(token, slug, { content });

      // Handle deduplication response
      if (response.message) {
        vscode.window.showInformationMessage(`mdspec: ${response.message}`);
        // Still update local hash to match
        const entry = this.configManager.getTrackedFile(relativePath);
        await this.configManager.setTrackedFile(relativePath, {
          ...entry,
          lastHash: hash,
        });
        return { status: 'no-change' };
      }

      // New revision created
      const contentHash = response.revision?.content_hash ?? hash;
      const entry = this.configManager.getTrackedFile(relativePath);
      await this.configManager.setTrackedFile(relativePath, {
        ...entry,
        lastHash: contentHash,
      });

      vscode.window.showInformationMessage(
        `mdspec: Synced ${relativePath} → revision ${response.revision?.revision_number}`
      );

      return { status: 'success', revisionNumber: response.revision?.revision_number };
    } catch (err) {
      return this.handleSyncError(err, relativePath);
    }
  }

  async downloadSpec(relativePath: string): Promise<SyncResult> {
    const token = await this.authManager.requireToken();
    if (!token) {
      return { status: 'error', message: 'Not authenticated. Please login first.' };
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return { status: 'error', message: 'No workspace folder open.' };
    }

    const entry = this.configManager.getTrackedFile(relativePath);
    if (!entry?.slug) {
      vscode.window.showErrorMessage('mdspec: File has not been synced yet. Cannot download.');
      return { status: 'error', message: 'No remote slug — file has not been synced yet.' };
    }

    // Check for local changes — block download if dirty
    const fullPath = path.join(workspaceRoot, relativePath);
    try {
      const localContent = fs.readFileSync(fullPath, 'utf-8');
      const localHash = computeHash(localContent);
      if (entry.lastHash && localHash !== entry.lastHash) {
        vscode.window.showErrorMessage(
          'mdspec: Cannot download — you have local changes. Sync first or discard your changes.'
        );
        return { status: 'error', message: 'Local changes detected. Download blocked.' };
      }
    } catch {
      // File doesn't exist locally — safe to download
    }

    // Fetch remote content
    try {
      const response = await this.client.getSpec(token, entry.slug);
      const remoteContent = response.content;

      // Write to local file
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, remoteContent, 'utf-8');

      // Update hash in config
      const newHash = computeHash(remoteContent);
      await this.configManager.setTrackedFile(relativePath, {
        ...entry,
        lastHash: newHash,
      });

      vscode.window.showInformationMessage(
        `mdspec: Downloaded ${relativePath} (revision ${response.spec.latest_revision?.revision_number})`
      );

      return { status: 'success', revisionNumber: response.spec.latest_revision?.revision_number };
    } catch (err) {
      if (err instanceof MdspecApiError && err.statusCode === 404) {
        vscode.window.showErrorMessage(`mdspec: Spec not found on server for ${relativePath}`);
        return { status: 'error', message: 'Spec not found (404).' };
      }
      return this.handleSyncError(err, relativePath);
    }
  }

  async linkRemoteSpec(
    slug: string,
    specId: string,
    specName: string,
    localRelativePath: string
  ): Promise<SyncResult> {
    const token = await this.authManager.requireToken();
    if (!token) {
      return { status: 'error', message: 'Not authenticated. Please login first.' };
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return { status: 'error', message: 'No workspace folder open.' };
    }

    const fullPath = path.join(workspaceRoot, localRelativePath);

    if (fs.existsSync(fullPath)) {
      const answer = await vscode.window.showWarningMessage(
        `A file already exists at "${localRelativePath}". Overwrite it with the remote content?`,
        { modal: true },
        'Overwrite'
      );
      if (answer !== 'Overwrite') {
        return { status: 'error', message: 'Cancelled by user.' };
      }
    }

    try {
      const response = await this.client.getSpec(token, slug);
      const content = response.content;

      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, content, 'utf-8');

      const hash = computeHash(content);
      await this.configManager.setTrackedFile(localRelativePath, {
        slug,
        specId,
        lastHash: hash,
      });

      vscode.window.showInformationMessage(
        `mdspec: Linked "${specName}" → ${localRelativePath}`
      );

      return {
        status: 'success',
        revisionNumber: response.spec.latest_revision?.revision_number,
      };
    } catch (err) {
      return this.handleSyncError(err, localRelativePath);
    }
  }

  private handleSyncError(err: unknown, relativePath: string): SyncResult {
    if (err instanceof MdspecApiError) {
      if (err.statusCode === 401) {
        vscode.window.showErrorMessage('mdspec: Session expired. Please login again.');
        return { status: 'error', message: 'Authentication expired.' };
      }
      if (err.statusCode === 409) {
        vscode.window.showErrorMessage(
          `mdspec: Slug conflict for ${relativePath}. A spec with that slug already exists.`
        );
        return { status: 'error', message: 'Slug conflict (409).' };
      }
      vscode.window.showErrorMessage(`mdspec: Sync failed for ${relativePath} — ${err.message}`);
      return { status: 'error', message: err.message };
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    vscode.window.showErrorMessage(`mdspec: Sync failed for ${relativePath} — ${message}`);
    return { status: 'error', message };
  }
}
