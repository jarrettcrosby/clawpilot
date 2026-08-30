import assert from "node:assert/strict";
import test from "node:test";
import {
  ReplayNonceStore,
  sha256Hex,
  signInternalRequest,
  verifyInternalRequest,
} from "../src/internal-auth.mjs";

const fixture = Object.freeze({
  bearerToken: "token-fixture-0123456789abcdef-EXACT",
  hmacSecret: "hmac-fixture-secret-0123456789abcdef-EXACT",
  workerId: "worker-fixture-1",
  method: "POST",
  path: "/api/internal/career-site/linkedin/worker/claim",
  timestamp: 1_787_980_800,
  nonce: "2f4fdc89-7607-4fd0-8267-c52e89a6d1fd",
  rawBody:
    '{"workerId":"worker-fixture-1","capabilities":["interactive_auth","jobs_read"]}',
});

test("matches the frozen ClawPilot HMAC fixture exactly", () => {
  assert.equal(
    sha256Hex(fixture.rawBody),
    "5e56217bd77e52ed7cf60f275de79c1fdaad8d6b34f3d5bfad313b5becaabe78",
  );
  const headers = signInternalRequest(fixture);
  assert.equal(
    headers["x-clawpilot-linkedin-signature"],
    "7200746731d2be408f0412941a77e10dcac7b2814607c3bcf20e4779b5a77c15",
  );
  assert.equal(headers["x-clawpilot-linkedin-timestamp"], "1787980800");
  assert.equal(headers["x-clawpilot-linkedin-nonce"], fixture.nonce);
  assert.equal(headers["x-clawpilot-linkedin-worker-id"], fixture.workerId);
});

test("requires bearer, HMAC, worker id, freshness, and a single-use nonce", () => {
  const headers = signInternalRequest(fixture);
  const nonceStore = new ReplayNonceStore();
  const input = {
    headers,
    bearerToken: fixture.bearerToken,
    hmacSecret: fixture.hmacSecret,
    workerId: fixture.workerId,
    method: fixture.method,
    path: fixture.path,
    rawBody: fixture.rawBody,
    nonceStore,
    now: fixture.timestamp,
  };
  assert.deepEqual(verifyInternalRequest(input), { ok: true });
  assert.deepEqual(verifyInternalRequest(input), { ok: false, code: "replayed_nonce" });
});
