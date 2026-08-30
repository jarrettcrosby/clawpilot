import { createServer } from "node:http";
import { createConnection } from "node:net";
import { LinkedInBrowserSession } from "./browser-session.mjs";
import { loadConfig } from "./config.mjs";
import { ControlPlaneClient } from "./control-plane-client.mjs";
import {
  ReplayNonceStore,
  verifyInternalRequest,
} from "./internal-auth.mjs";
import { LiveSurface } from "./live-surface.mjs";
import { LiveTokenStore } from "./live-token-store.mjs";
import { probeChromiumReadiness } from "./runtime-health.mjs";
import { WorkerPoller } from "./worker-poller.mjs";

const SERVICE_NAME = "career-linkedin-browser";
const SERVICE_VERSION = "0.1.0";

function safeEventLog(event, fields = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    service: SERVICE_NAME,
    event,
  };
  if (typeof fields.command === "string") record.command = fields.command;
  if (typeof fields.errorCode === "string") record.errorCode = fields.errorCode;
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function responseHeaders() {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...responseHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function vncIsReachable() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: config.vncHost, port: config.vncPort });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

let config;
try {
  config = loadConfig();
} catch (error) {
  safeEventLog("configuration_invalid", { errorCode: error.message });
  process.exitCode = 1;
  throw error;
}

const controlPlane = new ControlPlaneClient(config);
const chromiumReady = await probeChromiumReadiness({
  executablePath: config.chromiumExecutablePath,
  display: config.display,
  timeoutMs: config.runtimeProbeTimeoutMs,
});
if (!chromiumReady) {
  safeEventLog("runtime_prerequisite_failed", { errorCode: "chromium_not_ready" });
  process.exitCode = 1;
  throw new Error("chromium_not_ready");
}
const browserSession = new LinkedInBrowserSession(config);
const tokenStore = new LiveTokenStore({ hmacSecret: config.cookieSecret });
const nonceStore = new ReplayNonceStore();
let poller;
const liveSurface = new LiveSurface({
  tokenStore,
  vncHost: config.vncHost,
  vncPort: config.vncPort,
  publicBaseUrl: config.publicBaseUrl,
  redeemWithControlPlane: (match) =>
    poller?.redeemLiveToken(match) || { kind: "retryable" },
});
poller = new WorkerPoller({
  config,
  controlPlane,
  browserSession,
  tokenStore,
  onEvent: safeEventLog,
});

const server = createServer(async (request, response) => {
  let url;
  try {
    url = new URL(request.url, "https://worker.invalid");
  } catch {
    sendJson(response, 400, { error: "invalid_request" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    const ready = chromiumReady && await vncIsReachable();
    sendJson(response, ready ? 200 : 503, {
      status: ready ? "ok" : "unavailable",
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/internal/status") {
    const verification = verifyInternalRequest({
      headers: request.headers,
      bearerToken: config.bearerToken,
      hmacSecret: config.hmacSecret,
      workerId: config.workerId,
      method: request.method,
      path: url.pathname,
      rawBody: "",
      nonceStore,
    });
    if (!verification.ok) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    sendJson(response, 200, {
      status: "ok",
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      capabilities: ["interactive_auth", "jobs_read"],
    });
    return;
  }

  if (await liveSurface.handleHttp(request, response, url)) return;
  sendJson(response, 404, { error: "not_found" });
});

server.on("upgrade", (request, socket, head) => {
  void liveSurface.handleUpgrade(request, socket, head).catch(() => socket.destroy());
});

const abortController = new AbortController();
server.listen(config.port, "0.0.0.0", () => {
  safeEventLog("server_started", {});
  void poller.run(abortController.signal);
});

async function shutdown(signal) {
  safeEventLog("shutdown_started", { errorCode: signal });
  abortController.abort();
  liveSurface.close();
  await browserSession.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", () => void shutdown("sigterm"));
process.once("SIGINT", () => void shutdown("sigint"));
