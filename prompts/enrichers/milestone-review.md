Review this diff for obvious bugs, security issues, or logic errors.

Return a JSON object with a single `issues` array. Each entry should be a concise description of the problem found.

If the code is clean, return `{ "issues": [] }`.

Focus on:
- Logic errors and off-by-one mistakes
- Security vulnerabilities (injection, XSS, hardcoded secrets)
- Unhandled error cases that could crash at runtime
- Obvious performance issues (e.g. N+1 queries, unbounded loops)

Do NOT flag:
- Style preferences or formatting
- Missing comments or documentation
- Minor naming suggestions
