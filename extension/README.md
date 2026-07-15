# Расширение (Bitrix24 MCP Bridge)

Два content script'а на вкладке портала:

- **`connector.js`** — `world: ISOLATED` (есть `chrome.runtime`). На старте читает
  `config.json` (`{ token, port }`) через `chrome.runtime.getURL` + `fetch`, подключается
  к локальному MCP-мосту (`ws://127.0.0.1:<port>`), аутентифицируется токеном и авто-переподключается
  (3 с). На каждый запрос `{type:"call"}` спрашивает свежий `sessid` у MAIN-шима через
  `window.postMessage` (запрос/ответ с nonce), выполняет `fetch` к Bitrix24 с cookie сессии и
  интерпретирует ответ. **Токен и WebSocket живут только здесь** — страница (MAIN world) их не видит.
- **`sessid-shim.js`** — `world: MAIN`, крошечный. Единственная причина быть в MAIN — доступ к
  `window.BX.bitrix_sessid()`. Отвечает на `postMessage`-запрос коннектора свежим `sessid`.
  Никакого токена и сокета. В capture-сборке он же ставит перехват трафика страницы и пересылает
  записи коннектору (тот отправляет их в daemon).

## Сборка и установка

Конфигурация (токен, порт, домен портала) берётся из корневого **`.env`** — исходники
редактировать не нужно. JS-бандлы **статичны** (одинаковы для всех): пер-пользовательские значения
попадают только в `config.json`.

Структура:
- `extension/src/` — исходники (TypeScript): `bridge-core.ts` (чистые хелперы), `bridge-protocol.ts`
  (чистые: разбор `config.json` + протокол `postMessage`, покрыты юнит-тестами), `connector.ts`,
  `sessid-shim.ts`, `capture.ts`, `manifest.template.json`, тесты.
- `extension/config.example.json` — пример схемы `config.json` (`{ token, port }`).
- `extension/dist/` — сборка (генерируется, gitignored). **Именно `dist/` грузится как расширение.**

```bash
# в корне проекта, где лежит .env:
bun run build:ext
```
Генерирует в `extension/dist/`:
- `connector.js`, `sessid-shim.js` — статичные бандлы (esbuild IIFE) + их `*.js.map`;
- `config.json` — пер-пользовательский `{ token, port }` из env (токен живёт только здесь);
- `manifest.json` — из `src/manifest.template.json` с `matches` / `host_permissions` /
  `web_accessible_resources` = `BITRIX_ORIGIN` + `/*`.

Типы браузерной среды — в `extension/tsconfig.json` (отдельный от серверного, с `lib: DOM`);
проверка: `bun run typecheck` гоняет и сервер, и расширение.

Установка: `chrome://extensions` → **Developer mode** → **Load unpacked** → папка **`extension/dist/`**.
Держи открытой обычную залогиненную вкладку портала (где грузится `BX` и мессенджер).

Примечание (G6): работает только в Chromium — `ws://127.0.0.1` из HTTPS разрешён исключением для loopback.

### Почему `config.json` в `web_accessible_resources`

В Chrome MV3 `chrome-extension://`-ресурс по умолчанию недоступен со страниц. Коннектор выполняется в
контексте страницы портала, поэтому его `fetch(chrome.runtime.getURL("config.json"))` считается доступом
со стороны origin портала и требует, чтобы `config.json` был объявлен в `web_accessible_resources` c
`matches` по этому origin. `matches` ограничивает доступ только порталом — сторонний сайт токен не вытащит.

## Заметки по безопасности

- Токен и WebSocket живут **только в ISOLATED-мире** (`connector.js`); MAIN-мир страницы (и любой
  скрипт на ней) их прочитать не может. MAIN-шим отдаёт лишь `sessid`, который у страницы и так есть.
- `token` должен быть длинным и случайным (`openssl rand -hex 32`) — единственная защита
  loopback-порта WebSocket; всё, что на машине может достучаться до `127.0.0.1` и знает токен, может управлять мостом.
- `config.json` пер-пользовательский и **не коммитится** (`extension/dist/` в `.gitignore`); генерируется
  сборкой из `.env`. В репозитории — только `config.example.json`.
- Сервер отклоняет WS-подключения, у которых браузерный `Origin` ≠ `BITRIX_ORIGIN` (defense-in-depth).
