export interface CapturedCall {
  endpoint: string;
  action: string | null;
  method: "GET" | "POST";
  params: Record<string, string>;
  transport: "ajax" | "rest" | "other";
}

interface HarPostParam {
  name: string;
  value: string;
}

interface HarEntry {
  request: {
    method: string;
    url: string;
    postData?: { params?: HarPostParam[] };
  };
  response?: { content?: { mimeType?: string } };
}

function classify(pathname: string): "ajax" | "rest" | "other" {
  if (pathname.endsWith("/bitrix/services/main/ajax.php")) return "ajax";
  if (pathname.includes("/rest/")) return "rest";
  return "other";
}

export function parseHar(har: {
  log?: { entries?: HarEntry[] };
}): CapturedCall[] {
  const calls: CapturedCall[] = [];
  for (const entry of har.log?.entries ?? []) {
    const url = new URL(entry.request.url);
    const params: Record<string, string> = {};
    let hasSessid = false;
    for (const p of entry.request.postData?.params ?? []) {
      if (p.name === "sessid") {
        hasSessid = true;
        continue;
      }
      params[p.name] = p.value;
    }
    const mime = entry.response?.content?.mimeType ?? "";
    const looksApi =
      url.pathname.includes("ajax.php") || url.pathname.includes("/rest/");
    const isJson = mime.includes("application/json");
    if (!hasSessid && !looksApi && !isJson) continue; // static / non-API — drop
    calls.push({
      endpoint: url.pathname,
      action: url.searchParams.get("action"),
      method: entry.request.method === "GET" ? "GET" : "POST",
      params,
      transport: classify(url.pathname),
    });
  }
  return calls;
}
