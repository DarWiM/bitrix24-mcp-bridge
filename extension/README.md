# Расширение (Bitrix24 MCP Bridge)

Два content script'а на вкладке портала:

- **`connector.js`** — `world: ISOLATED` (есть `chrome.runtime`). На старте читает
  `config.json` (`{ token, port }`) через `chrome.runtime.getURL` + `fetch`, подключается
  к локальному daemon (`ws://127.0.0.1:<port>`), аутентифицируется токеном и авто-переподключается.
  На каждый запрос `{type:"call"}` спрашивает свежий `sessid` у MAIN-шима через
  `window.postMessage` (запрос/ответ с nonce), выполняет `fetch` к Bitrix24 с cookie сессии и
  интерпретирует ответ. **Токен и WebSocket живут только здесь** — страница (MAIN world) не может
  прочитать токен, не зная динамический (`use_dynamic_url`) URL ресурса `config.json`.
- **`sessid-shim.js`** — `world: MAIN`, крошечный. Единственная причина быть в MAIN — доступ к
  `window.BX.bitrix_sessid()`. Отвечает на `postMessage`-запрос коннектора свежим `sessid`.
  Никакого токена и сокета. В capture-сборке он же ставит перехват трафика страницы и пересылает
  записи коннектору (тот отправляет их в daemon).

## Откуда берётся расширение

В финальном потоке пер-пользовательское расширение **не собирается из `.env`**. Его
**материализует `bitrix24-bridge setup`** (функция `materializeExtension`) в
**`~/.bitrix24-mcp-bridge/extension/`** — именно эту папку грузишь как unpacked:

- `connector.js`, `sessid-shim.js` (+ их `*.js.map`) — **статичные бандлы**, одинаковые для
  всех пользователей. Их собирает npm-хук `prepare` при установке пакета
  (`scripts/build-ext-static.mjs` → `extension/dist/`), а `setup` копирует в runtime-папку.
- `config.json` — пер-пользовательский `{ token, port }`, который пишет `setup` (токен живёт
  только здесь). **Не редактируется руками** и не коммитится.
- `manifest.json` — генерируется **программно** (`buildManifest`) под сконфигурированные
  порталы: `matches` / `host_permissions` = `<origin>/*` каждого портала (least-privilege на
  origin), `content_scripts` (ISOLATED `connector.js` + MAIN `sessid-shim.js`) и запись
  `web_accessible_resources` для `config.json` с `use_dynamic_url: true`. Отдельного
  файла-шаблона манифеста больше нет.

После правки через `setup` **перезапусти daemon** (он читает серверный `config.json` только на
старте: `pkill -f -- --daemon`, следующий вызов агента поднимет новый). Дополнительно: смена набора
порталов (`setup` → add/remove/edit) переписывает `manifest.json` → **перезагрузи расширение** в
`chrome://extensions`; смена порта/токена меняет `config.json` расширения → **переоткрой вкладку** портала.

Установка: `chrome://extensions` → **Developer mode** → **Load unpacked** → папка
**`~/.bitrix24-mcp-bridge/extension/`**. Держи открытой обычную залогиненную вкладку портала
(где грузится `BX` и мессенджер).

Работает только в Chromium — `ws://127.0.0.1` из HTTPS разрешён исключением для loopback.

## Разработка расширения

Исходники (TypeScript) — в `extension/src/`: `bridge-core.ts` (чистые хелперы),
`bridge-protocol.ts` (чистые: разбор `config.json` + протокол `postMessage`, покрыты
юнит-тестами), `connector.ts`, `sessid-shim.ts`, `capture.ts`, тесты.
`extension/config.example.json` — пример схемы `config.json` (`{ token, port }`).

Типы браузерной среды — в `extension/tsconfig.json` (отдельный от серверного, с `lib: DOM`);
проверка: `bun run typecheck` гоняет и сервер, и расширение.

```bash
bun run build:ext     # dev-сборка пер-пользовательского расширения в extension/dist/
```

`build:ext` — dev-удобство для мейнтейнера (собирает в `extension/dist/`, gitignored). Обычному
пользователю оно не нужно: продовое расширение приходит статичными бандлами в пакете и
материализуется через `setup`.

### Почему `config.json` в `web_accessible_resources`

В Chrome MV3 `chrome-extension://`-ресурс по умолчанию недоступен со страниц. Коннектор выполняется в
контексте страницы портала, поэтому его `fetch(chrome.runtime.getURL("config.json"))` считается доступом
со стороны origin портала и требует, чтобы `config.json` был объявлен в `web_accessible_resources` c
`matches` по этому origin. `matches` ограничивает *чей* origin вообще может обращаться к ресурсу, но
extension ID — не секрет и не является границей безопасности: любой скрипт на самом портале (например,
через XSS или сторонний виджет) в принципе мог бы угадать `chrome-extension://<id>/config.json` и
прочитать токен. Реальная граница — `"use_dynamic_url": true` на этой записи: она делает URL ресурса
непредсказуемым со страницы, при этом `chrome.runtime.getURL()` в ISOLATED-коннекторе по-прежнему
резолвит его корректно.

## Заметки по безопасности

- Токен и WebSocket живут **только в ISOLATED-мире** (`connector.js`); MAIN-мир страницы (и любой
  скрипт на ней) не может прочитать токен без знания динамического (`use_dynamic_url`) URL ресурса
  `config.json` — это и есть фактическая граница, а не сам факт нахождения кода в ISOLATED-мире.
  MAIN-шим отдаёт лишь `sessid`, который у страницы и так есть.
- `token` должен быть длинным и случайным — `setup` генерирует `crypto.randomBytes(32)`. Это
  единственная защита loopback-порта WebSocket; всё, что на машине может достучаться до
  `127.0.0.1` и знает токен, может управлять мостом.
- `config.json` пер-пользовательский и **не коммитится**: он живёт в
  `~/.bitrix24-mcp-bridge/extension/` (вне репозитория), а dev-сборка (`extension/dist/`) —
  в `.gitignore`. В репозитории — только `config.example.json`.
- daemon отклоняет WS-подключения, у которых браузерный `Origin` не входит в набор
  сконфигурированных порталов (defense-in-depth).
