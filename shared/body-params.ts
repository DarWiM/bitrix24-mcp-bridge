// Pure, browser + bun agnostic. Turns a request body string into params + its type.
// A JSON body (Content-Type: application/json, e.g. ui.entityselector.*) is kept as the
// parsed NESTED object so it can be round-tripped back to JSON when a write is sent; a
// form body is parsed flat via URLSearchParams (bracket keys like data[fields][...] kept).

export interface ParsedBody {
  params: Record<string, unknown>;
  bodyType: "json" | "form";
}

export function parseBody(text: string): ParsedBody {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        return { params: parsed as Record<string, unknown>, bodyType: "json" };
      }
    } catch {
      // not JSON after all — fall through to form parsing
    }
  }
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(trimmed)) params[k] = v;
  return { params, bodyType: "form" };
}
