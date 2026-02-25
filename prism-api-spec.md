# Prism HTTP API — Implementation Spec

Hive currently integrates with Prism via the `@prism/core` library, connecting directly to Prism's database. This document proposes replacing that with a proper HTTP API so that each system owns its own data and responsibilities.

## Motivation

- **Hive was generating its own embeddings** to query Prism's vector index — meaning Hive had to know (and match exactly) which embedding model Prism used. One wrong model name or dimension mismatch produces silently bad search results.
- **Hive was calling `runPipeline` directly after PR merges** — no deduplication. If three PRs merge in quick succession for the same repo, three full reindex runs fire in parallel.
- **Hive had direct read access to Prism's database schema** — any schema change in Prism breaks Hive.

With an HTTP API, Prism owns all of this. Hive just sends a query or a reindex request.

---

## Changes on the Hive side

Already done. Hive now:

- Calls `POST /api/projects/:slug/search` with plain query text — no embeddings, no model config
- Calls `POST /api/projects/:slug/reindex` on PR merge — fire-and-forget, 202 response
- Configures only `PRISM_API_URL` and `PRISM_API_KEY` (no database URL, no embedding provider/model)
- No longer runs a nightly semantic reindex tick — Prism schedules this internally

---

## API to implement

### Authentication

All endpoints require a bearer token:

```
Authorization: Bearer <api-key>
```

Return `401` if missing or invalid. A single shared API key is fine to start with.

---

### `POST /api/projects/:slug/search`

Semantic search over a project's index. Prism handles embedding internally.

**Path param:** `:slug` is the URL-encoded `owner/repo` string (e.g. `my-org%2Fmy-repo`).

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

**Response `404`:** Project not found or not yet indexed — Hive will skip the enricher gracefully.

**Notes:**
- Only return findings with severity `critical`, `high`, or `medium` (Hive filters these, but filtering server-side is cheaper)
- If the project's `indexStatus` is not `completed` or `partial`, return `404` — not ready yet
- Embed the query using the same model/provider used to build the index for that project

---

### `POST /api/projects/:slug/reindex`

Enqueue a reindex request. Prism processes these on its own schedule.

**Path param:** `:slug` — same URL-encoded `owner/repo`.

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

**Implementation notes — the queue:**

This is the key change. Instead of running reindex synchronously, persist requests to a table:

```sql
CREATE TABLE reindex_requests (
  id          SERIAL PRIMARY KEY,
  project_id  TEXT NOT NULL,
  layers      TEXT[] NOT NULL DEFAULT '{structural}',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id)  -- deduplication: upsert on conflict
);
```

On each `POST /reindex`, do an upsert:
```sql
INSERT INTO reindex_requests (project_id, layers, requested_at)
VALUES ($1, $2, now())
ON CONFLICT (project_id)
DO UPDATE SET layers = EXCLUDED.layers, requested_at = now();
```

This means if the same repo gets 10 reindex requests in one minute, only one row exists and one reindex runs.

---

## Prism daemon changes

Replace the current nightly/periodic reindex scheduling with a single 15-minute polling loop:

```
every 15 minutes:
  rows = SELECT * FROM reindex_requests ORDER BY requested_at ASC
  for each row:
    project = getProject(row.project_id)
    runPipeline(project, { layers: row.layers })
    DELETE FROM reindex_requests WHERE id = row.id
```

Process one repo at a time to avoid overloading the embedding API. If a reindex fails, log and delete the row anyway (or add a retry counter if you want retries).

The semantic layer (embeddings) can be folded into this same queue — Hive or any other trigger just posts `{ "layers": ["structural", "semantic"] }` or `{ "layers": ["semantic"] }`.

---

## Config changes on the Hive side

`autonomous.config.yaml` and the settings UI now only need:

```yaml
prism:
  apiUrl: "https://prism.example.com"
  apiKey: "sk-..."
```

Or via environment variables: `PRISM_API_URL`, `PRISM_API_KEY`.

The old fields (`databaseUrl`, `embeddingProvider`, `embeddingModel`) are gone.
