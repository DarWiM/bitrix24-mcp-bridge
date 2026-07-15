# Расширение (Bitrix24 MCP Bridge)

Main-world content script на вкладке портала: подключается к локальному MCP-мосту
(`ws://127.0.0.1`), аутентифицируется общим токеном и по запросу выполняет `fetch`
к Bitrix24 со свежим `sessid` и cookie сессии.

## Сборка и установка

Конфигурация (токен, порт, домен портала) берётся из корневого **`.env`** — исходники
редактировать не нужно.

Структура:
- `extension/src/` — исходники (TypeScript): `bridge-core.ts`, `bridge-client.ts`, `manifest.template.json`, тесты.
- `extension/dist/` — сборка (генерируется, gitignored): `bridge-client.js` + `manifest.json`. **Именно `dist/` грузится как расширение.**

```bash
# в корне проекта, где лежит .env:
bun run build:ext
```
Генерирует в `extension/dist/`:
- `bridge-client.js` — бандл (esbuild IIFE) с вшитыми `BITRIX_MCP_TOKEN` и `BITRIX_MCP_PORT`;
- `manifest.json` — из `src/manifest.template.json` с `matches` = `BITRIX_ORIGIN` + `/*`.

Типы браузерной среды — в `extension/tsconfig.json` (отдельный от серверного, с `lib: DOM`);
проверка: `bun run typecheck` гоняет и сервер, и расширение.

Установка: `chrome://extensions` → **Developer mode** → **Load unpacked** → папка **`extension/dist/`**.
Держи открытой обычную залогиненную вкладку портала (где грузится `BX` и мессенджер).

Примечание (G6): работает только в Chromium — `ws://127.0.0.1` из HTTPS разрешён исключением для loopback.

## Заметки по безопасности

- `BITRIX_MCP_TOKEN` должен быть длинным и случайным (`openssl rand -hex 32`) — единственная защита
  loopback-порта WebSocket; всё, что на машине может достучаться до `127.0.0.1` и знает токен, может управлять мостом.
- Content script выполняется в `world: MAIN`, поэтому скрипт, уже работающий на аутентифицированной
  странице портала, теоретически может прочитать вшитый токен — но такой скрипт уже полностью контролирует
  вашу сессию, так что эскалация ограничена.
- Сервер отклоняет WS-подключения, у которых браузерный `Origin` ≠ `BITRIX_ORIGIN` (defense-in-depth).
