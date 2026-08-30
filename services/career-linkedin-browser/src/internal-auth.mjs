import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

const SIGNATURE_VERSION = "clawpilot-linkedin-worker-v1";
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function signaturePayload({ timestamp, nonce, method, path, rawBody }) {
  return [
    SIGNATURE_VERSION,
    method.toUpperCase(),
    path,
    String(timestamp),
    nonce,
    sha256Hex(rawBody),
  ].join("\n");
}

export function signInternalRequest({
  bearerToken,
  hmacSecret,
  workerId,
  method,
  path,
  rawBody = "",
  timestamp = Math.floor(Date.now() / 1_000),
  nonce = randomUUID().toLowerCase(),
}) {
  const payload = signaturePayload({ timestamp, nonce, method, path, rawBody });
  const signature = createHmac("sha256", hmacSecret).update(payload).digest("hex");
  return {
    authorization: `Bearer ${bearerToken}`,
    "content-type": "application/json",
    "x-clawpilot-linkedin-worker-id": workerId,
    "x-clawpilot-linkedin-timestamp": String(timestamp),
    "x-clawpilot-linkedin-nonce": nonce,
    "x-clawpilot-linkedin-signature": signature,
  };
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left || "", "utf8");
  const rightBuffer = Buffer.from(right || "", "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export class ReplayNonceStore {
  constructor() {
    this.nonces = new Map();
  }

  use(nonce, expiresAt, now = Date.now()) {
    for (const [knownNonce, knownExpiry] of this.nonces) {
      if (knownExpiry <= now) {
        this.nonces.delete(knownNonce);
      }
    }
    if (this.nonces.has(nonce)) {
      return false;
    }
    this.nonces.set(nonce, expiresAt);
    return true;
  }
}

export function verifyInternalRequest({
  headers,
  bearerToken,
  hmacSecret,
  workerId,
  method,
  path,
  rawBody = "",
  nonceStore,
  now = Math.floor(Date.now() / 1_000),
}) {
  const authorization = headers.authorization;
  const suppliedWorkerId = headers["x-clawpilot-linkedin-worker-id"];
  const timestampText = headers["x-clawpilot-linkedin-timestamp"];
  const nonce = headers["x-clawpilot-linkedin-nonce"];
  const suppliedSignature = headers["x-clawpilot-linkedin-signature"];

  if (!constantTimeEqual(authorization, `Bearer ${bearerToken}`)) {
    return { ok: false, code: "invalid_bearer" };
  }
  if (!constantTimeEqual(suppliedWorkerId, workerId)) {
    return { ok: false, code: "invalid_worker_id" };
  }

  const timestamp = Number(timestampText);
  if (
    !/^\d{10}$/.test(timestampText || "") ||
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now - timestamp) > MAX_CLOCK_SKEW_SECONDS
  ) {
    return { ok: false, code: "stale_timestamp" };
  }
  if (
    typeof nonce !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)
  ) {
    return { ok: false, code: "invalid_nonce" };
  }
  if (typeof suppliedSignature !== "string" || !/^[a-f0-9]{64}$/.test(suppliedSignature)) {
    return { ok: false, code: "invalid_signature" };
  }

  const expectedHeaders = signInternalRequest({
    bearerToken,
    hmacSecret,
    workerId,
    method,
    path,
    rawBody,
    timestamp,
    nonce,
  });
  if (!constantTimeEqual(suppliedSignature, expectedHeaders["x-clawpilot-linkedin-signature"])) {
    return { ok: false, code: "invalid_signature" };
  }
  if (!nonceStore.use(nonce, timestamp + MAX_CLOCK_SKEW_SECONDS, now)) {
    return { ok: false, code: "replayed_nonce" };
  }
  return { ok: true };
}
