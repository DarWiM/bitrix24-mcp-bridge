import { readFileSync } from "node:fs";
import { z } from "zod";

const entrySchema = z.object({
  endpoint: z.string().min(1).default("/bitrix/services/main/ajax.php"),
  action: z.string().nullable().default(null),
  method: z.enum(["GET", "POST"]).default("POST"),
  params: z.record(z.unknown()).default({}),
});
const fileSchema = z.record(entrySchema);

// Conservative, exact-token denylist of clearly-mutating REST/ajax verbs.
// Read verbs (get/list/read/...) are deliberately not listed here.
const MUTATING_VERBS = new Set([
  "add", "update", "delete", "set", "complete", "remove", "create", "save",
  "send", "rename", "move", "import", "attach", "bind", "unbind",
]);

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function assertReadOnly(name: string, entry: { action: string | null; endpoint: string }): void {
  for (const field of [entry.action, entry.endpoint]) {
    if (!field) continue;
    for (const token of tokenize(field)) {
      if (MUTATING_VERBS.has(token)) {
        throw new Error(
          `catalog entry "${name}" looks mutating ("${token}") — this bridge is read-only`,
        );
      }
    }
  }
}

export interface CatalogEntry {
  endpoint: string;
  action: string | null;
  method: "GET" | "POST";
  params: Record<string, unknown>;
}

export interface Catalog {
  resolve(name: string): CatalogEntry;
  names(): string[];
}

export function loadCatalog(path: string): Catalog {
  const raw = fileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  for (const [name, entry] of Object.entries(raw)) {
    assertReadOnly(name, entry);
  }
  return {
    resolve(name) {
      if (!Object.prototype.hasOwnProperty.call(raw, name)) {
        throw new Error(`call "${name}" is not allowed (not in catalog)`);
      }
      return raw[name];
    },
    names() { return Object.keys(raw); },
  };
}
