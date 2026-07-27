// Keeps an installed catalog in step with the one shipped in the package.
//
// The runtime catalog is seeded once and then belongs to the user — it is also the allowlist,
// so entries they removed on purpose must stay removed. That rules out "copy the example over
// it" and even "add anything the example has that you don't": the second would resurrect a
// deleted entry on every start.
//
// So we remember which shipped keys this installation has already been offered (a small state
// file next to the catalog) and only add ones it has never seen. A key removed after delivery
// stays gone; a key added in a new package version arrives on the next start.

import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const stateSchema = z.object({ deliveredEntries: z.array(z.string()).default([]) });

export interface CatalogSyncPlan {
  /** Entries to append to the user's catalog. */
  toAdd: string[];
  /** Full set of shipped keys this installation has now been offered. */
  delivered: string[];
}

export function planCatalogSync(
  current: Record<string, unknown>,
  shipped: Record<string, unknown>,
  delivered: string[],
): CatalogSyncPlan {
  const seen = new Set(delivered);
  const toAdd = Object.keys(shipped).filter((key) => !seen.has(key) && !(key in current));
  // Everything the package ships counts as delivered — including what the user already had,
  // so a later removal is respected rather than undone on the next start.
  return { toAdd, delivered: [...new Set([...delivered, ...Object.keys(shipped)])] };
}

/** Mirrors the hand-written layout of actions.example.json: one entry per line. */
export function serializeCatalog(catalog: Record<string, unknown>): string {
  const lines = Object.entries(catalog).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{\n${lines.join(",\n")}\n}\n`;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readState(path: string): string[] {
  const raw = readJson(path);
  if (!raw) return [];
  const parsed = stateSchema.safeParse(raw);
  return parsed.success ? parsed.data.deliveredEntries : [];
}

export interface SyncArgs {
  catalogPath: string;
  examplePath: string;
  statePath: string;
}

/**
 * Adds catalog entries introduced by newer package versions. Returns the keys added, so the
 * caller can say so out loud — silently widening an allowlist would be the wrong kind of quiet.
 */
export function syncCatalogWithPackage(args: SyncArgs): string[] {
  const current = readJson(args.catalogPath);
  const shipped = readJson(args.examplePath);
  // No catalog yet (fresh install, seeded by setup) or no example (dev checkout): nothing to do.
  if (!current || !shipped) return [];

  const { toAdd, delivered } = planCatalogSync(current, shipped, readState(args.statePath));
  if (toAdd.length > 0) {
    const merged = { ...current };
    for (const key of toAdd) merged[key] = shipped[key];
    writeFileSync(args.catalogPath, serializeCatalog(merged), "utf8");
  }
  writeFileSync(args.statePath, JSON.stringify({ deliveredEntries: delivered }, null, 2) + "\n", "utf8");
  return toAdd;
}
