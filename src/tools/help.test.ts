import { describe, it, expect } from "bun:test";
import { OPERATIONS } from "../ops/index.js";
import { HELP } from "./help.js";

// The bulleted list right under this heading is the one place the docs name every mutating tool.
const MUTATING_LIST_HEADING = "**Мутирующие операции** (⚠)";

// The list ends at the first line that is neither a list item, its indented continuation nor blank.
function documentedMutatingTools(notes: string): string[] {
  const at = notes.indexOf(MUTATING_LIST_HEADING);
  if (at === -1) return [];
  const list: string[] = [];
  for (const line of notes.slice(at).split("\n").slice(1)) {
    if (line.startsWith("- ") || line.startsWith("  ")) list.push(line);
    else if (line.trim() !== "") break;
  }
  return [...list.join("\n").matchAll(/`(bitrix_\w+)`/g)].map((m) => m[1]);
}

describe("HELP (api-notes)", () => {
  it("loads non-empty api notes at dev time (reads docs/api-notes.md)", () => {
    expect(HELP.length).toBeGreaterThan(0);
    // must be the real notes, not the not-found fallback sentence
    expect(HELP).not.toMatch(/not found at runtime/);
  });

  it("lists exactly the mutating operations", () => {
    const documented = documentedMutatingTools(HELP);
    const mutating = OPERATIONS.filter((op) => op.mutating).map((op) => `bitrix_${op.name}`);
    expect(documented.length).toBe(new Set(documented).size);
    expect(new Set(documented)).toEqual(new Set(mutating));
  });
});
