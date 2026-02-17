import type { SessionUser } from "../../domain/types.js";
import {
  card,
  badge,
  button,
  input,
  select,
  table,
  emptyState,
  escapeHtml,
} from "./components.js";
import { layout } from "./layout.js";

// ── Credential row type ──────────────────────────────────────────────────────

interface Credential {
  id: number;
  provider: string;
  label: string | null;
  createdAt: Date | null;
}

// ── Credentials list partial (reused by HTMX responses) ─────────────────────

export function credentialsListPartial(credentials: Credential[]): string {
  if (credentials.length === 0) {
    return emptyState("No credentials configured yet");
  }

  const rows = credentials.map((c) => [
    badge(
      escapeHtml(c.provider),
      c.provider === "github" ? "emerald" : "blue",
    ),
    escapeHtml(c.label ?? ""),
    c.createdAt
      ? escapeHtml(new Date(c.createdAt).toLocaleDateString())
      : "-",
    button("Delete", {
      variant: "danger",
      attrs: `hx-delete="/api/profile/tokens/${c.id}" hx-target="#credentials-list" hx-confirm="Delete this credential?"`,
    }),
  ]);

  return table(["Provider", "Label", "Created", ""], rows);
}

// ── Full profile page ────────────────────────────────────────────────────────

export function profilePage(
  user: SessionUser,
  credentials: Credential[],
): string {
  const roleBadgeColor =
    user.role === "admin" ? "amber" : user.role === "viewer" ? "slate" : "blue";

  const userInfoCard = card(
    `<div class="flex items-center gap-4">
      <div class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-amber-400/10 text-lg font-semibold text-amber-400">
        ${escapeHtml(
          user.displayName
            .split(" ")
            .map((w) => w[0])
            .join("")
            .toUpperCase()
            .slice(0, 2),
        )}
      </div>
      <div>
        <h2 class="text-lg font-semibold text-slate-50">${escapeHtml(user.displayName)}</h2>
        <p class="text-sm text-slate-400">${escapeHtml(user.email)}</p>
        <div class="mt-1">${badge(user.role, roleBadgeColor)}</div>
      </div>
    </div>`,
    { title: "User Info" },
  );

  const addTokenForm = `
    <form hx-post="/api/profile/tokens" hx-target="#credentials-list" class="space-y-4">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        ${select("provider", "Provider", [
          { value: "github", label: "GitHub" },
          { value: "azure_devops", label: "Azure DevOps" },
        ])}
        ${input("label", "Label", { required: true, placeholder: "e.g. personal" })}
        ${input("token", "Token", { type: "password", required: true, placeholder: "ghp_..." })}
      </div>
      <div>${button("Add Token", { variant: "primary", attrs: 'type="submit"' })}</div>
    </form>`;

  const credentialsCard = card(
    `<div id="credentials-list" class="mb-6">
      ${credentialsListPartial(credentials)}
    </div>
    <h4 class="text-sm font-semibold text-slate-300 mb-3">Add Token</h4>
    ${addTokenForm}`,
    { title: "Credentials" },
  );

  const content = `
    <div class="space-y-6">
      ${userInfoCard}
      ${credentialsCard}
    </div>`;

  return layout("Profile", content, user);
}
