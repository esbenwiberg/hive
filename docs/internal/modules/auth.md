# Auth Module Guide

> **Location:** `src/auth/`  
> **Related:** `src/vault/keyvault.ts`, `src/db/queries/users.ts`, `src/db/queries/user-credentials.ts`, `src/dashboard/server.ts`

---

## Table of Contents

1. [Overview](#overview)
2. [Module Structure](#module-structure)
3. [Azure Entra ID Integration](#azure-entra-id-integration)
4. [Authentication Flow](#authentication-flow)
5. [Session Management](#session-management)
6. [Middleware](#middleware)
7. [Role-Based Access Control](#role-based-access-control)
8. [User Records and Provisioning](#user-records-and-provisioning)
9. [Git Credential Management](#git-credential-management)
10. [Azure Key Vault Integration](#azure-key-vault-integration)
11. [Configuration Reference](#configuration-reference)
12. [Security Considerations](#security-considerations)
13. [Integration Points](#integration-points)

---

## Overview

The auth module implements **Microsoft Entra ID (Azure AD) OIDC single sign-on** for The Hive. All browser-facing routes require authentication; access is further controlled by a three-tier role hierarchy (`viewer`, `user`, `admin`). Git credentials (GitHub/Azure DevOps tokens) are stored separately from session state, encrypted in **Azure Key Vault**, and resolved at execution time.

The module has three source files with distinct responsibilities:

| File | Responsibility |
|---|---|
| `entra.ts` | MSAL client, OAuth 2.0 flow (auth URL, callback, token refresh) |
| `session.ts` | `express-session` + PostgreSQL session store configuration |
| `middleware.ts` | `requireAuth` and `requireRole` Express middleware |

---

## Module Structure

```
src/auth/
├── entra.ts        # MSAL ConfidentialClientApplication wrapper
├── session.ts      # Session store configuration + SessionUser type
└── middleware.ts   # Authentication and authorisation middleware

src/vault/
└── keyvault.ts     # Azure Key Vault integration for git credentials

src/db/queries/
├── users.ts            # findOrCreate user by Entra OID; list/update helpers
└── user-credentials.ts # CRUD for per-user git credential references
```

---

## Azure Entra ID Integration

### MSAL Client (`entra.ts`)

The module uses `@azure/msal-node`'s `ConfidentialClientApplication`, which implements the **OAuth 2.0 Authorization Code flow with PKCE** suited for server-side web applications. The client is constructed lazily on first use to avoid startup failures when Entra environment variables are not yet set (e.g., during local development with auth disabled).

```typescript
// Lazy singleton construction
function getMsalClient(): ConfidentialClientApplication {
  if (!msalClient) {
    msalClient = new ConfidentialClientApplication({
      auth: {
        clientId:     process.env.ENTRA_CLIENT_ID!,
        clientSecret: process.env.ENTRA_CLIENT_SECRET!,
        authority:    `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}`,
      },
    });
  }
  return msalClient;
}
```

**Required environment variables:**

| Variable | Purpose |
|---|---|
| `ENTRA_CLIENT_ID` | Application (client) ID from Entra app registration |
| `ENTRA_CLIENT_SECRET` | Client secret generated in Entra |
| `ENTRA_TENANT_ID` | Directory (tenant) ID |
| `REDIRECT_URI` | Must match the registered reply URL (e.g., `https://hive.example.com/auth/callback`) |

### Exported Functions

#### `getAuthUrl()`

Generates the Entra ID sign-in URL to which unauthenticated users are redirected. The MSAL library handles PKCE code-verifier/code-challenge generation internally.

```typescript
export async function getAuthUrl(): Promise<string>
```

Internally calls `msalClient.getAuthCodeUrl()` with:
- `scopes: ["openid", "profile", "email"]` — minimum scopes for identity information
- `redirectUri` from `REDIRECT_URI` environment variable

#### `handleCallback(code: string)`

Exchanges the one-time authorization code (delivered by Entra to `/auth/callback`) for an access token and ID token claims.

```typescript
export async function handleCallback(code: string): Promise<TokenClaims>
```

Returns MSAL `AuthenticationResult.idTokenClaims`, which includes:
- `oid` — Object ID (stable, unique user identifier across the tenant)
- `email` / `preferred_username` — User's email address
- `name` — Display name

These claims are used to find or create the user record in PostgreSQL (see [User Records](#user-records-and-provisioning)).

#### `refreshToken(account: AccountInfo)`

Silently refreshes an access token for a previously authenticated account using the MSAL token cache. Called proactively when a session's token is near expiry.

```typescript
export async function refreshToken(account: AccountInfo): Promise<AuthenticationResult | null>
```

Returns `null` if the silent refresh fails (e.g., the user's account was revoked), in which case the session should be destroyed and the user redirected to sign in again.

---

## Authentication Flow

The complete sign-in flow is orchestrated by **`src/dashboard/server.ts`**, which mounts the auth routes directly on the Express app:

```
Browser                    Hive Server                    Entra ID
  │                             │                              │
  │  GET /auth/login            │                              │
  │────────────────────────────►│                              │
  │                             │  getAuthUrl()                │
  │                             │─────────────────────────────►│
  │                             │◄─────────────────────────────│
  │  302 → Entra login page     │                              │
  │◄────────────────────────────│                              │
  │                             │                              │
  │  User signs in with         │                              │
  │  Microsoft credentials      │                              │
  │────────────────────────────────────────────────────────────►
  │                             │                              │
  │  302 → /auth/callback?code= │                              │
  │◄──────────────────────────────────────────────────────────  │
  │                             │                              │
  │  GET /auth/callback?code=…  │                              │
  │────────────────────────────►│                              │
  │                             │  handleCallback(code)        │
  │                             │─────────────────────────────►│
  │                             │◄─────────────────────────────│
  │                             │  findOrCreateUser(oid, …)    │
  │                             │──────────────────────────────► PostgreSQL
  │                             │◄──────────────────────────────
  │                             │  req.session.user = userRow  │
  │  302 → /                    │                              │
  │◄────────────────────────────│                              │
```

### Route Handlers (in `server.ts`)

```typescript
// Initiates the OAuth flow
app.get("/auth/login", async (req, res) => {
  const url = await getAuthUrl();
  res.redirect(url);
});

// Entra redirects back here with one-time authorization code
app.get("/auth/callback", async (req, res) => {
  const claims = await handleCallback(req.query.code as string);
  const user   = await findOrCreateUser(claims.oid, claims.email, claims.name);
  req.session.user = user;           // persisted to PostgreSQL session store
  res.redirect("/");
});

// Destroys session and redirects to Entra logout
app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect(
      `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/oauth2/v2.0/logout`
      + `?post_logout_redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI!)}`
    );
  });
});
```

The callback handler follows the **find-or-create** pattern: a user who signs in for the first time is automatically provisioned in the `users` table with the `user` role. Subsequent sign-ins simply retrieve the existing record.

---

## Session Management

### Configuration (`session.ts`)

Sessions are stored in PostgreSQL using `connect-pg-simple`, which reuses the existing connection pool from `src/db/connection.ts`. This avoids a separate Redis dependency and ensures sessions survive server restarts.

```typescript
import session          from "express-session";
import connectPgSimple  from "connect-pg-simple";
import { pool }         from "../db/connection.js";

const PgStore = connectPgSimple(session);

export default session({
  store: new PgStore({
    pool,
    tableName: "sessions",   // matches the sessions table in schema.ts
    createTableIfMissing: false,
  }),
  secret:            process.env.SESSION_SECRET!,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge:   24 * 60 * 60 * 1000,   // 24 hours
    sameSite: "lax",
  },
});
```

**Key choices:**

| Setting | Value | Rationale |
|---|---|---|
| `resave: false` | Don't re-save unchanged sessions | Avoids unnecessary DB writes |
| `saveUninitialized: false` | Don't create sessions for unauthenticated visitors | Reduces session store bloat |
| `secure: true` (production) | Cookies only sent over HTTPS | Prevents token interception |
| `httpOnly: true` | Cookie inaccessible to JavaScript | Mitigates XSS cookie theft |
| `sameSite: "lax"` | Prevents CSRF in most scenarios | While allowing top-level navigations |
| `maxAge: 24h` | Session lifetime | Balances security and usability |

### `sessions` Table

```sql
CREATE TABLE sessions (
  sid    TEXT PRIMARY KEY,
  sess   JSONB NOT NULL,   -- serialised session data including req.session.user
  expire TIMESTAMP WITH TIME ZONE NOT NULL
);
```

`connect-pg-simple` automatically prunes expired sessions. The `sess` JSONB column holds the full session object, including the `user` field (see below).

### SessionUser Type

`session.ts` augments the `express-session` module to add a typed `user` field:

```typescript
declare module "express-session" {
  interface SessionData {
    user?: {
      id:          number;   // DB primary key (users.id)
      entraOid:    string;   // Entra Object ID — stable across renames
      email:       string;
      displayName: string;
      role:        string;   // "viewer" | "user" | "admin"
      dailyBudget: string;   // numeric string, e.g. "100.00"
    };
  }
}
```

This declaration ensures `req.session.user` is fully typed throughout the codebase. Middleware and routes access user identity via `req.session.user!` (non-null assertion safe after `requireAuth`).

---

## Middleware

### `requireAuth` (`middleware.ts`)

Ensures the incoming request has a valid authenticated session. If not, redirects to `/auth/login`.

```typescript
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user) {
    return next();
  }
  res.redirect("/auth/login");
}
```

**Usage:** Applied to every route that must be authenticated (which is nearly all of them):

```typescript
router.get("/dashboard", requireAuth, dashboardHandler);
```

For API endpoints (HTMX fragments, REST) that should return `401` instead of a redirect, callers check `req.headers["hx-request"]` or a similar signal and respond accordingly — though in practice all API calls originate from the already-authenticated dashboard.

### `requireRole` (`middleware.ts`)

Extends `requireAuth` by also enforcing a minimum role level. The role hierarchy is:

```typescript
const ROLE_LEVELS: Record<string, number> = {
  viewer: 0,
  user:   1,
  admin:  2,
};
```

```typescript
export function requireRole(minRole: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session.user) {
      return res.redirect("/auth/login");
    }
    const userLevel = ROLE_LEVELS[req.session.user.role] ?? -1;
    const required  = ROLE_LEVELS[minRole]               ?? 99;

    if (userLevel >= required) {
      return next();
    }
    res.status(403).send("Forbidden");
  };
}
```

**Usage:**

```typescript
// Admin-only pages/APIs
router.get("/permissions",          requireRole("admin"), permissionsHandler);
router.post("/api/permissions/grant", requireRole("admin"), grantHandler);

// Any authenticated user
router.get("/profile", requireAuth, profileHandler);
```

---

## Role-Based Access Control

### Role Definitions

| Role | Level | Capabilities |
|---|---|---|
| `viewer` | 0 | Read-only access to task list and details |
| `user` | 1 | Create tasks, manage own git credentials, view own costs |
| `admin` | 2 | Everything above + manage all users, grant repo access, configure budgets, access system settings |

Roles are stored in the `users.role` column (default: `"user"` on first sign-in). Admins can promote/demote users through the permissions UI.

### Enforcement Points

| Route | Middleware | Minimum Role |
|---|---|---|
| `GET /permissions` | `requireRole("admin")` | admin |
| `POST /api/permissions/grant` | `requireRole("admin")` | admin |
| `POST /api/permissions/revoke` | `requireRole("admin")` | admin |
| `POST /api/permissions/budget` | `requireRole("admin")` | admin |
| `GET /settings` | `requireRole("admin")` | admin |
| `POST /api/settings` | `requireRole("admin")` | admin |
| `GET /profile` | `requireAuth` | any authenticated |
| `POST /api/profile/tokens` | `requireAuth` | any authenticated |
| `DELETE /api/profile/tokens/:id` | `requireAuth` | any authenticated |
| All other routes | `requireAuth` | any authenticated |

### Repo-Level Access Control

Beyond role levels, access to individual repositories is further controlled through the `user_repo_access` join table. Admins grant or revoke per-repo access for each user via the permissions page. The execution worker validates that the task creator has access to the target repo before starting execution.

```
users ──(1:N)──► user_repo_access ◄──(N:1)── repos
```

---

## User Records and Provisioning

### Find-or-Create Pattern (`src/db/queries/users.ts`)

On every successful Entra callback, the server calls `findOrCreateUser()`:

```typescript
export async function findOrCreateUser(
  entraOid:    string,
  email:       string,
  displayName: string,
): Promise<SessionUser>
```

This performs an **upsert** on `entra_oid`:

```typescript
await db
  .insert(users)
  .values({ entraOid, email, displayName, role: "user" })
  .onConflictDoUpdate({
    target: users.entraOid,
    set: { email, displayName, updatedAt: sql`now()` },
  });
```

**Key behaviours:**

- **New users** are created with `role: "user"` and `dailyBudget: "100.00"` (configurable defaults).
- **Returning users** have their `email` and `displayName` updated from Entra claims on every sign-in, keeping the DB in sync with directory changes (e.g., name changes, email alias updates).
- The stable `entra_oid` (Entra Object ID) is used as the unique key, not the email, because emails can change.

### User Schema

```typescript
// src/db/schema.ts
export const users = pgTable("users", {
  id:          serial("id").primaryKey(),
  entraOid:    text("entra_oid").unique().notNull(),  // Entra Object ID
  email:       text("email").unique().notNull(),
  displayName: text("display_name").notNull(),
  role:        text("role").notNull().default("user"),
  dailyBudget: numeric("daily_budget", { precision: 10, scale: 2 }).default("100.00"),
  createdAt:   timestamp("created_at", tz).defaultNow(),
  updatedAt:   timestamp("updated_at", tz).defaultNow(),
});
```

### Admin Query Helpers

Additional query functions support the admin permissions UI:

| Function | Description |
|---|---|
| `listAllWithRole()` | Returns all users with their roles (for the permissions matrix) |
| `updateRole(userId, role)` | Promotes or demotes a user's role |
| `updateDailyBudget(userId, budget)` | Adjusts a user's daily spend limit |

---

## Git Credential Management

Users store personal access tokens (GitHub, Azure DevOps, etc.) so the execution worker can clone private repositories and open pull requests on their behalf. The system uses a **pointer pattern**: the database stores only a reference (secret name), never the raw token.

### Data Flow

```
User POSTs token via /api/profile/tokens
         │
         ▼
  1. Generate secret name:  user:{userId}:{provider}:{label}
         │
         ▼
  2. Write raw token to Azure Key Vault  (setSecret)
         │
         ▼
  3. Store secret name in user_credentials table
         │
         ▼
  4. At execution time: retrieve secret name from DB,
     fetch actual token from Key Vault (getSecret)
         │
         ▼
  5. Pass token to git clone / PR API call
     (token never logged or stored in session)
```

### `user_credentials` Table

```typescript
export const userCredentials = pgTable(
  "user_credentials",
  {
    id:            serial("id").primaryKey(),
    userId:        integer("user_id").notNull().references(() => users.id),
    provider:      text("provider").notNull(),    // "github" | "azuredevops" | etc.
    vaultSecretId: text("vault_secret_id").notNull(), // Key Vault secret name
    label:         text("label").default("default"),  // named credential sets
    createdAt:     timestamp("created_at", tz).defaultNow(),
  },
  (t) => [unique().on(t.userId, t.provider, t.label)], // one default per provider
);
```

### Credential CRUD (Profile Routes)

**`POST /api/profile/tokens`** — Add or update a credential:

```typescript
// Atomic: vault write succeeded before DB insert is attempted.
// If the DB insert fails, the orphaned vault secret is cleaned up.
const secretName = userSecretName(user.id, provider, label);
await setSecret(secretName, token);
try {
  await db.insert(userCredentials).values({ userId, provider, label, vaultSecretId: secretName });
} catch (dbErr) {
  await deleteSecret(secretName).catch(() => {}); // compensating transaction
  throw dbErr;
}
```

**`DELETE /api/profile/tokens/:id`** — Remove a credential:

1. Verifies ownership (`userId` must match `req.session.user.id`)
2. Deletes the Key Vault secret
3. Deletes the `user_credentials` row

This ensures no orphaned vault secrets accumulate when credentials are removed.

---

## Azure Key Vault Integration

### Architecture (`src/vault/keyvault.ts`)

The Key Vault client uses `DefaultAzureCredential` from `@azure/identity`, which resolves credentials via the Azure credential chain (managed identity in production, developer CLI credentials locally):

```typescript
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient }           from "@azure/keyvault-secrets";

const client = new SecretClient(
  process.env.AZURE_KEYVAULT_URI!,
  new DefaultAzureCredential(),
);
```

When `AZURE_KEYVAULT_URI` is not set (local development), the module falls back to an **in-memory secret store** so that the application runs without Azure credentials during development.

### Secret Naming Convention

Secrets follow a deterministic naming scheme to avoid collisions and allow secrets to be enumerated per user:

```typescript
export function userSecretName(userId: number, provider: string, label: string): string {
  return `user-${userId}-${provider}-${label}`;
}
```

Example: `user-42-github-default`, `user-42-azuredevops-work`

### Exported Functions

| Function | Signature | Description |
|---|---|---|
| `setSecret` | `(name, value) → Promise<void>` | Creates or updates a vault secret |
| `getSecret` | `(name) → Promise<string \| null>` | Retrieves a secret value; returns `null` if not found |
| `deleteSecret` | `(name) → Promise<void>` | Soft-deletes a secret (Key Vault keeps deleted secrets for recovery period) |

### Local Development Fallback

```typescript
// In-memory map used when AZURE_KEYVAULT_URI is not set
const devSecrets = new Map<string, string>();

export async function setSecret(name: string, value: string) {
  if (!process.env.AZURE_KEYVAULT_URI) {
    devSecrets.set(name, value);
    return;
  }
  await client.setSecret(name, value);
}
```

This fallback means developers can test git credential flows locally without provisioning a Key Vault instance.

---

## Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ENTRA_CLIENT_ID` | Yes (production) | — | Entra app registration client ID |
| `ENTRA_CLIENT_SECRET` | Yes (production) | — | Entra client secret |
| `ENTRA_TENANT_ID` | Yes (production) | — | Azure AD tenant ID |
| `REDIRECT_URI` | Yes | `http://localhost:3000/auth/callback` | OAuth redirect URL (must match Entra registration) |
| `SESSION_SECRET` | Yes | `change-me-in-production` | HMAC key for session cookie signing |
| `AZURE_KEYVAULT_URI` | No | — | Key Vault endpoint; omit to use in-memory fallback |
| `NODE_ENV` | No | `development` | Set to `production` to enable secure cookies |

### Entra App Registration Requirements

The Azure app registration must be configured with:

1. **Platform:** Web (not SPA)
2. **Redirect URIs:** Must include the exact value of `REDIRECT_URI`
3. **Implicit grant:** Disabled (authorization code flow is used)
4. **API permissions:** `openid`, `profile`, `email` (delegated, Microsoft Graph)
5. **Client secret:** Copied to `ENTRA_CLIENT_SECRET` environment variable

---

## Security Considerations

### Token Handling

- **Tokens are never stored in the database.** Only the Key Vault secret name (a pointer) is persisted in `user_credentials`.
- **Tokens are never logged.** The `setSecret` / `getSecret` functions work with secret values that do not pass through the application logger.
- **Tokens are not held in session.** Git tokens are fetched from Key Vault at execution time, used, and discarded — they do not persist in the session store.

### Session Security

- **`SESSION_SECRET` must be a strong random value in production.** The `.env.example` default `change-me-in-production` is intentionally invalid as a production value.
- **Cookies are `httpOnly`**, preventing JavaScript access (XSS mitigation).
- **Cookies are `secure`** in production, ensuring they are only sent over HTTPS.
- **`sameSite: "lax"`** prevents the session cookie from being sent with cross-site POST requests (CSRF mitigation for most scenarios).
- **Session destruction on logout** calls `req.session.destroy()` before redirecting to the Entra logout endpoint, ensuring both the server-side session (PostgreSQL) and the browser cookie are invalidated.

### OIDC Code Flow

- The **Authorization Code flow** (not Implicit flow) is used, keeping tokens off the browser address bar and browser history.
- MSAL handles **PKCE** internally for the public-client variant; the `ConfidentialClientApplication` uses a client secret as the confidential client credential.
- The `code` query parameter from `/auth/callback` is used exactly once; subsequent requests with the same code will fail at Entra.

### Authorisation Checks

- **Ownership verification on credential deletion:** The DELETE handler queries `user_credentials` with both `credId` AND `userId = req.session.user.id` before deleting. This prevents horizontal privilege escalation where user A could delete user B's credentials by guessing an ID.
- **Role checks are middleware, not inline:** Using `requireRole("admin")` as middleware ensures the check cannot be accidentally omitted from individual handler implementations.
- **Repo access is separate from role:** Even `admin` users go through `user_repo_access` for repo-level permissions, preventing accidental data leakage across organizational boundaries if multiple teams share an instance.

### Key Vault Compensating Transactions

When adding a credential, the vault write happens **before** the DB insert. If the DB insert fails, the code attempts to delete the vault secret as a compensating action:

```typescript
try {
  await db.insert(userCredentials).values({ ... });
} catch (dbErr) {
  await deleteSecret(secretName).catch(() => {}); // best-effort cleanup
  throw dbErr;
}
```

The `.catch(() => {})` on the cleanup ensures that a Key Vault failure during cleanup does not mask the original DB error. Orphaned vault secrets from such failures can be identified by their naming convention (`user-{id}-{provider}-{label}`) and cleaned up manually if needed.

---

## Integration Points

### Where Auth Is Consumed

| Consumer | How It Uses Auth |
|---|---|
| `src/dashboard/server.ts` | Mounts session middleware; handles `/auth/login`, `/auth/callback`, `/auth/logout` |
| Every dashboard route handler | Uses `requireAuth` / `requireRole` middleware from `middleware.ts` |
| `src/dashboard/routes/profile.ts` | Accesses `req.session.user` to scope credential CRUD to the current user |
| `src/dashboard/routes/permissions.ts` | Uses `requireRole("admin")` to protect role/repo access management |
| `src/execution/worker.ts` (keeper) | Calls `getSecret(credential.vaultSecretId)` to retrieve git tokens at execution time |
| `src/db/queries/tasks.ts` | Filters tasks by `createdBy` (userId) to enforce per-user visibility |
| Daemon scheduler | Uses `HIVE_DAEMON_USER_ID` env var as the system user for producer-created tasks |

### Middleware Application Order in `server.ts`

```
Express App
  ├── express.json()          ← Body parsing
  ├── express.urlencoded()    ← Form body parsing
  ├── sessionMiddleware       ← Session hydration (from session.ts)
  │     (all subsequent middleware/routes have req.session.user available)
  ├── /auth/login             ← Public (no auth required)
  ├── /auth/callback          ← Public (Entra redirect target)
  ├── /auth/logout            ← Public (clears session)
  └── [all other routes]      ← Protected by requireAuth / requireRole
```

The session middleware is applied **globally** so that every request (including the auth routes themselves) has access to session state. Individual route handlers then apply `requireAuth` or `requireRole` as appropriate.

### Adding a New Protected Route

```typescript
import { requireAuth, requireRole } from "../../auth/middleware.js";

// Any signed-in user
router.get("/my-feature", requireAuth, async (req, res) => {
  const user = req.session.user!; // safe: requireAuth guarantees this
  // ...
});

// Admins only
router.post("/admin/feature", requireRole("admin"), async (req, res) => {
  const user = req.session.user!; // safe: requireRole includes requireAuth logic
  // ...
});
```
