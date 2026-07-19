import { readFileSync } from "node:fs";
import { parseHar, missingTriadDomains } from "./har-parse.js";
import { newAccumulator, addSample, toObject } from "./draft.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun run build-catalog.ts <file.har>");
  process.exit(1);
}
const calls = parseHar(JSON.parse(readFileSync(path, "utf8")));

// Coverage warnings — did we exercise each triad domain? (no silent misses)
for (const domain of missingTriadDomains(calls)) {
  console.error(`⚠ nothing captured for "${domain}" — exercise it in the browser and re-capture`);
}

const acc = newAccumulator();
for (const c of calls) addSample(acc, c, c.params);
process.stdout.write(JSON.stringify(toObject(acc), null, 2) + "\n");
