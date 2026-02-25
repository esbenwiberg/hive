# Dashboard Module

> **Location:** `src/dashboard/`
> **Purpose:** HTMX-powered web interface for The Hive — the primary human-facing layer for task monitoring, system administration, cost visibility, and operational control. It also exposes a small set of server-sent-event (SSE) and JSON endpoints consumed by client-side JavaScript.

---

## Table of Contents

1. [Module Overview](#module-overview)
2. [Server Bootstrap — `server.ts`](#server-bootstrap--serverts)
   - [Middleware Stack](#middleware-stack)
   - [Route Registration](#route-registration)
   - [Error Handling](#error-handling)
   - [OAuth Callback Flow](#oauth-callback-flow)
3. [Rendering Architecture — Views](#rendering-architecture--views)
   - [`layout.ts` — Full-page Shell](#layoutts--full-page-shell)
   - [`components.ts` — Design-system Helpers](#componentsts--design-system-helpers)
   - [Page View Files](#page-view-files)
4. [Route Handlers](#route-handlers)
   - [`dashboard.ts` — Home](#dashboardts--home)
   - [`tasks.ts` — Task Management](#tasksts--task-management)
   - [`changelog.ts` — Changelog](#changelogts--changelog)
   - [`costs.ts` — Cost Reports](#coststs--cost-reports)
   - [`logs.ts` — Live Log Stream](#logsts--live-log-stream)
   - [`settings.ts` — Autonomous Config](#settingsts--autonomous-config)
   - [`permissions.ts` — Repository Access](#permissionsts--repository-access)
   - [`profile.ts` — User Profile & API Keys](#profilets--user-profile--api-keys)
   - [`instances.ts` — Preview Instances](#instancests--preview-instances)
   - [`hivemind.ts` — Learnings Library](#hivemindts--learnings-library)
   - [`prompts.ts` — Prompt Editor](#promptsts--prompt-editor)
   - [`producers.ts` — Producer Runs](#producersts--producer-runs)
   - [`workflow.ts` — Workflow Management](#workflowts--workflow-management)
   - [`health.ts` — Health & System Info](#healthts--health--system-info)
5. [Frontend JavaScript](#frontend-javascript)
   - [`htmx-ext.js` — Toast System, Slide-over Panel, HTMX Hooks](#htmx-extjs--toast-system-slide-over-panel-htmx-hooks)
   - [`commands.js` — Command Palette & Keyboard Shortcuts](#commandsjs--command-palette--keyboard-shortcuts)
   - [`logs.js` — Live Log Streaming Viewer](#logsjs--live-log-streaming-viewer)
6. [Authentication Integration](#authentication-integration)
   - [Session Middleware](#session-middleware)
   - [Route Guards](#route-guards)
   - [Role-based Access](#role-based-access)
7. [HTMX Patterns](#htmx-patterns)
   - [Full-page Responses vs. Partials](#full-page-responses-vs-partials)
   - [Partial Fragment Pattern](#partial-fragment-pattern)
   - [Toast Notifications](#toast-notifications)
8. [Navigation & Layout](#navigation--layout)
9. [Security Considerations](#security-considerations)
10. [See Also](#see-also)

---

## Module Overview

The dashboard is a **server-rendered, HTMX-enhanced** web application built on top of Express. There is no frontend framework — every page is rendered by TypeScript view functions that return HTML strings. Client-side interactivity is layered on top via HTMX (for partial page updates) and three small vanilla-JS scripts for the command palette, toast notifications, and log streaming.

### Key Design Decisions

| Decision | Rationale |
|---|---|
| Server-rendered HTML | Zero build pipeline, fast initial load, no hydration cost |
| Pure TypeScript view functions | Type-safe templates, easily testable, no templating engine dependency |
| HTMX for interactivity | Selective DOM swaps without a full SPA framework |
| Vanilla JS scripts | No bundler required; scripts are served as static files |
| Tailwind CSS (CDN or build) | Utility-first styling; dark theme (`bg-slate-900` palette) |

### File Map

```
src/dashboard/
├── server.ts               # Express app factory, middleware, route wiring
├── routes/
│   ├── changelog.ts        # GET /changelog
│   ├── costs.ts            # GET /costs, GET /costs/breakdown (HTMX partial)
│   ├── dashboard.ts        # GET /
│   ├── health.ts           # GET /health (JSON), GET /health/ui (HTML)
│   ├── hivemind.ts         # GET/POST /hivemind (learnings library)
│   ├── instances.ts        # GET /instances (preview environments)
│   ├── logs.ts             # GET /logs (UI), GET /logs/stream (SSE)
│   ├── permissions.ts      # GET/POST/DELETE /permissions (admin)
│   ├── producers.ts        # GET /producers (run history)
│   ├── profile.ts          # GET/POST /profile, /profile/api-keys
│   ├── prompts.ts          # GET/PUT /prompts/:name (admin)
│   ├── settings.ts         # GET/POST /settings (admin)
│   ├── tasks.ts            # GET/POST /tasks and sub-routes
│   └── workflow.ts         # GET/POST /workflow
├── views/
│   ├── changelog.ts        # changelogPage()
│   ├── components.ts       # statCard(), card(), table(), badge(), …
│   ├── costs.ts            # costsPage(), costsBreakdownPartial()
│   ├── dashboard.ts        # dashboardPage()
│   ├── health.ts           # healthPage()
│   ├── hivemind.ts         # hivemindPage(), learningDetailPartial()
│   ├── instances.ts        # instancesPage()
│   ├── layout.ts           # layout() — full HTML shell with nav
│   ├── logs.ts             # logsPage()
│   ├── permissions.ts      # permissionsPage()
│   ├── producers.ts        # producersPage()
│   ├── profile.ts          # profilePage()
│   ├── prompts.ts          # promptsPage(), promptEditorPartial()
│   ├── settings.ts         # settingsPage()
│   ├── tasks.ts            # taskListPage(), taskDetailPage(), …
│   └── workflow.ts         # workflowPage()
└── public/
    ├── commands.js          # Command palette + keyboard shortcuts
    ├── htmx-ext.js          # Toasts, slide-over panel, HTMX event handlers
    └── logs.js              # SSE-based live log viewer
```

---

## Server Bootstrap — `server.ts`

`server.ts` exports a factory function (`createDashboardApp`) that returns a fully-configured Express application. The daemon calls this function once at startup and mounts the result under the configured port.

### Middleware Stack

Applied in order for every incoming request:

```
Request
  │
  ├─ express.json()           — parse JSON bodies (for API-style POST endpoints)
  ├─ express.urlencoded()     — parse form bodies (HTMX form submissions)
  ├─ sessionMiddleware         — cookie-based session via connect-pg-simple
  ├─ /public (static)         — serves src/dashboard/public/*.js files
  │
  └─ Route handlers (see below)
        │
        └─ Global error handler  — catches next(err) and renders a 500 page
```

#### Session Store

Sessions are persisted to PostgreSQL using `connect-pg-simple`. The session table (`session`) is created automatically on first startup. The session secret is read from `SESSION_SECRET` environment variable — there is no hardcoded fallback.

### Route Registration

Each route file exports a default Express `Router`. They are mounted directly on the root path in `server.ts`:

```ts
app.use("/", dashboardRouter);
app.use("/", changelogRouter);
app.use("/", costsRouter);
app.use("/", logsRouter);
app.use("/", tasksRouter);
// … and so on for every route file
```

The OAuth endpoints (`/auth/callback`, `/auth/login`, `/auth/logout`) are handled inline in `server.ts` rather than in a separate router, keeping the auth flow co-located with the session wiring that depends on it.

### Error Handling

A global Express error handler is registered last:

```ts
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled dashboard error");
  res.status(500).send(layout("Error", errorContent(err), req.session.user));
});
```

The error page renders inside the normal `layout()` shell so the navigation bar remains accessible even on errors. If `req.session.user` is undefined (unauthenticated error), the layout gracefully renders without user-specific nav items.

### OAuth Callback Flow

The Hive uses GitHub OAuth for authentication. The callback flow is handled in `server.ts`:

```
GET /auth/login
  └─ redirect to GitHub authorize URL (via getAuthUrl())

GET /auth/callback?code=<code>
  └─ handleCallback(code)       — exchange code for token
  └─ fetchGitHubUser(token)     — get GitHub profile
  └─ upsertUser(githubUser)     — create or update DB record
  └─ req.session.user = user    — hydrate session
  └─ redirect to /

GET /auth/logout
  └─ req.session.destroy()
  └─ redirect to /auth/login
```

If the callback fails (bad code, network error, insufficient GitHub permissions), the user is redirected back to `/auth/login` with an error query parameter displayed as a toast notification.

---

## Rendering Architecture — Views

All views are pure TypeScript functions with the signature:

```ts
function somePage(data: SomeData, user: SessionUser): string
```

They return a complete HTML string (for full pages) or an HTML fragment string (for HTMX partials). There are no template files — HTML is constructed using tagged template literals and component helper calls.

### `layout.ts` — Full-page Shell

`layout(title, content, user)` returns a complete `<!DOCTYPE html>` document:

- **`<head>`** — sets the page `<title>`, includes Tailwind CDN and HTMX script tags, and links `src/dashboard/public/htmx-ext.js` and `src/dashboard/public/commands.js`.
- **Navigation sidebar / top bar** — renders nav links appropriate to the user's role. Admin-only links (Settings, Permissions, Prompts, etc.) are omitted for non-admin users.
- **`<main>`** — wraps the `content` string passed by the caller.
- **Flash messages** — renders any `req.session.flash` messages as toast notifications on page load.

The layout uses `escapeHtml()` on the `title` parameter but treats `content` as trusted HTML (it is always produced by server-side view functions, not user input).

### `components.ts` — Design-system Helpers

A library of pure functions that each return an HTML string. These enforce visual consistency across all pages:

| Function | Output |
|---|---|
| `escapeHtml(str)` | HTML-escapes a string; used everywhere user data is rendered |
| `statCard(label, value, opts)` | KPI stat card with icon, colour accent, and optional trend |
| `card(inner, opts)` | Bordered panel with optional title, padding variants |
| `table(headers, rows)` | Responsive data table with striped rows |
| `badge(text, colour)` | Coloured pill badge (used for task status, roles, etc.) |
| `emptyState(message)` | Centred empty-state placeholder |
| `button(label, opts)` | Styled button element |
| `alert(message, level)` | Info / warning / error alert box |

All helper functions accept only known safe string inputs or run their user-data arguments through `escapeHtml()`. No view function passes unsanitised user content directly into HTML.

### Page View Files

Each view file corresponds to one route area. They follow a consistent pattern:

1. Import `layout()` from `layout.ts` and component helpers from `components.ts`.
2. Import only the DB row types they need (never the DB client directly).
3. Compose the page content from component helper calls and template literals.
4. Export a primary full-page function (e.g. `tasksPage()`) and optionally one or more partial functions for HTMX fragment endpoints (e.g. `taskRowPartial()`).

---

## Route Handlers

### `dashboard.ts` — Home

**Mounts at:** `GET /`

The dashboard home page shows:

- **Active task summary** — count of tasks in each non-terminal status (queued, running, enriching, etc.)
- **Active agent table** — currently running agent workers with their task ID, type, and elapsed time
- **Recent tasks table** — last N completed or in-progress tasks across all repositories
- **Quick-action buttons** — "New Task" slide-over trigger, links to logs and settings

All data is fetched in parallel via `Promise.all` over `taskQueries.*` and `agentQueries.*`.

**HTMX refresh:** The active task summary and agent table include `hx-trigger="every 10s"` to poll for updates without a full page reload.

```
GET /
  requireAuth
  └─ fetchActiveAgents(), fetchRecentTasks(), fetchTaskCounts()
  └─ dashboardPage(data, user) → full HTML
```

---

### `tasks.ts` — Task Management

**Mounts at:** `GET /tasks`, `GET /tasks/:id`, `POST /tasks`, and several sub-routes

The tasks route is the most complex handler. It covers:

| Endpoint | Description |
|---|---|
| `GET /tasks` | Paginated task list with status / repo / type filters |
| `GET /tasks/:id` | Task detail page with events timeline and agent log |
| `POST /tasks` | Create a new task (from the "New Task" slide-over form) |
| `POST /tasks/:id/cancel` | Cancel a running task |
| `POST /tasks/:id/approve` | Approve a task pending human review |
| `POST /tasks/:id/reject` | Reject a task pending human review |
| `POST /tasks/:id/rework` | Send a task back to the agent with feedback |
| `GET /tasks/:id/events` | HTMX partial — event stream for polling task progress |
| `GET /tasks/row/:id` | HTMX partial — single task table row for live status updates |

#### Task Filters

The `GET /tasks` list accepts query parameters that are validated before use:

```
?status=running&repo=42&type=bug&page=2
```

Invalid values are silently ignored (safe defaults applied). Filters are passed to `taskQueries.listTasks()` which builds the WHERE clause.

#### Task Detail Page

`GET /tasks/:id` renders:

- Task metadata (title, body, type, status badge, created date)
- Full event timeline — all `task_events` rows for this task in chronological order, rendered as a vertical timeline component
- Code review results (if a PR was created)
- Approval/rejection controls (if the task is in `pending_human_review` status and the user has appropriate permissions)

#### Task Creation

`POST /tasks` accepts `application/x-www-form-urlencoded` or JSON. The handler:

1. Validates `title` (required, max 200 chars) and `body` (required).
2. Calls `taskQueries.create()` to insert the task.
3. For HTMX requests (detected via `HX-Request` header), responds with an `HX-Redirect` header to navigate to the new task's detail page.
4. For plain form submissions, issues a standard `302` redirect.

---

### `changelog.ts` — Changelog

**Mounts at:** `GET /changelog`

**Access:** Admin only (`requireRole("admin")`)

Reads the project's `CHANGELOG.md` from disk at request time and renders it as a series of date-labelled card components. The parser expects the standard `## YYYY-MM-DD` heading format with `- item` bullet lists.

```ts
// Parsing logic in views/changelog.ts
function parseChangelog(raw: string): ChangelogSection[]
```

If `CHANGELOG.md` does not exist, an empty-state message is shown. The file is read synchronously (`fs.readFileSync`) since it is a small local file and this route is admin-only with infrequent access.

---

### `costs.ts` — Cost Reports

**Mounts at:** `GET /costs`, `GET /costs/breakdown`

Provides visibility into LLM API spend accumulated in the `llm_usage` table.

#### `GET /costs` — Full Page

Renders three stat cards (today / this month / all-time) and three tabbed sections:

- **Cost Breakdown** — a table grouped by the active dimension (user / repo / agent / model)
- **Daily Trend** — a CSS bar chart of spend per day for the last 30 days, plus a recent-days table
- **Monthly Summary** — table of total spend per calendar month

Admins see cost data across all users; regular users see only costs scoped to their own user ID and their accessible repositories (enforced via the `CostScope` helper that builds a WHERE clause).

#### `GET /costs/breakdown` — HTMX Partial

Used by the dimension-switcher tab buttons in the full page. When the user clicks "By Repo" or "By Model", HTMX fires:

```html
<button hx-get="/costs/breakdown?dimension=repo"
        hx-target="#breakdown-table"
        hx-swap="innerHTML">
  By Repo
</button>
```

The server validates the `dimension` query parameter against an allowlist (`user | repo | agent | model`) and returns only the HTML fragment for the table body. This avoids a full page reload when switching breakdown dimensions.

---

### `logs.ts` — Live Log Stream

**Mounts at:** `GET /logs`, `GET /logs/stream`

#### `GET /logs` — Log Viewer UI

Renders a static HTML page containing the filter controls and the empty log container. The page includes a `<script src="logs.js">` tag that activates the live streaming client.

**Access:** Admin only (`requireRole("admin")`) for both the page and the stream endpoint, since logs can contain sensitive task content and internal system state.

#### `GET /logs/stream` — Server-Sent Events

An SSE endpoint that streams log entries from the in-process `logBuffer` in real time:

```
Response headers:
  Content-Type: text/event-stream
  Cache-Control: no-cache
  Connection: keep-alive

Event format:
  data: {"level":"info","time":1234567890,"msg":"Task queued","taskId":42,"component":"router"}\n\n
```

The handler:
1. Sets SSE response headers and flushes them immediately.
2. Replays the current `logBuffer` snapshot to new connections (so the viewer shows recent history on connect).
3. Registers a listener on `logBuffer.on("entry", handler)` to push new entries as they arrive.
4. Removes the listener on `req.on("close", ...)` to prevent memory leaks when the client disconnects.

Filtering (by level, component, task ID, free-text search) is performed **client-side** in `logs.js` — the server sends all entries and the browser applies filters locally for zero-latency response to filter changes.

---

### `settings.ts` — Autonomous Config

**Mounts at:** `GET /settings`, `POST /settings`

**Access:** Admin only (`requireRole("admin")`)

Provides a web UI for viewing and editing `autonomous.config.yaml` — the configuration file that controls producer schedules, agent model selection, autonomous mode toggles, and per-repo settings.

#### `GET /settings`

Reads the current config via `getAutonomousConfig()` and renders it as an editable form. Sensitive fields (API keys, secrets) are rendered as password inputs with `autocomplete="off"`.

#### `POST /settings`

Accepts the submitted form, validates the YAML (parses it to check for syntax errors), and writes it back to disk via `saveAutonomousConfig()`. On success, a success toast is triggered via the `HX-Trigger` response header:

```ts
res.setHeader("HX-Trigger", JSON.stringify({ showToast: { message: "Settings saved", level: "success" } }));
res.send(settingsPage(config, user));
```

If validation fails, the page is re-rendered with an inline error message and the user's input preserved.

---

### `permissions.ts` — Repository Access

**Mounts at:** `GET /permissions`, `POST /permissions`, `DELETE /permissions/:id`

**Access:** Admin only (`requireRole("admin")`)

Manages which users have access to which repositories via the `user_repo_access` table.

| Endpoint | Action |
|---|---|
| `GET /permissions` | Lists all users and their current repo access grants |
| `POST /permissions` | Grants a user access to a repository |
| `DELETE /permissions/:id` | Revokes a specific access grant |

POST and DELETE respond with HTMX-friendly responses: on success they return the updated permissions table as an HTML fragment (target `#permissions-table`) so the page updates without a full reload.

---

### `profile.ts` — User Profile & API Keys

**Mounts at:** `GET /profile`, `POST /profile`, `POST /profile/api-keys`, `DELETE /profile/api-keys/:id`

Allows users to manage their own profile and API keys for the REST API.

#### Profile Update

`POST /profile` accepts `name` and `email` fields, updates the user record in the `users` table, and refreshes the session with the updated user data.

#### API Key Management

API keys allow non-browser clients (scripts, CI pipelines) to authenticate to the dashboard API without OAuth:

| Endpoint | Action |
|---|---|
| `POST /profile/api-keys` | Generate a new API key with optional label and expiry |
| `DELETE /profile/api-keys/:id` | Revoke an API key |

Generated keys are shown once (in a modal or inline response) and then stored only as a SHA-256 hash. The plaintext key is never stored or logged.

---

### `instances.ts` — Preview Instances

**Mounts at:** `GET /instances`, `POST /instances/:id/stop`

**Access:** Authenticated users (own instances); admins see all instances

Displays preview environment instances created by agent task executions. Integrates with the preview instance management layer (`getPreviewInstances()`) to show:

- Instance ID and associated task
- Repository and branch
- Start time and current status (running / stopped)
- Direct URL to the preview environment

Admins can stop any instance; regular users can only stop their own.

---

### `hivemind.ts` — Learnings Library

**Mounts at:** `GET /hivemind`, `GET /hivemind/:id`, `POST /hivemind/:id/delete`

**Access:** Authenticated users (read); admins can delete

The Hive Mind is The Hive's internal knowledge base — a collection of `learnings` entries that agents write when they discover reusable patterns, gotchas, or best practices during task execution.

| Endpoint | Action |
|---|---|
| `GET /hivemind` | Paginated list of all learnings, searchable by keyword |
| `GET /hivemind/:id` | HTMX partial — learning detail panel (slide-over) |
| `POST /hivemind/:id/delete` | Delete a learning (admin only) |

The detail view (`learningDetailPartial()`) is returned as an HTML fragment that populates the slide-over panel via HTMX swap — clicking a learning row in the list triggers:

```html
<tr hx-get="/hivemind/42"
    hx-target="#slide-over-content"
    hx-swap="innerHTML"
    class="cursor-pointer">
```

---

### `prompts.ts` — Prompt Editor

**Mounts at:** `GET /prompts`, `GET /prompts/:name`, `PUT /prompts/:name`

**Access:** Admin only (`requireRole("admin")`)

Provides an in-browser editor for the agent system prompts stored as Markdown files on disk. Editing prompts through the dashboard allows tuning agent behaviour without a code deployment.

| Endpoint | Action |
|---|---|
| `GET /prompts` | Lists all available prompt files |
| `GET /prompts/:name` | Returns the raw prompt content for inline editing (HTMX partial) |
| `PUT /prompts/:name` | Saves updated prompt content to disk |

The editor uses a `<textarea>` with monospace styling. The `name` parameter is validated against the allowlist returned by `listPromptFiles()` to prevent path traversal — only filenames present in the known prompts directory are accepted.

---

### `producers.ts` — Producer Runs

**Mounts at:** `GET /producers`

**Access:** Admin only (`requireRole("admin")`)

Displays the history of producer run records from the `producer_runs` table. Shows:

- Producer name
- Target repository
- Run timestamp
- Tasks created / duplicates skipped
- Errors (expandable)
- Cost incurred

Data is fetched via `producerRunQueries.listRecentRuns()` and rendered as a sortable table. Allows operators to verify that producers are running on schedule and generating work.

---

### `workflow.ts` — Workflow Management

**Mounts at:** `GET /workflow`, `POST /workflow/approve`, `POST /workflow/reject`

**Access:** Authenticated users (view own workflow items); admins see all

The workflow view shows tasks currently in `pending_human_review` status — tasks that the gate agent has flagged as requiring a human decision before proceeding. Users see only tasks in their accessible repositories.

| Endpoint | Action |
|---|---|
| `GET /workflow` | List tasks awaiting human review |
| `POST /workflow/approve` | Approve a task (sets status to allow pipeline to continue) |
| `POST /workflow/reject` | Reject a task with an optional feedback note |

This route is the primary interface for human-in-the-loop oversight of the autonomous pipeline.

---

### `health.ts` — Health & System Info

**Mounts at:** `GET /health`, `GET /health/ui`

#### `GET /health` — JSON Health Check

Returns a machine-readable JSON response suitable for load balancer health checks and monitoring:

```json
{
  "status": "ok",
  "uptime": 3600,
  "version": "1.2.3",
  "db": "ok",
  "memory": { "rss": 134217728, "heapUsed": 67108864 }
}
```

**Access:** Open (no auth required) — intentionally accessible without login for infra health checks.

#### `GET /health/ui` — HTML System Info Page

**Access:** Admin only (`requireRole("admin")`)

A rich HTML page showing:
- Node.js version and process uptime
- Memory usage (`process.memoryUsage()`)
- OS hostname and platform (`os.hostname()`, `os.platform()`)
- Git commit hash (from `git rev-parse HEAD` via `execSync`)
- Database connectivity status
- Environment variable presence check (no values exposed, only `present` / `missing`)

---

## Frontend JavaScript

All three scripts are plain vanilla JS (no modules, no transpilation). They are served as static files from `/public/` and loaded via `<script src="/public/...">` tags in the layout or individual view files.

### `htmx-ext.js` — Toast System, Slide-over Panel, HTMX Hooks

**Loaded on:** Every page (included in `layout.ts`)

This script is the HTMX integration layer. It wraps HTMX's event system and adds two UI primitives.

#### Toast System

Toasts are triggered by a custom HTMX event mechanism. The server can request a toast notification by including an `HX-Trigger` response header:

```
HX-Trigger: {"showToast": {"message": "Settings saved", "level": "success"}}
```

The client intercepts the `htmx:afterRequest` event, reads the trigger payload, and displays a floating toast:

- **Positioning:** Bottom-right, stacked vertically
- **Levels:** `success` (green), `error` (red), `warn` (amber), `info` (blue/slate)
- **Auto-dismiss:** After 4 seconds (configurable)
- **Manual dismiss:** Click the `×` button

```
Server response
  └─ HX-Trigger header with showToast payload
       └─ HTMX fires htmx:afterRequest
            └─ htmx-ext.js reads the trigger
            └─ injects <div class="toast ..."> into #toast-container
            └─ setTimeout(removeToast, 4000)
```

Toasts can also be triggered directly from JavaScript:

```js
window.showToast({ message: "Copied!", level: "success" });
```

#### Slide-over Panel

A right-side drawer panel for detail views (task events, Hivemind learning detail, etc.) without navigating away from the current page:

- **Open:** Set `hx-target="#slide-over-content"` and `hx-swap="innerHTML"` on any link or button. After the HTMX swap, the script animates the panel into view.
- **Close:** Clicking the overlay or the `×` button slides the panel out and clears its content.

The panel is a fixed-position element already present in the DOM (rendered by `layout.ts`); `htmx-ext.js` manages its visibility and animation classes.

#### HTMX Lifecycle Hooks

`htmx-ext.js` also registers handlers for:

| HTMX Event | Handler |
|---|---|
| `htmx:beforeRequest` | Show loading indicator on the target element |
| `htmx:afterRequest` | Hide loading indicator; process `HX-Trigger` headers |
| `htmx:responseError` | Display error toast with HTTP status code |
| `htmx:sendError` | Display network error toast |

---

### `commands.js` — Command Palette & Keyboard Shortcuts

**Loaded on:** Every page (included in `layout.ts`)

A command palette (similar to VS Code's `Ctrl+P`) and a set of global keyboard shortcuts.

#### Keyboard Shortcuts

| Key | Action |
|---|---|
| `Ctrl+K` / `Cmd+K` | Open / close the command palette |
| `?` | Open the shortcuts help overlay |
| `Escape` | Close any open overlay |
| `G T` (sequential) | Navigate to Tasks (`/tasks`) |
| `G D` | Navigate to Dashboard (`/`) |
| `G C` | Navigate to Costs (`/costs`) |
| `G L` | Navigate to Logs (`/logs`) |
| `G H` | Navigate to Hivemind (`/hivemind`) |
| `N` | Open "New Task" slide-over |

The `G` prefix shortcuts are inspired by GitHub's navigation model: press `G` to enter "go to" mode, then a second letter to navigate.

#### Command Palette

Opening the palette with `Ctrl+K`:
1. Renders a modal overlay with a fuzzy-search input.
2. Filters the static command list (navigation links, actions) in real time as the user types.
3. Keyboard-navigable with `↑` / `↓` arrow keys and `Enter` to activate.
4. Closes on `Escape` or clicking outside the modal.

Commands are defined as a static array of `{ label, description, action }` objects. The `action` is either a URL string (navigates to that page) or a callback function.

#### Shortcuts Help Overlay

Pressing `?` renders a modal displaying all registered keyboard shortcuts in a two-column grid. The overlay is generated entirely from the same static command definitions so the help display and actual bindings are always in sync.

---

### `logs.js` — Live Log Streaming Viewer

**Loaded on:** `/logs` page only (injected by `src/dashboard/views/logs.ts` via inline `<script>` tag into the HTML response)

Implements a real-time log viewer using the browser's `EventSource` API to consume the `/logs/stream` SSE endpoint.

#### Connection Management

```
EventSource('/logs/stream')
  │
  ├─ onopen  → update #status-dot to green, #status-text to "Connected"
  ├─ onmessage → parse JSON, apply filters, render log entry
  └─ onerror → update status to "Reconnecting...", EventSource auto-reconnects
```

The `EventSource` API handles reconnection automatically with exponential back-off. The status indicator in the UI reflects the current connection state.

#### Log Entry Rendering

Each incoming event is parsed as JSON and rendered as a `<div>` log row with:

- **Timestamp** — formatted as `HH:MM:SS.mmm`
- **Level badge** — colour-coded (`debug`=grey, `info`=blue, `warn`=amber, `error`=red, `fatal`=dark red)
- **Component** — extracted from the structured log fields and rendered as a monospace tag
- **Message** — the `msg` field
- **Structured fields** — remaining JSON fields (e.g. `taskId`, `agentType`) rendered as `key=value` pairs in a muted colour

Rows are appended to `#log-container`. When the container exceeds 2 000 entries, the oldest 500 are pruned to prevent unbounded memory growth.

#### Auto-scroll Behaviour

The viewer auto-scrolls to the bottom as new entries arrive **unless** the user has manually scrolled up. The `#log-scroll-bottom` button appears when the user is not at the bottom, allowing them to jump back to the latest entries.

#### Client-side Filters

Filters are applied before rendering — entries that don't match are discarded silently (not buffered):

| Filter | Control | Logic |
|---|---|---|
| Log level | Checkboxes (debug/info/warn/error/fatal) | Entry dropped if level checkbox unchecked |
| Component | `<select>` dropdown | `All` passes everything; specific value filters by `component` field |
| Task ID | Text input | Filters by exact `taskId` match |
| Free text | Text input | Case-insensitive substring match on the full serialised entry |

The component dropdown is populated dynamically from observed log entries — new component names are added to the `<option>` list as they appear.

#### Pause / Resume

The `Pause` button suspends rendering (new SSE messages are discarded) without closing the `EventSource` connection. Pressing `Resume` re-connects and replays the backlog from the server's log buffer.

#### Clear

The `Clear` button removes all rendered log rows from the DOM. The SSE connection remains open; new entries continue to arrive and render.

---

## Authentication Integration

### Session Middleware

Every route (except `GET /health` and the OAuth callback endpoints) is behind the session middleware. The session object is typed:

```ts
declare module "express-session" {
  interface SessionData {
    user?: SessionUser;
    flash?: { message: string; level: "success" | "error" | "warn" | "info" }[];
  }
}
```

`SessionUser` is defined in `src/domain/types.ts` and contains `id`, `name`, `email`, `role`, and `githubLogin` — enough to make access control decisions and render personalised UI without additional DB queries per request.

### Route Guards

Two middleware functions from `src/auth/middleware.ts` are used throughout the dashboard:

#### `requireAuth`

```ts
function requireAuth(req: Request, res: Response, next: NextFunction): void
```

Checks that `req.session.user` is set. If not, redirects to `/auth/login` with the original URL preserved as a `?next=` parameter so the user is returned to their intended destination after login.

#### `requireRole(role: "admin" | "user")`

```ts
function requireRole(role: string): RequestHandler
```

Returns a middleware that checks `req.session.user.role`. If the role does not match, responds with a 403 Forbidden page (rendered in the layout shell). This is always used **after** `requireAuth` — never standalone.

### Role-based Access

| Role | Access level |
|---|---|
| `admin` | Full access to all routes and data across all users/repos |
| `user` | Access scoped to their own profile, their accessible repos, and shared read-only views |

Scoping for `user` role is enforced at the **data layer** (in DB query helpers), not just at the route level. For example, `GET /costs` runs a `CostScope` query that restricts results to the user's own data even if the route guard were bypassed.

---

## HTMX Patterns

### Full-page Responses vs. Partials

Routes return either:

1. **Full page** — a complete HTML document via `layout(title, content, user)`. Used for direct navigation (link click, browser address bar).
2. **HTML fragment** — a bare HTML snippet (no `<html>` wrapper). Used for HTMX swap targets.

Routes detect the request type via the `HX-Request: true` header HTMX sets on all its requests:

```ts
const isHtmx = req.headers["hx-request"] === "true";
if (isHtmx) {
  res.send(partialHtml);
} else {
  res.send(layout("Title", partialHtml, user));
}
```

Some routes always return partials (e.g. `/costs/breakdown`) and some always return full pages (e.g. `GET /`). Hybrid routes handle both.

### Partial Fragment Pattern

The pattern for an HTMX-swappable section:

**In the view (HTML):**
```html
<div id="breakdown-table" hx-swap-oob="true">
  <!-- initial content rendered by full page -->
</div>

<button hx-get="/costs/breakdown?dimension=repo"
        hx-target="#breakdown-table"
        hx-swap="innerHTML">
  By Repo
</button>
```

**In the route handler:**
```ts
router.get("/costs/breakdown", requireAuth, async (req, res) => {
  const rows = await costQueries.getBreakdownByRepo(scope);
  res.send(costsBreakdownPartial(rows, "repo"));  // returns fragment only
});
```

**In the view module:**
```ts
// Exported separately so it can be called by both the full page and the partial route
export function costsBreakdownPartial(rows: BreakdownRow[], dim: BreakdownDimension): string {
  return table(headers, tableRows);
}
```

### Toast Notifications

Server-initiated toast notifications are sent via the `HX-Trigger` response header. This works for both HTMX requests and regular form submissions (when used with `hx-boost`):

```ts
// Success toast
res.setHeader("HX-Trigger", JSON.stringify({
  showToast: { message: "Task created", level: "success" }
}));

// Error toast (in addition to inline error display)
res.setHeader("HX-Trigger", JSON.stringify({
  showToast: { message: "Validation failed: title is required", level: "error" }
}));
```

The client-side `htmx-ext.js` intercepts the `htmx:afterRequest` event and processes the `HX-Trigger` payload, delegating to `window.showToast()`.

---

## Navigation & Layout

The navigation sidebar (rendered by `layout.ts`) adapts to the user's role:

### All authenticated users

- Dashboard (`/`)
- Tasks (`/tasks`)
- Costs (`/costs`)
- Workflow (`/workflow`)
- Hivemind (`/hivemind`)
- Profile (`/profile`)
- Instances (`/instances`)

### Admin-only nav items

- Logs (`/logs`)
- Settings (`/settings`)
- Permissions (`/permissions`)
- Prompts (`/prompts`)
- Producers (`/producers`)
- Health (`/health/ui`)
- Changelog (`/changelog`)

The current page is highlighted in the nav using path comparison between `req.path` and each nav item's href.

---

## Security Considerations

| Concern | Mitigation |
|---|---|
| XSS | All user-supplied data rendered via `escapeHtml()` before insertion into HTML |
| Path traversal (prompts) | `name` parameter validated against allowlist from `listPromptFiles()` |
| CSRF | HTMX sends requests with `HX-Request: true`; combined with session-cookie same-site policy |
| Session fixation | Session is regenerated on login (new session ID after OAuth callback) |
| Secrets exposure | `/health` JSON endpoint includes only status/metrics, never env var values |
| Privilege escalation | Role checks at both route level (`requireRole`) and data level (`CostScope`, access queries) |
| API key storage | Keys stored only as SHA-256 hash; plaintext shown exactly once on creation |
| Dimension injection | `GET /costs/breakdown` validates `dimension` against an explicit allowlist |
| Log content | `/logs/stream` requires admin role; entries are JSON-serialised (not HTML) |

---

## See Also

- [`docs/internal/architecture.md`](../architecture.md) — end-to-end system overview and component relationships
- [`docs/internal/modules/agents.md`](./agents.md) — the pipeline that the dashboard monitors and controls
- [`docs/internal/modules/producers.md`](./producers.md) — producers whose run history is visible in `/producers`
- `src/auth/middleware.ts` — `requireAuth` and `requireRole` implementations
- `src/auth/session.ts` — session store configuration
- `src/db/queries/costs.ts` — cost aggregation queries behind the `/costs` page
- `src/domain/types.ts` — `SessionUser` type definition
- `src/log-buffer.ts` — in-process log ring-buffer consumed by `/logs/stream`
- `autonomous.config.yaml` — configuration edited via `/settings`
- Client-side JavaScript — see `src/dashboard/public/commands.js`, `src/dashboard/public/htmx-ext.js`, and `src/dashboard/public/logs.js`
