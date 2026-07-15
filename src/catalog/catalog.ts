import { readFileSync } from "node:fs";
import { z } from "zod";

const entrySchema = z.object({
  endpoint: z.string().min(1).default("/bitrix/services/main/ajax.php"),
  action: z.string().nullable().default(null),
  method: z.enum(["GET", "POST"]).default("POST"),
  params: z.record(z.unknown()).default({}),
});
const fileSchema = z.record(entrySchema);

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
