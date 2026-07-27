// Helpers for pulling files (chat attachments, task files, call recordings) off the portal.
// Download URLs are minted by the portal itself and carry their own signature, so the tool
// takes a whole URL — but only after checking it points at a configured portal, which is the
// security boundary here (the catalog allowlist can't cover per-file signed links).

import { basename, isAbsolute, join } from "node:path";
import { existsSync, renameSync } from "node:fs";

export interface ResolvedTarget {
  /** Portal alias the URL belongs to. */
  portal: string;
  /** Path + query, ready to be used as a catalog-style endpoint. */
  endpoint: string;
}

export function resolvePortalUrl(rawUrl: string, origins: Record<string, string>): ResolvedTarget {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`"${rawUrl}" is not an absolute URL — pass the full urlDownload from the portal response`);
  }
  const match = Object.entries(origins).find(([, origin]) => origin === url.origin);
  if (!match) {
    const known = Object.values(origins).join(", ") || "none configured";
    throw new Error(`refusing to download from ${url.origin} — not a configured portal (known: ${known})`);
  }
  return { portal: match[0], endpoint: `${url.pathname}${url.search}` };
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Strips anything that could escape the target directory or confuse the filesystem. */
export function safeFileName(name: string, fallback: string): string {
  const cleaned = basename(name.trim())
    .replace(/[/\\]/g, "-")
    .replace(/^\.+/, "") // no ".." and no accidentally hidden files
    .replace(CONTROL_CHARS, "")
    .slice(0, 180)
    .trim();
  return cleaned || fallback;
}

/** Portal links usually name the file in a query param; fall back to the last path segment. */
export function fileNameFromUrl(rawUrl: string, fallback: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fallback;
  }
  const named = url.searchParams.get("fileName") ?? url.searchParams.get("filename");
  if (named) return safeFileName(named, fallback);
  // An ajax endpoint names a controller, not a file — "ajax.php" is never the name we want.
  if (url.searchParams.has("action")) return fallback;
  const last = url.pathname.split("/").filter(Boolean).pop();
  return last && last.includes(".") ? safeFileName(last, fallback) : fallback;
}

export interface DestinationRequest {
  savePath?: string;
  downloadsDir: string;
  suggestedName: string;
  overwrite?: boolean;
}

/**
 * The destination has to be picked before the request goes out, but the portal only reveals the
 * real name in Content-Disposition once it answers — so a default-named file gets renamed here.
 * An explicit savePath is always left alone: the caller asked for that exact path.
 */
export function renameToServerName(
  currentPath: string,
  serverName: string | null,
  opts: { downloadsDir: string; explicitSavePath: boolean; overwrite?: boolean },
): string {
  if (!serverName || opts.explicitSavePath) return currentPath;
  const wanted = join(opts.downloadsDir, safeFileName(serverName, basename(currentPath)));
  if (wanted === currentPath) return currentPath;
  if (!opts.overwrite && existsSync(wanted)) return currentPath; // don't clobber on a rename
  renameSync(currentPath, wanted);
  return wanted;
}

export function resolveDestination(req: DestinationRequest): string {
  const path = req.savePath
    ? (isAbsolute(req.savePath) ? req.savePath : join(req.downloadsDir, safeFileName(req.savePath, req.suggestedName)))
    : join(req.downloadsDir, safeFileName(req.suggestedName, "download"));
  if (!req.overwrite && existsSync(path)) {
    throw new Error(`${path} already exists — pass overwrite: true to replace it`);
  }
  return path;
}
