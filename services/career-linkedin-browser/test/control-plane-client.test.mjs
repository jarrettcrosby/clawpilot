import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneClient } from "../src/control-plane-client.mjs";

const clientConfig = Object.freeze({
  controlPlaneBaseUrl: "https://control.example.com",
  bearerToken: "worker-token-0123456789abcdef-123456",
  hmacSecret: "hmac-secret-0123456789abcdef-12345678",
  workerId: "worker-retry-fixture",
  requestTimeoutMs: 5_000,
});

function reportPayload(status) {
  return {
    leaseId: "lease-report-retry",
    leaseToken: "lease-token-report-retry-00000000",
    status,
    authState: { kind: "none", message: null },
    encryptedSessionEnvelope: status === "succeeded" ? { version: 1 } : null,
    jobs: [],
    evidence: null,
    errorCode: null,
    errorMessage: null,
  };
}

test("claim accepts a valid base64 envelope larger than the old 2 MiB response cap", async () => {
  const encodedEnvelopeBytes = Math.ceil((2 * 1024 * 1024 * 4) / 3) + 16_384;
  const claim = {
    encryptedSessionEnvelope: {
      version: 1,
      algorithm: "A256GCM",
      ciphertext: "A".repeat(encodedEnvelopeBytes),
    },
  };
  const payload = JSON.stringify({ ok: true, claim });
  assert.ok(Buffer.byteLength(payload) > 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(payload) < 8 * 1024 * 1024);

  const client = new ControlPlaneClient({
    controlPlaneBaseUrl: "https://control.example.com",
    bearerToken: "worker-token-0123456789abcdef-123456",
    hmacSecret: "hmac-secret-0123456789abcdef-12345678",
    workerId: "worker-near-limit",
    requestTimeoutMs: 5_000,
  }, {
    fetchImpl: async () => new Response(payload, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  const received = await client.claim({ workerId: "worker-near-limit" });
  assert.equal(
    received.encryptedSessionEnvelope.ciphertext.length,
    encodedEnvelopeBytes,
  );
});

test("committed awaiting-auth response loss retries the exact report with a fresh nonce", async () => {
  const requests = [];
  const client = new ControlPlaneClient(clientConfig, {
    reportRetryDelaysMs: [0, 0],
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      requests.push({ headers: init.headers, body: init.body });
      if (requests.length === 1) throw new TypeError("response_lost_after_commit");
      return new Response(JSON.stringify({
        ok: true,
        result: { kind: "auth", authAttempt: { status: "awaiting_auth" } },
      }), { status: 200 });
    },
  });
  const result = await client.report(reportPayload("awaiting_auth"));
  assert.equal(result.kind, "auth");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.notEqual(
    requests[0].headers["x-clawpilot-linkedin-nonce"],
    requests[1].headers["x-clawpilot-linkedin-nonce"],
  );
  assert.notEqual(
    requests[0].headers["x-clawpilot-linkedin-signature"],
    requests[1].headers["x-clawpilot-linkedin-signature"],
  );
});

test("retryable report exhaustion is explicitly ambiguous and 409 is authoritative", async () => {
  let attempts = 0;
  const ambiguousClient = new ControlPlaneClient(clientConfig, {
    reportRetryDelaysMs: [0, 0, 0],
    sleepImpl: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: "temporary" }), { status: 503 });
    },
  });
  await assert.rejects(
    () => ambiguousClient.report(reportPayload("running")),
    (error) => error.code === "control_plane_report_ambiguous",
  );
  assert.equal(attempts, 3);

  attempts = 0;
  const conflictClient = new ControlPlaneClient(clientConfig, {
    reportRetryDelaysMs: [0, 0, 0],
    sleepImpl: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: "stale_fence" }), { status: 409 });
    },
  });
  await assert.rejects(
    () => conflictClient.report(reportPayload("succeeded")),
    /control_plane_report_409/,
  );
  assert.equal(attempts, 1);
});

test("a committed malformed 2xx response is retried and never treated as definitive 200", async () => {
  let attempts = 0;
  const client = new ControlPlaneClient(clientConfig, {
    reportRetryDelaysMs: [0, 0],
    sleepImpl: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("{truncated", { status: 200 })
        : new Response(JSON.stringify({
            ok: true,
            result: { kind: "auth", authAttempt: { status: "running" } },
          }), { status: 200 });
    },
  });
  assert.equal((await client.report(reportPayload("running"))).kind, "auth");
  assert.equal(attempts, 2);

  const alwaysMalformed = new ControlPlaneClient(clientConfig, {
    reportRetryDelaysMs: [0, 0],
    sleepImpl: async () => {},
    fetchImpl: async () => new Response("{truncated", { status: 200 }),
  });
  await assert.rejects(
    () => alwaysMalformed.report(reportPayload("succeeded")),
    (error) => error.code === "control_plane_report_ambiguous",
  );
});
