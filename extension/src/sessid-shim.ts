// MAIN-world shim. The ONLY reason it runs in the page's MAIN world is that
// window.BX (and thus the rotating CSRF sessid) lives there. It holds NO token and
// NO socket — it just answers the ISOLATED connector's sessid requests.

import { parseSessidRequest, buildSessidResponse } from "./bridge-protocol.ts";

// window.BX is provided by the Bitrix24 page itself (MAIN world).
declare global {
  interface Window {
    BX?: { bitrix_sessid?: () => string };
  }
}

window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== window) return; // same frame only — ignore other frames/windows
  const req = parseSessidRequest(ev.data);
  if (!req) return;
  const sessid = window.BX?.bitrix_sessid?.() || "";
  window.postMessage(buildSessidResponse(req.nonce, sessid), location.origin);
});
