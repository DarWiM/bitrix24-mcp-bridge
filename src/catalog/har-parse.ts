import { parseBody } from "../../shared/body-params.js";

export interface CapturedCall {
  endpoint: string;
  action: string | null;
  method: "GET" | "POST";
  params: Record<string, unknown>;
  transport: "ajax" | "rest" | "other";
  bodyType: "json" | "form";
}

interface HarPostParam {
  name: string;
  value: string;
}

interface HarEntry {
  request: {
    method: string;
    url: string;
    postData?: { params?: HarPostParam[]; text?: string };
  };
  response?: { content?: { mimeType?: string } };
}

function classify(pathname: string): "ajax" | "rest" | "other" {
  if (pathname.endsWith("/bitrix/services/main/ajax.php")) return "ajax";
  if (pathname.includes("/rest/")) return "rest";
  return "other";
}

const TRIAD_HINT_TOKENS: Record<string, string[]> = {
  tasks: ["tasks", "task"],
  projects: ["socialnetwork", "workgroup", "sonet"],
  chats: ["im", "dialog", "recent"],
};

function tokenize(value: string | null): string[] {
  if (!value) return [];
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Returns the triad domain names ("tasks", "projects", "chats") that have
 * NO captured call. Coverage is determined by exact token equality against
 * each domain's hint tokens (tokenized from `action`/`endpoint`), NOT
 * substring matching — e.g. "tasks.task.estimate" must not be mistaken for
 * chats coverage just because "estimate" contains "im".
 */
export function missingTriadDomains(calls: Array<{ action: string | null; endpoint: string }>): string[] {
  const tokens = new Set<string>();
  for (const call of calls) {
    for (const t of tokenize(call.action)) tokens.add(t);
    for (const t of tokenize(call.endpoint)) tokens.add(t);
  }
  const missing: string[] = [];
  for (const [domain, hints] of Object.entries(TRIAD_HINT_TOKENS)) {
    if (!hints.some((h) => tokens.has(h))) {
      missing.push(domain);
    }
  }
  return missing;
}

export function parseHar(har: {
  log?: { entries?: HarEntry[] };
}): CapturedCall[] {
  const calls: CapturedCall[] = [];
  for (const entry of har.log?.entries ?? []) {
    const url = new URL(entry.request.url);
    let params: Record<string, unknown> = {};
    let bodyType: "json" | "form" = "form";
    let hasSessid = false;
    const pd = entry.request.postData;
    const flat: Record<string, string> = {};
    for (const p of pd?.params ?? []) {
      if (p.name === "sessid") { hasSessid = true; continue; }
      flat[p.name] = p.value;
    }
    params = flat;
    // JSON bodies (e.g. ui.entityselector.*) arrive as postData.text with no .params —
    // parse them so the payload isn't silently dropped.
    if (Object.keys(params).length === 0 && pd?.text) {
      const parsed = parseBody(pd.text);
      params = parsed.params;
      bodyType = parsed.bodyType;
      if ("sessid" in params) { hasSessid = true; delete params.sessid; }
    }
    const mime = entry.response?.content?.mimeType ?? "";
    const looksApi = url.pathname.includes("ajax.php") || url.pathname.includes("/rest/");
    const isJson = mime.includes("application/json");
    if (!hasSessid && !looksApi && !isJson) continue; // static / non-API — drop
    calls.push({
      endpoint: url.pathname,
      action: url.searchParams.get("action"),
      method: entry.request.method === "GET" ? "GET" : "POST",
      params,
      transport: classify(url.pathname),
      bodyType,
    });
  }
  return calls;
}
