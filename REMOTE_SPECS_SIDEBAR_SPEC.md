# mdspec Extension — Remote Specs Sidebar Section

## Purpose

Add a second section to the mdspec sidebar that lists specs that exist on the remote mdspec project but are **not linked to any local file**. This gives users visibility into what is on the server and lets them pull those specs down as new local files.

---

## Problem Being Solved

The current sidebar only shows local `.md` files and their sync state. If a spec was created by another team member via the web app (or another machine), it is completely invisible in the extension. The user has no way to discover, download, or link it without going to the browser.

---

## Updated Sidebar Layout

```
mdspec
├── Project: Product Docs
│
├── Local Specs
│   ☑ auth.md              [Download] [Sync]
│   ☑ api.md               [Download] [Sync]
│   ☐ notes.md
│   ☑ security.md          [Sync ●]
│
├── Remote Only  (2)
│   ↓ Onboarding Flow      [Link]
│   ↓ Billing Spec         [Link]
│
├── Last Sync: 2h ago
└── Open in Web
```

**Legend additions:**
- `Remote Only` = collapsible section, count badge shows number of unlinked remote specs
- `↓` = remote spec with no local file
- `[Link]` = download content and create a new local file

---

## Remote Only Section — Behavior

### What it shows
- All specs returned by `GET /api/public/specs` that are **not** already present in `config.trackedFiles` (matched by `specId` or `slug`)
- Sorted by `updated_at` descending (most recently changed first)
- Section is hidden entirely if all remote specs are already linked locally

### When it loads
- On sidebar open (same request as the rest of the sidebar refresh)
- On manual refresh
- After any successful `[Link]` action (re-fetches to update both sections)

### Collapsed by default
- The `Remote Only` section starts collapsed
- State persists across sessions using `workspaceState`

### Empty state
- If all remote specs are linked, the section is not rendered at all
- If the project has no remote specs yet, the section is not rendered

---

## Remote Spec Item Display

Each item in the `Remote Only` section shows:

```
↓ <spec name>      [Link]
```

- **Spec name**: `spec.name` from the API response
- **Tooltip on hover**: Shows `slug`, `revision_number`, and `updated_at`
- **`[Link]` button**: Single action per item (see below)

---

## `[Link]` Action — Flow

Clicking `[Link]` on a remote-only spec:

1. Prompt user for a local file path to save to:
   ```
   Save as (relative to workspace root):
   [docs/specs/onboarding.md        ]   [OK]
   ```
   - Pre-filled suggestion: `<specRoot>/<slug>.md`
   - User can edit the path before confirming

2. Check if file already exists at that path:
   - If yes → show warning: "A file already exists at that path. Overwrite?" `[Yes] [Cancel]`
   - If no → proceed

3. Call `GET /api/public/specs/[slug]` to fetch full content

4. Write content to the specified local path (create directories if needed)

5. Add entry to `config.trackedFiles`:
   ```json
   "docs/specs/onboarding.md": {
     "slug": "onboarding-flow",
     "specId": "uuid",
     "lastHash": "<sha256 of downloaded content>"
   }
   ```

6. Move the spec from `Remote Only` section to `Local Specs` section (as tracked, synced)

7. Show notification: `mdspec: Linked "Onboarding Flow" → docs/specs/onboarding.md`

---

## API Usage

### Endpoint
`GET /api/public/specs`

Already used by the extension. No new endpoint needed.

### Filtering logic
```
remoteOnly = apiSpecs.filter(spec =>
  !Object.values(config.trackedFiles).some(f => f.specId === spec.id)
)
```

Matching is done by `specId` (UUID), not slug, to handle renamed specs correctly.

---

## Data Flow

```
Sidebar refresh triggered
        │
        ├── Scan local .md files  (existing)
        │
        └── GET /api/public/specs
                │
                ├── Filter: specId present in trackedFiles → Local Specs section
                │
                └── Filter: specId NOT in trackedFiles → Remote Only section
```

Both sections are populated from the same API call — no extra network request.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| API returns `401` | Prompt re-login; both sections show "Sign in to load specs" |
| API call fails (network) | Remote Only section shows "Could not load remote specs. Refresh to retry." Local Specs section still renders from config |
| `[Link]` fetch fails | Show error notification: "Failed to download spec. Try again." |
| Local path write fails (permissions) | Show error: "Could not write file. Check folder permissions." |
| User cancels path prompt | No action taken |

---

## Config Impact

No new config keys. The existing `trackedFiles` structure is used as-is. A successful `[Link]` action adds a new entry to `trackedFiles` exactly as a successful first `Sync` would.

---

## Performance

- The `GET /api/public/specs` call is already made on sidebar refresh — this section adds zero extra API calls
- Remote spec content is **not** fetched until the user clicks `[Link]`
- The remote section does not poll; it only updates on explicit refresh or after a `[Link]` action

---

## UX States

| State | Remote Only section behavior |
|---|---|
| Not authenticated | Section hidden; sidebar shows sign-in prompt |
| Authenticated, API loads | Section shown if unlinked specs exist |
| All remote specs linked | Section not rendered |
| Project has no specs | Section not rendered |
| API load in progress | Section shows loading spinner |
| API failed | Section shows inline error with "Retry" button |

---

## Non-Goals

This section will **not**:
- Allow deleting remote specs from the sidebar
- Show specs from other projects
- Auto-link specs to local files without user action
- Show revision history per spec
- Allow renaming specs from the sidebar
