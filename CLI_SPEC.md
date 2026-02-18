# mdspec CLI — Functional Specification

## Purpose

`mdspec` is a cross-platform command-line tool that mirrors the VS Code extension's sync capabilities. It runs directly in a terminal, enabling the same file-to-spec synchronization workflow in any project directory on macOS and Windows — without a code editor.

---

## Design Principles

Identical to the extension:
- Explicit user control — no auto-sync
- File-based sync, not repo-wide
- Markdown-only
- Config-driven (reuses `.mdspec/config.json`)
- No deletions, ever
- No destructive actions without confirmation
- No background processes or daemons

CLI-specific additions:
- Scriptable and pipe-friendly (exit codes, `--json` output flag)
- CI/CD-compatible via environment variable token injection (`MDSPEC_TOKEN`)
- Human-readable terminal output by default, machine-readable with `--json`

---

## Technology Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript | Consistent with extension codebase |
| Runtime | Node.js ≥ 18 | Built-in `fetch`, `crypto`, `http` |
| CLI framework | `commander` | Lightweight, zero config |
| Interactive prompts | `@inquirer/prompts` | Mac + Windows compatible |
| Token storage | `keytar` | OS keychain (macOS Keychain, Windows Credential Manager) |
| Fallback storage | `~/.mdspec/credentials` (600 permissions) | When keytar unavailable |
| Distribution | npm package (`mdspec-cli`) + single binaries via `pkg` | Both install methods supported |
| Binary targets | `node18-macos-x64`, `node18-macos-arm64`, `node18-win-x64` | Native binaries, no Node.js required |

---

## Installation

### Via npm (requires Node.js)
```
npm install -g mdspec-cli
```

### Via binary (no Node.js required)
Download from GitHub Releases:
- `mdspec-macos-arm64` (Apple Silicon)
- `mdspec-macos-x64` (Intel Mac)
- `mdspec-win-x64.exe` (Windows)

Place in `PATH`. On macOS: `chmod +x mdspec-macos-arm64`.

---

## Command Reference

### Top-level usage
```
mdspec <command> [options]
```

Global flags available on all commands:

| Flag | Description |
|---|---|
| `--json` | Output result as JSON (for scripts/CI) |
| `--config <path>` | Use a custom config file path |
| `--api <url>` | Override API base URL (default: `https://mdspec.app/api`) |

---

### `mdspec login`

Authenticate the user and store credentials.

**Flow (default — browser-based, same as extension):**
1. Pick a random ephemeral port (49152–65535)
2. Start a one-shot local HTTP server on `127.0.0.1:<port>`
3. Open `https://mdspec.app/auth/cli?port=<port>` in the default browser
4. User logs in on the web page
5. Web page POSTs `{ token, refreshToken, email }` to `http://localhost:<port>/callback`
6. CLI stores tokens, closes server, prints confirmation

**Flow (non-interactive / CI):**
```
mdspec login --token <access_token>
```
Stores the provided token directly. Skips browser. Suitable for CI environments.

**Environment variable override (highest priority):**
```
MDSPEC_TOKEN=<access_token>
```
When set, all commands use this token directly. `login`/`logout` have no effect on it.

**Timeout:** Server auto-closes after 5 minutes.

**Output:**
```
Opening browser for sign-in…
✓ Logged in as user@example.com
```

---

### `mdspec logout`

Clear stored credentials.

```
mdspec logout
```

**Output:**
```
✓ Signed out.
```

---

### `mdspec whoami`

Show currently authenticated user.

```
mdspec whoami
```

**Output (logged in):**
```
user@example.com
```

**Output (not logged in):**
```
Not signed in. Run: mdspec login
```

Exit code: `1` if not logged in.

---

### `mdspec init`

Link the current directory to an mdspec project.

```
mdspec init
```

Interactive prompts:
1. `Org slug:` (pre-fill from existing config if present)
2. `Project slug:`
3. `Spec root directory (default: .):` — the folder to scan for `.md` files

Creates or updates `.mdspec/config.json` with `orgSlug`, `projectSlug`, `specRoot`.

**Option:**
```
mdspec init --org <slug> --project <slug> --root <path>
```
Skips prompts when all flags provided (suitable for scripts).

**Output:**
```
✓ Linked to project "product-docs" (org: my-org)
  Config saved to .mdspec/config.json
```

---

### `mdspec status`

Show the sync state of all tracked and untracked `.md` files. Analogous to `git status`.

```
mdspec status
```

**Output format:**
```
Project: my-org / product-docs

Tracked
  ✓  docs/specs/auth.md          (synced)
  ●  docs/specs/api.md           (local changes)
  ↓  docs/specs/security.md      (not yet synced)

Untracked
     docs/notes.md
     README.md

Legend: ✓ synced  ● local changes  ↓ never synced
```

**`--json` output:**
```json
{
  "project": { "orgSlug": "my-org", "projectSlug": "product-docs" },
  "tracked": [
    { "file": "docs/specs/auth.md", "state": "synced" },
    { "file": "docs/specs/api.md",  "state": "changed" },
    { "file": "docs/specs/security.md", "state": "unsynced" }
  ],
  "untracked": ["docs/notes.md", "README.md"]
}
```

Exit code: `0` always (even if changes exist). Use `--json` + external tooling to fail on changes in CI.

---

### `mdspec track <file>`

Add a `.md` file to the tracked list.

```
mdspec track docs/specs/auth.md
```

- Adds the file path to `trackedFiles` in config (no slug yet — pending first sync)
- Relative paths from workspace root
- Errors if file does not exist or is not `.md`

**Output:**
```
✓ Tracking docs/specs/auth.md
  Run "mdspec sync docs/specs/auth.md" to upload it.
```

---

### `mdspec untrack <file>`

Remove a file from tracking. Does **not** delete the file or the remote spec.

```
mdspec untrack docs/specs/auth.md
```

Prompts for confirmation:
```
Remove docs/specs/auth.md from tracking? The remote spec will not be deleted. [y/N]
```

**Output:**
```
✓ Untracked docs/specs/auth.md
```

---

### `mdspec sync [file]`

Upload a file (or all changed tracked files) to mdspec.

**Single file:**
```
mdspec sync docs/specs/auth.md
```

**All changed files:**
```
mdspec sync --all
```

**Sync flow:**

*First sync (no slug in config):*
1. Read file content
2. Compute SHA-256 hash
3. Extract spec name from first `# Header`, fallback to filename
4. `POST /api/public/specs` with `{ name, content, file_name, project_slug, org_slug }`
5. Store `slug`, `specId`, `lastHash` in config

*Subsequent sync (slug exists):*
1. Read file content
2. Compute SHA-256 hash
3. If hash matches `lastHash` → print "No changes" and skip
4. `POST /api/public/specs/[slug]/revisions` with `{ content }`
5. Update `lastHash` in config

**`--summary` flag:**
```
mdspec sync docs/specs/auth.md --summary "Update auth flow diagram"
```
Passes `summary` field to the revision upload endpoint.

**`--force` flag:**
Skip the "no changes" local-hash check and always upload.

**Output:**
```
Syncing docs/specs/auth.md…
✓ Synced  →  auth  (revision 4)

Syncing docs/specs/api.md…
  No changes since last sync.
```

**`--json` output:**
```json
[
  { "file": "docs/specs/auth.md", "status": "synced", "slug": "auth", "revision": 4 },
  { "file": "docs/specs/api.md",  "status": "unchanged" }
]
```

Exit code: `0` on full success, `1` if any file failed.

---

### `mdspec pull [file]`

Download the latest spec content from mdspec and overwrite the local file.

**Single file:**
```
mdspec pull docs/specs/auth.md
```

**All tracked files:**
```
mdspec pull --all
```

**Pull flow:**
1. Check file has a remote slug — if not, error: "File has not been synced yet"
2. Compute local hash
3. Compare with `lastHash`
4. **If local changes detected** → error: "Cannot pull: you have local changes. Sync first or use --force." — abort
5. `GET /api/public/specs/[slug]`
6. Write content to local file
7. Compute SHA-256 of downloaded content
8. Update `lastHash` in config

**`--force` flag:**
Overwrite even if local changes exist. Prompts for confirmation unless `--yes` is also passed.

**Output:**
```
Pulling docs/specs/auth.md…
✓ Pulled  →  auth  (revision 5)
```

---

### `mdspec list`

List all specs visible to the authenticated user on the remote, along with their link status locally.

```
mdspec list
```

**Output:**
```
Remote specs (project: my-org / product-docs)

  slug               name                  local file
  ─────────────────────────────────────────────────────────
  auth               Auth Spec             docs/specs/auth.md
  api-reference      API Reference         docs/specs/api.md
  onboarding         Onboarding Flow       (not linked locally)
```

---

### `mdspec open [file]`

Open a spec in the default browser.

```
mdspec open docs/specs/auth.md
mdspec open                        # opens the project page
```

Opens `https://mdspec.app/<org>/<project>/specs/<slug>` (or the project root if no file specified).

---

## Configuration File

Identical schema to the VS Code extension:

**Location:** `.mdspec/config.json` (relative to current working directory)

```json
{
  "orgSlug": "my-org",
  "projectSlug": "product-docs",
  "specRoot": "docs/specs",
  "trackedFiles": {
    "docs/specs/auth.md": {
      "slug": "auth",
      "specId": "uuid",
      "lastHash": "sha256_hash_string"
    }
  }
}
```

The CLI reads and writes this same file, so a project configured with the VS Code extension works with the CLI and vice versa. Config is always resolved from the current working directory (or overridden via `--config`).

Path separators are normalized to `/` in config on all platforms, including Windows.

---

## Credential Storage

| Platform | Primary storage | Fallback |
|---|---|---|
| macOS | macOS Keychain via `keytar` | `~/.mdspec/credentials` (mode 600) |
| Windows | Windows Credential Manager via `keytar` | `%APPDATA%\mdspec\credentials` |

Service name in keychain: `mdspec-cli`

Stored keys:
- `mdspec.accessToken`
- `mdspec.refreshToken`
- `mdspec.userEmail`

**CI environment:** If `MDSPEC_TOKEN` environment variable is set, the keychain is never read or written. The env var takes full priority.

---

## Error Handling

| Error | Cause | CLI output |
|---|---|---|
| `401 Unauthorized` | Token expired/invalid | `✗ Session expired. Run: mdspec login` |
| `404 Not Found` | Spec doesn't exist or no access | `✗ Spec not found: [slug]` |
| `409 Conflict` | Slug collision on create | `✗ Slug already taken. Use --slug <custom-slug> to specify one.` |
| Local changes on pull | Pull blocked by local edits | `✗ Local changes detected. Sync first or use --force.` |
| Network failure | No connectivity | `✗ Network error. Check your connection.` |
| Server error (5xx) | mdspec platform issue | `✗ Server error (503). Try again later.` |
| Not authenticated | No token stored | `✗ Not signed in. Run: mdspec login` |
| Config not found | No `.mdspec/config.json` | `✗ No config found. Run: mdspec init` |

All errors print to `stderr`. Exit code is always non-zero on error.

---

## Authentication — Web App Contract

The CLI requires the mdspec web app to provide a `/auth/cli` page (parallel to the existing `/auth/vscode` page):

- **URL:** `https://mdspec.app/auth/cli?port=<number>`
- **Behavior:** Identical to `/auth/vscode` — shows login form, POSTs `{ token, refreshToken, email }` to `http://localhost:<port>/callback`
- **Port validation:** Reject ports outside 49152–65535
- **Success message:** "You're connected! Return to your terminal."

The existing `/auth/vscode` page can be reused or aliased to avoid duplication.

---

## File Discovery

- Scans `specRoot` (from config) for `*.md` files
- Ignores `node_modules/`, `.git/`, `dist/`, `.next/`, `coverage/`
- Uses relative paths from workspace root as keys (consistent with extension)
- Path separator normalized to `/` in config on all platforms

---

## CI/CD Usage

Example GitHub Actions workflow:
```yaml
- name: Sync specs
  env:
    MDSPEC_TOKEN: ${{ secrets.MDSPEC_TOKEN }}
  run: |
    mdspec sync --all --json
```

No login step needed when `MDSPEC_TOKEN` is set. Exit code `1` on any sync failure causes the CI step to fail.

---

## Explicit Non-Goals

The CLI will **not**:
- Delete local files, remote specs, or config entries
- Render markdown
- Show diffs
- Manage comments
- Auto-sync on file watch
- Manage organizations or billing
- Replace Git

---

## Command Summary

| Command | Description |
|---|---|
| `mdspec login` | Authenticate via browser or `--token` |
| `mdspec logout` | Clear stored credentials |
| `mdspec whoami` | Show logged-in user |
| `mdspec init` | Link directory to an mdspec project |
| `mdspec status` | Show sync state of all tracked files |
| `mdspec track <file>` | Add file to tracking |
| `mdspec untrack <file>` | Remove file from tracking |
| `mdspec sync [file]` | Upload file(s) to mdspec |
| `mdspec sync --all` | Upload all changed tracked files |
| `mdspec pull [file]` | Download latest spec content |
| `mdspec pull --all` | Pull all tracked files |
| `mdspec list` | List remote specs and local link status |
| `mdspec open [file]` | Open spec in browser |

---

## Post-MVP

- `mdspec sync --watch` — file watcher mode (opt-in, explicit)
- `mdspec diff <file>` — show diff between local and latest remote revision
- `mdspec history <file>` — list revision history for a spec
- `mdspec ci-token` — generate a long-lived CI token from the web app
- Shell completion scripts (`mdspec completion bash/zsh/fish/powershell`)
