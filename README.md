# mdspec

Sync Markdown files between your local workspace and the [mdspec](https://mdspec.app) platform — manually, explicitly, and safely.

No auto-sync. No background uploads. Nothing happens without you clicking a button.

---

## Features

- **Sync local `.md` files to mdspec** — upload a new spec or push a new revision with one click
- **Pull latest content from mdspec** — overwrite a local file with the latest remote version
- **See remote specs not yet on your machine** — discover specs created by teammates on the web and link them to a local file
- **Hash-based change detection** — the sidebar shows which files have changed since the last sync
- **Config-driven** — all state lives in `.mdspec/config.json`, shareable with your team via git

---

## Getting Started

### 1. Open the sidebar

Click the **mdspec** icon in the Activity Bar (left side of VS Code).

### 2. Log in

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`), run **mdspec: Login**, and sign in through the browser window that opens. Your credentials never touch the extension — only the session token is stored securely in VS Code's secret storage.

### 3. Link your project

Run **mdspec: Set Project** from the Command Palette and enter your project in `org-slug/project-slug` format (e.g. `my-org/product-docs`). This is saved to `.mdspec/config.json`.

### 4. Track files

The sidebar lists all `.md` files in your workspace. Check a file to start tracking it. Only tracked files can be synced.

### 5. Sync and pull

Click the **↑ upload** icon next to a tracked file to push it to mdspec. Click the **↓ download** icon to pull the latest version down.

---

## The Sidebar

```
mdspec
├── Project: my-org / product-docs
│
├── Local Specs
│   ☑ auth.md              ↓  ↑
│   ☑ api.md               ↓  ↑
│   ☐ notes.md
│   ☑ security.md    ●        ↑
│
├── Remote Only  (2)
│   Onboarding Flow         🔗
│   Billing Spec            🔗
│
└── Open in Web
```

| Element | Meaning |
|---|---|
| ☑ | File is tracked |
| ☐ | File is not tracked — check it to start tracking |
| ↑ | Upload this file to mdspec |
| ↓ | Pull latest content from mdspec |
| ● | Local changes detected — download blocked, upload available |
| Remote Only | Specs on the server with no local file yet |
| 🔗 | Link this remote spec to a new local file |
| Open in Web | Opens your mdspec project in the browser |

---

## Local Specs

### Tracking files

Check a file in the sidebar to track it. Uncheck to stop tracking. Only tracked files appear on mdspec.

### Syncing (uploading)

Click the upload icon next to a tracked file.

- **First sync** — creates a new spec on mdspec. The spec name is taken from the first `# Heading` in the file. If there is no heading, the filename is used.
- **Subsequent syncs** — uploads a new revision of the existing spec. If the content is identical to the latest revision, no new revision is created.

### Pulling (downloading)

Click the download icon next to a tracked file to overwrite your local copy with the latest content from mdspec.

**Download is blocked if your local file has changed since the last sync.** You will see: *"Cannot download — you have local changes. Sync first or discard your changes."* This prevents you from accidentally losing work.

---

## Remote Only

The **Remote Only** section lists specs that exist on your mdspec project but have no local file linked to them. This happens when a teammate creates a spec via the web app, or when you're setting up a machine for the first time.

Click the **🔗 link** icon next to any remote spec. You will be prompted for a local file path (pre-filled as `<specRoot>/<slug>.md`). The extension downloads the content, creates the file, and adds it to your tracked files — exactly as if you had synced it yourself.

The section is hidden when you are not logged in, and disappears automatically once all remote specs are linked locally.

---

## Change Detection

The extension uses **SHA-256 hashing**, not timestamps.

When you sync a file, a hash of the content is saved. On subsequent saves or refreshes, the current hash is compared with the saved one. If they differ, the file shows a **●** in the sidebar.

- Edit and save a file → dot appears
- Undo edits until content matches the last sync → dot disappears
- Whitespace-only changes still count as changes

---

## Configuration

The extension stores its state in:

```
.mdspec/config.json
```

This file is created automatically. It contains your linked project, which files are tracked, the remote slug and spec ID for each file, and the last synced content hash.

You can commit this file to your repository so your whole team shares the same tracked file mappings.

### Settings

| Setting | Default | Description |
|---|---|---|
| `mdspec.apiBaseUrl` | `https://mdspec.dev/api` | Base URL for the mdspec API |
| `mdspec.project` | _(empty)_ | Project in `org-slug/project-slug` format |

Open Settings (`Cmd+,` / `Ctrl+,`) and search for `mdspec`.

---

## Commands

| Command | Description |
|---|---|
| `mdspec: Login` | Sign in via browser |
| `mdspec: Logout` | Clear stored session |
| `mdspec: Set Project` | Link this workspace to an mdspec project |

Syncing, pulling, and linking remote specs are done via the inline buttons in the sidebar.

---

## What This Extension Does Not Do

- Delete local files
- Delete specs from mdspec
- Auto-sync in the background
- Render markdown previews
- Show diffs
- Manage comments, users, or billing

---

## Troubleshooting

**"Not authenticated" error**
Your session may have expired. Run `mdspec: Login` again.

**File not showing in the sidebar**
- Confirm it has a `.md` extension
- Confirm it is not inside `node_modules`, `.git`, `dist`, or `.mdspec`
- Click the **refresh** button at the top of the sidebar
- If `specRoot` is set in your config, the file must be under that folder

**"Cannot download — you have local changes"**
Your local file has been modified since the last sync. Upload your changes first, or revert the file to its last synced state, then try pulling again.

**Sync failed with 409 Conflict**
A spec with the same slug already exists on mdspec. This can happen if two files generate the same slug. Rename the file or its first heading to produce a unique slug, then sync again.

**Remote Only section is not showing**
Make sure you are logged in. The section only appears after authentication. Click the refresh button to reload.
