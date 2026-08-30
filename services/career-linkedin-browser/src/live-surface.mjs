import { createRequire } from "node:module";
import { createConnection as createTcpConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
// noVNC 1.7 exports its RFB entrypoint at the package root. Resolving the
// unexported `core/rfb.js` subpath throws ERR_PACKAGE_PATH_NOT_EXPORTED in the
// production image, while the root export remains stable and still locates the
// package's self-hosted core/vendor assets.
const noVncRoot = path.dirname(path.dirname(require.resolve("@novnc/novnc")));
const serviceSourceRoot = path.dirname(new URL(import.meta.url).pathname);
const LIVE_COOKIE = "__Host-clp_linkedin_live";
const MAX_REDEEM_BODY_BYTES = 2_048;

const ASSET_CONTENT_TYPES = Object.freeze({
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
});

function securityHeaders({ nonce } = {}) {
  return {
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}`,
      `style-src ${nonce ? `'nonce-${nonce}'` : "'none'"}`,
      "connect-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function writeJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  response.end(payload);
}

async function readRedeemBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REDEEM_BODY_BYTES) throw new Error("redeem_body_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_redeem_body");
  }
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

function normalizeRedemptionResult(value) {
  return ["accepted", "conflict", "retryable"].includes(value?.kind)
    ? value
    : { kind: "retryable" };
}

function writeUpgradeError(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function liveHtml(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="referrer" content="no-referrer">
  <title>Connect LinkedIn to Career Desk</title>
  <style nonce="${nonce}">
    :root { color-scheme: light; font-family: system-ui, sans-serif; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #111; }
    body { display: grid; grid-template-rows: 1fr auto; }
    #screen { width: 100%; height: 100%; min-height: 0; overflow: hidden; background: #111; }
    #status { position: fixed; z-index: 2; inset: 0 0 52px; display: grid; place-items: center; padding: 24px; color: white; text-align: center; background: #111; }
    #status[hidden] { display: none; }
    #toolbar { min-height: 52px; display: flex; align-items: center; gap: 10px; padding: 6px max(10px, env(safe-area-inset-right)) max(6px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left)); background: #202124; color: white; }
    button, #return-link { min-height: 40px; box-sizing: border-box; border: 1px solid #74777c; border-radius: 8px; padding: 9px 14px; color: white; background: #34363a; font: inherit; text-decoration: none; }
    #connection { margin-left: auto; font-size: 13px; }
    #mobile-keyboard { position: fixed; left: -20px; bottom: 0; width: 1px; height: 1px; opacity: .01; }
  </style>
</head>
<body>
  <div id="status">Preparing your private LinkedIn sign-in window…</div>
  <div id="screen" aria-label="LinkedIn authentication browser"></div>
  <div id="toolbar">
    <button id="keyboard" type="button">Keyboard</button>
    <button id="reconnect" type="button" disabled>Reconnect</button>
    <a id="return-link" href="https://jarrett.suburbiasandwichco.com/career">Return to Career Desk</a>
    <span id="connection" role="status">Connecting…</span>
    <input id="mobile-keyboard" type="text" inputmode="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Mobile keyboard input">
  </div>
  <script type="module" nonce="${nonce}">
    import { KEY_SYMS, sendControlKeyToRfb, sendTextToRfb } from '/live-ui/mobile-input.mjs';
    import { redeemLiveToken } from '/live-ui/live-redeem.mjs';
    const status = document.querySelector('#status');
    const connection = document.querySelector('#connection');
    const keyboardInput = document.querySelector('#mobile-keyboard');
    const reconnectButton = document.querySelector('#reconnect');
    const params = new URLSearchParams(location.hash.slice(1));
    let token = params.get('token');
    history.replaceState(null, '', '/live');
    try {
      if (token) {
        const redemption = await redeemLiveToken({ token });
        token = null;
        if (!redemption.ok) throw new Error('redemption_failed');
      }
      reconnectButton.disabled = false;
      const { default: RFB } = await import('/live-assets/core/rfb.js');
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = scheme + '://' + location.host + '/live/ws';
      const rfb = new RFB(document.querySelector('#screen'), wsUrl);
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.viewOnly = false;
      rfb.addEventListener('connect', () => {
        status.hidden = true;
        connection.textContent = 'Connected';
      });
      rfb.addEventListener('disconnect', () => {
        status.hidden = false;
        connection.textContent = 'Disconnected';
        status.textContent = 'This authentication window has closed. Return to Career Desk to continue.';
      });
      document.querySelector('#keyboard').addEventListener('click', () => keyboardInput.focus());
      reconnectButton.addEventListener('click', () => location.reload());
      keyboardInput.addEventListener('input', (event) => {
        const text = event.data || keyboardInput.value;
        if (text) sendTextToRfb(rfb, text);
        keyboardInput.value = '';
      });
      keyboardInput.addEventListener('beforeinput', (event) => {
        if (event.inputType === 'deleteContentBackward') {
          event.preventDefault();
          sendControlKeyToRfb(rfb, KEY_SYMS.backspace);
        }
      });
      keyboardInput.addEventListener('keydown', (event) => {
        const keysym = event.key === 'Enter' ? KEY_SYMS.enter : event.key === 'Tab' ? KEY_SYMS.tab : null;
        if (keysym) {
          event.preventDefault();
          sendControlKeyToRfb(rfb, keysym);
        }
      });
      const outcomeTimer = setInterval(async () => {
        try {
          const response = await fetch('/v1/live/outcome', { credentials: 'same-origin', cache: 'no-store' });
          if (!response.ok) return;
          const outcome = await response.json();
          if (['succeeded', 'confirming'].includes(outcome.status) && outcome.returnUrl) {
            clearInterval(outcomeTimer);
            location.replace(outcome.returnUrl);
          }
        } catch {}
      }, 1000);
      rfb.focus();
    } catch {
      token = null;
      history.replaceState(null, '', '/live');
      status.textContent = 'This private sign-in link is invalid or expired. Return to Career Desk and reconnect.';
    }
  </script>
</body>
</html>`;
}

export class LiveSurface {
  constructor({
    tokenStore,
    vncHost,
    vncPort,
    publicBaseUrl,
    redeemWithControlPlane,
    connectVnc = createTcpConnection,
  }) {
    this.tokenStore = tokenStore;
    this.vncHost = vncHost;
    this.vncPort = vncPort;
    this.publicOrigin = new URL(publicBaseUrl).origin;
    this.redeemWithControlPlane = redeemWithControlPlane;
    this.connectVnc = connectVnc;
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
    });
    this.activeViewer = null;
    this.unsubscribeVncRevocation = this.tokenStore.onVncRevoked((attemptId) => {
      this.closeViewer(attemptId, "authentication_complete");
    });
  }

  async redeemWithCurrentFence(proof) {
    try {
      return normalizeRedemptionResult(await this.redeemWithControlPlane(proof));
    } catch {
      return { kind: "retryable" };
    }
  }

  async adoptExistingCookie(cookie) {
    const proof = this.tokenStore.inspectCookie(cookie);
    if (!proof) return { kind: "conflict" };
    if (!proof.adoptionRequired) return { kind: "accepted" };
    const adoption = await this.redeemWithCurrentFence(proof);
    if (adoption.kind !== "accepted") return adoption;
    return this.tokenStore.completeCookieAdoption(proof.attemptId, cookie)
      ? { kind: "accepted" }
      : { kind: "conflict" };
  }

  async handleHttp(request, response, url) {
    if (request.method === "GET" && url.pathname === "/live") {
      const nonce = randomBytes(18).toString("base64url");
      const body = liveHtml(nonce);
      response.writeHead(200, {
        ...securityHeaders({ nonce }),
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/live/redeem") {
      let body;
      try {
        body = await readRedeemBody(request);
      } catch {
        writeJson(response, 400, { error: "invalid_request" });
        return true;
      }
      const match = this.tokenStore.matchToken(body?.token);
      if (!match) {
        writeJson(response, 409, { error: "handoff_not_ready_or_expired" });
        return true;
      }

      // A retry immediately after an accepted response was lost may replay the
      // exact same in-memory cookie. It never reopens control-plane redemption
      // and the replay capability is removed on terminal/new-command/expiry.
      const redemption = match.responseReplay
        ? { kind: "accepted" }
        : await this.redeemWithCurrentFence(match);
      if (redemption.kind === "retryable") {
        writeJson(response, 503, { error: "handoff_temporarily_unavailable" });
        return true;
      }
      if (redemption.kind !== "accepted") {
        writeJson(response, 409, { error: "link_already_redeemed_or_expired" });
        return true;
      }
      const issued = this.tokenStore.issueCookieAfterAcceptedRedemption(match.attemptId);
      if (!issued) {
        writeJson(response, 409, { error: "link_already_redeemed_or_expired" });
        return true;
      }
      const maxAge = Math.max(1, Math.floor((issued.expiresAtMs - Date.now()) / 1_000));
      writeJson(response, 200, { ok: true }, {
        "set-cookie": `${LIVE_COOKIE}=${issued.cookie}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/live/outcome") {
      const cookie = parseCookies(request.headers.cookie).get(LIVE_COOKIE);
      const adoption = await this.adoptExistingCookie(cookie);
      if (adoption.kind === "retryable") {
        writeJson(response, 503, { error: "handoff_temporarily_unavailable" });
        return true;
      }
      if (adoption.kind !== "accepted") {
        writeJson(response, 409, { error: "link_already_redeemed_or_expired" });
        return true;
      }
      const outcome = this.tokenStore.outcomeForCookie(cookie);
      if (!outcome) {
        writeJson(response, 401, { error: "invalid_or_expired_session" });
      } else {
        writeJson(response, 200, outcome);
      }
      return true;
    }

    const liveUiAsset = new Map([
      ["/live-ui/mobile-input.mjs", "mobile-input.mjs"],
      ["/live-ui/live-redeem.mjs", "live-redeem.mjs"],
    ]).get(url.pathname);
    if (request.method === "GET" && liveUiAsset) {
      try {
        const body = await readFile(path.join(serviceSourceRoot, liveUiAsset));
        response.writeHead(200, {
          ...securityHeaders(),
          "content-type": "text/javascript; charset=utf-8",
          "content-length": body.length,
        });
        response.end(body);
      } catch {
        writeJson(response, 404, { error: "not_found" });
      }
      return true;
    }

    if (request.method === "GET" && url.pathname.startsWith("/live-assets/")) {
      const relative = url.pathname.slice("/live-assets/".length);
      const resolved = path.resolve(noVncRoot, relative);
      if (!resolved.startsWith(`${noVncRoot}${path.sep}`)) {
        writeJson(response, 404, { error: "not_found" });
        return true;
      }
      try {
        const body = await readFile(resolved);
        response.writeHead(200, {
          ...securityHeaders(),
          "content-type": ASSET_CONTENT_TYPES[path.extname(resolved)] || "application/octet-stream",
          "content-length": body.length,
        });
        response.end(body);
      } catch {
        writeJson(response, 404, { error: "not_found" });
      }
      return true;
    }
    return false;
  }

  async handleUpgrade(request, socket, head) {
    let url;
    try {
      url = new URL(request.url, "https://worker.invalid");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/live/ws") {
      socket.destroy();
      return;
    }
    let requestOrigin;
    try {
      requestOrigin = new URL(String(request.headers.origin || "")).origin;
    } catch {
      socket.destroy();
      return;
    }
    if (requestOrigin !== this.publicOrigin) {
      writeUpgradeError(socket, 403, "Forbidden");
      return;
    }
    const cookie = parseCookies(request.headers.cookie).get(LIVE_COOKIE);
    const adoption = await this.adoptExistingCookie(cookie);
    if (adoption.kind === "retryable") {
      writeUpgradeError(socket, 503, "Service Unavailable");
      return;
    }
    if (adoption.kind !== "accepted") {
      writeUpgradeError(socket, 409, "Conflict");
      return;
    }
    const authorization = this.tokenStore.authorizeCookieForVnc(cookie);
    if (!authorization) {
      writeUpgradeError(socket, 401, "Unauthorized");
      return;
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.bridgeVnc(webSocket, authorization);
    });
  }

  bridgeVnc(webSocket, authorization) {
    if (this.activeViewer) this.closeViewer(null, "replaced");

    const vncSocket = this.connectVnc({ host: this.vncHost, port: this.vncPort });
    const forwardInput = (data) => {
      if (this.activeViewer?.webSocket === webSocket) {
        vncSocket.write(Buffer.from(data));
      }
    };
    this.activeViewer = {
      attemptId: authorization.attemptId,
      webSocket,
      vncSocket,
      forwardInput,
    };
    webSocket.binaryType = "arraybuffer";
    webSocket.on("message", forwardInput);
    webSocket.on("close", () => vncSocket.destroy());
    webSocket.on("error", () => vncSocket.destroy());
    vncSocket.on("data", (data) => {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.send(data, { binary: true });
    });
    vncSocket.on("error", () => webSocket.close(1011, "browser_unavailable"));
    vncSocket.on("close", () => {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1000, "browser_closed");
      if (this.activeViewer?.webSocket === webSocket) {
        this.activeViewer = null;
      }
    });
  }

  closeViewer(attemptId, reason = "authentication_complete") {
    const viewer = this.activeViewer;
    if (!viewer || (attemptId && viewer.attemptId !== attemptId)) return;
    // Remove the input path before initiating either asynchronous close. This
    // makes the revocation synchronous even if the WebSocket close handshake
    // or x11vnc socket shutdown takes time.
    this.activeViewer = null;
    viewer.webSocket.off("message", viewer.forwardInput);
    if (viewer.webSocket.readyState === WebSocket.OPEN) {
      viewer.webSocket.close(1000, reason);
    }
    viewer.vncSocket.destroy();
  }

  closeAttempt(attemptId) {
    this.tokenStore.revokeAttempt(attemptId);
  }

  close() {
    this.unsubscribeVncRevocation();
    this.closeViewer(null, "worker_stopping");
    this.tokenStore.clear();
    this.webSocketServer.close();
  }
}
