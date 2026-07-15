# Снятие каталога вызовов

1. Открой вкладку своего Bitrix24, залогинься.
2. DevTools → Network → включи "Preserve log" (фильтр НЕ ставь — ловим всё).
3. Выполни целевые действия по каждому домену Триады:
   - Задачи: список задач + открой одну задачу.
   - Проекты: список рабочих групп + зайди в группу.
   - Чаты: открой мессенджер + один диалог + проскролль историю.
4. ПКМ по списку → "Save all as HAR with content" → `src/catalog/captured.har`.
5. `bun run src/catalog/build-catalog.ts src/catalog/captured.har > actions.draft.json`
6. Прочитай предупреждения в stderr: если по какому-то домену "no captured call" —
   вернись в браузер и прокликай его ещё раз.
7. Из `actions.draft.json` собери `actions.json`: присвой понятные ключи
   (tasks.list, task.get, projects.list, chats.recent, chat.messages),
   оставив поля endpoint/action/method/transport как есть.
