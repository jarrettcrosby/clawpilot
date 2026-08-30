import { signInternalRequest } from "./internal-auth.mjs";
import { setTimeout as delay } from "node:timers/promises";

export const CLAIM_PATH = "/api/internal/career-site/linkedin/worker/claim";
export const REPORT_PATH = "/api/internal/career-site/linkedin/worker/report";
const DEFAULT_RESPONSE_BYTES = 2 * 1024 * 1024;
const CLAIM_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REPORT_RETRY_DELAYS_MS = Object.freeze([0, 250, 1_000, 3_000]);

function retryableReportStatus(status) {
  return [408, 425, 429].includes(status) || status >= 500;
}

function ambiguousReportError(cause) {
  const error = new Error("control_plane_report_ambiguous", { cause });
  error.code = "control_plane_report_ambiguous";
  return error;
}

async function readJsonResponse(response, maximumBytes = 2 * 1024 * 1024) {
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > maximumBytes) throw new Error("control_plane_response_too_large");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new Error("control_plane_response_too_large");
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid_control_plane_response");
  }
}

export class ControlPlaneClient {
  constructor(config, {
    fetchImpl = globalThis.fetch,
    sleepImpl = delay,
    reportRetryDelaysMs = DEFAULT_REPORT_RETRY_DELAYS_MS,
  } = {}) {
    this.baseUrl = config.controlPlaneBaseUrl;
    this.bearerToken = config.bearerToken;
    this.hmacSecret = config.hmacSecret;
    this.workerId = config.workerId;
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
    if (
      !Array.isArray(reportRetryDelaysMs) ||
      reportRetryDelaysMs.length < 1 ||
      reportRetryDelaysMs.length > 6 ||
      reportRetryDelaysMs.some(
        (value) => !Number.isSafeInteger(value) || value < 0 || value > 10_000,
      )
    ) throw new Error("invalid_report_retry_schedule");
    this.reportRetryDelaysMs = [...reportRetryDelaysMs];
  }

  async post(
    path,
    payload,
    extraHeaders = {},
    maximumResponseBytes = DEFAULT_RESPONSE_BYTES,
  ) {
    const rawBody = JSON.stringify(payload);
    const headers = {
      ...signInternalRequest({
        bearerToken: this.bearerToken,
        hmacSecret: this.hmacSecret,
        workerId: this.workerId,
        method: "POST",
        path,
        rawBody,
      }),
      ...extraHeaders,
    };
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      redirect: "error",
    });
    try {
      return { response, body: await readJsonResponse(response, maximumResponseBytes) };
    } catch (cause) {
      const error = new Error(cause.message, { cause });
      error.httpStatus = response.status;
      throw error;
    }
  }

  async claim({ workerId }) {
    const { response, body } = await this.post(
      CLAIM_PATH,
      {
        workerId,
        capabilities: ["interactive_auth", "jobs_read"],
      },
      {},
      CLAIM_RESPONSE_BYTES,
    );
    if (!response.ok) throw new Error(`control_plane_claim_${response.status}`);
    if (
      !body ||
      typeof body !== "object" ||
      body.ok !== true ||
      !(body.claim === null || (typeof body.claim === "object" && !Array.isArray(body.claim)))
    ) throw new Error("invalid_claim_response");
    return body.claim;
  }

  async report(payload) {
    if (
      typeof payload?.leaseId !== "string" ||
      typeof payload?.leaseToken !== "string" ||
      payload.leaseToken.length < 16
    ) {
      throw new Error("invalid_lease_token");
    }
    let lastRetryableError;
    for (const retryDelayMs of this.reportRetryDelaysMs) {
      if (retryDelayMs > 0) await this.sleepImpl(retryDelayMs);
      let response;
      let body;
      try {
        ({ response, body } = await this.post(REPORT_PATH, payload));
      } catch (error) {
        if (
          Number.isSafeInteger(error.httpStatus) &&
          error.httpStatus >= 400 &&
          !retryableReportStatus(error.httpStatus)
        ) throw new Error(`control_plane_report_${error.httpStatus}`);
        lastRetryableError = error;
        continue;
      }
      if (!response.ok) {
        if (!retryableReportStatus(response.status)) {
          throw new Error(`control_plane_report_${response.status}`);
        }
        lastRetryableError = new Error(`control_plane_report_${response.status}`);
        continue;
      }
      if (
        !body ||
        typeof body !== "object" ||
        body.ok !== true ||
        !body.result ||
        typeof body.result !== "object" ||
        Array.isArray(body.result)
      ) {
        lastRetryableError = new Error("invalid_report_response");
        continue;
      }
      return body.result;
    }
    throw ambiguousReportError(lastRetryableError);
  }
}
