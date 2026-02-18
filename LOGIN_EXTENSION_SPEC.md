# mdspec Extension — Browser Login (Extension-Side Spec)

This document specifies the **extension-side** implementation of the browser-based login flow. The web app `/auth/vscode` page is implemented separately in the mdspec Next.js app.

---

## Overview

The extension authenticates users via a **browser-based login flow**:

1. User runs "mdspec: Login" command
2. Extension starts a local HTTP server on a random ephemeral port (49152–65535)
3. Extension opens the mdspec web app at `{webBaseUrl}/auth/vscode?port={port}`
4. User signs in on the web page
5. Web page POSTs `{ token, refreshToken, email }` to `http://localhost:{port}/callback`
6. Extension stores tokens, closes server, shows success

**URLs:**
- **API base**: `mdspec.apiBaseUrl` (e.g. `https://mdspec.dev/api`) — used for API calls
- **Web base**: `apiBaseUrl.replace(/\/api$/, '')` (e.g. `https://mdspec.dev`) — used for login page and CORS

---

## Components

### 1. `src/auth/BrowserLogin.ts`

| Responsibility | Details |
|----------------|---------|
| Start local server | Bind to `127.0.0.1`, random port in 49152–65535 |
| Handle `/callback` | Accept POST with `{ token, refreshToken, email }`, validate, call `recipient.saveSession()` |
| CORS | `Access-Control-Allow-Origin: {webBaseUrl}` |
| Open browser | `vscode.env.openExternal(loginUrl)` |
| Cancel | Notification with "Cancel" button → close server, reject |
| Timeout | 5 minutes → close server, reject |

**Interface:**
```typescript
export interface SessionRecipient {
  saveSession(accessToken: string, refreshToken: string, email: string): Promise<void>;
}

export async function startBrowserLogin(recipient: SessionRecipient): Promise<void>;
```

### 2. `src/auth/authManager.ts`

| Method | Purpose |
|--------|---------|
| `saveSession(accessToken, refreshToken, email)` | Store tokens in SecretStorage, email in globalState; fire `onDidChangeAuth` |
| `getUserEmail()` | Read email from globalState |
| `getToken()` | Read access token from SecretStorage |
| `logout()` | Clear tokens and email; fire `onDidChangeAuth` |
| `isAuthenticated()` | `!!getToken()` |
| `requireToken()` | If no token, call `startBrowserLogin(this)`; return token or undefined |
| `onDidChangeAuth` | Event for tree refresh |

**Storage keys:**
- `mdspec.accessToken` (SecretStorage)
- `mdspec.refreshToken` (SecretStorage)
- `mdspec.userEmail` (globalState)

### 3. `src/extension.ts`

- **Login command**: If authenticated → show "Already signed in as {email}". Else → `startBrowserLogin(authManager)`, refresh tree on success.
- **Logout command**: `authManager.logout()`, refresh tree.
- **AuthManager**: Constructed with `(context)` only — no MdspecClient.

---

## UX States

| State | Behavior |
|------|----------|
| Not logged in | Login opens browser, shows "A browser window has opened. Please sign in." with Cancel |
| Browser opened | User signs in on web page |
| Login success | Browser shows success; VSCode shows "Logged in as {email}"; tree refreshes |
| Login cancelled | User clicks Cancel → no error toast |
| Login timeout | After 5 min → error toast "Login failed — Login timed out" |
| Already logged in | Login shows "Already signed in as {email}" |
| Sync without token | `requireToken()` triggers browser login; user completes in browser, sync retries |

---

## Security

| Concern | Mitigation |
|---------|------------|
| Token storage | SecretStorage (OS keychain) |
| Local server | Bind to `127.0.0.1` only |
| CORS | Restrict to web base URL |
| Port range | Ephemeral 49152–65535 |
| Timeout | 5 minutes |

---

## Activation Events

```json
"activationEvents": [
  "onView:mdspecSidebar",
  "onCommand:mdspec.login",
  "onCommand:mdspec.logout"
]
```

---

## Web App Contract (External)

The mdspec web app must provide:

- **URL**: `{webBaseUrl}/auth/vscode?port={number}`
- **On submit**: Call `POST /api/public/auth/login` (relative to API base)
- **On success**: POST `{ token, refreshToken, email }` to `http://localhost:{port}/callback`
- **Port validation**: Reject `?port=` outside 49152–65535
