// Single source of truth: the MCP help served to any client IS docs/api-notes.md.
// - Dev/test (bun run / bun test): read the .md relative to THIS file via import.meta.url.
// - Bundled dist: esbuild replaces `__API_NOTES__` with the file's contents at build time,
//   so the standalone cli.js needs no adjacent .md. `typeof` guard is safe when undeclared.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

declare const __API_NOTES__: string | undefined;

const API_NOTES = fileURLToPath(new URL("../../docs/api-notes.md", import.meta.url));

function load(): string {
  try {
    return readFileSync(API_NOTES, "utf8");
  } catch {
    return "Bitrix24 MCP — tasks/projects/chats over your live session; bitrix_call runs curated catalog calls incl. mutating. See docs/api-notes.md (not found at runtime).";
  }
}

export const HELP: string =
  typeof __API_NOTES__ !== "undefined" && __API_NOTES__ ? __API_NOTES__ : load();
