// Parser for a task's legacy forum comments — the discussion tasks had before they moved to
// im.v2 chats. The first page is the server-rendered `/task/comments/<id>/` slider; older
// comments come from `bitrix:forum.comments` → `navigateComment` as an HTML fragment.
//
// Both render the same `main.post.list` markup: one `[bx-mpl-entity-id]` cover per comment.
// Reading never marks anything as read — the browser does that through a separate
// `readComment` action fired by JS when a comment scrolls into view, and the bridge runs no JS.

import { parse, type HTMLElement } from "node-html-parser";

export interface TaskCommentFile {
  attachedId: number;
  name: string | null;
  size: string | null;
  url: string;
}

export interface TaskComment {
  id: number;
  authorId: number | null;
  author: string | null;
  date: string | null;
  dateIso: string | null;
  text: string;
  isNew: boolean;
  // Task-info notices ("назначены исполнителем", deadline changes, pings), not a person's words.
  system: boolean;
  files: TaskCommentFile[];
}

export interface TaskCommentsPage {
  exemplarId: string;
  signedParameters: string;
  hasOlder: boolean;
  comments: TaskComment[];
}

const MONTHS: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

/** "9 марта 2024 08:15" → "2024-03-09T08:15" (portal-local time). Relative forms stay null. */
export function toIsoDate(raw: string): string | null {
  const m = /^(\d{1,2})\s+(\p{L}+)\s+(\d{4})(?:,)?\s+(\d{1,2}):(\d{2})$/u.exec(raw.trim());
  const month = m ? MONTHS[m[2].toLowerCase()] : undefined;
  if (!m || !month) return null;
  const pad = (n: number | string) => String(n).padStart(2, "0");
  return `${m[3]}-${pad(month)}-${pad(m[1])}T${pad(m[4])}:${m[5]}`;
}

function clean(el: HTMLElement | null | undefined): string {
  if (!el) return "";
  return el.text.replace(/[^\S\n]+/g, " ").replace(/ *\n+ */g, "\n").trim();
}

function num(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function absolute(path: string, origin?: string): string {
  return origin && path.startsWith("/") ? `${origin}${path}` : path;
}

function parseText(body: HTMLElement | null): string {
  if (!body) return "";
  // A labelled external link would otherwise lose its target ("макет" → which макет?).
  for (const a of body.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    const label = clean(a);
    if (/^https?:\/\//i.test(href) && label !== href) a.replaceWith(escapeHtml(`${label} (${href})`));
  }
  return clean(body);
}

function parseFiles(cover: HTMLElement, origin?: string): TaskCommentFile[] {
  const files = new Map<number, TaskCommentFile>();
  // Image attachments carry their metadata on the thumbnail.
  for (const el of cover.querySelectorAll("[data-attached-object-id]")) {
    const attachedId = num(el.getAttribute("data-attached-object-id"));
    const src = el.getAttribute("data-src");
    if (attachedId === null || !src || files.has(attachedId)) continue;
    files.set(attachedId, {
      attachedId,
      name: el.getAttribute("data-title") ?? null,
      size: el.getAttribute("data-bx-size") ?? null,
      url: absolute(src, origin),
    });
  }
  // Other files are plain download links.
  for (const a of cover.querySelectorAll('a[href*="attachedId="]')) {
    const href = a.getAttribute("href") ?? "";
    const attachedId = num(/attachedId=(\d+)/.exec(href)?.[1]);
    if (attachedId === null || files.has(attachedId) || !/action=download/.test(href)) continue;
    files.set(attachedId, {
      attachedId,
      name: a.getAttribute("data-title") ?? a.getAttribute("title") ?? (clean(a) || null),
      size: a.getAttribute("data-bx-size") ?? null,
      url: absolute(href, origin),
    });
  }
  return [...files.values()];
}

function parseComment(cover: HTMLElement, origin?: string): TaskComment | null {
  const id = num(cover.getAttribute("bx-mpl-entity-id"));
  if (id === null) return null;
  const block = cover.querySelector(".feed-com-block");
  const authorLink = cover.querySelector(".feed-com-user-box [bx-tooltip-user-id]");
  const authorId =
    num(authorLink?.getAttribute("bx-tooltip-user-id")) ??
    num(/blog-comment-user-(\d+)/.exec(block?.getAttribute("class") ?? "")?.[1]);
  const date = clean(cover.querySelector(".feed-com-time")) || null;
  return {
    id,
    authorId,
    author: clean(authorLink ?? cover.querySelector(".feed-com-name")) || null,
    date,
    dateIso: date ? toIsoDate(date) : null,
    text: parseText(cover.querySelector(".feed-com-text-inner-inner")),
    isNew: cover.getAttribute("bx-mpl-read-status") === "new",
    system: block?.classList.contains("mpl-comment-aux") ?? false,
    files: parseFiles(cover, origin),
  };
}

/** Comments in an HTML chunk (first page or a navigateComment fragment), oldest first. */
export function parseComments(html: string, origin?: string): TaskComment[] {
  const root = parse(html);
  const comments = root
    .querySelectorAll(".feed-com-block-cover[bx-mpl-entity-id]")
    .map((cover) => parseComment(cover, origin))
    .filter((c): c is TaskComment => c !== null);
  return comments.sort((a, b) => a.id - b.id);
}

/**
 * The first page also carries what paging needs: the list instance id and the server-signed
 * component parameters (base64 PHP array + HMAC), which cannot be built client-side.
 */
export function parseFirstPage(html: string, origin?: string): TaskCommentsPage {
  const exemplarId = /EXEMPLAR_ID\s*:\s*'([^']+)'/.exec(html)?.[1];
  const signedParameters = /"componentName":"bitrix:forum\.comments"[^}]*?"params":"([^"]+)"/.exec(html)?.[1];
  if (!exemplarId || !signedParameters) {
    throw new Error(
      "response is not a task comments page (no comment list) — the portal likely answered with a login " +
        "page or the task is not accessible to this user",
    );
  }
  return {
    exemplarId,
    signedParameters,
    // The "Предыдущие комментарии (N)" link is rendered only when older comments exist.
    hasOlder: parse(html).querySelector('[id$="_page_nav"]') !== null,
    comments: parseComments(html, origin),
  };
}

/** One line per comment so a grep hit carries its own id, date and author. */
export function formatComments(taskId: number | string, comments: TaskComment[], reachedHistoryStart: boolean): string {
  const header = [
    `# Задача ${taskId} — старые комментарии (форум): ${comments.length}`,
    `# Дочитано до начала: ${reachedHistoryStart ? "да" : "нет"}`,
    "",
  ];
  const lines = comments.flatMap((c) => {
    const who = `${c.author ?? "?"}${c.authorId !== null ? ` (id ${c.authorId})` : ""}`;
    const tag = c.system ? " [системный]" : "";
    const head = `#${c.id} [${c.dateIso ?? c.date ?? "?"}] ${who}${tag}: ${c.text.replace(/\n+/g, " ⏎ ")}`;
    return [head, ...c.files.map((f) => `  файл: ${f.name ?? f.attachedId}${f.size ? ` (${f.size})` : ""} ${f.url}`)];
  });
  return [...header, ...lines].join("\n") + "\n";
}
