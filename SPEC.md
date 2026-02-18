# mdspec VS Code Extension — Functional Specification

## Purpose
The mdspec VS Code extension provides **manual, explicit synchronization** between local Markdown files and the mdspec web platform.

The extension is **not** an editor or reviewer.  
It is a **sync + visibility tool**.

---

## Core Principles
- Explicit user control (no auto-sync)
- File-based sync, not repo-wide
- Markdown-only
- Config-driven
- No deletions — ever (no local files, no remote specs, no config mappings)
- No destructive actions without confirmation
- No heavy background processes

---

## High-Level Capabilities
- Authenticate user
- Link workspace to an mdspec project
- Select which `.md` files are managed
- Sync selected files to mdspec (upload)
- Download latest spec content from mdspec (pull)
- Detect file changes
- Re-sync individual files on demand
- Open spec in browser

---

## Extension UI

### Sidebar View (Activity Bar)
**Panel Title:** `mdspec`

```
mdspec
├── Project: Product Docs
├── Specs
│   ☑ auth.md          [Download] [Sync]
│   ☑ api.md           [Download] [Sync]
│   ☐ notes.md
│   ☑ security.md      [Sync ●]
│
├── Last Sync: 2h ago
└── Open in Web
```

**Legend**
- ☑ = tracked file
- ☐ = untracked file
- ● = local changes detected (download blocked, sync available)
- [Sync] = per-file upload button
- [Download] = per-file download button (hidden when local changes exist)

---

## Sidebar Behavior

### File Discovery
- Scan workspace for `.md` files
- Configurable root folder
- Ignore `node_modules`, `.git`, `dist`, etc.
- Manual refresh button available

---

### File Selection (Checklist)
- User checks/unchecks files
- Checked files become **tracked specs**
- Unchecked files are ignored entirely
- State saved to config file

---

### Per-File Sync Button
- Each tracked file has a `Sync` (upload) action
- Uploads only that file
- No automatic background syncing

---

### Per-File Download Button
- Each tracked file with a remote slug has a `Download` action
- Downloads the latest spec content from mdspec and overwrites the local file
- **Blocked when local changes exist** — if the local file has been modified since last sync, download is refused with an error message
- User must sync (upload) or discard local changes before downloading

---

## Configuration File

### Location
```
.mdspec/config.json
```

### Example
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
    },
    "docs/specs/api.md": {
      "slug": "api-reference",
      "specId": "uuid",
      "lastHash": "sha256_hash_string"
    }
  }
}
```

### Config Keys
- `trackedFiles` keys are **relative paths** from the workspace root (e.g. `docs/specs/auth.md`)
- This ensures each local file is correctly and uniquely mapped to its remote spec ID
```

---

## Config Responsibilities
- Source of truth for:
  - Linked project
  - Tracked files
  - Local → remote spec mapping
  - Last synced hash
- Updated only by:
  - User checklist action
  - Successful sync

---

## File Change Detection

### Strategy
**Hash-based detection**, not timestamps.

### When to Compute Hash
- On file save
- On sidebar refresh
- On sync attempt

### Hash Algorithm
- **SHA-256** (matches mdspec API `content_hash`)

### Hash Input
- Raw file contents (UTF-8)
- Normalize line endings if possible

---

### Change States

| Indicator | Meaning |
|---------|--------|
| none | File unchanged since last sync |
| ● | Local hash ≠ last synced hash |
| disabled | File not tracked |

---

## Sync Flow (Per File)

### First Sync (New Tracked File, No Slug in Config)
1. Read file content
2. Compute SHA-256 hash
3. Extract spec name:
   - Parse first `# Header` line from content
   - If no header found, use filename without `.md` extension
4. Call `POST /api/public/specs` with `{ name, content, file_name, project_slug, org_slug }`
5. Receive `{ spec: { id, slug, name } }`
6. Store `slug`, `specId`, and `lastHash` in config
7. Update sidebar indicator

### Subsequent Sync (Slug Exists in Config)
1. Read file content
2. Compute SHA-256 hash
3. Compare with `lastHash`
4. If unchanged → show "No changes" toast (skip API call)
5. If changed:
   - Call `POST /api/public/specs/[slug]/revisions` with `{ content }`
   - API performs server-side deduplication — if content matches latest revision, no new revision is created
   - Receive revision metadata (`revision_number`, `content_hash`)
6. Update `lastHash` with `content_hash` from response
7. Update sidebar indicator

---

## Bulk Sync (Optional)
Button: `Sync All Changed`

Behavior:
- Sync only tracked files with changed hashes
- Show progress per file
- Skip unchanged files

---

## Download Flow (Per File)

### User Clicks `Download`
1. Check if file has a remote slug in config — if not, show error: "File has not been synced yet"
2. Read local file content
3. Compute local SHA-256 hash
4. Compare with `lastHash`
5. **If local changes detected** (hashes differ) → show error: "Cannot download: you have local changes. Sync first or discard your changes." — **abort**
6. If no local changes:
   - Call `GET /api/public/specs/[slug]`
   - Receive `{ spec, content }`
   - Write `content` to the local file
   - Compute SHA-256 of downloaded content
   - Update `lastHash` in config
   - Update sidebar indicator

### Safety Rule
Download is a **destructive overwrite** of the local file. The local-changes guard ensures the user never loses unsaved work. There is no merge — it is a full replace.

---

## File Lifecycle Rules

### New File
- Appears unchecked
- User must explicitly enable tracking

---

### Deleted Local File
- Extension takes no action
- Spec remains in mdspec
- Config mapping is preserved
- File reappears as tracked (with stale indicator) if recreated at same path

---

### Renamed File
- Treated as a new file
- Old mapping is permanently retained in config

---

## Authentication

### Method
- Email/password login via `POST /api/public/auth/login`
- Returns `access_token`, `refresh_token`, and `expires_in`
- Tokens stored in VS Code secret storage

### Token Lifecycle
- `access_token` used as Bearer token for all API calls
- `refresh_token` stored for re-authentication
- Extension should prompt re-login when token expires or becomes invalid

### Scope
- Project level only
- No repository permissions required

---

## API Interactions

### Endpoints Used

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/public/auth/login` | Authenticate user, receive tokens |
| GET | `/api/public/specs` | List all specs visible to user |
| GET | `/api/public/specs/[slug]` | Download a spec's latest content |
| POST | `/api/public/specs` | Create a new spec (first sync) |
| POST | `/api/public/specs/[slug]/revisions` | Upload a new revision (subsequent syncs) |

### Auth: Login
- **Request**: `{ email, password }`
- **Response**: `{ user: { id, email }, session: { access_token, refresh_token, expires_in } }`

### List Specs
- **Response**: Array of specs with `id`, `name`, `slug`, `project_id`, `updated_at`, and `latest_revision` (including `revision_number`, `content_hash`, `created_at`)
- Used to populate sidebar and verify remote state

### Get Spec (Download)
- **Request**: `GET /api/public/specs/[slug]`
- **Response**: `{ spec: { id, name, slug, updated_at, project_id, latest_revision }, content }`
- Returns full markdown content of the latest revision
- Returns `404` if spec does not exist or user lacks access

### Create Spec
- **Request**: `{ name, content, file_name?, project_slug?, org_slug?, slug? }`
- **Response**: `{ spec: { id, slug, name, latest_revision_number } }`
- `slug` auto-generated from name if omitted
- Returns `409 Conflict` if slug already exists

### Upload Revision
- **Request**: `{ content, summary? }`
- **Response**: `{ revision: { revision_number, content_hash, created_at } }`
- **Deduplication**: If content is identical to latest revision (SHA-256 match), no new revision is created. Returns `{ message: "Content identical to latest revision", revision_number }`

### Not Needed
- Diff API
- Comments API
- Billing endpoints
- User management

---

## Error Handling

### Sync Errors
- Sync failures shown per file
- Retry button available
- No silent failures

### Specific Error Cases
| Error | Cause | User Action |
|-------|-------|-------------|
| `401 Unauthorized` | Token expired or invalid | Prompt re-login |
| `404 Not Found` | Spec does not exist or no access (download) | Show error |
| `409 Conflict` | Slug collision on spec creation | Prompt user to choose a different slug |
| Local changes detected | Download attempted with unsaved local edits | Show error: "Sync first or discard changes" |
| Network failure | No connectivity | Show error, offer retry |
| Server error (5xx) | mdspec platform issue | Show error, offer retry |

### Conflict Resolution
- "Upload anyway" — force push current content as new revision
- "Open in Web" — let user resolve manually in mdspec

---

## Performance Considerations
- No continuous polling
- File scan only on:
  - Workspace open
  - Manual refresh
- Hashing cost is low (markdown files are small)
- Lazy UI updates

---

## Explicit Non-Goals
The extension will **not**:
- Delete local files, remote specs, or config mappings
- Render markdown previews
- Provide diff UI
- Manage comments inline
- Edit specs
- Auto-sync silently
- Manage organizations or billing

---

## UX Philosophy
> The extension should feel like **Git staging**, not Google Docs.

- Explicit
- Predictable
- Reversible
- Low magic
- Safe by default

---

## Future Extensions (Post-MVP)
- Comment presence indicators
- Lightweight comment panel
- CI token-based sync
- Multi-root workspace support
- Grouped spec folders

---

## Summary
The VS Code extension is:
- A **manual sync controller**
- A **file-to-spec bridge**
- A **visibility layer**

It intentionally avoids becoming:
- A second editor
- A full review UI
- A Git replacement

This keeps it lightweight, maintainable, and aligned with mdspec's core purpose.
