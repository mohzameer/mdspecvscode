# Publishing the mdspec VS Code Extension

## Overview

VS Code extensions are published to the [Visual Studio Marketplace](https://marketplace.visualstudio.com/) using the `vsce` CLI tool. Every published extension is identified by `publisher.name` — in this case `mdspec.mdspec`.

---

## Prerequisites

### 1. Install `vsce`

```bash
npm install -g @vscode/vsce
```

### 2. Create a publisher account

1. Go to [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
2. Sign in with a Microsoft account
3. Click **Create publisher**
4. Set the publisher ID to `mdspec` (must match `"publisher"` in `package.json`)

### 3. Create a Personal Access Token (PAT)

1. Go to [dev.azure.com](https://dev.azure.com) and sign in with the same Microsoft account
2. Click your avatar → **Personal access tokens** → **New Token**
3. Settings:
   - **Name:** anything (e.g. `vsce-publish`)
   - **Organization:** All accessible organizations
   - **Expiration:** your preference (max 1 year)
   - **Scopes:** Custom defined → **Marketplace** → check **Manage**
4. Copy the token — it is shown only once

### 4. Authenticate `vsce`

```bash
vsce login mdspec
```

Paste the PAT when prompted. Credentials are stored in your system keychain.

---

## Pre-publish Checklist

Before every release, verify:

- [ ] `"version"` in `package.json` is bumped (follows [semver](https://semver.org/))
- [ ] `"publisher"` is `"mdspec"`
- [ ] `"engines.vscode"` reflects the minimum VS Code version you support
- [ ] `resources/mdspec-icon.svg` exists (required for Marketplace listing)
- [ ] A `README.md` exists at the project root (Marketplace displays it as the extension page)
- [ ] `.vscodeignore` excludes `src/`, `node_modules/`, test files, and config files — only `dist/` and `resources/` should be packaged
- [ ] Production build is clean: `npm run package` exits with no errors

### Verify what gets packaged

```bash
vsce ls
```

This lists every file that will be included in the `.vsix`. If anything unexpected appears, update `.vscodeignore`.

---

## Versioning

Use standard [semver](https://semver.org/):

| Change type | Version bump | Example |
|---|---|---|
| Bug fix | Patch | `0.1.0` → `0.1.1` |
| New feature, backwards-compatible | Minor | `0.1.1` → `0.2.0` |
| Breaking change | Major | `0.2.0` → `1.0.0` |

Update the version manually in `package.json`, or use:

```bash
npm version patch   # 0.0.1 → 0.0.2
npm version minor   # 0.0.2 → 0.1.0
npm version major   # 0.1.0 → 1.0.0
```

---

## Package (build the `.vsix`)

Creates a `.vsix` file that you can install locally or upload manually.

```bash
vsce package
```

Output: `mdspec-<version>.vsix` in the project root.

### Install locally for testing

```bash
code --install-extension mdspec-0.0.1.vsix
```

Or via the VS Code UI: Extensions panel → `...` → **Install from VSIX…**

---

## Publish to the Marketplace

### Publish directly (most common)

```bash
vsce publish
```

This runs `npm run vscode:prepublish` (which calls `npm run package`), then uploads the result.

### Publish a specific version bump in one command

```bash
vsce publish patch   # bumps patch, packages, publishes
vsce publish minor
vsce publish major
```

### Publish a pre-built `.vsix`

```bash
vsce publish --packagePath mdspec-0.0.1.vsix
```

---

## Post-publish

After publishing:

1. The extension appears on the Marketplace within a few minutes
2. Existing users receive an update notification automatically
3. Verify the listing at:
   `https://marketplace.visualstudio.com/items?itemName=mdspec.mdspec`

---

## Required Marketplace Assets

| Asset | Location | Notes |
|---|---|---|
| Icon | `resources/mdspec-icon.svg` | Already present. Min 128×128px. |
| README | `README.md` (project root) | Displayed as the extension page. Must exist before first publish. |
| Changelog | `CHANGELOG.md` (optional) | Shown in the **Changelog** tab on the Marketplace. |

The `.vscodeignore` currently excludes `*.md` files implicitly via the wildcard rules. Make sure `README.md` and `CHANGELOG.md` are **not** excluded — check the ignore file before publishing.

Current `.vscodeignore`:

```
.vscode/**
.vscode-test/**
src/**
node_modules/**
.gitignore
webpack.config.js
tsconfig.json
**/*.map
**/*.ts
!dist/**
```

`README.md` and `CHANGELOG.md` are not matched by any of these rules, so they will be included automatically.

---

## CI/CD — Automated Publishing with GitHub Actions

Create `.github/workflows/publish.yml`:

```yaml
name: Publish Extension

on:
  push:
    tags:
      - 'v*'   # triggers on tags like v0.1.0, v1.0.0

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm ci

      - name: Publish to VS Code Marketplace
        run: npx @vscode/vsce publish --no-dependencies
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
```

Store the PAT as a GitHub Actions secret named `VSCE_PAT`.

**Release workflow:**
```bash
npm version minor          # bumps version, commits, creates git tag
git push && git push --tags  # triggers the CI publish
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing publisher name` | Ensure `"publisher": "mdspec"` is in `package.json` |
| `Publisher 'mdspec' not found` | Create the publisher at marketplace.visualstudio.com/manage |
| `401 Unauthorized` | PAT expired or wrong scope — create a new one with **Marketplace → Manage** scope |
| `Extension already exists at version X` | Bump the version in `package.json` before publishing |
| `icon not found` | Ensure `resources/mdspec-icon.svg` exists and the path matches `package.json` |
| `README.md not found` | Create a `README.md` at the project root — the Marketplace requires it |
| `.vsix` is too large | Check `vsce ls` — ensure `node_modules/` and `src/` are in `.vscodeignore` |
