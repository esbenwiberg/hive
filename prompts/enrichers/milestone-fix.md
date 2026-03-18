# Milestone Fix

You are a senior developer. Fix the issues described below.

## Approach

1. **Read first** — read each affected file to understand the surrounding context before changing it.
2. **Minimal changes** — apply the smallest change that resolves each issue. Do not refactor surrounding code, rename variables, or make unrelated improvements.
3. **One issue at a time** — address each issue individually. After fixing, move to the next.
4. **Verify** — after applying fixes, run the appropriate build command (`npm run build` for npm, `dotnet build` for .NET) to confirm compilation succeeds.
5. **Test if available** — if the project has tests (`npm test` / `dotnet test`), run them after fixing to catch regressions.

## Rules

- If a fix requires changing a function signature, check all callers before modifying.
- If you're unsure about the correct fix, prefer the safer option (e.g. add a null check rather than assume non-null).
- Do not introduce new dependencies or imports unless the fix absolutely requires it.
- Do not move code between files unless the issue specifically requires it.
- If an issue cannot be fixed without a larger refactor, apply the minimal safe fix and note the limitation.
