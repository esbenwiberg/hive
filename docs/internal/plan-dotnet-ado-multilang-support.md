# Plan: Full .NET/C# + Azure DevOps + Multi-Language Pipeline Support

## Context

The first Azure DevOps project is about to be onboarded — a .NET 9 / C# solution with a React/TypeScript frontend project inside it. This is the first non-GitHub, non-Node.js, and multi-language project. The pipeline audit found several gaps that would cause failures or degraded quality. This plan fixes all of them.

---

## Changes

### 1. Azure DevOps PR reuse detection (CRITICAL)

**Problem:** On retry, ADO returns 409 when a PR already exists. GitHub handles this gracefully; ADO crashes the pipeline.

**Files:**
- `src/integrations/azure-devops.ts` — add `listPullRequests()` function
- `src/execution/git-provider.ts` — wrap `AzureDevOpsProvider.createPR` in try/catch, reuse on 409
- `tests/integrations/azure-devops.test.ts` — add tests for `listPullRequests()`
- `tests/execution/git-provider.test.ts` — update existing 409 test (line 496-516) to expect reuse behavior

**Implementation:**

a) Add to `azure-devops.ts` after `getPullRequest()`:
```typescript
export async function listPullRequests(
  org, project, repo, sourceBranch, pat
) → Array<{ id, url, status }>
// GET .../_apis/git/repositories/{repo}/pullrequests
//   ?searchCriteria.sourceRefName=refs/heads/{branch}
//   &searchCriteria.status=active&api-version=7.1
```

b) Update `git-provider.ts` `AzureDevOpsProvider.createPR` (lines 444-455):
- Import `listPullRequests`
- Try `createPullRequest()`, catch errors containing `"(409)"` or `"TF401179"`
- On catch: call `listPullRequests()`, return first match with `reused: true`
- Re-throw if no existing PR found or non-409 error

c) Update test at `git-provider.test.ts:496-516`: mock a 409 from `createPullRequest` then a successful `listPullRequests` response → expect `{ url, reused: true }`

---

### 2. Settings UI dynamic placeholder (CRITICAL)

**Problem:** Repo form shows `"owner/repo"` for all providers but ADO needs `"org/project/repo"`.

**File:** `src/dashboard/views/settings.ts` (lines 752-758)

**Implementation:** Add `onchange` attr to the `select()` call (uses existing 5th `attrs` param):
```js
onchange="document.getElementById('fullName').placeholder =
  this.value === 'azure_devops' ? 'org/project/repo' : 'owner/repo'"
```

No new tests needed — pure client-side JS using existing component API.

---

### 3. Deeper .csproj detection (HIGH)

**Problem:** `hasCsproj()` only scans depth 1. Real .NET repos have `src/MyApp/MyApp.csproj` at depth 2+.

**File:** `src/execution/build-system.ts` (lines 38-67)

**Implementation:** Rewrite `hasCsproj()` to be recursive with `maxDepth=3`:
- Add `SKIP_DIRS` set (`node_modules`, `.git`, `bin`, `obj`, `.vs`, `TestResults`, `packages`, `dist`, `build`)
- Recurse into subdirs not in SKIP_DIRS, decrementing depth
- Early-return on first `.csproj` match
- Matches the depth 3 used by `findCsproj()` in `src/enrichers/dependencies.ts:24`

**Test file (new):** `tests/execution/build-system.test.ts`
- Test nested .csproj at depth 2 and 3
- Test skip dirs are excluded
- Test dotnet+npm hybrid detection
- Test override behavior
- Use temp directories with real files (mkdtemp pattern)

---

### 4. Architect prompt — .NET awareness (HIGH)

**File:** `prompts/enrichers/architect.md`

**Add after Guidelines section (after line 149):**

New "Multi-Language and .NET Awareness" section:
- When enrichment data shows `buildSystem: "dotnet"` or `"dotnet+npm"`, use C# file paths
- .NET acceptance criteria: "builds with `dotnet build`", "passes `dotnet test`"
- For hybrid projects: note both stacks in milestones, verify both build systems
- Update small task schema example to show mixed `.cs` + `.tsx` keyFiles

---

### 5. Scorer prompt — .NET cost notes (MEDIUM)

**File:** `prompts/enrichers/scorer.md`

**Add after "PR follow-up" bullet (after line 48):**
- Hybrid projects (`dotnet+npm`): execution cost ~1.3-1.5x single-stack
- Adjust reference totals accordingly when enrichment shows dual build system

---

### 6. Review gate prompt — broaden to C# (MEDIUM)

**File:** `prompts/review-gate.md`

**Changes:**
- Update one findings example `file` to use `.cs` path
- Update one security finding example to use `.cs` path
- Add `deserialization` to the security `type` enum example
- Add rule 10: C#-specific concerns (SQL injection via `FromSqlRaw`, insecure deserialization, missing `[Authorize]`, hardcoded secrets)

---

## Verification

1. **Build check:** `npm run build` — all TypeScript compiles
2. **Tests:** `npm test` — all existing + new tests pass
3. **Specific test files:**
   - `npm test tests/integrations/azure-devops.test.ts` — new `listPullRequests` tests
   - `npm test tests/execution/git-provider.test.ts` — updated 409 reuse test
   - `npm test tests/execution/build-system.test.ts` — new detection tests
4. **Manual spot-check:** review prompt files for clarity and correctness
