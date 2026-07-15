import { readFileSync } from "node:fs";
import { parseHar, missingTriadDomains } from "./har-parse.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun run build-catalog.ts <file.har>");
  process.exit(1);
}
const calls = parseHar(JSON.parse(readFileSync(path, "utf8")));

// Coverage warnings — did we exercise each triad domain? (G1: no silent misses)
for (const domain of missingTriadDomains(calls)) {
  console.error(
    `⚠ nothing captured for "${domain}" — exercise it in the browser and re-capture`
  );
}

const draft: Record<string, unknown> = {};
for (const c of calls) {
  const key = c.action ?? c.endpoint;
  draft[key] = {
    endpoint: c.endpoint,
    action: c.action,
    method: c.method,
    transport: c.transport,
    sampleParams: c.params,
  };
}
process.stdout.write(JSON.stringify(draft, null, 2) + "\n");
