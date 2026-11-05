# E2E проверка

Подготовка:
- Настрой мост: `bitrix24-bridge setup` (или из репозитория: `bun run src/index.ts setup`).
- Загрузи расширение из `~/.bitrix24-mcp-bridge/extension/` (extension/README.md).
- Открой обычную вкладку портала. `bitrix_status` → портал в списке подключённых.

Функциональные (через MCP-инспектор или агента):
- [ ] **Каждый инструмент отвечает** без ошибки транспорта: `bitrix_help`, `bitrix_status`, `bitrix_tasks_list`,
  `bitrix_task_get`, `bitrix_task_get_v2`, `bitrix_task_scrum_info`, `bitrix_task_files`,
  `bitrix_task_views_count`, `bitrix_task_subtasks`, `bitrix_task_related`, `bitrix_task_comments`,
  `bitrix_projects_list`, `bitrix_project_get`, `bitrix_chats_recent`, `bitrix_recent_load`,
  `bitrix_recent_tail`, `bitrix_chat_load`, `bitrix_chat_get_dialog_id`, `bitrix_chat_messages`,
  `bitrix_chat_history`, `bitrix_user_get`, `bitrix_entity_search`, `bitrix_entity_selector`,
  `bitrix_entity_chat`, `bitrix_chat_calls`, `bitrix_call_detail`, `bitrix_call_recording`,
  `bitrix_file_download`, `bitrix_sprint_columns`; мутирующие — на тестовой задаче / тестовом чате:
  `bitrix_chat_mark_read`, `bitrix_chat_read_all`, `bitrix_chat_send`, `bitrix_task_description_set`,
  `bitrix_task_description_append`, `bitrix_task_result_add`, `bitrix_task_move`.
- [ ] Пакетные `bitrix_task_move` / `bitrix_task_result_add` с двумя `taskIds`, одна из которых заведомо
  не подходит (напр. задача в бэклоге для переноса) → `results` в порядке `taskIds`, у неподходящей
  `ok: false` и `error`, вторая выполнена.
- [ ] `bitrix_chat_messages { chatId }` → последние сообщения; `bitrix_chat_history { chatId, beforeId }` листает вглубь.
- [ ] Инструмента `bitrix_call` в списке нет.

Безопасность / границы:
- [ ] Мутации выключены (`setup` → `[m]` или `BITRIX_MCP_MUTATIONS=off`) → `bitrix_chat_mark_read` →
  `operation chat_mark_read changes data, but mutations are disabled…`; чтение при этом работает.
- [ ] `bitrix_file_download` с чужой ссылкой (другой origin или путь не из allowlist, напр.
  `https://<портал>/bitrix/services/main/ajax.php?action=tasks.task.list`) → `refusing to download …`.
- [ ] Закрыть все вкладки портала → любой инструмент → "extension not connected".
- [ ] Открыть вкладку без BX (встроенное приложение) → инструмент → "session context not ready".
- [ ] Неверный токен на порту → сокет закрывается.
- [ ] Протухшая сессия → ответ инструмента содержит `invalid_csrf`/`invalid_authentication` (сигнал перелогиниться), а не молчаливый успех.
- [ ] Данные вне доступа твоего пользователя в UI недоступны и через инструменты (совпадение скоупа).

Обновление:
- [ ] После старта новой версии в `~/.bitrix24-mcp-bridge/` нет `actions.json` / `catalog-state.json`;
  `config.json` и `downloads/` на месте.

Диагностика:
- Если инструмент падает пустым/ошибкой — сверь запрос операции (`src/ops/`) с реальным запросом из
  Charles / DevTools (docs/reconnaissance.md).
