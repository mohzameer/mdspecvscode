import * as vscode from 'vscode';
import * as path from 'path';

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.mdspec/**',
  '**/out/**',
  '**/build/**',
  '**/.vscode/**',
  '**/.vscode-test/**',
];

export class FileScanner {
  /**
   * Scan the workspace for .md files, returning paths relative to workspace root.
   * Respects specRoot from config if provided.
   */
  async scan(specRoot?: string): Promise<string[]> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceRoot) {
      return [];
    }

    const pattern = specRoot
      ? new vscode.RelativePattern(workspaceRoot, `${specRoot}/**/*.md`)
      : new vscode.RelativePattern(workspaceRoot, '**/*.md');

    const ignorePattern = `{${IGNORE_PATTERNS.join(',')}}`;
    const files = await vscode.workspace.findFiles(pattern, ignorePattern);

    const rootPath = workspaceRoot.uri.fsPath;
    return files
      .map(f => path.relative(rootPath, f.fsPath))
      .sort();
  }
}
