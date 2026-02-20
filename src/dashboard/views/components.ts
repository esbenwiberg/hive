// Design-system component helpers — return HTML strings

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => ESC[ch]);
}

export function button(
  label: string,
  opts?: {
    variant?: "primary" | "secondary" | "danger";
    href?: string;
    attrs?: string;
  },
): string {
  const variant = opts?.variant ?? "primary";

  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-900";

  const variants: Record<string, string> = {
    primary: "bg-amber-400 text-slate-900 hover:bg-amber-300 focus:ring-amber-400",
    secondary:
      "border border-slate-600 text-slate-300 hover:bg-slate-800 hover:text-slate-50 focus:ring-slate-500",
    danger: "bg-red-500 text-white hover:bg-red-400 focus:ring-red-400",
  };

  const classes = `${base} ${variants[variant]}`;
  const extra = opts?.attrs ? ` ${opts.attrs}` : "";

  if (opts?.href) {
    return `<a href="${opts.href}" class="${classes}"${extra}>${label}</a>`;
  }
  return `<button class="${classes}"${extra}>${label}</button>`;
}

export function badge(
  text: string,
  color?: "amber" | "emerald" | "red" | "blue" | "slate",
): string {
  const c = color ?? "slate";

  const colors: Record<string, string> = {
    amber: "bg-amber-400/10 text-amber-400 ring-amber-400/20",
    emerald: "bg-emerald-400/10 text-emerald-400 ring-emerald-400/20",
    red: "bg-red-400/10 text-red-400 ring-red-400/20",
    blue: "bg-blue-400/10 text-blue-400 ring-blue-400/20",
    slate: "bg-slate-400/10 text-slate-400 ring-slate-400/20",
  };

  return `<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${colors[c]}">${escapeHtml(text)}</span>`;
}

export function card(
  content: string,
  opts?: { title?: string; padding?: "compact" | "spacious" },
): string {
  const pad = opts?.padding === "compact" ? "p-4" : "p-6";
  const titleHtml = opts?.title
    ? `<h3 class="text-lg font-semibold text-slate-50 mb-4">${opts.title}</h3>`
    : "";

  return `<div class="rounded-xl border border-slate-700 bg-slate-800 ${pad}">${titleHtml}${content}</div>`;
}

export function statusBadge(status: string): string {
  const map: Record<string, "amber" | "emerald" | "red" | "blue" | "slate"> = {
    pending: "slate",
    queued: "blue",
    enriching: "blue",
    ready: "amber",
    approved: "emerald",
    executing: "amber",
    reviewing: "amber",
    done: "emerald",
    merged: "emerald",
    failed: "red",
    rejected: "red",
    cancelled: "slate",
    rework: "red",
    suspended: "blue",
  };

  return badge(status, map[status] ?? "slate");
}

export function input(
  name: string,
  label: string,
  opts?: {
    type?: string;
    value?: string;
    required?: boolean;
    placeholder?: string;
  },
): string {
  const type = opts?.type ?? "text";
  const value = opts?.value ? ` value="${opts.value}"` : "";
  const required = opts?.required ? " required" : "";
  const placeholder = opts?.placeholder
    ? ` placeholder="${opts.placeholder}"`
    : "";

  return `<div class="space-y-1.5">
  <label for="${name}" class="block text-sm font-medium text-slate-300">${label}</label>
  <input type="${type}" id="${name}" name="${name}"${value}${required}${placeholder}
    class="block w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-50 placeholder-slate-500 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400" />
</div>`;
}

// ── Stat Card ───────────────────────────────────────────────────────────────

export function statCard(
  label: string,
  value: string | number,
  opts?: { icon?: string; color?: string },
): string {
  const color = opts?.color ?? "slate";
  const iconHtml = opts?.icon
    ? `<div class="flex h-10 w-10 items-center justify-center rounded-lg bg-${color}-400/10 text-${color}-400">${opts.icon}</div>`
    : "";

  return `<div class="rounded-xl border border-slate-700 bg-slate-800 p-5">
  <div class="flex items-center gap-4">
    ${iconHtml}
    <div>
      <p class="text-sm font-medium text-slate-400">${escapeHtml(label)}</p>
      <p class="mt-1 text-2xl font-semibold text-slate-50">${escapeHtml(String(value))}</p>
    </div>
  </div>
</div>`;
}

// ── Table ───────────────────────────────────────────────────────────────────

export function table(headers: string[], rows: string[][]): string {
  const ths = headers
    .map(
      (h) =>
        `<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">${escapeHtml(h)}</th>`,
    )
    .join("");

  const trs = rows
    .map((row) => {
      const tds = row
        .map(
          (cell) =>
            `<td class="whitespace-nowrap px-4 py-3 text-sm text-slate-300">${cell}</td>`,
        )
        .join("");
      return `<tr class="hover:bg-slate-800/50">${tds}</tr>`;
    })
    .join("");

  return `<div class="overflow-x-auto">
  <table class="min-w-full divide-y divide-slate-700">
    <thead class="bg-slate-800/50">
      <tr>${ths}</tr>
    </thead>
    <tbody class="divide-y divide-slate-700">${trs}</tbody>
  </table>
</div>`;
}

// ── Modal ───────────────────────────────────────────────────────────────────

export function modal(id: string, title: string, bodyHtml: string): string {
  return `<div id="${id}" class="fixed inset-0 z-50 hidden">
  <!-- Backdrop -->
  <div class="fixed inset-0 bg-black/60 backdrop-blur-sm" onclick="document.getElementById('${id}').classList.add('hidden')"></div>
  <!-- Panel -->
  <div class="fixed inset-0 flex items-center justify-center p-4">
    <div class="relative w-full max-w-lg rounded-xl border border-slate-700 bg-slate-800 shadow-xl">
      <div class="flex items-center justify-between border-b border-slate-700 px-6 py-4">
        <h3 class="text-lg font-semibold text-slate-50">${escapeHtml(title)}</h3>
        <button onclick="document.getElementById('${id}').classList.add('hidden')"
                class="rounded-lg p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-50">
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="px-6 py-4">${bodyHtml}</div>
    </div>
  </div>
</div>`;
}

// ── Pipeline Steps ──────────────────────────────────────────────────────────

export function pipelineSteps(currentStatus: string): string {
  const steps = [
    { key: "pending", label: "Route" },
    { key: "enriching", label: "Enrich" },
    { key: "ready", label: "Gate" },
    { key: "executing", label: "Execute" },
    { key: "reviewing", label: "Review" },
    { key: "done", label: "Done" },
  ];

  // Map some statuses to their closest pipeline step
  const statusMap: Record<string, number> = {
    pending: 0,
    queued: 0,
    enriching: 1,
    ready: 2,
    approved: 2,
    executing: 3,
    reviewing: 4,
    done: 5,
    merged: 5,
    failed: -1,
    rejected: -1,
    cancelled: -1,
    rework: 3,
    suspended: -1,
  };

  const activeIdx = statusMap[currentStatus] ?? -1;

  const stepHtml = steps
    .map((step, i) => {
      let dotClasses: string;
      let labelClasses: string;

      if (i === activeIdx) {
        // Current step
        dotClasses = "h-3 w-3 rounded-full bg-amber-400 ring-4 ring-amber-400/20";
        labelClasses = "text-xs font-medium text-amber-400";
      } else if (i < activeIdx) {
        // Completed step
        dotClasses = "h-3 w-3 rounded-full bg-emerald-400";
        labelClasses = "text-xs font-medium text-emerald-400";
      } else {
        // Future step
        dotClasses = "h-3 w-3 rounded-full bg-slate-600";
        labelClasses = "text-xs font-medium text-slate-500";
      }

      const connectorBefore =
        i > 0
          ? `<div class="h-0.5 w-full ${i <= activeIdx ? "bg-emerald-400" : "bg-slate-600"}"></div>`
          : "";

      return `<div class="flex flex-1 flex-col items-center gap-1.5">
      <div class="flex w-full items-center">
        ${connectorBefore}
        <div class="${dotClasses}"></div>
        ${i < steps.length - 1 ? `<div class="h-0.5 w-full ${i < activeIdx ? "bg-emerald-400" : "bg-slate-600"}"></div>` : ""}
      </div>
      <span class="${labelClasses}">${step.label}</span>
    </div>`;
    })
    .join("");

  return `<div class="flex items-start">${stepHtml}</div>`;
}

// ── Pipeline Dialog ────────────────────────────────────────────────────────

export function pipelineDialog(currentStatus: string): string {
  const dialogId = "pipeline-dialog";

  const happyPath = [
    "pending",
    "queued",
    "enriching",
    "ready",
    "approved",
    "executing",
    "reviewing",
    "done",
    "merged",
  ];
  const currentIdx = happyPath.indexOf(currentStatus);

  const nodes = [
    // Row 1 — happy path (y=55)
    { key: "pending", label: "Pending", x: 50, y: 55 },
    { key: "queued", label: "Queued", x: 150, y: 55 },
    { key: "enriching", label: "Enriching", x: 250, y: 55 },
    { key: "ready", label: "Ready", x: 350, y: 55 },
    { key: "approved", label: "Approved", x: 450, y: 55 },
    { key: "executing", label: "Executing", x: 550, y: 55 },
    { key: "reviewing", label: "Reviewing", x: 650, y: 55 },
    { key: "done", label: "Done", x: 750, y: 55 },
    { key: "merged", label: "Merged", x: 850, y: 55 },
    // Row 2 — error/recovery (y=175)
    { key: "failed", label: "Failed", x: 200, y: 175 },
    { key: "suspended", label: "Suspended", x: 450, y: 175 },
    { key: "rework", label: "Rework", x: 700, y: 175 },
    // Row 3 — terminal (y=275)
    { key: "rejected", label: "Rejected", x: 150, y: 275 },
    { key: "cancelled", label: "Cancelled", x: 450, y: 275 },
  ];

  function getCategory(
    key: string,
  ): "current" | "completed" | "future" | "error" {
    if (key === currentStatus) return "current";
    const idx = happyPath.indexOf(key);
    if (idx === -1) return "error";
    if (currentIdx === -1) return "future";
    return idx < currentIdx ? "completed" : "future";
  }

  const defs = `<defs>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="4" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <marker id="arrow" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
        <polygon points="0 0, 10 3.5, 0 7" fill="#475569"/>
      </marker>
      <marker id="arrow-g" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
        <polygon points="0 0, 10 3.5, 0 7" fill="#34d399"/>
      </marker>
      <style>
        @keyframes pg{0%,100%{opacity:1}50%{opacity:.6}}
        .pulse-node{animation:pg 2s ease-in-out infinite}
      </style>
    </defs>`;

  // Happy path edges (solid horizontal arrows)
  const happyEdges = happyPath
    .slice(0, -1)
    .map((from, i) => {
      const f = nodes.find((n) => n.key === from)!;
      const t = nodes.find((n) => n.key === happyPath[i + 1])!;
      const done = currentIdx > -1 && i < currentIdx;
      return `<line x1="${f.x + 18}" y1="${f.y}" x2="${t.x - 18}" y2="${t.y}" stroke="${done ? "#34d399" : "#475569"}" stroke-width="1.5" marker-end="url(#arrow${done ? "-g" : ""})"/>`;
    })
    .join("\n    ");

  // Error/recovery edges (dashed diagonals)
  const errEdges = [
    { from: "executing", to: "failed" },
    { from: "reviewing", to: "rework" },
    { from: "failed", to: "pending" },
    { from: "rework", to: "executing" },
    { from: "suspended", to: "pending" },
  ]
    .map(({ from, to }) => {
      const f = nodes.find((n) => n.key === from)!;
      const t = nodes.find((n) => n.key === to)!;
      const up = f.y > t.y;
      const y1 = up ? f.y - 16 : f.y + 16;
      const y2 = up ? t.y + 16 : t.y - 16;
      return `<line x1="${f.x}" y1="${y1}" x2="${t.x}" y2="${y2}" stroke="#475569" stroke-width="1" stroke-dasharray="4 3" marker-end="url(#arrow)"/>`;
    })
    .join("\n    ");

  // Nodes
  const nodesSvg = nodes
    .map((n) => {
      const cat = getCategory(n.key);
      let circle: string,
        textFill: string,
        cls = "";
      switch (cat) {
        case "current":
          circle = `fill="#fbbf24" stroke="#fbbf24" stroke-width="2" filter="url(#glow)"`;
          textFill = "#fbbf24";
          cls = ' class="pulse-node"';
          break;
        case "completed":
          circle = `fill="#34d399" fill-opacity="0.2" stroke="#34d399" stroke-width="1.5"`;
          textFill = "#34d399";
          break;
        case "future":
          circle = `fill="#334155" stroke="#475569" stroke-width="1.5"`;
          textFill = "#94a3b8";
          break;
        default:
          circle = `fill="#1e293b" stroke="#475569" stroke-width="1"`;
          textFill = "#64748b";
          break;
      }

      let icon = "";
      if (cat === "completed") {
        icon = `<path d="M${n.x - 5} ${n.y} l3 4 l7 -8" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
      } else if (cat === "current") {
        icon = `<circle cx="${n.x}" cy="${n.y}" r="4" fill="#92400e"/>`;
      }

      return `<g>
      <circle cx="${n.x}" cy="${n.y}" r="16" ${circle}${cls}/>
      ${icon}
      <text x="${n.x}" y="${n.y + 30}" text-anchor="middle" fill="${textFill}" font-size="11" font-family="system-ui,sans-serif">${n.label}</text>
    </g>`;
    })
    .join("\n    ");

  const legend = `<div class="flex items-center gap-4 text-xs text-slate-400">
      <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400/20 ring-1 ring-emerald-400"></span> Completed</span>
      <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-full bg-amber-400"></span> Current</span>
      <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-full bg-slate-700 ring-1 ring-slate-600"></span> Pending</span>
    </div>`;

  const svg = `<svg viewBox="0 0 900 310" class="w-full" xmlns="http://www.w3.org/2000/svg">
    ${defs}
    ${happyEdges}
    ${errEdges}
    ${nodesSvg}
  </svg>`;

  return `<div id="${dialogId}" class="fixed inset-0 z-50 hidden">
  <div class="fixed inset-0 bg-black/60 backdrop-blur-sm" onclick="document.getElementById('${dialogId}').classList.add('hidden')"></div>
  <div class="fixed inset-0 flex items-center justify-center p-4">
    <div class="relative w-full max-w-4xl rounded-xl border border-slate-700 bg-slate-800 shadow-xl">
      <div class="flex items-center justify-between border-b border-slate-700 px-6 py-4">
        <h3 class="text-lg font-semibold text-slate-50">Pipeline Workflow</h3>
        <button onclick="document.getElementById('${dialogId}').classList.add('hidden')"
                class="rounded-lg p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-50">
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="px-6 py-4">${legend}<div class="mt-3">${svg}</div></div>
    </div>
  </div>
</div>`;
}

// ── Select ──────────────────────────────────────────────────────────────────

export function select(
  name: string,
  label: string,
  options: { value: string; label: string }[],
  selected?: string,
  attrs?: string,
): string {
  const optionHtml = options
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}"${o.value === selected ? " selected" : ""}>${escapeHtml(o.label)}</option>`,
    )
    .join("");

  const extra = attrs ? ` ${attrs}` : "";

  return `<div class="space-y-1.5">
  <label for="${name}" class="block text-sm font-medium text-slate-300">${label}</label>
  <select id="${name}" name="${name}"${extra}
    class="block w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-50 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400">
    ${optionHtml}
  </select>
</div>`;
}

// ── Textarea ────────────────────────────────────────────────────────────────

export function textarea(
  name: string,
  label: string,
  opts?: { required?: boolean; placeholder?: string; rows?: number },
): string {
  const rows = opts?.rows ?? 4;
  const required = opts?.required ? " required" : "";
  const placeholder = opts?.placeholder
    ? ` placeholder="${escapeHtml(opts.placeholder)}"`
    : "";

  return `<div class="space-y-1.5">
  <label for="${name}" class="block text-sm font-medium text-slate-300">${escapeHtml(label)}</label>
  <textarea id="${name}" name="${name}" rows="${rows}"${required}${placeholder}
    class="block w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-50 placeholder-slate-500 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"></textarea>
</div>`;
}

// ── Empty State ─────────────────────────────────────────────────────────────

// ── Checkbox ─────────────────────────────────────────────────────────────

export function checkbox(
  name: string,
  label: string,
  checked: boolean,
): string {
  const checkedAttr = checked ? " checked" : "";

  return `<label class="flex items-center gap-3 cursor-pointer">
  <input type="checkbox" name="${escapeHtml(name)}" value="true"${checkedAttr}
    class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-amber-400 focus:ring-amber-400 focus:ring-offset-0" />
  <span class="text-sm text-slate-300">${escapeHtml(label)}</span>
</label>`;
}

// ── Empty State ─────────────────────────────────────────────────────────────

export function emptyState(message: string, actionHtml?: string): string {
  const action = actionHtml
    ? `<div class="mt-4">${actionHtml}</div>`
    : "";

  return `<div class="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 py-12 px-6">
  <svg class="h-12 w-12 text-slate-600" fill="none" viewBox="0 0 24 24" stroke-width="1" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125 2.25 2.25m0 0 2.25-2.25M12 13.875V7.5M3.75 7.5h16.5" />
  </svg>
  <p class="mt-3 text-sm text-slate-400">${escapeHtml(message)}</p>
  ${action}
</div>`;
}

/** Banner shown to non-admin users who have no repository access. */
export function noAccessBanner(): string {
  return `<div class="flex items-start gap-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-3">
  <svg class="mt-0.5 h-5 w-5 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
  </svg>
  <div>
    <p class="text-sm font-medium text-amber-400">No repository access</p>
    <p class="mt-0.5 text-sm text-slate-400">You don't have access to any repositories yet. Ask a team admin to grant you permissions.</p>
  </div>
</div>`;
}
