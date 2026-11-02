import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// Left by the removed action catalog; listed explicitly so cleanup can never touch user data.
export const OBSOLETE_FILES = ["actions.json", "catalog-state.json"] as const;

export function removeObsoleteFiles(home: string): string[] {
  const removed: string[] = [];
  for (const name of OBSOLETE_FILES) {
    const path = join(home, name);
    if (!existsSync(path)) continue;
    try {
      // force: a concurrent client may delete it between the check and here.
      rmSync(path, { force: true });
      removed.push(path);
    } catch {
      // not removable — startup must not fail over cleanup
    }
  }
  return removed;
}
