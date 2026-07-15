# E2E проверка

Подготовка:
- Сними HAR и собери `actions.json` (docs/reconnaissance.md). Проверь, что нет предупреждений о покрытии Триады.
- Запусти сервер: `BITRIX_MCP_TOKEN=<secret> BITRIX_ORIGIN=https://<portal>.bitrix24.ru bun run src/index.ts`
- Установи расширение с тем же токеном/доменом (extension/README.md).
- Открой обычную вкладку портала. В stderr: `[bridge] extension authenticated`.

Функциональные (через MCP-инспектор или агента):
- [ ] `bitrix_tasks_list` возвращает твои задачи.
- [ ] `bitrix_projects_list` возвращает твои группы.
- [ ] `bitrix_chats_recent` возвращает недавние диалоги.
- [ ] `bitrix_chat_messages { dialogId }` → 20 последних; с `beforeId` листает вглубь.
- [ ] `bitrix_call { name: "task.get", params: { taskId } }` работает.

Безопасность / границы:
- [ ] `bitrix_call { name: "crm.deal.list" }` → "not allowed".
- [ ] Закрыть все вкладки портала → любой инструмент → "extension not connected".
- [ ] Открыть вкладку без BX (встроенное приложение) → инструмент → "session context not ready".
- [ ] Неверный токен на порту → сокет закрывается.
- [ ] Протухшая сессия → ответ инструмента содержит `invalid_csrf`/`invalid_authentication` (сигнал перелогиниться), а не молчаливый успех.
- [ ] Данные вне доступа твоего пользователя в UI недоступны и через инструменты (совпадение скоупа).

Диагностика:
- Если функциональный пункт падает пустым/ошибкой — сверь `endpoint`/`action`/`transport` в `actions.json` с реальным запросом из DevTools. Правка — только в данных, код не трогаем.
