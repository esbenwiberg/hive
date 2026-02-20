import { escapeHtml } from "./components.js";
import { layout } from "./layout.js";
import type { SessionUser } from "../../domain/types.js";

interface UserInfo {
  id: number;
  displayName: string;
  role: string;
}

interface RepoInfo {
  id: number;
  fullName: string;
}

/**
 * Full permissions page with user x repo checkbox matrix.
 */
export function permissionsPage(
  users: UserInfo[],
  repos: RepoInfo[],
  grants: Set<string>,
  currentUser: SessionUser,
): string {
  const nonAdminUsers = users.filter((u) => u.role !== "admin");

  if (nonAdminUsers.length === 0 || repos.length === 0) {
    const msg = nonAdminUsers.length === 0
      ? "No non-admin users found. Admins have access to all repos by default."
      : "No repositories found. Add repos first.";

    return layout(
      "Permissions",
      `<div class="space-y-6">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-xl font-semibold text-slate-50">Repo Access Permissions</h2>
            <p class="mt-1 text-sm text-slate-400">Control which repos each user can see and create tasks for. Admins have full access.</p>
          </div>
        </div>
        <div class="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 py-12 px-6">
          <p class="text-sm text-slate-400">${escapeHtml(msg)}</p>
        </div>
      </div>`,
      currentUser,
    );
  }

  const matrixHtml = permissionsMatrix(nonAdminUsers, repos, grants);

  return layout(
    "Permissions",
    `<div class="space-y-6">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-xl font-semibold text-slate-50">Repo Access Permissions</h2>
          <p class="mt-1 text-sm text-slate-400">Control which repos each user can see and create tasks for. Admins have full access.</p>
        </div>
      </div>
      <div id="permissions-matrix">
        ${matrixHtml}
      </div>
    </div>`,
    currentUser,
  );
}

/**
 * The permissions matrix table (also used as HTMX partial).
 */
export function permissionsMatrix(
  users: UserInfo[],
  repos: RepoInfo[],
  grants: Set<string>,
): string {
  const repoHeaders = repos
    .map((r) => {
      const shortName = r.fullName.includes("/")
        ? r.fullName.split("/").pop()!
        : r.fullName;
      return `<th class="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400 whitespace-nowrap" title="${escapeHtml(r.fullName)}">${escapeHtml(shortName)}</th>`;
    })
    .join("");

  const rows = users
    .map((u) => {
      const cells = repos
        .map((r) => {
          const key = `${u.id}:${r.id}`;
          const checked = grants.has(key);
          const action = checked ? "revoke" : "grant";
          return `<td class="px-3 py-3 text-center">
            <button
              hx-post="/api/permissions/${action}"
              hx-vals='${JSON.stringify({ userId: u.id, repoId: r.id })}'
              hx-target="#permissions-matrix"
              hx-swap="innerHTML"
              class="inline-flex items-center justify-center w-6 h-6 rounded transition-colors ${
                checked
                  ? "bg-amber-400/20 text-amber-400 hover:bg-red-400/20 hover:text-red-400"
                  : "bg-slate-700/50 text-slate-500 hover:bg-emerald-400/20 hover:text-emerald-400"
              }">
              ${checked
                ? '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>'
                : '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>'
              }
            </button>
          </td>`;
        })
        .join("");

      return `<tr class="hover:bg-slate-800/50">
        <td class="px-4 py-3 text-sm font-medium text-slate-300 whitespace-nowrap">${escapeHtml(u.displayName)}</td>
        ${cells}
      </tr>`;
    })
    .join("");

  return `<div class="overflow-x-auto rounded-xl border border-slate-700 bg-slate-800">
    <table class="min-w-full divide-y divide-slate-700">
      <thead class="bg-slate-800/50">
        <tr>
          <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">User</th>
          ${repoHeaders}
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-700">${rows}</tbody>
    </table>
  </div>`;
}
