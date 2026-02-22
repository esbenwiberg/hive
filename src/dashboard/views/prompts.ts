import { escapeHtml, card } from "./components.js";
import { layout } from "./layout.js";
import type { SessionUser } from "../../domain/types.js";
import type { PromptEntry } from "../../prompts.js";

// ── File tree rendering ──────────────────────────────────────────────────────

function fileTreeItem(entry: PromptEntry): string {
  if (entry.isDir) {
    const depth = entry.path.split("/").length - 1;
    const indent = depth * 1; // rem units via pl-{n}
    return `<div class="pl-${indent * 4} py-1 text-xs font-semibold uppercase tracking-wider text-slate-500 mt-2">
  <span class="flex items-center gap-1">
    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" /></svg>
    ${escapeHtml(entry.name)}
  </span>
</div>`;
  }

  const depth = entry.path.split("/").length - 1;
  const indent = depth * 4;
  return `<button
  class="w-full text-left pl-${indent} pr-2 py-1.5 text-sm text-slate-300 hover:bg-slate-700 hover:text-slate-50 rounded transition-colors truncate"
  hx-get="/api/prompts/${escapeHtml(entry.path)}"
  hx-target="#prompt-editor"
  hx-swap="innerHTML"
  title="${escapeHtml(entry.path)}">
  <span class="flex items-center gap-1.5">
    <svg class="w-4 h-4 shrink-0 text-slate-500" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
    ${escapeHtml(entry.name)}
  </span>
</button>`;
}

// ── Exported views ───────────────────────────────────────────────────────────

/**
 * Full prompts page with two-panel layout:
 * left sidebar with file list, right panel with editor.
 */
export function promptsPage(files: PromptEntry[], user: SessionUser): string {
  const fileList = files.length > 0
    ? files.map(fileTreeItem).join("\n")
    : `<p class="p-4 text-sm text-slate-500">No prompt files found</p>`;

  const content = `
<div class="flex gap-6 min-h-[calc(100vh-12rem)]">
  <!-- Left sidebar: file list -->
  <div class="w-64 shrink-0">
    ${card(`<div class="space-y-0.5">${fileList}</div>`, { title: "Prompt Files", padding: "compact" })}
  </div>

  <!-- Right panel: editor -->
  <div class="flex-1" id="prompt-editor">
    <div class="flex items-center justify-center h-full rounded-xl border border-dashed border-slate-700 py-20">
      <p class="text-sm text-slate-500">Select a prompt file to view or edit</p>
    </div>
  </div>
</div>`;

  return layout("Prompts", content, user);
}

/**
 * HTMX partial: editor panel for a single prompt file.
 */
export function promptEditorPartial(relativePath: string, content: string): string {
  const safePath = escapeHtml(relativePath);
  const safeContent = escapeHtml(content);

  return `
<div class="rounded-xl border border-slate-700 bg-slate-800 p-6">
  <div class="flex items-center justify-between mb-4">
    <h3 class="text-lg font-semibold text-slate-50 flex items-center gap-2">
      <svg class="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
      ${safePath}
    </h3>
  </div>
  <form hx-post="/api/prompts/${safePath}" hx-target="#prompt-editor" hx-swap="innerHTML">
    <textarea
      name="content"
      rows="24"
      class="block w-full rounded-lg border border-slate-600 bg-slate-900 px-4 py-3 font-mono text-sm text-slate-50 placeholder-slate-500 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
    >${safeContent}</textarea>
    <div class="mt-4 flex justify-end gap-2">
      <button type="button"
        hx-post="/api/prompts/${safePath}/reset"
        hx-target="#prompt-editor"
        hx-swap="innerHTML"
        hx-confirm="Reset this prompt to the original committed version?"
        class="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-900 focus:ring-slate-500">
        Reset
      </button>
      <button type="submit"
        class="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium bg-amber-400 text-slate-900 hover:bg-amber-300 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-900 focus:ring-amber-400">
        Save
      </button>
    </div>
  </form>
</div>`;
}
