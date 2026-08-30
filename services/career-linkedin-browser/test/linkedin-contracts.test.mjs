import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLinkedInJobsSearchUrl,
  deduplicateJobs,
  extractLinkedInJobId,
  normalizeJobCandidate,
} from "../src/linkedin-jobs.mjs";
import { classifyLinkedInState, publicAuthEvidence } from "../src/linkedin-state.mjs";
import {
  buildReport,
  liveTokenRedeemedEvidence,
  mapAuthState,
  pageStateEvidence,
} from "../src/report-contract.mjs";
import {
  buildBoundedQueryPairs,
  validateClaim,
  WorkerPoller,
} from "../src/worker-poller.mjs";

const ownerId = "owner-fixture";
const future = new Date(Date.now() + 60_000).toISOString();
const baseClaim = Object.freeze({
  leaseId: "lease-fixture-0001",
  leaseToken: "lease-token-fixture-000000000000",
  expiresAt: future,
  authExpiresAt: null,
  command: "scan",
  ownerId,
  attemptId: null,
  scanId: "scan-fixture-0001",
  authTokenDigest: null,
  authTokenRedeemedAt: null,
  authTokenAdoptionRequired: false,
  encryptedSessionEnvelope: null,
  transientSessionDataKey: Buffer.alloc(32, 7).toString("base64url"),
  scan: {
    scope: "jobs",
    maximum: 10,
    filters: {
      keywords: ["operations", "supply chain"],
      locations: ["New York", "New Jersey"],
      minimumSalary: 180000,
    },
  },
  returnUrl: null,
});

test("accepts only the canonical flat claim and bounds query pairs deterministically", () => {
  assert.equal(validateClaim({ ...baseClaim }, ownerId).command, "scan");
  assert.throws(() => validateClaim({ ...baseClaim, type: "scan" }, ownerId), /unknown_claim_field/);
  assert.throws(
    () =>
      validateClaim(
        {
          ...baseClaim,
          scan: {
            ...baseClaim.scan,
            filters: { ...baseClaim.scan.filters, minimumSalary: 2_000_001 },
          },
        },
        ownerId,
      ),
    /invalid_scan_minimum_salary/,
  );
  assert.throws(
    () =>
      validateClaim(
        {
          ...baseClaim,
          scan: {
            ...baseClaim.scan,
            filters: { ...baseClaim.scan.filters, keywords: ["x".repeat(101)] },
          },
        },
        ownerId,
      ),
    /invalid_scan_keywords/,
  );
  assert.deepEqual(buildBoundedQueryPairs(baseClaim.scan.filters, 3), [
    { keywords: "operations", location: "New York" },
    { keywords: "operations", location: "New Jersey" },
    { keywords: "supply chain", location: "New York" },
  ]);
});

test("requires the exact Career return URL and the independent auth expiry", () => {
  const attemptId = "attempt-fixture-0001";
  const connectClaim = {
    ...baseClaim,
    command: "connect",
    authExpiresAt: future,
    attemptId,
    scanId: null,
    authTokenDigest: "a".repeat(64),
    scan: null,
    returnUrl:
      `https://jarrett.suburbiasandwichco.com/career/linkedin/return?attemptId=${attemptId}&destination=settings`,
  };
  assert.equal(validateClaim(connectClaim, ownerId).authExpiresAt, future);
  assert.throws(
    () => validateClaim({ ...connectClaim, authTokenAdoptionRequired: true }, ownerId),
    /invalid_auth_claim/,
  );
  assert.equal(validateClaim({
    ...connectClaim,
    authTokenRedeemedAt: future,
    authTokenAdoptionRequired: true,
  }, ownerId).authTokenAdoptionRequired, true);
  assert.throws(
    () =>
      validateClaim(
        { ...connectClaim, returnUrl: `${connectClaim.returnUrl}&extra=1` },
        ownerId,
      ),
    /invalid_return_url/,
  );
  assert.throws(
    () => validateClaim({ ...connectClaim, authExpiresAt: null }, ownerId),
    /invalid_auth_claim/,
  );
});

test("supports both LinkedIn job URL shapes and refuses non-LinkedIn URLs", () => {
  assert.equal(extractLinkedInJobId("https://www.linkedin.com/jobs/view/123456789/"), "123456789");
  assert.equal(
    extractLinkedInJobId(
      "https://www.linkedin.com/jobs/search-results/?keywords=ops&currentJobId=987654321",
    ),
    "987654321",
  );
  assert.equal(extractLinkedInJobId("https://example.com/jobs/view/123456789"), null);
  assert.match(buildLinkedInJobsSearchUrl({ query: { keywords: "operations" } }), /jobs\/search/);
});

test("emits only complete job rows with Career-compatible caps and nullability", () => {
  const normalized = normalizeJobCandidate({
    externalId: "123456789",
    title: "T".repeat(300),
    company: "C".repeat(300),
    location: "",
    description: "A substantive job description with more than forty characters for testing.",
    salaryText: "",
  });
  assert.equal(normalized.title.length, 240);
  assert.equal(normalized.company.length, 240);
  assert.equal(normalized.location, null);
  assert.equal(normalized.salaryText, null);
  assert.equal(normalized.postedAt, null);
  assert.equal(
    normalizeJobCandidate({
      externalId: "123",
      title: "Incomplete",
      company: "Example",
      description: "Too short",
    }),
    null,
  );
  assert.equal(deduplicateJobs([normalized, normalized], 50).length, 1);
});

test("classifies login, MFA, checkpoint, authenticated, and restricted without bypass", () => {
  const common = { title: "", visibleText: "", selectorSignals: {}, hasSessionCookie: false };
  assert.equal(
    classifyLinkedInState({ ...common, url: "https://www.linkedin.com/login" }),
    "login_required",
  );
  assert.equal(
    classifyLinkedInState({ ...common, url: "https://www.linkedin.com/checkpoint/", visibleText: "Enter the code we sent" }),
    "mfa_required",
  );
  assert.equal(
    classifyLinkedInState({ ...common, url: "https://www.linkedin.com/checkpoint/challenge/" }),
    "checkpoint_required",
  );
  assert.equal(
    classifyLinkedInState({ ...common, url: "https://www.linkedin.com/feed/", hasSessionCookie: true }),
    "authenticated",
  );
  assert.equal(
    classifyLinkedInState({ ...common, url: "https://www.linkedin.com/feed/", visibleText: "Your account has been restricted" }),
    "restricted",
  );
  assert.deepEqual(Object.keys(publicAuthEvidence({})).sort(), [
    "capturedAt",
    "event",
    "memberName",
    "profileUrl",
    "sessionExpiresAt",
  ]);
});

test("reports a restricted scan as terminal instead of awaiting authentication", async () => {
  const reports = [];
  const poller = new WorkerPoller({
    config: { ownerId, authTimeoutMs: 60_000, authPollIntervalMs: 1_000 },
    controlPlane: {
      async report(report) {
        reports.push(report);
        return { kind: "scan" };
      },
    },
    browserSession: {
      sessionId: "session-fixture",
      async open() {},
      async close() {},
      async prepareAuthentication() {
        return { state: "restricted", evidence: publicAuthEvidence({}) };
      },
    },
    tokenStore: {
      clear() {},
      getOutcome() { return null; },
      revokeAttempt() {},
    },
  });

  await poller.execute({ ...baseClaim });

  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, "restricted");
  assert.equal(reports[0].errorCode, "restricted");
  assert.equal(reports[0].authState.kind, "none");
});

test("builds exact control-plane report shapes for every lifecycle outcome", () => {
  const reportClaim = { leaseId: baseClaim.leaseId, leaseToken: baseClaim.leaseToken };
  const pageEvidence = publicAuthEvidence({});
  const variants = [
    buildReport(reportClaim, { status: "awaiting_auth", authState: mapAuthState("login_required"), evidence: pageEvidence }),
    buildReport(reportClaim, { status: "running", authState: mapAuthState("authenticated"), evidence: liveTokenRedeemedEvidence(null) }),
    buildReport(reportClaim, { status: "succeeded", authState: mapAuthState("authenticated"), encryptedSessionEnvelope: { version: 1 }, evidence: pageEvidence }),
    buildReport(reportClaim, { status: "succeeded", authState: mapAuthState("authenticated"), jobs: [], evidence: pageEvidence }),
    buildReport(reportClaim, { status: "failed", authState: mapAuthState("checkpoint_required"), errorCode: "checkpoint_required", errorMessage: "Authentication required.", evidence: pageEvidence }),
  ];
  const expectedKeys = [
    "authState",
    "encryptedSessionEnvelope",
    "errorCode",
    "errorMessage",
    "evidence",
    "jobs",
    "leaseId",
    "leaseToken",
    "status",
  ];
  for (const report of variants) assert.deepEqual(Object.keys(report).sort(), expectedKeys);
  for (const report of variants) assert.ok(Array.isArray(report.jobs));
});

test("page-state evidence propagates only bounded LinkedIn identity evidence", () => {
  const evidence = pageStateEvidence({
    evidence: {
      capturedAt: future,
      memberName: `  Jarrett ${"X".repeat(300)}  `,
      profileUrl:
        "https://www.linkedin.com/in/jarrett/details/experience/?tracking=removed#fragment",
      sessionExpiresAt: future,
    },
  });
  assert.equal(evidence.memberName.length, 200);
  assert.equal(evidence.profileUrl, "https://www.linkedin.com/in/jarrett/");
  assert.equal(evidence.sessionExpiresAt, future);
});
