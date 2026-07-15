// MAIN-world shim. The ONLY reason it runs in the page's MAIN world is that
// window.BX (and thus the rotating CSRF sessid) lives there. It holds NO token and
// NO socket — it just answers the ISOLATED connector's sessid requests.
//
// In the capture build it additionally installs the page-traffic recorder (which must
// run in MAIN to observe the page's own fetch/XHR) and forwards each observed entry to
// the connector over postMessage; the connector owns the socket and relays to the daemon.

import { parseSessidRequest, buildSessidResponse, buildCaptureForward } from "./bridge-protocol.ts";
import { installCapture } from "./capture.ts";

// Stripped from normal builds via esbuild `define` + dead-code elimination.
declare const __BITRIX_CAPTURE__: boolean;

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

if (__BITRIX_CAPTURE__) {
  installCapture((call) => window.postMessage(buildCaptureForward(call), location.origin));
}
