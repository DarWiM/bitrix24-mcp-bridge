import type { ServerConfig } from "./config-core.js";
import { addPortal, removePortal, editPortal, setPort, setMutations, rotateToken, setDefaultPortal } from "./config-core.js";

export type SetupCommand =
  | { kind: "add-portal"; alias: string; origin: string }
  | { kind: "remove-portal"; alias: string }
  | { kind: "edit-portal"; alias: string; origin: string }
  | { kind: "set-port"; port: number }
  | { kind: "set-mutations"; on: boolean }
  | { kind: "rotate-token" }
  | { kind: "set-default"; alias: string }
  | { kind: "update-extension" };

export type SetupEffect = "write-config" | "materialize-extension" | "reload-extension" | "reopen-tab" | "restart-daemon";

export interface SetupResult {
  config: ServerConfig;
  effects: SetupEffect[];
  message: string;
}

// config.json has no "mutations" key until the first toggle, and absent means on.
export function toggleMutations(config: ServerConfig): SetupCommand {
  return { kind: "set-mutations", on: config.mutations === false };
}

export function applySetupCommand(config: ServerConfig, command: SetupCommand): SetupResult {
  switch (command.kind) {
    case "add-portal": {
      const next = addPortal(config, command);
      return { config: next, effects: ["write-config", "materialize-extension", "reload-extension", "restart-daemon"], message: `added portal "${command.alias}" → ${command.origin}` };
    }
    case "remove-portal": {
      const next = removePortal(config, command.alias);
      return { config: next, effects: ["write-config", "materialize-extension", "reload-extension", "restart-daemon"], message: `removed portal "${command.alias}"` };
    }
    case "edit-portal": {
      const next = editPortal(config, command);
      return { config: next, effects: ["write-config", "materialize-extension", "reload-extension", "restart-daemon"], message: `updated portal "${command.alias}" → ${command.origin}` };
    }
    case "set-port": {
      const next = setPort(config, command.port);
      return { config: next, effects: ["write-config", "materialize-extension", "reopen-tab", "restart-daemon"], message: `port set to ${command.port}` };
    }
    case "set-mutations": {
      const next = setMutations(config, command.on);
      return { config: next, effects: ["write-config", "restart-daemon"], message: `mutations ${command.on ? "enabled" : "disabled"}` };
    }
    case "rotate-token": {
      const next = rotateToken(config);
      return { config: next, effects: ["write-config", "materialize-extension", "reopen-tab", "restart-daemon"], message: "token rotated" };
    }
    case "set-default": {
      const next = setDefaultPortal(config, command.alias);
      return { config: next, effects: ["write-config", "restart-daemon"], message: `default portal set to "${command.alias}"` };
    }
    case "update-extension": {
      return { config, effects: ["materialize-extension", "reload-extension"], message: "extension refreshed from the installed package" };
    }
  }
}
