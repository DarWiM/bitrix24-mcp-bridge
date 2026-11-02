import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallSink } from "../bridge/uds-client.js";
import type { Operation } from "../ops/operation.js";
import { HELP } from "./help.js";
import { PACKAGE_VERSION } from "../version.js";

export interface ToolDeps {
  sink: CallSink;
  operations: Operation[];
  defaultPortal: string;
  portals: string[];
}

function ok(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data) }] }; }
function fail(message: string) { return { isError: true, content: [{ type: "text" as const, text: message }] }; }

export function registerTools(server: McpServer, deps: ToolDeps): void {
  // Self-describing: any MCP client can call bitrix_help (or read the resource) to learn
  // param conventions, the response envelope, and field names without repo access.
  server.registerTool(
    "bitrix_help",
    {
      description:
        "Справка по этому Bitrix24 MCP: список инструментов, формат ответа, конвенции params " +
        "(select/filter/order/пагинация), имена полей, примеры. Вызови, если не уверен, как формировать params.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text" as const, text: HELP }] }),
  );

  // Same guide as an MCP resource, for clients that surface resources.
  server.registerResource(
    "bitrix-api-guide",
    "bitrix://api-notes",
    { title: "Bitrix24 MCP usage guide", description: "Как пользоваться инструментами: params, поля, формат ответа.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: HELP }] }),
  );

  server.registerTool(
    "bitrix_status",
    {
      description:
        "Диагностика моста (read-only): какие порталы сконфигурированы и какие сейчас подключены " +
        "(открыта залогиненная вкладка с расширением). Помогает понять, почему вызов не проходит.",
      inputSchema: {},
    },
    async () => {
      try {
        const { portals, mutations } = await deps.sink.status();
        // The bundles on disk are refreshed automatically on upgrade, but Chrome keeps running
        // the copy it loaded until someone hits "Обновить" — so a stale extension is reported
        // rather than left to fail later with a confusing error.
        const stale = portals.filter((p) => p.connected && p.extensionVersion !== PACKAGE_VERSION);
        return ok({
          configured: true,
          defaultPortal: deps.defaultPortal,
          packageVersion: PACKAGE_VERSION,
          // null: the daemon is too old to report whether mutating operations are allowed.
          mutations: mutations ?? null,
          portals,
          ...(stale.length > 0
            ? {
                warning:
                  `расширение устарело (${stale.map((p) => `${p.alias}: ${p.extensionVersion ?? "до 0.3.0"}`).join(", ")}), ` +
                  `мост версии ${PACKAGE_VERSION}. Файлы уже обновлены — нажми «Обновить» на расширении в chrome://extensions ` +
                  "и перезагрузи вкладку портала, иначе новые методы работать не будут.",
              }
            : {}),
        });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // Every Bitrix24 request is built and policed by the daemon; this process only forwards the
  // validated arguments. An absent portal is left to the daemon, which applies the default.
  for (const op of deps.operations) {
    server.registerTool(
      `bitrix_${op.name}`,
      { description: op.description, inputSchema: { ...op.input, portal: z.string().optional() } },
      async ({ portal, ...args }) => {
        try {
          return ok(await deps.sink.op(portal, op.name, args, op.budget));
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    );
  }
}
