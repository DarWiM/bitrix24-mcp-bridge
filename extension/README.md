# Установка расширения

1. В `manifest.json` замени `REPLACE_WITH_YOUR_PORTAL.bitrix24.ru` на домен своего портала.
2. В `bridge-client.src.js` замени `REPLACE_WITH_SHARED_TOKEN` на значение `BITRIX_MCP_TOKEN` сервера.
3. Собери: `bun run build:ext` (создаст `bridge-client.js`).
4. chrome://extensions → «Загрузить распакованное» → папка `extension/`.
5. Держи открытой ОБЫЧНУЮ вкладку портала (где грузится BX и мессенджер), залогинься.
   Расширение подключится к `ws://127.0.0.1:39917`.

Примечание (G6): работает только в Chromium — `ws://127.0.0.1` из HTTPS разрешён исключением для loopback.
