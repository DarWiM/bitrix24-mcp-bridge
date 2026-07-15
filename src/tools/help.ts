// Single source of truth: the MCP help served to any client IS docs/api-notes.md.
// We read it at startup relative to THIS source file (via import.meta.url), so it
// resolves regardless of the process's working directory. Edit the .md — nothing else.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API_NOTES = fileURLToPath(new URL("../../docs/api-notes.md", import.meta.url));

function load(): string {
  try {
    return readFileSync(API_NOTES, "utf8");
  } catch {
    return "Bitrix24 MCP — read-only tasks/projects/chats. See docs/api-notes.md (not found at runtime).";
  }
}

export const HELP: string = load();
