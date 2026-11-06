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
  `bitrix_file_download`, `bitrix_sprint_columns`, `bitrix_user_find`, `bitrix_task_checklist`,
  `bitrix_task_reminders`. Мутирующие — только в разделе «Запись» ниже.
- [ ] `bitrix_chat_messages { chatId }` → последние сообщения; `bitrix_chat_history { chatId, beforeId }` листает вглубь.
- [ ] Инструмента `bitrix_call` в списке нет.

Запись (мутирующие операции):

> **Только на тестовых сущностях**: заранее заведённая тестовая задача (и вторая — для пакетов и
> связей), тестовый чат, тестовый scrum-проект с активным спринтом. **Никогда на рабочих задачах и в
> рабочих чатах** — изменения и уведомления видят живые люди. Участники для делегирования,
> соисполнителей, наблюдателей и упоминаний `[user=ID]` — только из заранее согласованного тестового
> набора (например, неактивные пользователи из `bitrix_user_find`: их уведомления никто не прочтёт).
> Имена, id задач и людей в этот файл не записывай. Всё созданное (задачи, файлы на Диске) после
> проверки удали в интерфейсе — мост ничего не удаляет.

- [ ] **Каждая мутирующая операция** один раз без ошибки: `bitrix_task_description_set`,
  `bitrix_task_description_append`, `bitrix_task_description_replace`, `bitrix_task_tags`,
  `bitrix_task_checklist_edit`, `bitrix_task_plan`, `bitrix_task_priority`, `bitrix_task_deadline`,
  `bitrix_task_close`, `bitrix_task_reopen`, `bitrix_task_result_add`, `bitrix_task_file_attach`,
  `bitrix_task_mute`, `bitrix_task_reminder_set`, `bitrix_task_reminder_delete`, `bitrix_task_delegate`,
  `bitrix_task_accomplices`, `bitrix_task_auditors`, `bitrix_task_related_edit`, `bitrix_task_parent`,
  `bitrix_task_gantt_link`, `bitrix_task_move`, `bitrix_task_to_sprint`, `bitrix_task_to_backlog`,
  `bitrix_task_create`, `bitrix_chat_send`, `bitrix_chat_message_edit`, `bitrix_chat_reaction`,
  `bitrix_task_chat_post`, `bitrix_chat_mark_read`, `bitrix_chat_read_all`.
- [ ] Пакеты: `bitrix_task_move` / `bitrix_task_result_add` с двумя `taskIds`, одна из которых заведомо
  не подходит (напр. задача в бэклоге для переноса) → `results` в порядке `taskIds`, у неподходящей
  `ok: false` и `error`, вторая выполнена. Один и тот же id дважды → `invalid arguments…`, ничего не сделано.
- [ ] Списки: `bitrix_task_accomplices` / `bitrix_task_auditors` / `bitrix_task_tags` с `add` → в ответе
  прежний список плюс новый (сверь с `bitrix_task_get` / `bitrix_task_get_v2`); тот же `add` ещё раз →
  `changed: false`; `remove` последнего → пустой список.
- [ ] Scrum: задача из бэклога → `bitrix_task_to_sprint` → `fromBacklog: true`, колонка `NEW`;
  `bitrix_task_move` в другую колонку; `bitrix_task_to_backlog` → `changed: true`, повтор → `changed: false`.
  `bitrix_task_create` → задача на доске в колонке `NEW`.
- [ ] DoD: `bitrix_task_close { taskId }` в scrum-проекте с DoD → `needsConfirmation: true`, задача **не**
  закрыта; `{ taskId, typeId, confirmItems: true }` → `status: 5`; `bitrix_task_reopen` → снова открыта.
- [ ] Файл: `bitrix_task_file_attach` с маленьким файлом по абсолютному пути → вложение в
  `bitrix_task_files`; относительный путь → ошибка, ничего не загружено.
- [ ] Напоминания: `bitrix_task_reminder_set` без `reminderId` → в `bitrix_task_reminders` с `mine: true`;
  правка с `reminderId`; `bitrix_task_reminder_delete` → пропало. `at` в прошлом → ошибка аргументов.
- [ ] Связи: `bitrix_task_related_edit` add / remove, `bitrix_task_parent` с id и с `null`,
  `bitrix_task_gantt_link` добавить / `remove: true` на задачах без других связей Ганта → `confirmed: true`;
  прочие связи задачи не изменились.
- [ ] Чат: `bitrix_chat_send` с `replyTo` → показан ответом; `bitrix_chat_message_edit` своего сообщения;
  `bitrix_chat_reaction { reaction: "like" }`; `bitrix_task_chat_post` по двум тестовым задачам.

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
