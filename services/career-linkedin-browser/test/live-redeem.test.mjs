import assert from "node:assert/strict";
import test from "node:test";
import { redeemLiveToken } from "../src/live-redeem.mjs";

function response(status, error = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return error ? { error } : { ok: true };
    },
  };
}

test("keeps a preimage only in memory while retrying activation beyond the old 15-second window", async () => {
  let now = 0;
  let attempts = 0;
  const token = "delayed-private-preimage";
  const result = await redeemLiveToken({
    token,
    now: () => now,
    retryMs: 1_000,
    maxWaitMs: 60_000,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    fetchImpl: async (_url, init) => {
      attempts += 1;
      assert.deepEqual(JSON.parse(init.body), { token });
      return attempts < 20
        ? response(409, "handoff_not_ready_or_expired")
        : response(200);
    },
  });
  assert.equal(attempts, 20);
  assert.deepEqual(result, { ok: true, status: 200, error: null });
});

test("does not retry a control-plane-rejected duplicate redemption", async () => {
  let attempts = 0;
  const result = await redeemLiveToken({
    token: "already-redeemed-private-preimage",
    fetchImpl: async () => {
      attempts += 1;
      return response(409, "link_already_redeemed_or_expired");
    },
  });
  assert.equal(attempts, 1);
  assert.deepEqual(result, {
    ok: false,
    status: 409,
    error: "link_already_redeemed_or_expired",
  });
});

test("retains and retries the preimage across transient control-plane unavailability", async () => {
  let now = 0;
  let attempts = 0;
  const token = "transient-control-private-preimage";
  const result = await redeemLiveToken({
    token,
    now: () => now,
    retryMs: 1_000,
    maxWaitMs: 10_000,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    fetchImpl: async (_url, init) => {
      attempts += 1;
      assert.deepEqual(JSON.parse(init.body), { token });
      return attempts === 1
        ? response(503, "handoff_temporarily_unavailable")
        : response(200);
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(result, { ok: true, status: 200, error: null });
});
