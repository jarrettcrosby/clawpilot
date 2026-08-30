import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { LinkedInBrowserSession } from "../src/browser-session.mjs";
import { ControlPlaneClient } from "../src/control-plane-client.mjs";
import { LiveTokenStore } from "../src/live-token-store.mjs";
import {
  WorkerPoller,
  interleaveAndDeduplicatePairJobs,
} from "../src/worker-poller.mjs";

const cookieSecret = "cookie-secret-fixture-0123456789abcdef-EXACT";

function pageState() {
  return {
    state: "authenticated",
    evidence: {
      event: "page_state",
      capturedAt: new Date().toISOString(),
      memberName: "Jarrett",
      profileUrl: "https://www.linkedin.com/in/jarrett/",
      sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
}

function job(externalId, title = `Role ${externalId}`) {
  return {
    externalId,
    url: `https://www.linkedin.com/jobs/view/${externalId}/`,
    title,
    company: "Example Company",
    location: "New York",
    description: "A complete and substantive role description that safely exceeds forty characters.",
    salaryText: null,
    postedAt: null,
  };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition_not_met");
}

function recoveredAuthClaim({ attemptId, ownerId }) {
  return {
    leaseId: `lease-${attemptId}`,
    leaseToken: `lease-token-${attemptId}-000000000000`,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    authExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    command: "reauthenticate",
    ownerId,
    attemptId,
    scanId: null,
    authTokenDigest: createHash("sha256").update("T".repeat(43)).digest("hex"),
    authTokenRedeemedAt: new Date(Date.now() - 1_000).toISOString(),
    authTokenAdoptionRequired: false,
    encryptedSessionEnvelope: { version: 1 },
    transientSessionDataKey: Buffer.alloc(32, 4).toString("base64url"),
    scan: null,
    returnUrl:
      `https://jarrett.suburbiasandwichco.com/career/linkedin/return?attemptId=${attemptId}&destination=settings`,
  };
}

function recoveredBrowserSession() {
  return {
    sessionId: null,
    async open() { this.sessionId = "browser-session-recovered"; },
    async prepareAuthentication() { return pageState(); },
    async detectAuthState() { return pageState(); },
    async exportEncryptedState() {
      return { version: 1, algorithm: "A256GCM", iv: "iv", ciphertext: "ct", tag: "tag" };
    },
    async close() { this.sessionId = null; },
  };
}

test("connect with a restored authenticated session cannot succeed before accepted redemption", async () => {
  const preimage = "D".repeat(43);
  const attemptId = "attempt-p1-0001";
  const reports = [];
  let releaseStateInspection;
  const stateInspectionGate = new Promise((resolve) => {
    releaseStateInspection = resolve;
  });
  const controlPlane = {
    async report(report) {
      reports.push(report);
      return { kind: "recorded" };
    },
  };
  const browserSession = {
    sessionId: null,
    async open() {
      this.sessionId = "browser-session-1";
    },
    async prepareAuthentication() {
      await stateInspectionGate;
      return pageState();
    },
    async detectAuthState() {
      return pageState();
    },
    async exportEncryptedState() {
      return { version: 1, algorithm: "A256GCM", iv: "iv", ciphertext: "ct", tag: "tag" };
    },
    async close() {
      this.sessionId = null;
    },
  };
  const tokenStore = new LiveTokenStore({ hmacSecret: cookieSecret });
  const config = {
    ownerId: "owner-fixture",
    workerId: "worker-fixture",
    authPollIntervalMs: 5,
    authTimeoutMs: 15 * 60_000,
  };
  const poller = new WorkerPoller({ config, controlPlane, browserSession, tokenStore });
  const claim = {
    leaseId: "lease-p1-0001",
    leaseToken: "lease-token-p1-000000000000",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    authExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    command: "connect",
    ownerId: config.ownerId,
    attemptId,
    scanId: null,
    authTokenDigest: createHash("sha256").update(preimage).digest("hex"),
    authTokenRedeemedAt: null,
    authTokenAdoptionRequired: false,
    encryptedSessionEnvelope: { version: 1 },
    transientSessionDataKey: Buffer.alloc(32, 9).toString("base64url"),
    scan: null,
    returnUrl:
      `https://jarrett.suburbiasandwichco.com/career/linkedin/return?attemptId=${attemptId}&destination=settings`,
  };

  let completed = false;
  const execution = poller.execute({ ...claim }).then(() => {
    completed = true;
  });
  // The handoff must be redeemable before potentially slow restored-state
  // inspection or LinkedIn navigation completes.
  await waitFor(() => Boolean(tokenStore.matchToken(preimage)));
  releaseStateInspection();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(completed, false);
  assert.equal(reports.some((report) => report.status === "succeeded"), false);

  const match = tokenStore.matchToken(preimage);
  assert.deepEqual(await poller.redeemLiveToken(match), { kind: "accepted" });
  assert.ok(tokenStore.issueCookieAfterAcceptedRedemption(attemptId));
  await execution;
  assert.equal(completed, true);
  assert.equal(reports.some((report) => report.status === "succeeded"), true);
});

test("redemption distinguishes accepted, authoritative conflict, and retryable failure", async () => {
  let outcome = "accepted";
  const poller = new WorkerPoller({
    config: {},
    controlPlane: {
      async report() {
        if (outcome === "accepted") return { kind: "auth" };
        throw new Error(`control_plane_report_${outcome === "conflict" ? 409 : 503}`);
      },
    },
    browserSession: {},
    tokenStore: {},
  });
  poller.activeClaim = {
    attemptId: "attempt-redemption-result",
    leaseId: "lease-redemption-result",
    leaseToken: "lease-token-redemption-result-0000",
  };
  const match = { attemptId: poller.activeClaim.attemptId };
  assert.deepEqual(await poller.redeemLiveToken(match), { kind: "accepted" });
  outcome = "retryable";
  assert.deepEqual(await poller.redeemLiveToken(match), { kind: "retryable" });
  outcome = "conflict";
  assert.deepEqual(await poller.redeemLiveToken(match), { kind: "conflict" });
  assert.deepEqual(
    await poller.redeemLiveToken({ attemptId: "stale-attempt" }),
    { kind: "conflict" },
  );
});

test("page-level redemption retry preserves exact report bytes after client ambiguity", async () => {
  const serializedReports = [];
  const poller = new WorkerPoller({
    config: {},
    controlPlane: {
      async report(report) {
        serializedReports.push(JSON.stringify(report));
        if (serializedReports.length === 1) {
          const error = new Error("control_plane_report_ambiguous");
          error.code = "control_plane_report_ambiguous";
          throw error;
        }
        return { kind: "auth" };
      },
    },
    browserSession: {},
    tokenStore: {},
  });
  poller.activeClaim = {
    attemptId: "attempt-exact-redemption-retry",
    leaseId: "lease-exact-redemption-retry",
    leaseToken: "lease-token-exact-redemption-retry-0000",
  };
  const match = { attemptId: poller.activeClaim.attemptId };
  assert.deepEqual(await poller.redeemLiveToken(match), { kind: "retryable" });
  assert.deepEqual(await poller.redeemLiveToken(match), { kind: "accepted" });
  assert.equal(serializedReports.length, 2);
  assert.equal(serializedReports[0], serializedReports[1]);
});

test("restored authenticated state closes VNC before the initial awaiting report settles", async () => {
  const ownerId = "owner-initial-vnc-close";
  const attemptId = "attempt-initial-vnc-close";
  const claim = recoveredAuthClaim({ attemptId, ownerId });
  const tokenStore = new LiveTokenStore({ hmacSecret: cookieSecret });
  const events = [];
  tokenStore.onVncRevoked(() => events.push("vnc_closed"));
  let releaseAwaitingReport;
  const awaitingReportGate = new Promise((resolve) => {
    releaseAwaitingReport = resolve;
  });
  let awaitingReportStarted;
  const awaitingReportSeen = new Promise((resolve) => {
    awaitingReportStarted = resolve;
  });
  const poller = new WorkerPoller({
    config: { ownerId, authPollIntervalMs: 1, authTimeoutMs: 60_000 },
    controlPlane: {
      async report(report) {
        if (report.status === "awaiting_auth") {
          events.push("awaiting_report_started");
          awaitingReportStarted();
          await awaitingReportGate;
        }
        return { kind: "auth" };
      },
    },
    browserSession: recoveredBrowserSession(),
    tokenStore,
  });

  const execution = poller.execute(claim);
  await awaitingReportSeen;
  assert.deepEqual(events.slice(0, 2), ["vnc_closed", "awaiting_report_started"]);
  releaseAwaitingReport();
  await execution;
});

test("authentication reached while the initial report hangs also fences VNC", async () => {
  const ownerId = "owner-racing-vnc-close";
  const attemptId = "attempt-racing-vnc-close";
  const claim = recoveredAuthClaim({ attemptId, ownerId });
  const tokenStore = new LiveTokenStore({ hmacSecret: cookieSecret });
  let vncClosed = false;
  tokenStore.onVncRevoked(() => {
    vncClosed = true;
  });
  let releaseAwaitingReport;
  const awaitingReportGate = new Promise((resolve) => {
    releaseAwaitingReport = resolve;
  });
  let awaitingReportStarted;
  const awaitingReportSeen = new Promise((resolve) => {
    awaitingReportStarted = resolve;
  });
  const browserSession = recoveredBrowserSession();
  browserSession.prepareAuthentication = async () => ({
    state: "login_required",
    evidence: pageState().evidence,
  });
  const poller = new WorkerPoller({
    config: { ownerId, authPollIntervalMs: 1, authTimeoutMs: 60_000 },
    controlPlane: {
      async report(report) {
        if (report.status === "awaiting_auth") {
          awaitingReportStarted();
          await awaitingReportGate;
        }
        return { kind: "auth" };
      },
    },
    browserSession,
    tokenStore,
  });

  const execution = poller.execute(claim);
  await awaitingReportSeen;
  await waitFor(() => vncClosed);
  assert.equal(vncClosed, true);
  releaseAwaitingReport();
  await execution;
});

test("authenticated detection closes VNC before a hanging report or session export", async () => {
  const ownerId = "owner-vnc-close";
  const attemptId = "attempt-vnc-close";
  const claim = recoveredAuthClaim({ attemptId, ownerId });
  const tokenStore = new LiveTokenStore({ hmacSecret: cookieSecret });
  const preCrashStore = new LiveTokenStore({ hmacSecret: cookieSecret });
  preCrashStore.activate({
    sessionId: "session-before-close",
    attemptId,
    authTokenDigest: claim.authTokenDigest,
    expiresAt: claim.authExpiresAt,
  });
  const existingCookie = preCrashStore.issueCookieAfterAcceptedRedemption(attemptId).cookie;
  const events = [];
  tokenStore.onVncRevoked(() => events.push("vnc_closed"));
  let releaseRunningReport;
  const runningReportGate = new Promise((resolve) => {
    releaseRunningReport = resolve;
  });
  let runningReportStarted;
  const runningReportSeen = new Promise((resolve) => {
    runningReportStarted = resolve;
  });
  const poller = new WorkerPoller({
    config: { ownerId, authPollIntervalMs: 1, authTimeoutMs: 60_000 },
    controlPlane: {
      async report(report) {
        if (report.status === "running") {
          events.push("running_report_started");
          runningReportStarted();
          await runningReportGate;
        }
        return { kind: "auth" };
      },
    },
    browserSession: recoveredBrowserSession(),
    tokenStore,
  });

  const execution = poller.execute(claim);
  await runningReportSeen;
  assert.deepEqual(events.slice(0, 2), ["vnc_closed", "running_report_started"]);
  assert.equal(tokenStore.authorizeCookieForVnc(existingCookie), null);
  assert.equal(tokenStore.authorizeCookieForOutcome(existingCookie).attemptId, attemptId);
  releaseRunningReport();
  await execution;
});

test("committed terminal success response loss retries before setting local outcome", async () => {
  const ownerId = "owner-terminal-retry";
  const attemptId = "attempt-terminal-retry";
  const claim = recoveredAuthClaim({ attemptId, ownerId });
  let succeededRequests = 0;
  const controlPlane = new ControlPlaneClient({
    controlPlaneBaseUrl: "https://control.example.com",
    bearerToken: "worker-token-0123456789abcdef-123456",
    hmacSecret: "hmac-secret-0123456789abcdef-12345678",
    workerId: "worker-terminal-retry",
    requestTimeoutMs: 5_000,
  }, {
    reportRetryDelaysMs: [0, 0],
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      const report = JSON.parse(init.body);
      if (report.status === "succeeded") {
        succeededRequests += 1;
        if (succeededRequests === 1) {
          throw new TypeError("response_lost_after_terminal_commit");
        }
      }
      return new Response(JSON.stringify({
        ok: true,
        result: { kind: "auth", authAttempt: { status: report.status } },
      }), { status: 200 });
    },
  });
  const tokenStore = new LiveTokenStore({ hmacSecret: cookieSecret });
  const poller = new WorkerPoller({
    config: { ownerId, authPollIntervalMs: 1, authTimeoutMs: 60_000 },
    controlPlane,
    browserSession: recoveredBrowserSession(),
    tokenStore,
  });

  await poller.execute(claim);
  assert.equal(succeededRequests, 2);
  assert.equal(tokenStore.getOutcome(attemptId).status, "succeeded");
});

test("exhausted terminal report ambiguity returns to Career without reporting failed", async () => {
  const ownerId = "owner-terminal-ambiguous";
  const attemptId = "attempt-terminal-ambiguous";
  const claim = recoveredAuthClaim({ attemptId, ownerId });
  const reports = [];
  const tokenStore = new LiveTokenStore({ hmacSecret: cookieSecret });
  const poller = new WorkerPoller({
    config: { ownerId, authPollIntervalMs: 1, authTimeoutMs: 60_000 },
    controlPlane: {
      async report(report) {
        reports.push(report);
        if (report.status === "succeeded") {
          const error = new Error("control_plane_report_ambiguous");
          error.code = "control_plane_report_ambiguous";
          throw error;
        }
        return { kind: "auth" };
      },
    },
    browserSession: recoveredBrowserSession(),
    tokenStore,
  });

  await poller.execute(claim);
  assert.equal(reports.some((report) => report.status === "failed"), false);
  assert.deepEqual(tokenStore.getOutcome(attemptId), {
    status: "confirming",
    returnUrl: claim.returnUrl,
  });
});

test("fair scan scheduling runs every bounded pair and round-robins globally", async () => {
  const calls = [];
  let pairNumber = 0;
  const browserSession = {
    async scanJobs({ query, maxResults, onProgress }) {
      calls.push({ query, maxResults });
      await onProgress({ phase: "search_navigation_complete" });
      const base = 10000 + pairNumber * 10;
      pairNumber += 1;
      return { jobs: [job(String(base)), job(String(base + 1))] };
    },
  };
  const reports = [];
  const poller = new WorkerPoller({
    config: {
      scanHeartbeatMs: 30_000,
      scanMaxDurationMs: 720_000,
      scanLeaseSafetyMs: 240_000,
    },
    controlPlane: { report: async (report) => reports.push(report) },
    browserSession,
    tokenStore: {},
  });
  const claim = {
    leaseId: "lease-scan-1",
    leaseToken: "lease-token-scan-0000000000",
    scan: {
      maximum: 5,
      filters: {
        keywords: ["operations", "warehouse"],
        locations: ["New York", "New Jersey"],
      },
    },
  };
  const result = await poller.runScan(claim, pageState());
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.maxResults), [2, 2, 2, 2]);
  assert.deepEqual(result.jobs.map((entry) => entry.externalId), [
    "10000",
    "10010",
    "10020",
    "10030",
    "10001",
  ]);
  assert.equal(reports.length, 3);
});

test("scan latency triggers a running lease heartbeat before completion", async () => {
  let now = 1_000_000;
  const reports = [];
  const poller = new WorkerPoller({
    config: {
      scanHeartbeatMs: 30_000,
      scanMaxDurationMs: 120_000,
      scanLeaseSafetyMs: 240_000,
    },
    controlPlane: { report: async (report) => reports.push(report) },
    browserSession: {
      async scanJobs({ onProgress }) {
        now += 31_000;
        await onProgress({ phase: "job_complete" });
        return { jobs: [job("55555")] };
      },
    },
    tokenStore: {},
    now: () => now,
  });
  const result = await poller.runScan(
    {
      leaseId: "lease-heartbeat-1",
      leaseToken: "lease-token-heartbeat-0000000",
      scan: {
        maximum: 1,
        filters: { keywords: ["operations"], locations: ["New York"] },
      },
    },
    pageState(),
  );
  assert.equal(result.jobs.length, 1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, "running");
});

test("job discovery accepts scoped results and verified empty state but rejects ambiguous zero", async () => {
  function fakePage({ scopedHrefs = [], fallbackHrefs = [], empty = false }) {
    const selectors = [];
    return {
      selectors,
      url: () => "https://www.linkedin.com/jobs/search/?keywords=operations",
      locator(selector) {
        selectors.push(selector);
        return {
          async evaluateAll() {
            if (selector.includes("jobs-search-results-list")) return scopedHrefs;
            if (selector.startsWith("main")) return fallbackHrefs;
            return [];
          },
          async count() {
            return selector.includes("jobs-search-no-results") && empty ? 1 : 0;
          },
        };
      },
      async evaluate() {},
      async waitForTimeout() {},
    };
  }

  const session = new LinkedInBrowserSession({});
  session.page = fakePage({
    scopedHrefs: ["https://www.linkedin.com/jobs/view/12345/"],
    fallbackHrefs: ["https://www.linkedin.com/jobs/view/99999/"],
  });
  const scoped = await session.discoverJobIds(10);
  assert.deepEqual(scoped.ids, ["12345"]);
  assert.equal(session.page.selectors.some((selector) => selector.startsWith("main")), false);

  session.page = fakePage({ empty: true });
  const empty = await session.discoverJobIds(10);
  assert.deepEqual(empty.ids, []);
  assert.equal(empty.emptyStateSeen, true);

  session.page = fakePage({});
  await assert.rejects(
    () => session.discoverJobIds(10),
    (error) => error.code === "extraction_incomplete",
  );
});

test("scan fails safely when discovered detail pages produce no valid jobs", async () => {
  const session = new LinkedInBrowserSession({
    maxScanResults: 50,
    navigationTimeoutMs: 1_000,
  });
  session.context = {
    async route() {},
    async unroute() {},
  };
  session.page = { async goto() {} };
  session.detectAuthState = async () => pageState();
  session.discoverJobIds = async () => ({
    ids: ["12345", "23456"],
    scopedCount: 2,
    fallbackCount: 0,
    emptyStateSeen: false,
  });
  session.readCurrentJob = async (externalId) => ({
    externalId,
    title: "",
    company: "Example Company",
    location: null,
    description: "blocked",
    salaryText: null,
    postedAt: null,
  });

  await assert.rejects(
    () => session.scanJobs({
      query: { keywords: "operations", location: "New York" },
      maxResults: 2,
    }),
    (error) => {
      assert.equal(error.code, "extraction_incomplete");
      assert.deepEqual(error.diagnostics, {
        discoveredCount: 2,
        candidateCount: 2,
        validCount: 0,
        missingTitleCount: 2,
        missingCompanyCount: 0,
        shortDescriptionCount: 2,
      });
      assert.equal(JSON.stringify(error.diagnostics).includes("blocked"), false);
      return true;
    },
  );
});

test("round-robin helper globally deduplicates without favoring the first pair", () => {
  assert.deepEqual(
    interleaveAndDeduplicatePairJobs(
      [[job("11111"), job("22222")], [job("11111"), job("33333")]],
      3,
    ).map((entry) => entry.externalId),
    ["11111", "22222", "33333"],
  );
});
