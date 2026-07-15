export interface Config {
  port: number;
  token: string;
  bitrixOrigin: string;
  catalogPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const token = env.BITRIX_MCP_TOKEN?.trim();
  if (!token) throw new Error("BITRIX_MCP_TOKEN (shared token) is required");
  const bitrixOrigin = env.BITRIX_ORIGIN?.trim();
  if (!bitrixOrigin) throw new Error("BITRIX_ORIGIN (e.g. https://portal.bitrix24.ru) is required");
  return {
    token,
    bitrixOrigin,
    port: Number(env.BITRIX_MCP_PORT ?? 39917),
    catalogPath: env.BITRIX_CATALOG?.trim() || "actions.json",
  };
}
