import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimePaths {
  home: string;
  configJson: string;
  actionsJson: string;
  sock: string;
  lock: string;
  extensionDir: string;
}

export function runtimePaths(env: NodeJS.ProcessEnv): RuntimePaths {
  const home = env.BITRIX24_MCP_BRIDGE_HOME?.trim() || join(homedir(), ".bitrix24-mcp-bridge");
  return {
    home,
    configJson: join(home, "config.json"),
    actionsJson: join(home, "actions.json"),
    sock: join(home, "bridge.sock"),
    lock: join(home, "bridge.lock"),
    extensionDir: join(home, "extension"),
  };
}
