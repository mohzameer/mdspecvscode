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

    if (entry.isLinked) {
      vscode.window.showErrorMessage(
        'mdspec: Cannot sync — this spec is linked and read-only. Use Download to pull the latest version.'
      );
      return { status: 'error', message: 'Linked spec is read-only.' };
    }

    const doSync = async (t: string): Promise<SyncResult> => {
      if (!entry.slug) {
        return this.firstSync(relativePath, content, currentHash, t);
      }
      if (entry.lastHash === currentHash) {
        vscode.window.showInformationMessage(`mdspec: No changes in ${relativePath}`);
        return { status: 'no-change' };
      }
      const slugOrId = entry.specId ?? entry.slug;
      return this.subsequentSync(relativePath, slugOrId, content, currentHash, t, entry);
    };

    try {
      return await doSync(token);
    } catch (err) {
      if (err instanceof MdspecApiError && err.statusCode === 401) {
        const newToken = await this.authManager.refreshAccessToken(this.client);
        if (newToken) {
          return await doSync(newToken);
        }
      }
      return this.handleSyncError(err, relativePath);
    }
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
      if (err instanceof MdspecApiError && err.statusCode === 401) throw err;
      return this.handleSyncError(err, relativePath);
    }
  }

  private async subsequentSync(
    relativePath: string,
    slugOrId: string,
    content: string,
    hash: string,
    token: string,
    entry?: { slug?: string; specId?: string }
  ): Promise<SyncResult> {
    try {
      let response = await this.client.uploadRevision(token, slugOrId, { content });

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
      if (err instanceof MdspecApiError && err.statusCode === 401) throw err;
      // 404 when using slug can happen if the same slug exists as a linked spec; server may resolve to the proxy. Resolve source spec by id and retry.
      if (
        err instanceof MdspecApiError &&
        err.statusCode === 404 &&
        entry?.slug &&
        slugOrId === entry.slug
      ) {
        const list = await this.client.listSpecs(token);
        const isLinked = (s: { is_linked?: boolean; isLinked?: boolean }) =>
          s.is_linked ?? (s as { isLinked?: boolean }).isLinked ?? false;
        const norm = (x: string) => (x ?? '').toLowerCase().trim();
        const sourceSpec = list.specs.find(
          (s) => !isLinked(s) && norm(s.slug) === norm(entry.slug!)
        );
        if (sourceSpec?.id) {
          const retryResponse = await this.client.uploadRevision(token, sourceSpec.id, {
            content,
          });
          if (retryResponse.message) {
            vscode.window.showInformationMessage(`mdspec: ${retryResponse.message}`);
            const e = this.configManager.getTrackedFile(relativePath);
            await this.configManager.setTrackedFile(relativePath, {
              ...e,
              specId: sourceSpec.id,
              lastHash: hash,
            });
            return { status: 'no-change' };
          }
          const contentHash = retryResponse.revision?.content_hash ?? hash;
          const e = this.configManager.getTrackedFile(relativePath);
          await this.configManager.setTrackedFile(relativePath, {
            ...e,
            specId: sourceSpec.id,
            lastHash: contentHash,
          });
          vscode.window.showInformationMessage(
            `mdspec: Synced ${relativePath} → revision ${retryResponse.revision?.revision_number}`
          );
          return {
            status: 'success',
            revisionNumber: retryResponse.revision?.revision_number,
          };
        }
      }
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
    if (!entry?.slug && !entry?.specId) {
      vscode.window.showErrorMessage('mdspec: File has not been synced yet. Cannot download.');
      return { status: 'error', message: 'No remote slug or spec id — file has not been synced yet.' };
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

    const doDownload = async (t: string): Promise<SyncResult> => {
      let response: Awaited<ReturnType<MdspecClient['getSpecById']>>;
      if (entry.specId) {
        response = await this.client.getSpecById(t, entry.specId);
      } else if (entry.slug) {
        response = await this.client.getSpec(t, entry.slug);
      } else {
        return { status: 'error', message: 'No remote slug or spec id — file has not been synced yet.' };
      }
      const remoteContent = response.content;

      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, remoteContent, 'utf-8');

      const newHash = computeHash(remoteContent);
      await this.configManager.setTrackedFile(relativePath, {
        ...entry,
        lastHash: newHash,
      });

      vscode.window.showInformationMessage(
        `mdspec: Downloaded ${relativePath} (revision ${response.spec.latest_revision?.revision_number})`
      );

      return { status: 'success', revisionNumber: response.spec.latest_revision?.revision_number };
    };

    try {
      return await doDownload(token);
    } catch (err) {
      if (err instanceof MdspecApiError && err.statusCode === 401) {
        const newToken = await this.authManager.refreshAccessToken(this.client);
        if (newToken) {
          return await doDownload(newToken);
        }
      }
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
    localRelativePath: string,
    projectId?: string
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

    const doLink = async (t: string): Promise<SyncResult> => {
      const projectSlug = this.configManager.getProjectSlug();
      const orgSlug = this.configManager.getOrgSlug();
      if (projectSlug) {
        await this.client.createSpec(t, {
          name: specName,
          source_spec_id: specId,
          file_name: path.basename(localRelativePath),
          project_slug: projectSlug,
          ...(orgSlug && { org_slug: orgSlug }),
        });
      }
      let response: Awaited<ReturnType<MdspecClient['getSpecById']>>;
      try {
        response = await this.client.getSpecById(t, specId);
      } catch (err) {
        if (err instanceof MdspecApiError && err.statusCode === 404 && projectId) {
          console.log('[mdspec] getSpecById 404, trying getSpec(slug, projectId)');
          response = await this.client.getSpec(t, slug, projectId);
        } else {
          throw err;
        }
      }
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
        isLinked: true,
      });

      vscode.window.showInformationMessage(
        `mdspec: Linked "${specName}" → ${localRelativePath}`
      );

      return {
        status: 'success',
        revisionNumber: response.spec.latest_revision?.revision_number,
      };
    };

    try {
      return await doLink(token);
    } catch (err) {
      if (err instanceof MdspecApiError && err.statusCode === 401) {
        const newToken = await this.authManager.refreshAccessToken(this.client);
        if (newToken) {
          return await doLink(newToken);
        }
      }
      if (err instanceof MdspecApiError && err.statusCode === 404) {
        vscode.window.showErrorMessage(
          'mdspec: Spec not found (404). The API may need to support GET by spec id or GET by slug with project_id.'
        );
        return { status: 'error', message: 'Spec not found (404).' };
      }
      return this.handleSyncError(err, localRelativePath);
    }
  }

  /** Remove the link (delete linked spec on server, untrack locally). Local file is kept. */
  async unlinkSpec(relativePath: string): Promise<SyncResult> {
    const token = await this.authManager.requireToken();
    if (!token) {
      return { status: 'error', message: 'Not authenticated. Please login first.' };
    }

    const entry = this.configManager.getTrackedFile(relativePath);
    if (!entry?.isLinked || !entry.specId) {
      vscode.window.showWarningMessage('mdspec: Only linked specs can be unlinked.');
      return { status: 'error', message: 'Not a linked spec.' };
    }

    const doUnlink = async (t: string): Promise<SyncResult> => {
      // List specs (project_slug) returns the proxy row for this project. Resolve proxy id by slug or source_spec_id; then DELETE /specs/{proxy_id} only (no project query).
      const projectSlug = this.configManager.getProjectSlug();
      if (!projectSlug || !entry.slug) {
        vscode.window.showErrorMessage(
          'mdspec: Set project (org/project) to unlink. The proxy id is resolved from the project spec list.'
        );
        return { status: 'error', message: 'Project not set. Set mdspec project to unlink.' };
      }
      const list = await this.client.listSpecs(t, projectSlug);
      const srcId = (s: { source_spec_id?: string | null; sourceSpecId?: string }) =>
        s.source_spec_id ?? s.sourceSpecId;
      const isLinked = (s: { is_linked?: boolean; isLinked?: boolean }) => s.is_linked ?? s.isLinked;
      const norm = (x: string) => x.toLowerCase().trim();
      // Prefer spec with is_linked true (the proxy); fallback to slug or source_spec_id match per endpoints.md
      const proxy =
        list.specs.find((s) => isLinked(s) && norm(s.slug) === norm(entry.slug!)) ??
        list.specs.find((s) => isLinked(s) && srcId(s) === entry.specId) ??
        list.specs.find((s) => norm(s.slug) === norm(entry.slug!)) ??
        list.specs.find((s) => srcId(s) === entry.specId);
      if (!proxy) {
        // No link on server (proxy not in list): remove link locally so the spec can appear in Remote Only
        await this.configManager.untrackFile(relativePath);
        vscode.window.showInformationMessage(
          `mdspec: Link removed locally (spec was not in project list). Local file kept; you can link again from Remote Only if needed.`
        );
        return { status: 'success' };
      }
      await this.client.deleteLinkedSpec(t, proxy.id, undefined);
      await this.configManager.untrackFile(relativePath);
      vscode.window.showInformationMessage(`mdspec: Unlinked. Local file "${relativePath}" was kept.`);
      return { status: 'success' };
    };

    try {
      return await doUnlink(token);
    } catch (err) {
      if (err instanceof MdspecApiError && err.statusCode === 401) {
        const newToken = await this.authManager.refreshAccessToken(this.client);
        if (newToken) {
          return await doUnlink(newToken);
        }
      }
      if (err instanceof MdspecApiError && err.statusCode === 400) {
        const msg = err.message.includes('Multiple linked')
          ? 'Spec is linked in multiple projects. Set mdspec project (org/project) and try again.'
          : err.message.includes('non-linked')
            ? 'Not a linked spec on the server.'
            : err.message;
        vscode.window.showErrorMessage(`mdspec: ${msg}`);
        return { status: 'error', message: msg };
      }
      return this.handleSyncError(err, relativePath);
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
