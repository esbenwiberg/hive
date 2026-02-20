import fs from "node:fs";
import path from "node:path";
import type { SessionUser } from "../../domain/types.js";
import { escapeHtml, card } from "./components.js";
import { layout } from "./layout.js";

interface ChangelogSection {
  date: string;
  items: string[];
}

function parseChangelog(raw: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;

  for (const line of raw.split("\n")) {
    const dateMatch = line.match(/^## (.+)/);
    if (dateMatch) {
      current = { date: dateMatch[1].trim(), items: [] };
      sections.push(current);
      continue;
    }
    const itemMatch = line.match(/^- (.+)/);
    if (itemMatch && current) {
      current.items.push(itemMatch[1].trim());
    }
  }

  return sections;
}

export function changelogPage(user: SessionUser): string {
  const filePath = path.resolve("CHANGELOG.md");
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    raw = "";
  }

  const sections = parseChangelog(raw);

  const content = sections.length === 0
    ? `<p class="text-sm text-slate-400">No changelog entries yet.</p>`
    : sections.map((s) => {
        const items = s.items
          .map((i) => `<li class="text-sm text-slate-300">${escapeHtml(i)}</li>`)
          .join("\n");
        return card(
          `<ul class="list-disc list-inside space-y-1">${items}</ul>`,
          { title: escapeHtml(s.date) },
        );
      }).join("\n");

  return layout("Changelog", `<div class="space-y-6">${content}</div>`, user);
}
