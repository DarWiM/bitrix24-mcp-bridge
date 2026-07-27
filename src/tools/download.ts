// Helpers for pulling files (chat attachments, task files, call recordings) off the portal.
// Download URLs are minted by the portal itself and carry their own signature, so the tool
// takes a whole URL — but only after checking it points at a configured portal, which is the
// security boundary here (the catalog allowlist can't cover per-file signed links).

import { basename, isAbsolute, join } from "node:path";
import { existsSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

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
 * A download whose destination the caller didn't pick lands here first. The real name only
 * arrives with the response (Content-Disposition), so guessing one up front would both misname
 * the file and make "does it already exist?" ask about a name nothing is ever stored under.
 */
export function tempDownloadPath(downloadsDir: string): string {
  return join(downloadsDir, `.download-${randomUUID()}.part`);
}

/**
 * Moves a finished temp download to its real name, now that the portal has named it.
 * Refuses to clobber an existing file (and drops the temp) unless overwrite was requested.
 */
export function finalizeDownload(args: {
  tempPath: string;
  serverName: string | null;
  fallbackName: string;
  downloadsDir: string;
  overwrite?: boolean;
}): string {
  const wanted = join(args.downloadsDir, safeFileName(args.serverName ?? args.fallbackName, args.fallbackName));
  if (!args.overwrite && existsSync(wanted)) {
    rmSync(args.tempPath, { force: true });
    throw new Error(`${wanted} already exists — pass overwrite: true to download it again`);
  }
  renameSync(args.tempPath, wanted);
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
