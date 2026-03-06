// Task Lifecycle Diagram — interactive visual walkthrough of the full pipeline
// Pure functions returning HTML strings

import type { SessionUser } from "../../domain/types.js";
import { layout } from "./layout.js";

// ── Color helpers ───────────────────────────────────────────────────────────

type NodeColor = "blue" | "amber" | "emerald" | "red" | "slate" | "purple" | "cyan";

const nodeColors: Record<NodeColor, { bg: string; border: string; text: string; glow: string }> = {
  blue:    { bg: "bg-blue-400/10",    border: "border-blue-400/40",    text: "text-blue-400",    glow: "shadow-blue-400/20" },
  amber:   { bg: "bg-amber-400/10",   border: "border-amber-400/40",  text: "text-amber-400",   glow: "shadow-amber-400/20" },
  emerald: { bg: "bg-emerald-400/10", border: "border-emerald-400/40", text: "text-emerald-400", glow: "shadow-emerald-400/20" },
  red:     { bg: "bg-red-400/10",     border: "border-red-400/40",     text: "text-red-400",     glow: "shadow-red-400/20" },
  slate:   { bg: "bg-slate-700/50",   border: "border-slate-600",      text: "text-slate-400",   glow: "shadow-slate-400/10" },
  purple:  { bg: "bg-purple-400/10",  border: "border-purple-400/40",  text: "text-purple-400",  glow: "shadow-purple-400/20" },
  cyan:    { bg: "bg-cyan-400/10",    border: "border-cyan-400/40",    text: "text-cyan-400",    glow: "shadow-cyan-400/20" },
};

// ── Shared building blocks ──────────────────────────────────────────────────

function phaseHeader(number: number, title: string, color: NodeColor, subtitle: string): string {
  const c = nodeColors[color];
  return `<div class="flex items-center gap-3 mb-4">
    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${c.bg} ${c.border} border text-sm font-bold ${c.text}">${number}</span>
    <div>
      <h3 class="text-base font-semibold text-slate-50">${title}</h3>
      <p class="text-xs text-slate-400">${subtitle}</p>
    </div>
  </div>`;
}

function flowArrow(direction: "down" | "right" = "down"): string {
  if (direction === "right") {
    return `<div class="hidden lg:flex items-center justify-center px-1">
      <svg class="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" /></svg>
    </div>`;
  }
  return `<div class="flex justify-center py-2">
    <svg class="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 13.5 12 21m0 0-7.5-7.5M12 21V3" /></svg>
  </div>`;
}

function phaseConnector(): string {
  return `<div class="flex justify-center py-3">
    <div class="flex flex-col items-center gap-1">
      <div class="w-px h-4 bg-gradient-to-b from-slate-600 to-slate-500"></div>
      <svg class="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 13.5 12 21m0 0-7.5-7.5M12 21V3" /></svg>
    </div>
  </div>`;
}

function detailNode(
  id: string,
  title: string,
  color: NodeColor,
  summary: string,
  details: string,
): string {
  const c = nodeColors[color];
  return `<div
    class="diagram-node group rounded-xl border ${c.border} ${c.bg} p-3 cursor-pointer transition-all hover:shadow-lg hover:${c.glow} hover:scale-[1.02]"
    onclick="toggleDetail('${id}')"
    role="button"
    tabindex="0"
    aria-expanded="false"
    aria-controls="detail-${id}">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span class="text-sm font-semibold ${c.text}">${title}</span>
      </div>
      <svg class="w-4 h-4 ${c.text} opacity-50 transition-transform detail-chevron-${id}" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
      </svg>
    </div>
    <p class="text-xs text-slate-400 mt-1">${summary}</p>
    <div id="detail-${id}" class="hidden mt-3 pt-3 border-t border-slate-700/50 text-xs text-slate-300 space-y-2">
      ${details}
    </div>
  </div>`;
}

function stateChip(label: string, color: NodeColor): string {
  const c = nodeColors[color];
  return `<span class="inline-flex items-center rounded-lg border px-2 py-1 text-xs font-medium ${c.border} ${c.bg} ${c.text}">${label}</span>`;
}

function miniArrow(): string {
  return `<span class="text-slate-500 text-xs">&rarr;</span>`;
}

// ── Phase sections ──────────────────────────────────────────────────────────

function taskSourcesSection(): string {
  return `<div class="rounded-xl border border-slate-700 bg-slate-800 p-5">
    ${phaseHeader(0, "Task Sources", "slate", "Where tasks come from")}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
      ${detailNode("producers", "Auto-Discovery Producers", "blue",
        "7 producers scan for work every 15min (configurable)",
        `<div class="grid grid-cols-2 gap-2">
          <div class="flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span> log-scanner</div>
          <div class="flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span> bug-hunter</div>
          <div class="flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span> security-scanner</div>
          <div class="flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span> feature-scout</div>
          <div class="flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span> doc-auditor</div>
          <div class="flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span> self-monitor</div>
          <div class="flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span> maintenance</div>
        </div>
        <p class="text-slate-400 mt-1">Deduplicated against open tasks before creation.</p>
        <p><a href="/producers" class="text-blue-400 underline hover:text-blue-300">View producers &rarr;</a></p>`
      )}
      ${detailNode("human-tasks", "Human-Created Tasks", "amber",
        "Users create tasks via Dashboard, CLI, or API",
        `<p>All human-created tasks enter at <span class="font-semibold text-amber-400">PENDING</span>, same as producer-discovered tasks.</p>
        <div class="flex flex-wrap gap-1.5 mt-1">
          <span class="rounded-full bg-slate-700 px-2 py-0.5">Dashboard UI</span>
          <span class="rounded-full bg-slate-700 px-2 py-0.5">CLI (npm run cli)</span>
          <span class="rounded-full bg-slate-700 px-2 py-0.5">API endpoint</span>
        </div>`
      )}
    </div>
  </div>`;
}

function routingSection(): string {
  return `<div class="rounded-xl border border-slate-700 bg-slate-800 p-5">
    ${phaseHeader(1, "Intake & Routing", "blue", "PENDING → QUEUED")}
    <div class="flex flex-col lg:flex-row items-stretch gap-3">
      <div class="flex-1 flex items-center justify-center">
        ${stateChip("PENDING", "slate")}
      </div>
      ${flowArrow("right")}
      <div class="flex-1">
        ${detailNode("router", "Router Agent", "blue",
          "Claude classifies the task automatically",
          `<p>Analyzes task title + body to determine:</p>
          <ul class="list-disc list-inside space-y-1 mt-1">
            <li><strong>Type:</strong> bug / feature / security / refactor / improvement / maintenance</li>
            <li><strong>Size:</strong> trivial / small / medium / large</li>
            <li><strong>Workflow:</strong> flow / epic</li>
            <li><strong>Model:</strong> which Claude model for execution</li>
            <li><strong>Limits:</strong> maxTurns, maxBudget (all configurable)</li>
          </ul>`
        )}
      </div>
      ${flowArrow("right")}
      <div class="flex-1 flex items-center justify-center">
        ${stateChip("QUEUED", "blue")}
      </div>
    </div>
  </div>`;
}

function enrichmentSection(): string {
  const enrichers = [
    { id: "codebase", title: "1. Codebase", color: "blue" as NodeColor,
      summary: "Scans repo filesystem",
      details: "Counts files, identifies types, finds keyword-matched files relevant to the task." },
    { id: "docs", title: "2. Docs", color: "blue" as NodeColor,
      summary: "Discovers documentation",
      details: "Scans internal/external docs, README, ARCHITECTURE, .hive.yaml, OpenAPI specs." },
    { id: "git-history", title: "3. Git History", color: "blue" as NodeColor,
      summary: "Analyzes repo history",
      details: "Recent commits (last 50), active contributors (30 days), file hotspots (most-changed files)." },
    { id: "dependencies", title: "4. Dependencies", color: "blue" as NodeColor,
      summary: "Detects build system & deps",
      details: "Identifies npm / dotnet / both. Reads package.json, .csproj, lock files, NuGet packages." },
    { id: "prism", title: "5. Prism", color: "cyan" as NodeColor,
      summary: "Semantic codebase search (optional)",
      details: "Queries Prism API for semantically relevant code snippets, module summaries, and architectural findings. Requires PRISM_API_URL." },
    { id: "hivemind-enricher", title: "6. Hivemind", color: "purple" as NodeColor,
      summary: "Retrieves learnings from past tasks",
      details: `<p>Pulls relevant learnings scoped by:</p>
      <div class="flex flex-wrap gap-1.5 mt-1 mb-1">
        <span class="rounded-full bg-purple-400/10 text-purple-400 px-2 py-0.5">universal</span>
        <span class="rounded-full bg-purple-400/10 text-purple-400 px-2 py-0.5">repo-specific</span>
        <span class="rounded-full bg-purple-400/10 text-purple-400 px-2 py-0.5">user-specific</span>
      </div>
      <p>Confidence-weighted and decayed over time. Categories: patterns, pitfalls, best-practices, anti-patterns, architectural.</p>
      <p class="mt-1"><a href="/hivemind" class="text-purple-400 underline hover:text-purple-300">View hivemind &rarr;</a></p>` },
    { id: "architect", title: "7. Architect", color: "amber" as NodeColor,
      summary: "Designs implementation strategy (Claude)",
      details: `<p>Produces a blueprint with approach, milestones or checklist, key files. Incorporates hivemind learnings from step 6.</p>
      <div class="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/5 p-2">
        <p class="font-semibold text-amber-400">Clarification Questions</p>
        <p class="mt-1">When uncertain, the architect <strong>pauses and asks questions</strong>:</p>
        <ul class="list-disc list-inside mt-1 space-y-0.5">
          <li><strong>Human mode:</strong> task pauses in ENRICHING, waits for user answer</li>
          <li><strong>AI mode:</strong> self-answers from available context</li>
        </ul>
      </div>` },
    { id: "scorer", title: "8. Scorer", color: "amber" as NodeColor,
      summary: "Evaluates complexity & cost (Claude)",
      details: `Scores on 4 dimensions (1-10): <strong>value</strong>, <strong>complexity</strong>, <strong>risk</strong>, <strong>feasibility</strong>.
      <br/>Produces cost estimate and recommendation: approve / reject / rework.` },
  ];

  const enricherNodes = enrichers
    .map((e) => detailNode(e.id, e.title, e.color, e.summary, e.details))
    .join("\n");

  return `<div class="rounded-xl border border-slate-700 bg-slate-800 p-5">
    ${phaseHeader(2, "Enrichment Pipeline", "blue", "QUEUED → ENRICHING (8 enrichers, sequential)")}
    <div class="flex items-center gap-2 mb-4">
      ${stateChip("ENRICHING", "blue")}
      <span class="text-xs text-slate-400">Each enricher passes results to the next</span>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
      ${enricherNodes}
    </div>

    ${flowArrow()}

    <!-- Gate -->
    <div class="mt-2">
      ${detailNode("gate", "Gate Evaluation", "amber",
        "Decides if the task should proceed — mode: human / ai / auto",
        `<div class="space-y-2">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-slate-300">human</span>
            <span class="text-slate-500">&rarr;</span>
            <span>Task waits at ${stateChip("READY", "amber")} for manual approval</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="font-semibold text-slate-300">ai</span>
            <span class="text-slate-500">&rarr;</span>
            <span>Claude gate agent auto-decides</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="font-semibold text-slate-300">auto</span>
            <span class="text-slate-500">&rarr;</span>
            <span>Uses scorer recommendation directly</span>
          </div>
          <div class="border-t border-slate-700 pt-2 mt-2 flex flex-wrap gap-2">
            <span class="text-slate-400">Outcomes:</span>
            ${stateChip("APPROVED", "amber")}
            ${stateChip("READY", "amber")}
            ${stateChip("REJECTED", "red")}
          </div>
        </div>`
      )}
    </div>
  </div>`;
}

function executionSection(): string {
  return `<div class="rounded-xl border border-slate-700 bg-slate-800 p-5">
    ${phaseHeader(3, "Execution", "amber", "APPROVED → EXECUTING")}
    <div class="flex items-center gap-2 mb-4">
      ${stateChip("EXECUTING", "amber")}
    </div>

    <div class="space-y-3">
      ${detailNode("worktree", "Worktree Setup", "slate",
        "Isolated git environment for safe code changes",
        `<ul class="list-disc list-inside space-y-1">
          <li>Clones into <code class="text-xs bg-slate-700 px-1 rounded">/tmp/hive-worktrees/{branch}-{ts}</code></li>
          <li>Sets git user to "The Hive"</li>
          <li>Records base SHA (fork point for diffs)</li>
          <li>Recovers existing remote branch if resuming prior work</li>
        </ul>`
      )}

      ${flowArrow()}

      ${detailNode("worker", "Worker Agent (Claude + Tools)", "amber",
        "Claude writes code using the architect blueprint",
        `<p class="font-semibold text-amber-400 mb-1">Available tools:</p>
        <div class="flex flex-wrap gap-1.5 mb-2">
          <span class="rounded-full bg-slate-700 px-2 py-0.5">read/write files</span>
          <span class="rounded-full bg-slate-700 px-2 py-0.5">shell commands</span>
          <span class="rounded-full bg-slate-700 px-2 py-0.5">git operations</span>
          <span class="rounded-full bg-slate-700 px-2 py-0.5">web preview</span>
        </div>
        <p class="mb-2">Context: architect blueprint + all enrichment data + hivemind learnings. Budget tracked per turn (configurable).</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div class="rounded-lg border border-slate-600 bg-slate-900 p-2">
            <p class="font-semibold text-slate-300 mb-1">Milestone Mode</p>
            <p class="text-slate-400">Medium/large tasks. Each milestone has acceptance criteria, worked sequentially with verify + self-review after each.</p>
          </div>
          <div class="rounded-lg border border-slate-600 bg-slate-900 p-2">
            <p class="font-semibold text-slate-300 mb-1">Checklist Mode</p>
            <p class="text-slate-400">Small/trivial tasks. Claude works through a flat checklist, no milestones.</p>
          </div>
        </div>`
      )}

      ${flowArrow()}

      ${detailNode("quickverify", "Quick Verify", "emerald",
        "Automated build validation after each milestone",
        `<p>Runs the full build pipeline inside the worktree:</p>
        <div class="flex flex-wrap items-center gap-2 mt-1">
          <span class="rounded-full bg-emerald-400/10 text-emerald-400 px-2 py-0.5">install</span>
          ${miniArrow()}
          <span class="rounded-full bg-emerald-400/10 text-emerald-400 px-2 py-0.5">lint</span>
          ${miniArrow()}
          <span class="rounded-full bg-emerald-400/10 text-emerald-400 px-2 py-0.5">build</span>
          ${miniArrow()}
          <span class="rounded-full bg-emerald-400/10 text-emerald-400 px-2 py-0.5">test</span>
        </div>
        <p class="mt-1 text-slate-400">Supports npm and dotnet. Failures collected (non-blocking) and fed back to Claude for fixing.</p>`
      )}

      ${flowArrow()}

      ${detailNode("review-fix", "Self Review-Fix Loop", "amber",
        "Claude reviews its own code and fixes issues (configurable max iterations)",
        `<div class="flex flex-wrap items-center gap-2">
          <span class="text-slate-300">Claude self-reviews</span>
          ${miniArrow()}
          <span class="text-slate-300">Issues found?</span>
          ${miniArrow()}
          <span class="text-amber-400">Fix + re-verify</span>
          ${miniArrow()}
          <span class="text-slate-300">Loop or continue</span>
        </div>
        <p class="mt-1 text-slate-400">This is the <em>inner</em> review loop (per milestone). The <em>outer</em> review gate (Phase 4) is a separate quality check.</p>`
      )}
    </div>

    ${flowArrow()}

    <!-- Docker Self-Validation -->
    <div class="mt-2 rounded-xl border-2 border-cyan-400/30 bg-cyan-400/5 p-4">
      <div class="flex items-center gap-2 mb-3">
        <svg class="w-5 h-5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m0 3h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Zm-3 6h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Z" />
        </svg>
        <h4 class="text-sm font-semibold text-cyan-400">Docker Self-Validation & Browser Testing</h4>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        ${detailNode("docker-spinup", "1. Environment Spin-Up", "cyan",
          "Full app runs in Docker containers",
          `<ul class="list-disc list-inside space-y-1">
            <li>Docker Compose / Testcontainers / Local process</li>
            <li>Syncs worktree to remote Docker host (if configured)</li>
            <li>Runs <code class="bg-slate-700 px-1 rounded">docker-compose up</code></li>
            <li>Waits for health check endpoint to respond OK</li>
          </ul>`
        )}
        ${detailNode("browser-test", "2. Browser Validation", "cyan",
          "Playwright agent tests the live app end-to-end",
          `<p class="font-semibold text-cyan-400 mb-1">Headless Browser Agent:</p>
          <ul class="list-disc list-inside space-y-1">
            <li>Launches headless Chromium against preview URL</li>
            <li>Navigates pages, clicks buttons, fills forms</li>
            <li>Validates UI renders correctly</li>
            <li>Checks functional flows end-to-end</li>
            <li>Screenshots captured as evidence</li>
            <li>Vision-capable Claude model reviews results</li>
          </ul>
          <p class="mt-1 text-slate-400">Failures feed back to the worker for immediate fixing.</p>`
        )}
        ${detailNode("preview-url", "3. Preview URL → PR", "cyan",
          "Live URL attached to PR for human validation",
          `<p>The preview URL is included in the PR so humans can manually validate the running app before merging.</p>
          <p class="mt-1 text-slate-400">Preview stays alive until configurable cleanup timeout.</p>`
        )}
        ${detailNode("docker-teardown", "4. Teardown", "slate",
          "Containers cleaned up automatically",
          `<ul class="list-disc list-inside space-y-1">
            <li>Containers stopped after timeout (configurable)</li>
            <li>Worktree removed</li>
            <li>Logs persisted to DB for debugging</li>
          </ul>`
        )}
      </div>
    </div>
  </div>`;
}

function reviewSection(): string {
  return `<div class="rounded-xl border border-slate-700 bg-slate-800 p-5">
    ${phaseHeader(4, "Review Gate", "amber", "EXECUTING → REVIEWING")}
    <div class="flex items-center gap-2 mb-4">
      ${stateChip("REVIEWING", "amber")}
    </div>

    <div class="space-y-3">
      ${detailNode("review-gate", "Review-Gate Agent (Claude)", "amber",
        "Independent code review of all changes",
        `<p class="mb-2">Inputs: full git diff (base SHA &rarr; HEAD), task context, architect blueprint, verification results.</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <p class="font-semibold text-slate-300 mb-1">Code Quality Findings</p>
            <div class="flex flex-wrap gap-1.5">
              <span class="rounded-full bg-red-400/10 text-red-400 px-2 py-0.5">critical</span>
              <span class="rounded-full bg-red-400/10 text-red-400 px-2 py-0.5">major</span>
              <span class="rounded-full bg-amber-400/10 text-amber-400 px-2 py-0.5">minor</span>
              <span class="rounded-full bg-slate-700 text-slate-300 px-2 py-0.5">info</span>
            </div>
          </div>
          <div>
            <p class="font-semibold text-slate-300 mb-1">Security Findings</p>
            <div class="flex flex-wrap gap-1.5">
              <span class="rounded-full bg-red-400/10 text-red-400 px-2 py-0.5">critical</span>
              <span class="rounded-full bg-red-400/10 text-red-400 px-2 py-0.5">high</span>
              <span class="rounded-full bg-amber-400/10 text-amber-400 px-2 py-0.5">medium</span>
              <span class="rounded-full bg-slate-700 text-slate-300 px-2 py-0.5">low</span>
            </div>
            <p class="text-slate-500 mt-1 text-[11px]">advisory=true &rarr; don't block rework</p>
          </div>
        </div>
        <div class="border-t border-slate-700 mt-2 pt-2">
          <p class="font-semibold text-slate-300 mb-1">Verification Checklist</p>
          <div class="flex flex-wrap gap-3 text-slate-400">
            <span class="flex items-center gap-1"><span class="text-emerald-400">&check;</span> Tests</span>
            <span class="flex items-center gap-1"><span class="text-emerald-400">&check;</span> Lint</span>
            <span class="flex items-center gap-1"><span class="text-emerald-400">&check;</span> Build</span>
          </div>
        </div>`
      )}

      ${flowArrow()}

      <!-- Verdict -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div class="rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-3 text-center">
          <p class="text-sm font-semibold text-emerald-400 mb-1">PASS</p>
          <div class="flex items-center justify-center gap-2">
            ${stateChip("REVIEWING", "amber")} ${miniArrow()} ${stateChip("DONE", "emerald")}
          </div>
          <p class="text-xs text-slate-400 mt-2">Code is ready for PR</p>
        </div>
        <div class="rounded-xl border border-red-400/30 bg-red-400/5 p-3 text-center">
          <p class="text-sm font-semibold text-red-400 mb-1">REWORK</p>
          <div class="flex items-center justify-center gap-2">
            ${stateChip("REVIEWING", "amber")} ${miniArrow()} ${stateChip("REWORK", "red")}
          </div>
          <p class="text-xs text-slate-400 mt-2">Issues found, needs fixing</p>
        </div>
      </div>

      ${flowArrow()}

      <!-- Rework loop -->
      ${detailNode("rework-loop", "Rework Loop", "red",
        "Iterates fix → review until pass or max cycles exhausted",
        `<div class="space-y-2">
          <div class="flex flex-wrap items-center gap-2">
            ${stateChip("REWORK", "red")}
            ${miniArrow()}
            ${stateChip("EXECUTING", "amber")}
            <span class="text-slate-400">(Claude fixes issues)</span>
            ${miniArrow()}
            ${stateChip("REVIEWING", "amber")}
            <span class="text-slate-400">(re-review)</span>
          </div>
          <div class="rounded-lg border border-red-400/20 bg-red-400/5 p-2 mt-2">
            <p class="font-semibold text-red-400 mb-1">When max cycles exhausted:</p>
            <p class="text-slate-300">The system stops. The user chooses from the dashboard:</p>
            <div class="flex flex-wrap gap-2 mt-1">
              <span class="rounded-lg border border-amber-400/40 bg-amber-400/10 text-amber-400 px-2.5 py-1 text-xs font-medium">Add More Cycles &rarr; retry</span>
              <span class="rounded-lg border border-emerald-400/40 bg-emerald-400/10 text-emerald-400 px-2.5 py-1 text-xs font-medium">Force PR &rarr; push as-is</span>
            </div>
          </div>
        </div>`
      )}
    </div>
  </div>`;
}

function prSection(): string {
  return `<div class="rounded-xl border border-slate-700 bg-slate-800 p-5">
    ${phaseHeader(5, "PR & Merge", "emerald", "DONE → MERGED")}
    <div class="flex items-center gap-2 mb-4">
      ${stateChip("DONE", "emerald")}
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
      ${detailNode("pr-create", "PR Creation", "emerald",
        "Automated PR via GitHub or Azure DevOps",
        `<p>PR body built from architect blueprint:</p>
        <ul class="list-disc list-inside space-y-1 mt-1">
          <li>Approach summary</li>
          <li>Key files / Milestones / Checklist</li>
          <li>Review findings & security issues</li>
          <li>Verification status (build/test/lint)</li>
          <li>Cost tracking summary</li>
          <li>Docker preview URL (if available)</li>
        </ul>`
      )}
      ${detailNode("pr-monitor", "PR Monitoring", "emerald",
        "Daemon polls PR status every 15min (configurable)",
        `<ul class="list-disc list-inside space-y-1">
          <li>Polls review status & human feedback</li>
          <li>Feeds PR comments back into task for potential rework</li>
          <li>Monitors CI status checks</li>
          <li>Auto-merges when all checks pass</li>
        </ul>
        <div class="flex items-center gap-2 mt-2">
          ${stateChip("DONE", "emerald")} ${miniArrow()} ${stateChip("MERGED", "emerald")}
        </div>`
      )}
    </div>
  </div>`;
}

function learningSection(): string {
  return `<div class="rounded-xl border-2 border-purple-400/30 bg-purple-400/5 p-5">
    ${phaseHeader(6, "Self-Learning (Hivemind)", "purple", "Continuous improvement feedback loop")}

    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
      ${detailNode("feedback-loop", "Feedback-Loop Agent", "purple",
        "Runs after each task completes",
        `<ul class="list-disc list-inside space-y-1">
          <li>Analyzes what worked / what didn't</li>
          <li>Proposes new learnings &rarr; stored in DB</li>
          <li>Reinforces existing learnings that proved useful</li>
          <li>Contradicts learnings that led to failures</li>
        </ul>`
      )}
      ${detailNode("retro-agent", "Retrospective Agent", "purple",
        "Weekly batch analysis of completed tasks",
        `<ul class="list-disc list-inside space-y-1">
          <li>Reviews batch of completed tasks</li>
          <li>Identifies cross-task patterns</li>
          <li>Proposes systemic learnings</li>
        </ul>`
      )}
      ${detailNode("keeper-agent", "Keeper Agent", "purple",
        "Weekly curation of knowledge base",
        `<ul class="list-disc list-inside space-y-1">
          <li>Promotes high-confidence learnings</li>
          <li>Archives low-confidence or contradicted ones</li>
          <li>Deduplicates and merges similar learnings</li>
          <li>Scope promotion: repo &rarr; universal</li>
        </ul>`
      )}
      ${detailNode("decay", "Monthly Decay", "slate",
        "Prevents stale knowledge from influencing decisions",
        `<ul class="list-disc list-inside space-y-1">
          <li>Reduces confidence of unreinforced learnings</li>
          <li>Archives learnings below threshold</li>
          <li>Keeps knowledge base fresh and relevant</li>
        </ul>`
      )}
    </div>

    <!-- Feedback loop arrow -->
    <div class="mt-4 flex items-center gap-3 rounded-lg border border-purple-400/20 bg-purple-400/5 px-4 py-3">
      <svg class="w-5 h-5 text-purple-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
      </svg>
      <div>
        <p class="text-sm font-semibold text-purple-400">Closes the Loop</p>
        <p class="text-xs text-slate-400">Learnings feed back into <strong>Hivemind enricher (#6)</strong> and <strong>Architect enricher (#7)</strong> in Phase 2, making each task smarter than the last.</p>
      </div>
    </div>
  </div>`;
}

function terminalStatesSection(): string {
  return `<div class="rounded-xl border border-slate-700 bg-slate-800 p-5">
    <h3 class="text-base font-semibold text-slate-50 mb-4">Terminal & Recovery States</h3>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <div class="rounded-lg border border-red-400/30 bg-red-400/5 p-3">
        ${stateChip("FAILED", "red")}
        <p class="text-xs text-slate-400 mt-2">Can occur at any phase. Recoverable via:</p>
        <div class="flex flex-wrap gap-1.5 mt-1">
          <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">retry &rarr; QUEUED</span>
          <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">redesign &rarr; ENRICHING</span>
          <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">more-cycles &rarr; REWORK</span>
        </div>
      </div>
      <div class="rounded-lg border border-slate-600 bg-slate-700/30 p-3">
        ${stateChip("CANCELLED", "slate")}
        <p class="text-xs text-slate-400 mt-2">Manual cancel. Recoverable: retry &rarr; QUEUED</p>
      </div>
      <div class="rounded-lg border border-slate-600 bg-slate-700/30 p-3">
        ${stateChip("SUSPENDED", "slate")}
        <p class="text-xs text-slate-400 mt-2">Graceful daemon shutdown. Auto-resumed on restart.</p>
      </div>
      <div class="rounded-lg border border-red-400/30 bg-red-400/5 p-3">
        ${stateChip("REJECTED", "red")}
        <p class="text-xs text-slate-400 mt-2">Gate rejected. Terminal (can be manually re-opened).</p>
      </div>
    </div>
  </div>`;
}

function daemonSection(): string {
  const loops = [
    { name: "Main dispatcher", interval: "5s", purpose: "Poll tasks, dispatch to agents" },
    { name: "Producer scan", interval: "15min", purpose: "Run 7 auto-discovery producers" },
    { name: "PR feedback poll", interval: "15min", purpose: "Collect PR reviews & comments" },
    { name: "PR close cleanup", interval: "60s", purpose: "Auto-merge done PRs" },
    { name: "Preview cleanup", interval: "60s", purpose: "Stop expired Docker containers" },
    { name: "Retrospective", interval: "7 days", purpose: "Batch learning from completions" },
    { name: "Decay", interval: "30 days", purpose: "Reduce stale learning confidence" },
  ];

  const rows = loops
    .map(
      (l) => `<tr class="border-t border-slate-700">
      <td class="py-2 pr-4 text-xs text-slate-300">${l.name}</td>
      <td class="py-2 pr-4 text-xs text-slate-400 font-mono">${l.interval}</td>
      <td class="py-2 text-xs text-slate-400">${l.purpose}</td>
    </tr>`,
    )
    .join("");

  return `<div class="rounded-xl border border-slate-700 bg-slate-800 p-5">
    <h3 class="text-base font-semibold text-slate-50 mb-4">Daemon Background Loops</h3>
    <div class="overflow-x-auto">
      <table class="w-full">
        <thead>
          <tr class="text-left">
            <th class="pb-2 text-xs font-medium text-slate-400">Loop</th>
            <th class="pb-2 text-xs font-medium text-slate-400">Interval</th>
            <th class="pb-2 text-xs font-medium text-slate-400">Purpose</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="text-xs text-slate-500 mt-3">All intervals are configurable. Cost tracking per component: every Claude call tracked (model, tokens, cost, turns, duration). Configurable daily per-user and per-task budget limits.</p>
  </div>`;
}

// ── Main page ───────────────────────────────────────────────────────────────

export function diagramPage(user: SessionUser): string {
  const content = `<div class="space-y-2">
  <!-- Header -->
  <div class="mb-6">
    <h2 class="text-xl font-semibold text-slate-50">Task Lifecycle</h2>
    <p class="mt-1 text-sm text-slate-400">Interactive diagram of the complete 14-state pipeline. Click any node to expand details.</p>
  </div>

  <!-- Legend -->
  <div class="flex flex-wrap gap-4 text-xs text-slate-400 mb-2 px-1">
    <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-full bg-blue-400"></span> Intake & enrichment</span>
    <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-full bg-amber-400"></span> Execution & review</span>
    <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-full bg-cyan-400"></span> Docker validation</span>
    <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400"></span> PR & merge</span>
    <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-full bg-purple-400"></span> Hivemind learning</span>
    <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-full bg-red-400"></span> Error / rework</span>
  </div>

  <!-- Phases -->
  ${taskSourcesSection()}
  ${phaseConnector()}
  ${routingSection()}
  ${phaseConnector()}
  ${enrichmentSection()}
  ${phaseConnector()}
  ${executionSection()}
  ${phaseConnector()}
  ${reviewSection()}
  ${phaseConnector()}
  ${prSection()}
  ${phaseConnector()}
  ${learningSection()}

  <!-- Supporting sections -->
  <div class="pt-4 space-y-3">
    ${terminalStatesSection()}
    ${daemonSection()}
  </div>
</div>

<script>
function toggleDetail(id) {
  var el = document.getElementById('detail-' + id);
  var chevron = document.querySelector('.detail-chevron-' + id);
  if (!el) return;
  var isHidden = el.classList.contains('hidden');
  el.classList.toggle('hidden');
  if (chevron) {
    chevron.style.transform = isHidden ? 'rotate(180deg)' : '';
  }
  // Update aria
  var node = el.closest('.diagram-node');
  if (node) node.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
}

// Keyboard support
document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' || e.key === ' ') {
    var node = document.activeElement;
    if (node && node.classList.contains('diagram-node')) {
      e.preventDefault();
      node.click();
    }
  }
});
</script>`;

  return layout("Task Lifecycle", content, user);
}
