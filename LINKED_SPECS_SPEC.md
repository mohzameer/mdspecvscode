# Linked Specs — VS Code Extension Spec

## Overview

A **linked spec** is a spec in Project B that mirrors a source spec from Project A. It is read-only — the extension must never upload revisions to it. This spec defines exactly what changes are needed in the VS Code extension to support linked specs.

The backend returns `is_linked: true` on spec entries that are linked. The extension uses this flag to drive all behaviour differences.

---

## API Changes Consumed

### `SpecEntry` (used in `listSpecs` and `getSpec`)

Add `is_linked` and `file_name` fields to the existing `SpecEntry` interface in `mdspecClient.ts`:

```ts
export interface SpecEntry {
  id: string;
  name: string;
  slug: string;
  file_name: string | null;
  updated_at: string;
  project_id: string;
  is_linked: boolean;          // NEW — true if this is a cross-project linked spec
  latest_revision?: {
    revision_number: number;
    content_hash: string;
    created_at: string;
  };
}
```

No new endpoints are needed. The extension only consumes this flag — it does not create or manage links.

---

## Tree View Changes (`specTreeProvider.ts`)

### Remote Only — Linked Spec Item

When building spec items inside `buildSpecItems()`, linked specs must use a distinct icon and a different `itemType` so menu visibility conditions can target them separately.

**New `TreeItemType`:** `remoteLinkedSpec`

```
remoteOnlySpec   — regular unlinked remote spec (link button shown)
remoteLinkedSpec — linked spec (link button hidden, download-only)
```

**Icon:** `$(link)` (chain link icon) instead of `$(cloud-download)`

**Label behaviour** (same as regular remote spec):
- If `file_name` is set → label = `file_name`, description = `name`
- If `file_name` is null → label = `name`, description = `slug`

**Tooltip:** Same as regular spec but with an extra line: `Linked spec — read only`

### Local Specs — Tracked Linked File

Once a linked spec is pulled to a local file and tracked in `.mdspec.json`, it appears in the Local Specs section. It must be visually distinguished and must not show the Sync (upload) button.

**New `TreeItemType`:** `linkedFile`

```
trackedFile  — regular tracked file (sync + download buttons shown)
changedFile  — tracked file with local changes (sync + download buttons shown)
linkedFile   — tracked linked spec (download button only, no sync button)
```

**Icon:** `$(link)` 

**Description:** `linked` shown next to the filename

**How to detect:** the `.mdspec.json` tracked file entry gets a new optional field `isLinked: boolean`. This is written when the user first pulls the spec.

---

## Config Changes (`configManager.ts`)

The tracked file entry in `.mdspec.json` needs to store whether a spec is linked:

```json
{
  "trackedFiles": {
    "specs/source-spec.md": {
      "slug": "source-spec",
      "specId": "uuid",
      "lastHash": "sha256...",
      "isLinked": true
    }
  }
}
```

- `isLinked` is written when `linkRemoteSpec` is called for a spec with `is_linked: true`.
- `isLinked` defaults to `false` / `undefined` for existing entries (no migration needed).

---

## Sync Engine Changes (`syncEngine.ts`)

### `syncFile`

Before reading file content or calling the API, check if the tracked entry has `isLinked: true`:

```ts
if (entry.isLinked) {
  vscode.window.showErrorMessage(
    'mdspec: Cannot sync — this spec is linked and read-only. Use Download to pull the latest version.'
  );
  return { status: 'error', message: 'Linked spec is read-only.' };
}
```

This is a local guard. The server will also reject the upload with `403`, but the extension blocks it before the network call.

### `linkRemoteSpec`

When writing the tracked file entry after a successful download, include `isLinked`:

```ts
await this.configManager.setTrackedFile(localRelativePath, {
  slug,
  specId,
  lastHash: hash,
  isLinked: remoteSpec.is_linked ?? false,
});
```

### `downloadSpec`

No changes needed. Downloading a linked spec is identical to a regular spec.

---

## Command Changes (`extension.ts`)

No new commands are needed. The existing commands are gated by `viewItem` conditions in `package.json`.

---

## `package.json` Menu Changes

### Add `linkedFile` item context menus

```json
{
  "command": "mdspec.downloadSpec",
  "when": "view == mdspecSidebar && viewItem == linkedFile",
  "group": "inline"
}
```

Remove sync button for `linkedFile` — do not add `mdspec.syncFile` for `viewItem == linkedFile`.

### Add `remoteLinkedSpec` item context menu

```json
{
  "command": "mdspec.linkRemoteSpec",
  "when": "view == mdspecSidebar && viewItem == remoteLinkedSpec",
  "group": "inline"
}
```

The link button is still shown so the user can pull it to a local file. No sync button.

---

## Implementation Order

1. **`mdspecClient.ts`** — Add `is_linked: boolean` to `SpecEntry`
2. **`configManager.ts`** — Add `isLinked?: boolean` to tracked file entry type, write it in `setTrackedFile`
3. **`specTreeProvider.ts`** — Add `remoteLinkedSpec` and `linkedFile` item types, update `buildSpecItems` and `getLocalFileItems` to use them
4. **`syncEngine.ts`** — Guard `syncFile` against linked entries, pass `isLinked` in `linkRemoteSpec`
5. **`package.json`** — Add menu entries for `linkedFile` and `remoteLinkedSpec`
