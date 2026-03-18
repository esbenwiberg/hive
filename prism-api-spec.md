# Prism HTTP API — Integration Spec

Hive integrates with Prism via its HTTP API. Prism owns code indexing, embedding, and context assembly — Hive sends queries and receives pre-assembled context.

## Motivation

- **Hive doesn't generate embeddings** — Prism handles embedding model selection, so no model/dimension mismatch risk.
- **Reindex requests are deduplicated** — Prism queues and coalesces, so multiple PR merges don't trigger parallel reindex runs.
- **No shared database** — Hive talks to Prism over HTTP only; schema changes in Prism don't break Hive.

---

## How Hive uses the API

Three integration points:

- **Enrichment (primary):** `POST /api/projects/:owner/:repo/context/enrich` — one-shot task context for the enrichment pipeline (`src/enrichers/prism.ts`)
- **Search (worker tool):** `POST /api/projects/:owner/:repo/search` — semantic code search available as `search_codebase` tool during task execution (`src/execution/worker-tools.ts`)
- **Reindex (fire-and-forget):** `POST /api/projects/:owner/:repo/reindex` — triggered on PR merge (`src/daemon/pr-close-cleanup.ts`)

Configuration: `PRISM_API_URL` and `PRISM_API_KEY` env vars (or `prism.apiUrl`/`prism.apiKey` in `autonomous.config.yaml`).

---

## Authentication

All endpoints require a bearer token:

```
Authorization: Bearer <api-key>
```

Return `401` if missing or invalid.

---

## Endpoints

All project endpoints use `:owner/:repo` as separate path segments (e.g. `my-org/my-repo`).

---

### `POST /api/projects/:owner/:repo/context/enrich`

> **Recommended entry point.** One-shot endpoint that assembles everything an agent needs for a task.

Returns mentioned files, architecture context, semantic code & doc matches, forward dependencies, aggregated blast radius, and recent changes — all scoped to a natural language query. Prism allocates the token budget across signals automatically via a 4-tier priority system.

**Used by:** `src/enrichers/prism.ts` (enrichment pipeline)

**Request body:**
```json
{
  "query": "string — natural language description of the task",
  "maxTokens": 16000
}
```

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | yes | — | Natural language description of the task |
| `maxTokens` | number | no | 16000 | Token budget — priority system allocates it |

**Response `200`:**
```json
{
  "sections": [
    { "heading": "Mentioned Files", "priority": 1, "content": "**src/indexer/pipeline.ts**\n...", "tokenCount": 620 },
    { "heading": "Purpose", "priority": 1, "content": "Prism is a standalone...", "tokenCount": 120 },
    { "heading": "System Architecture", "priority": 1, "content": "Core modules: indexer, context, db...", "tokenCount": 310 },
    { "heading": "Dependencies of Mentioned Files", "priority": 2, "content": "**src/db/queries.ts** — ...", "tokenCount": 280 },
    { "heading": "Relevant Code", "priority": 2, "content": "**src/indexer/pipeline.ts** — ...", "tokenCount": 850 },
    { "heading": "Relevant Documentation", "priority": 2, "content": "**docs/architecture.md** — ...", "tokenCount": 200 },
    { "heading": "Blast Radius (3 files potentially affected)", "priority": 3, "content": "...", "tokenCount": 210 },
    { "heading": "Commits for Relevant Files", "priority": 3, "content": "`a1b2c3d` fix: handle timeout...", "tokenCount": 180 },
    { "heading": "Recent Commits", "priority": 4, "content": "`e4f5g6h` feat: add caching...", "tokenCount": 150 }
  ],
  "totalTokens": 2920,
  "truncated": false
}
```

**Priority tiers:**

| Priority | Sections | Behaviour |
|----------|----------|-----------|
| 1 | Mentioned Files, Purpose, System Architecture | Guaranteed — survive even tiny token budgets |
| 2 | Dependencies of Mentioned Files, Shared Dependencies, Relevant Code, Relevant Documentation | High value — included unless budget is very tight |
| 3 | Blast Radius, Commits for Relevant Files | Supporting — trimmed first under budget pressure |
| 4 | Recent Commits | Background — only when budget allows |

**Response `404`:** Project not found or not yet indexed — Hive skips the enricher gracefully.

**Notes:**
- Graceful degradation: returns architecture + critical findings even if semantic layer isn't indexed yet.

---

### `POST /api/projects/:owner/:repo/search`

Semantic search over a project's index. Used as an agent tool during task execution.

**Used by:** `src/execution/worker-tools.ts` (`search_codebase` tool)

**Request body:**
```json
{
  "query": "string — task title + body concatenated",
  "maxResults": 20,
  "maxSummaries": 30,
  "maxFindings": 20
}
```

**Response `200`:**
```json
{
  "relevantCode": [
    {
      "targetId": "string",
      "filePath": "string | null",
      "symbolName": "string | null",
      "symbolKind": "string | null",
      "level": "string",
      "summary": "string",
      "score": 0.91
    }
  ],
  "moduleSummaries": [
    {
      "targetId": "string",
      "content": "string"
    }
  ],
  "findings": [
    {
      "category": "string",
      "severity": "critical | high | medium | low",
      "title": "string",
      "description": "string",
      "suggestion": "string | null"
    }
  ]
}
```

**Response `404`:** Project not found or not yet indexed.

---

### `POST /api/projects/:owner/:repo/reindex`

Enqueue a reindex request. Prism queues and deduplicates — multiple requests for the same repo collapse into one.

**Used by:** `src/daemon/pr-close-cleanup.ts` (fire-and-forget on PR merge)

**Request body:**
```json
{
  "layers": ["structural"]
}
```

Possible layer values: `"structural"`, `"semantic"`, or both.

**Response `202 Accepted`:**
```json
{ "queued": true }
```

**Response `404`:** Project not found — Hive ignores this case.
