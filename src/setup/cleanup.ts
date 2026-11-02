import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// Left by the removed action catalog; listed explicitly so cleanup can never touch user data.
export const OBSOLETE_FILES = ["actions.json", "catalog-state.json"] as const;

export function removeObsoleteFiles(home: string, log: (line: string) => void = (line) => console.error(line)): string[] {
  const removed: string[] = [];
  for (const name of OBSOLETE_FILES) {
    const path = join(home, name);
    if (!existsSync(path)) continue;
    try {
      // force: a concurrent client may delete it between the check and here.
      rmSync(path, { force: true });
      removed.push(path);
    } catch (e) {
      // Startup must not fail over cleanup, but a file that keeps coming back should be explainable.
      log(`[cleanup] could not remove ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return removed;
}
