# Bitrix24 MCP Bridge

Локальный MCP-сервер, дающий ИИ-агенту **read-only** доступ к задачам, проектам и чатам Bitrix24
в объёме прав пользователя — через браузерное расширение, переиспользующее живую сессию.
Без прав администратора и без официального REST-вебхука.

```
ИИ-агент ──stdio──► MCP-сервер ──WS (127.0.0.1, токен + Origin)──► Расширение (вкладка портала)
                                                                      │ fetch + свежий sessid + cookie
                                                                      ▼
                                                          Bitrix24 (задачи / группы / чаты)
```

## Быстрый старт

Полная инструкция — **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

Коротко (первый запуск):
1. `bun install && bun test`
2. Сгенерировать токен: `openssl rand -hex 32`
3. Снять HAR и собрать `actions.json` — см. [docs/reconnaissance.md](docs/reconnaissance.md)
4. Вписать домен + токен в `extension/`, затем `bun run build:ext`, загрузить расширение в Chrome
5. Зарегистрировать сервер у агента (`claude mcp add …`) с `BITRIX_MCP_TOKEN` и `BITRIX_ORIGIN`
6. Проверить по [docs/e2e-checklist.md](docs/e2e-checklist.md)

Последующие запуски: держать открытой залогиненную вкладку портала — сервер поднимает агент сам.

## Инструменты

`bitrix_tasks_list`, `bitrix_task_get`, `bitrix_projects_list`, `bitrix_chats_recent`,
`bitrix_chat_messages`, и универсальный `bitrix_call` для любого разрешённого вызова из каталога.

## Разработка

```bash
bun test              # юнит-тесты (bun:test)
bun run typecheck     # tsc --noEmit
bun run build:ext     # собрать расширение (esbuild → extension/bridge-client.js)
```

## Документация

- [docs/RUNBOOK.md](docs/RUNBOOK.md) — первый и последующие запуски, диагностика, безопасность
- [docs/reconnaissance.md](docs/reconnaissance.md) — как снять HAR и собрать `actions.json`
- [docs/e2e-checklist.md](docs/e2e-checklist.md) — сквозная проверка
```

