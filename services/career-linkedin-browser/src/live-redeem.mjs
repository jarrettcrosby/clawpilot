const DEFAULT_MAX_WAIT_MS = 15 * 60_000;
const DEFAULT_RETRY_MS = 1_000;

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function redeemLiveToken({
  token,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = pause,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  retryMs = DEFAULT_RETRY_MS,
}) {
  if (typeof token !== "string" || !token) {
    return { ok: false, status: 0, error: "missing_token" };
  }
  const deadline = now() + maxWaitMs;
  do {
    let response;
    try {
      response = await fetchImpl("/v1/live/redeem", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        redirect: "error",
      });
    } catch {
      if (now() >= deadline) {
        return { ok: false, status: 0, error: "handoff_timeout" };
      }
      await sleep(Math.min(retryMs, Math.max(0, deadline - now())));
      continue;
    }
    if (response.ok) return { ok: true, status: response.status, error: null };

    const payload = await response.json().catch(() => null);
    const retryable =
      (response.status === 409 && payload?.error === "handoff_not_ready_or_expired") ||
      (response.status === 503 && payload?.error === "handoff_temporarily_unavailable");
    if (!retryable) {
      return {
        ok: false,
        status: response.status,
        error: typeof payload?.error === "string" ? payload.error : "redemption_failed",
      };
    }
    if (now() >= deadline) {
      return { ok: false, status: response.status, error: "handoff_timeout" };
    }
    await sleep(Math.min(retryMs, Math.max(0, deadline - now())));
  } while (now() < deadline);

  return { ok: false, status: 409, error: "handoff_timeout" };
}
