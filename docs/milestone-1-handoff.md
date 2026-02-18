# Milestone 1 Handoff Report

## 1. Context for Milestone 2

### Entry point and server wiring

`src/index.ts` is the boot sequence: `migrate() -> app.listen() -> graceful shutdown`. The Express app lives in `src/dashboard/server.ts` — mount new routers there via `app.use(...)`. The server already wires up `express.json()`, `express.urlencoded()`, `sessionMiddleware`, and `injectUser` globally.

### Authentication

Three exports from `src/auth/middleware.ts`:
- `requireAuth` — redirect-to-login guard
- `requireRole(role)` — role-level guard (viewer=0 < user=1 < admin=2)
- `injectUser` — already registered globally; puts `req.session.user` into `res.locals.user`

`SessionUser` interface is defined in `src/dashboard/views/layout.ts`:
```ts
{ id: number; entraOid: string; email: string; displayName: string; role: string; }
```

### Database

`src/db/connection.ts` exports:
- `db` — Drizzle instance with full schema (use for all queries)
- `pool` — raw pg.Pool (session store and tests only)

`src/db/schema.ts` exports all 15 tables by camelCase name. Key task table facts:
- `tasks.id` is `text` (not serial) — must generate IDs explicitly
- Status/type/size/workflow are plain `text` — validation is application-side
- `tasks.repoId` FK to `repos.id` — repo must exist before task
- `tasks.createdBy` FK to `users.id`
- `numeric` columns come back as strings from pg driver — parse with `parseFloat`

Existing query file: `src/db/queries/users.ts` — follow same pattern for new query files.

### Views

`layout(title, content, user?)` — full HTML shell. Pass `SessionUser` for sidebar layout, omit for unauthenticated.

`components.ts` exports: `button()`, `badge()`, `card()`, `statusBadge()`, `input()` — all return HTML strings.

### Design system

Using Tailwind CDN with inline config. Custom tokens in `tailwind.config.ts` (surface-*, accent, semantic-*) are NOT active — use raw Tailwind classes (slate-800, amber-400, etc.).

### HTMX

HTMX 2.0.4 loaded via CDN. For partial responses, detect `HX-Request` header.

### ESM conventions

All imports use `.js` extensions. `"module": "NodeNext"` in tsconfig.

### Testing

- `tests/setup.ts` exports `db`, `pool`, `cleanupTables()` for integration tests
- DB tests mock `../../src/db/connection.js` via `vi.mock()` to use test DB
- Middleware tests use `vi.fn()` mock req/res

---

## 2. Suggested Amendments to Milestone 2

### Amendment 1: Move `SessionUser` to shared types
Currently in `layout.ts`. Should relocate to `src/domain/types.ts` to avoid layering violation.

### Amendment 2: Task ID generation needed
`tasks.id` is `text` with no auto-increment. Use `crypto.randomUUID()` (built-in, no dependency) or format as `HIVE-YYYYMMDD-xxxx`.

### Amendment 3: Static file serving for client-side JS
`src/dashboard/public/commands.ts` and `htmx-ext.ts` need a static middleware route. No bundler exists — write as plain `.js` files and serve via `express.static()`.

### Amendment 4: Key Vault URI env var missing
Add `AZURE_KEYVAULT_URI` to docker-compose.yaml and .env.example for vault/keyvault.ts.

### Amendment 5: No YAML parser installed
Blueprint plans YAML config loading but no yaml library in deps. Either add `yaml` package or use `global_config` table only.

### Amendment 6: Tailwind CDN vs compiled CSS
Custom tokens unreachable via CDN. Either add build step or stick to standard Tailwind classes.

### Amendment 7: Home route conflict
`server.ts` has inline `GET /` — remove when mounting `dashboardRouter`.
