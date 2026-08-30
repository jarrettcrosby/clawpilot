import { existsSync } from "node:fs";

function required(name, minimumLength = 1) {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimumLength) {
    throw new Error(`missing_or_invalid_${name.toLowerCase()}`);
  }
  return value;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid_${name.toLowerCase()}`);
  }
  return value;
}

function validateControlPlaneUrl(value) {
  const url = new URL(value);
  const isPrivateRailway =
    url.protocol === "http:" && url.hostname.endsWith(".railway.internal");
  if (
    (url.protocol !== "https:" && !isPrivateRailway) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid_control_plane_base_url");
  }
  return url.toString().replace(/\/$/, "");
}

function validatePublicUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid_public_base_url");
  }
  return url.toString().replace(/\/$/, "");
}

export function loadConfig() {
  const chromiumExecutablePath =
    process.env.CHROMIUM_EXECUTABLE_PATH?.trim() || "/usr/bin/chromium";
  if (!existsSync(chromiumExecutablePath)) {
    throw new Error("chromium_executable_not_found");
  }

  const config = {
    port: boundedInteger("PORT", 8080, 1, 65_535),
    workerId: required("CAREER_LINKEDIN_BROWSER_WORKER_ID", 3),
    ownerId: required("CAREER_LINKEDIN_BROWSER_OWNER_ID", 3),
    controlPlaneBaseUrl: validateControlPlaneUrl(
      required("CAREER_LINKEDIN_BROWSER_CONTROL_PLANE_URL", 8),
    ),
    publicBaseUrl: validatePublicUrl(required("CAREER_LINKEDIN_BROWSER_PUBLIC_URL", 8)),
    bearerToken: required("CAREER_LINKEDIN_BROWSER_WORKER_TOKEN", 32),
    hmacSecret: required("CAREER_LINKEDIN_BROWSER_WORKER_HMAC_SECRET", 32),
    cookieSecret: required("CAREER_LINKEDIN_BROWSER_COOKIE_SECRET", 32),
    chromiumExecutablePath,
    display: process.env.DISPLAY?.trim() || ":99",
    vncHost: "127.0.0.1",
    vncPort: boundedInteger("VNC_PORT", 5900, 1, 65_535),
    runtimeProbeTimeoutMs: boundedInteger(
      "RUNTIME_PROBE_TIMEOUT_MS",
      10_000,
      1_000,
      15_000,
    ),
    pollIntervalMs: boundedInteger("WORKER_POLL_INTERVAL_MS", 2_000, 250, 30_000),
    requestTimeoutMs: boundedInteger("WORKER_REQUEST_TIMEOUT_MS", 15_000, 1_000, 60_000),
    authPollIntervalMs: boundedInteger("AUTH_POLL_INTERVAL_MS", 2_000, 500, 10_000),
    authTimeoutMs: boundedInteger("AUTH_TIMEOUT_MS", 15 * 60_000, 60_000, 30 * 60_000),
    navigationTimeoutMs: boundedInteger("NAVIGATION_TIMEOUT_MS", 30_000, 5_000, 90_000),
    maxScanResults: boundedInteger("MAX_SCAN_RESULTS", 50, 1, 50),
    scanHeartbeatMs: boundedInteger("SCAN_HEARTBEAT_MS", 30_000, 5_000, 60_000),
    scanMaxDurationMs: boundedInteger(
      "SCAN_MAX_DURATION_MS",
      12 * 60_000,
      60_000,
      30 * 60_000,
    ),
    scanLeaseSafetyMs: boundedInteger(
      "SCAN_LEASE_SAFETY_MS",
      4 * 60_000,
      60_000,
      270_000,
    ),
  };
  if (new Set([config.bearerToken, config.hmacSecret, config.cookieSecret]).size !== 3) {
    throw new Error("worker_secrets_must_be_distinct");
  }
  return Object.freeze(config);
}
