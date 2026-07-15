// Recorder: opens the WS bridge, receives captured API calls from the extension's
// capture build, and writes a live actions.draft.json with triad coverage warnings.
//
// Run: `bun run capture`  (uses the same .env token/origin/port as the MCP server).
// Then load the capture build of the extension and browse the portal. Ctrl-C to finish.
import { writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { Bridge } from "./bridge/server.js";
import { missingTriadDomains } from "./catalog/har-parse.js";
import type { CapturedEntry } from "./bridge/protocol.js";

const cfg = loadConfig(process.env);
const DRAFT_PATH = cfg.catalogPath.replace(/actions\.json$/, "actions.draft.json") || "actions.draft.json";

const draft = new Map<string, CapturedEntry>();
let dirty = false;

function flush(): void {
  writeFileSync(DRAFT_PATH, JSON.stringify(Object.fromEntries(draft), null, 2) + "\n");
}

const bridge = new Bridge({
  port: cfg.port,
  token: cfg.token,
  allowedOrigins: cfg.allowedOrigins,
  onCapture: (call) => {
    const key = call.action ?? call.endpoint;
    if (!draft.has(key)) console.error(`+ ${call.transport}\t${call.method}\t${key}`);
    draft.set(key, call);
    dirty = true;
  },
});

await bridge.start();
console.error(`[capture] recording on 127.0.0.1:${cfg.port} → ${DRAFT_PATH}`);
console.error(`[capture] load the CAPTURE build of the extension, open ${cfg.bitrixOrigin}, and browse`);
console.error(`[capture] tasks / projects / chats. Ctrl-C to finish.`);

const timer = setInterval(() => {
  if (!dirty) return;
  dirty = false;
  flush();
  const missing = missingTriadDomains([...draft.values()]);
  if (missing.length) console.error(`… ${draft.size} calls; still missing: ${missing.join(", ")}`);
  else console.error(`✓ ${draft.size} calls; all triad domains captured`);
}, 1500);

process.on("SIGINT", () => {
  clearInterval(timer);
  flush();
  const missing = missingTriadDomains([...draft.values()]);
  console.error(`\n[capture] wrote ${DRAFT_PATH} (${draft.size} calls)`);
  if (missing.length) console.error(`[capture] ⚠ never captured: ${missing.join(", ")} — re-run and exercise them`);
  process.exit(0);
});
