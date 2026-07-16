import type { ServerConfig } from "./config-core.js";
import { addPortal, removePortal, editPortal, setPort, rotateToken, setDefaultPortal } from "./config-core.js";

export type SetupCommand =
  | { kind: "add-portal"; alias: string; origin: string; catalog?: string }
  | { kind: "remove-portal"; alias: string }
  | { kind: "edit-portal"; alias: string; origin: string; catalog?: string }
  | { kind: "set-port"; port: number }
  | { kind: "rotate-token" }
  | { kind: "set-default"; alias: string }
  | { kind: "update-extension" };

export type SetupEffect = "write-config" | "materialize-extension" | "reload-extension" | "reopen-tab";

export interface SetupResult {
  config: ServerConfig;
  effects: SetupEffect[];
  message: string;
}

export function applySetupCommand(config: ServerConfig, command: SetupCommand): SetupResult {
  switch (command.kind) {
    case "add-portal": {
      const next = addPortal(config, command);
      return { config: next, effects: ["write-config", "materialize-extension", "reload-extension"], message: `added portal "${command.alias}" → ${command.origin}` };
    }
    case "remove-portal": {
      const next = removePortal(config, command.alias);
      return { config: next, effects: ["write-config", "materialize-extension", "reload-extension"], message: `removed portal "${command.alias}"` };
    }
    case "edit-portal": {
      const next = editPortal(config, command);
      return { config: next, effects: ["write-config", "materialize-extension", "reload-extension"], message: `updated portal "${command.alias}" → ${command.origin}` };
    }
    case "set-port": {
      const next = setPort(config, command.port);
      return { config: next, effects: ["write-config", "materialize-extension", "reopen-tab"], message: `port set to ${command.port}` };
    }
    case "rotate-token": {
      const next = rotateToken(config);
      return { config: next, effects: ["write-config", "materialize-extension", "reopen-tab"], message: "token rotated" };
    }
    case "set-default": {
      const next = setDefaultPortal(config, command.alias);
      return { config: next, effects: ["write-config"], message: `default portal set to "${command.alias}"` };
    }
    case "update-extension": {
      return { config, effects: ["materialize-extension", "reload-extension"], message: "extension refreshed from the installed package" };
    }
  }
}
