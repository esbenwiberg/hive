// Design-system component helpers — return HTML strings

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

  return `<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${colors[c]}">${text}</span>`;
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
    executing: "amber",
    reviewing: "amber",
    done: "emerald",
    merged: "emerald",
    failed: "red",
    rejected: "red",
    cancelled: "slate",
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
