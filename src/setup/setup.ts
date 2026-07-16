import { createInterface } from "node:readline/promises";
import type { Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runtimePaths } from "../paths.js";
import type { RuntimePaths } from "../paths.js";
import { PROJECT_ROOT } from "../config.js";
import {
  createInitialConfig,
  readServerConfig,
  writeServerConfig,
  materializeExtension,
  validateOrigin,
} from "./config-core.js";
import type { ServerConfig } from "./config-core.js";
import { applySetupCommand } from "./setup-reducer.js";
import type { SetupCommand, SetupResult } from "./setup-reducer.js";

type Ask = (query: string) => Promise<string>;

// A piped (non-TTY) stdin can deliver multiple newline-terminated answers in a single
// chunk before the next rl.question() call is armed; readline's internal `_onLine` then
// drops every line beyond the first pending question. Driving lines through the
// Interface's async iterator instead sidesteps that race — the iterator queues every
// 'line' event unconditionally, so no answer is lost regardless of chunk timing.
function makeAsk(rl: Interface): Ask {
  const lines = rl[Symbol.asyncIterator]();
  return async (query: string) => {
    stdout.write(query);
    const { value, done } = await lines.next();
    return done ? "" : value;
  };
}

function staticExtDir(): string {
  return join(PROJECT_ROOT, "extension/dist");
}

function actionsExample(): string {
  return join(PROJECT_ROOT, "actions.example.json");
}

function defaultAlias(origin: string): string {
  try {
    const label = new URL(origin).hostname.split(".")[0];
    return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(label) ? label : "portal";
  } catch {
    return "portal";
  }
}

function seedActions(paths: RuntimePaths): void {
  if (existsSync(paths.actionsJson)) return;
  mkdirSync(paths.home, { recursive: true });
  copyFileSync(actionsExample(), paths.actionsJson);
}

function printManualSteps(paths: RuntimePaths): void {
  stdout.write(
    [
      "",
      "Manual steps (cannot be automated):",
      `  1. Open chrome://extensions, enable Developer mode, "Load unpacked" → ${paths.extensionDir}`,
      "  2. Log into each configured portal and keep a tab open.",
      "  3. After changing the portal set, reload the extension at chrome://extensions.",
      "     (A port/token change only needs reopening the portal tab.)",
      "",
    ].join("\n"),
  );
}

function printState(config: ServerConfig, paths: RuntimePaths): void {
  stdout.write(`\nConfig: ${paths.configJson}\nPort: ${config.port}   Default portal: ${config.defaultPortal}\nPortals:\n`);
  for (const [alias, p] of Object.entries(config.portals)) {
    stdout.write(`  - ${alias}: ${p.origin}${alias === config.defaultPortal ? "   (default)" : ""}\n`);
  }
}

function applyEffects(paths: RuntimePaths, config: ServerConfig, result: SetupResult): void {
  if (result.effects.includes("write-config")) writeServerConfig(paths.home, config);
  if (result.effects.includes("materialize-extension")) {
    materializeExtension({ home: paths.home, config, staticExtDir: staticExtDir() });
  }
  stdout.write(`\n${result.message}\n`);
  if (result.effects.includes("reload-extension")) {
    stdout.write(`  → Reload the unpacked extension at chrome://extensions (${paths.extensionDir}).\n`);
  }
  if (result.effects.includes("reopen-tab")) {
    stdout.write("  → Reopen the portal tab to pick up the new port/token.\n");
  }
}

const MAX_ORIGIN_ATTEMPTS = 3;

async function firstRun(ask: Ask, paths: RuntimePaths): Promise<void> {
  stdout.write("No configuration found — let's set up your first Bitrix24 portal.\n");

  let config: ServerConfig | undefined;
  for (let attempt = 0; attempt < MAX_ORIGIN_ATTEMPTS && !config; attempt++) {
    const rawOrigin = (await ask("Portal origin (e.g. https://acme.bitrix24.ru): ")).trim();
    if (!rawOrigin) continue;
    let origin: string;
    try {
      origin = validateOrigin(rawOrigin);
    } catch (e) {
      stdout.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      continue;
    }
    const suggested = defaultAlias(origin);
    const aliasInput = (await ask(`Alias for this portal [${suggested}]: `)).trim();
    const alias = aliasInput || suggested;
    try {
      config = createInitialConfig({ origin, alias });
    } catch (e) {
      stdout.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  if (!config) {
    stdout.write("Setup cancelled: no valid portal origin was provided.\n");
    return;
  }

  writeServerConfig(paths.home, config);
  seedActions(paths);
  materializeExtension({ home: paths.home, config, staticExtDir: staticExtDir() });

  stdout.write(`\nWrote ${paths.configJson}\nSeeded ${paths.actionsJson}\nExtension materialized at ${paths.extensionDir}\n`);
  printManualSteps(paths);
}

async function promptCommand(ask: Ask, choice: string): Promise<SetupCommand | null> {
  switch (choice) {
    case "a": {
      const origin = (await ask("New portal origin: ")).trim();
      const alias = (await ask(`Alias [${defaultAlias(origin)}]: `)).trim() || defaultAlias(origin);
      return { kind: "add-portal", alias, origin };
    }
    case "r":
      return { kind: "remove-portal", alias: (await ask("Alias to remove: ")).trim() };
    case "e": {
      const alias = (await ask("Alias to edit: ")).trim();
      const origin = (await ask("New portal origin: ")).trim();
      return { kind: "edit-portal", alias, origin };
    }
    case "d":
      return { kind: "set-default", alias: (await ask("Alias to make default: ")).trim() };
    case "p":
      return { kind: "set-port", port: Number((await ask("New port: ")).trim()) };
    case "t":
      return { kind: "rotate-token" };
    case "u":
      return { kind: "update-extension" };
    default:
      return null;
  }
}

async function editMenu(ask: Ask, paths: RuntimePaths, initial: ServerConfig): Promise<void> {
  let current = initial;
  for (;;) {
    printState(current, paths);
    const choice = (
      await ask(
        "\n[a]dd portal  [r]emove portal  [e]dit portal  [d]efault portal  [p]ort  [t]oken rotate  [u]pdate extension  [q]uit: ",
      )
    ).trim().toLowerCase();
    if (choice === "q" || choice === "") break;
    const command = await promptCommand(ask, choice);
    if (!command) {
      stdout.write("Unknown choice.\n");
      continue;
    }
    let result: SetupResult;
    try {
      result = applySetupCommand(current, command);
    } catch (e) {
      stdout.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      continue;
    }
    current = result.config;
    applyEffects(paths, current, result);
  }
}

export async function runSetup(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const paths = runtimePaths(env);
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = makeAsk(rl);
  try {
    const existing = readServerConfig(paths.home);
    if (!existing) {
      await firstRun(ask, paths);
    } else {
      await editMenu(ask, paths, existing);
    }
  } finally {
    rl.close();
  }
}
