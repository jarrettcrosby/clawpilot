import { setTimeout as delay } from "node:timers/promises";
import { BrowserStateError } from "./browser-session.mjs";
import { deduplicateJobs } from "./linkedin-jobs.mjs";
import {
  buildReport,
  liveTokenRedeemedEvidence,
  mapAuthState,
  pageStateEvidence,
} from "./report-contract.mjs";

const CLAIM_KEYS = new Set([
  "leaseId",
  "leaseToken",
  "expiresAt",
  "authExpiresAt",
  "command",
  "ownerId",
  "attemptId",
  "scanId",
  "authTokenDigest",
  "authTokenRedeemedAt",
  "authTokenAdoptionRequired",
  "encryptedSessionEnvelope",
  "transientSessionDataKey",
  "scan",
  "returnUrl",
]);
const COMMANDS = new Set(["connect", "reauthenticate", "scan", "disconnect"]);
const TERMINAL_AUTH_STATES = new Set(["restricted"]);

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isNullableObject(value) {
  return value === null || (typeof value === "object" && !Array.isArray(value));
}

function validateStringArray(value, field) {
  if (!Array.isArray(value) || value.length > 10) throw new Error(`invalid_${field}`);
  for (const item of value) {
    if (typeof item !== "string" || item.length > 100) throw new Error(`invalid_${field}`);
  }
}

function validateReturnUrl(value, command, attemptId) {
  if (command === "scan" || command === "disconnect") {
    if (value !== null) throw new Error("unexpected_return_url");
    return;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_return_url");
  }
  if (
    url.origin !== "https://jarrett.suburbiasandwichco.com" ||
    url.pathname !== "/career/linkedin/return" ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll("attemptId").length !== 1 ||
    url.searchParams.get("attemptId") !== attemptId ||
    url.searchParams.getAll("destination").length !== 1 ||
    !["overview", "agents", "settings"].includes(url.searchParams.get("destination")) ||
    [...url.searchParams.keys()].some(
      (key) => !["attemptId", "destination"].includes(key),
    )
  ) throw new Error("invalid_return_url");
}

export function validateClaim(value, expectedOwnerId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_claim");
  }
  for (const key of Object.keys(value)) {
    if (!CLAIM_KEYS.has(key)) throw new Error("unknown_claim_field");
  }
  if (
    typeof value.leaseId !== "string" ||
    value.leaseId.length < 8 ||
    typeof value.leaseToken !== "string" ||
    value.leaseToken.length < 16 ||
    !COMMANDS.has(value.command) ||
    value.ownerId !== expectedOwnerId ||
    !isNullableString(value.attemptId) ||
    !isNullableString(value.scanId) ||
    !isNullableString(value.authTokenDigest) ||
    !isNullableString(value.authTokenRedeemedAt) ||
    typeof value.authTokenAdoptionRequired !== "boolean" ||
    !isNullableString(value.authExpiresAt) ||
    !isNullableString(value.transientSessionDataKey) ||
    !isNullableString(value.returnUrl) ||
    !isNullableObject(value.encryptedSessionEnvelope)
  ) {
    throw new Error("invalid_claim");
  }
  validateReturnUrl(value.returnUrl, value.command, value.attemptId);
  const expiresAtMs = new Date(value.expiresAt).valueOf();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error("expired_claim");
  }
  if (["connect", "reauthenticate"].includes(value.command)) {
    const authExpiresAtMs = new Date(value.authExpiresAt).valueOf();
    if (
      !value.attemptId ||
      !value.authTokenDigest ||
      !/^[a-f0-9]{64}$/i.test(value.authTokenDigest) ||
      !Number.isFinite(authExpiresAtMs) ||
      authExpiresAtMs <= Date.now()
    ) throw new Error("invalid_auth_claim");
    if (value.scanId !== null || value.scan !== null) throw new Error("invalid_auth_claim");
    if (
      value.authTokenRedeemedAt !== null &&
      Number.isNaN(new Date(value.authTokenRedeemedAt).valueOf())
    ) throw new Error("invalid_auth_claim");
    if (value.authTokenAdoptionRequired && value.authTokenRedeemedAt === null) {
      throw new Error("invalid_auth_claim");
    }
  } else if (
    value.authExpiresAt !== null ||
    value.authTokenDigest !== null ||
    value.authTokenRedeemedAt !== null ||
    value.authTokenAdoptionRequired !== false
  ) {
    throw new Error("unexpected_auth_claim");
  }
  if (value.command !== "disconnect" && !value.transientSessionDataKey) {
    throw new Error("missing_transient_session_key");
  }
  if (value.command === "scan") {
    if (
      !value.scan ||
      typeof value.scan !== "object" ||
      Array.isArray(value.scan) ||
      Object.keys(value.scan).some((key) => !["scope", "maximum", "filters"].includes(key)) ||
      value.scan.scope !== "jobs" ||
      !Number.isSafeInteger(value.scan.maximum) ||
      value.scan.maximum < 1 ||
      value.scan.maximum > 50 ||
      !value.scan.filters ||
      typeof value.scan.filters !== "object" ||
      Array.isArray(value.scan.filters) ||
      Object.keys(value.scan.filters).some(
        (key) => !["keywords", "locations", "minimumSalary"].includes(key),
      )
    ) throw new Error("invalid_scan_claim");
    if (value.attemptId !== null || !value.scanId) throw new Error("invalid_scan_claim");
    validateStringArray(value.scan.filters.keywords, "scan_keywords");
    validateStringArray(value.scan.filters.locations, "scan_locations");
    if (
      value.scan.filters.minimumSalary !== null &&
      (!Number.isSafeInteger(value.scan.filters.minimumSalary) ||
        value.scan.filters.minimumSalary < 0 ||
        value.scan.filters.minimumSalary > 2_000_000)
    ) throw new Error("invalid_scan_minimum_salary");
  } else if (value.scan !== null) {
    throw new Error("unexpected_scan_claim");
  }
  if (
    value.command === "disconnect" &&
    (value.attemptId !== null || value.scanId !== null || value.transientSessionDataKey !== null)
  ) throw new Error("invalid_disconnect_claim");
  return value;
}

export function buildBoundedQueryPairs(filters, maximumPairs = 10) {
  const keywords = filters.keywords.map((value) => value.trim()).filter(Boolean);
  const locations = filters.locations.map((value) => value.trim()).filter(Boolean);
  const keywordValues = keywords.length ? keywords : [""];
  const locationValues = locations.length ? locations : [""];
  const pairs = [];
  for (const keyword of keywordValues) {
    for (const location of locationValues) {
      pairs.push({ keywords: keyword, location });
      if (pairs.length >= maximumPairs) return pairs;
    }
  }
  return pairs;
}

function safeFailureCode(error) {
  const allowed = new Set([
    "auth_timeout",
    "checkpoint_required",
    "envelope_decryption_failed",
    "extraction_incomplete",
    "invalid_envelope",
    "login_required",
    "mfa_required",
    "restricted",
    "unauthenticated",
    "scan_lease_expired",
    "scan_timeout",
  ]);
  return allowed.has(error?.code || error?.message) ? error.code || error.message : "worker_failed";
}

function safeFailureMessage(code) {
  const messages = {
    auth_timeout: "The LinkedIn authentication window expired.",
    checkpoint_required: "LinkedIn requires an interactive account checkpoint.",
    envelope_decryption_failed: "The encrypted LinkedIn session could not be restored.",
    extraction_incomplete: "LinkedIn job results could not be verified for this scan.",
    invalid_envelope: "The encrypted LinkedIn session is invalid.",
    login_required: "LinkedIn authentication is required.",
    mfa_required: "LinkedIn multi-factor authentication is required.",
    restricted: "LinkedIn has restricted this account session; review it manually.",
    scan_lease_expired: "The LinkedIn scan lease could not be renewed safely.",
    scan_timeout: "The LinkedIn scan reached its bounded execution deadline.",
    unauthenticated: "LinkedIn authentication is required.",
    worker_failed: "The LinkedIn browser worker could not complete this command.",
  };
  return messages[code] || messages.worker_failed;
}

export function interleaveAndDeduplicatePairJobs(pairJobs, maximum) {
  const result = [];
  const seen = new Set();
  const longest = Math.max(0, ...pairJobs.map((jobs) => jobs.length));
  for (let index = 0; index < longest && result.length < maximum; index += 1) {
    for (const jobs of pairJobs) {
      const candidate = jobs[index];
      if (!candidate || seen.has(candidate.externalId)) continue;
      const normalized = deduplicateJobs([candidate], 1)[0];
      if (!normalized) continue;
      seen.add(normalized.externalId);
      result.push(normalized);
      if (result.length >= maximum) break;
    }
  }
  return result;
}

export class WorkerPoller {
  constructor({
    config,
    controlPlane,
    browserSession,
    tokenStore,
    onEvent = () => {},
    now = () => Date.now(),
  }) {
    this.config = config;
    this.controlPlane = controlPlane;
    this.browserSession = browserSession;
    this.tokenStore = tokenStore;
    this.onEvent = onEvent;
    this.now = now;
    this.activeClaim = null;
    this.activeAttemptId = null;
    this.activeRedemptionEvidence = null;
  }

  async redeemLiveToken(match) {
    const claim = this.activeClaim;
    if (!claim || match.attemptId !== claim.attemptId) return { kind: "conflict" };
    if (!this.activeRedemptionEvidence) {
      this.activeRedemptionEvidence = liveTokenRedeemedEvidence(null);
    }
    try {
      await this.controlPlane.report(buildReport(claim, {
        status: "running",
        authState: mapAuthState("authenticated"),
        evidence: this.activeRedemptionEvidence,
      }));
      return { kind: "accepted" };
    } catch (error) {
      return error?.message === "control_plane_report_409"
        ? { kind: "conflict" }
        : { kind: "retryable" };
    }
  }

  async report(claim, payload) {
    return this.controlPlane.report(buildReport(claim, payload));
  }

  async waitForAuthentication(claim, initialState) {
    let observedState = initialState;
    if (initialState.state === "authenticated") {
      // A restored authenticated page never needs interactive input. Fence VNC
      // before even the first lease report so report retries cannot extend a
      // write-capable window while token redemption completes in parallel.
      this.tokenStore.disableVncForAttempt(claim.attemptId);
    }
    const monitorAbort = new AbortController();
    let monitorError;
    const monitor = (async () => {
      while (!monitorAbort.signal.aborted) {
        const tickCompleted = await delay(
          this.config.authPollIntervalMs,
          true,
          { signal: monitorAbort.signal },
        ).catch(() => false);
        if (!tickCompleted || monitorAbort.signal.aborted) return;
        try {
          observedState = await this.browserSession.detectAuthState();
          if (observedState.state === "authenticated") {
            this.tokenStore.disableVncForAttempt(claim.attemptId);
          }
        } catch (error) {
          monitorError = error;
          return;
        }
      }
    })();
    try {
      await this.report(claim, {
        status: "awaiting_auth",
        authState: mapAuthState(initialState.state),
        evidence: pageStateEvidence(initialState),
      });
    } finally {
      monitorAbort.abort();
      await monitor;
    }
    if (monitorError) throw monitorError;
    if (
      observedState.state === "authenticated" &&
      this.tokenStore.isRedeemed(claim.attemptId)
    ) return observedState;

    const deadline = Math.min(
      Date.now() + this.config.authTimeoutMs,
      new Date(claim.authExpiresAt).valueOf(),
    );
    let priorState = observedState.state;
    let lastHeartbeat = Date.now();
    while (Date.now() < deadline) {
      await delay(this.config.authPollIntervalMs);
      const current = await this.browserSession.detectAuthState();
      if (current.state === "authenticated") {
        // Authentication ends the interactive capability immediately. Session
        // export and control-plane reports may retry, but the outcome cookie
        // can only poll while VNC input is synchronously revoked here.
        this.tokenStore.disableVncForAttempt(claim.attemptId);
        if (this.tokenStore.isRedeemed(claim.attemptId)) return current;
      }
      if (TERMINAL_AUTH_STATES.has(current.state)) {
        throw new BrowserStateError(current.state, current.evidence);
      }
      if (current.state !== priorState || Date.now() - lastHeartbeat >= 30_000) {
        await this.report(claim, {
          status: "awaiting_auth",
          authState: mapAuthState(current.state),
          evidence: pageStateEvidence(current),
        });
        priorState = current.state;
        lastHeartbeat = Date.now();
      }
    }
    const error = new Error("auth_timeout");
    error.code = "auth_timeout";
    throw error;
  }

  async ensureAuthenticated(claim) {
    if (!claim.attemptId || !claim.authTokenDigest) throw new Error("missing_auth_handoff");
    // Activate the handoff before reading or navigating LinkedIn. This makes a
    // just-opened phone link redeemable even when session-state inspection is
    // slow, and it ensures restored authenticated sessions still require the
    // control plane's accepted one-time redemption before they can succeed.
    this.activeAttemptId = claim.attemptId;
    this.tokenStore.activate({
      sessionId: this.browserSession.sessionId,
      attemptId: claim.attemptId,
      authTokenDigest: claim.authTokenDigest,
      authTokenRedeemedAt: claim.authTokenRedeemedAt,
      authTokenAdoptionRequired: claim.authTokenAdoptionRequired,
      expiresAt: claim.authExpiresAt,
      returnUrl: claim.returnUrl,
    });
    const initial = await this.browserSession.prepareAuthentication();
    if (initial.state === "restricted") {
      throw new BrowserStateError(initial.state, initial.evidence);
    }
    return this.waitForAuthentication(claim, initial);
  }

  async runScan(claim, auth) {
    const pairs = buildBoundedQueryPairs(claim.scan.filters, 10);
    const pairJobs = [];
    const perPairMaximum = Math.max(1, Math.ceil(claim.scan.maximum / pairs.length));
    const startedAt = this.now();
    const scanDeadline = startedAt + this.config.scanMaxDurationMs;
    let leaseSafetyDeadline = startedAt + this.config.scanLeaseSafetyMs;
    let lastHeartbeatAt = startedAt;
    const heartbeat = async (force = false) => {
      const observedAt = this.now();
      if (observedAt >= scanDeadline) {
        const error = new Error("scan_timeout");
        error.code = "scan_timeout";
        throw error;
      }
      if (observedAt >= leaseSafetyDeadline) {
        const error = new Error("scan_lease_expired");
        error.code = "scan_lease_expired";
        throw error;
      }
      if (!force && observedAt - lastHeartbeatAt < this.config.scanHeartbeatMs) return;
      await this.report(claim, {
        status: "running",
        authState: mapAuthState("authenticated"),
        evidence: pageStateEvidence(auth),
      });
      lastHeartbeatAt = this.now();
      leaseSafetyDeadline = lastHeartbeatAt + this.config.scanLeaseSafetyMs;
    };

    for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
      if (pairIndex > 0) await heartbeat(true);
      const result = await this.browserSession.scanJobs({
        query: pairs[pairIndex],
        maxResults: perPairMaximum,
        onProgress: () => heartbeat(false),
      });
      pairJobs.push(result.jobs);
    }
    return {
      jobs: interleaveAndDeduplicatePairJobs(pairJobs, claim.scan.maximum),
    };
  }

  async execute(rawClaim) {
    const claim = validateClaim(rawClaim, this.config.ownerId);
    this.tokenStore.disableAllVnc?.();
    this.activeClaim = claim;
    this.activeRedemptionEvidence = null;
    this.onEvent("command_claimed", { command: claim.command });
    try {
      if (claim.command === "disconnect") {
        await this.browserSession.close();
        this.tokenStore.clear();
        await this.report(claim, {
          status: "succeeded",
          authState: mapAuthState("unauthenticated"),
        });
        return;
      }

      await this.browserSession.open({
        ownerId: claim.ownerId,
        leaseId: claim.leaseId,
        encryptedSessionEnvelope: claim.encryptedSessionEnvelope,
        transientDataKey: claim.transientSessionDataKey,
      });
      claim.transientSessionDataKey = null;
      let auth;
      if (claim.command === "scan") {
        auth = await this.browserSession.prepareAuthentication();
        if (auth.state === "restricted") {
          throw new BrowserStateError(auth.state, auth.evidence);
        }
        if (auth.state !== "authenticated") {
          const authErrorCode = [
            "login_required",
            "mfa_required",
            "checkpoint_required",
          ].includes(auth.state)
            ? auth.state
            : "login_required";
          await this.report(claim, {
            status: "awaiting_auth",
            authState: mapAuthState(auth.state),
            evidence: pageStateEvidence(auth),
            errorCode: authErrorCode,
            errorMessage: safeFailureMessage(authErrorCode),
          });
          return;
        }
      } else {
        auth = await this.ensureAuthenticated(claim);
      }
      await this.report(claim, {
        status: "running",
        authState: mapAuthState(auth.state),
        evidence: pageStateEvidence(auth),
      });

      if (claim.command === "scan") {
        const scanResult = await this.runScan(claim, auth);
        const encryptedSessionEnvelope = await this.browserSession.exportEncryptedState();
        await this.report(claim, {
          status: "succeeded",
          authState: mapAuthState("authenticated"),
          encryptedSessionEnvelope,
          jobs: scanResult.jobs,
          evidence: pageStateEvidence(await this.browserSession.detectAuthState()),
        });
      } else {
        const encryptedSessionEnvelope = await this.browserSession.exportEncryptedState();
        await this.report(claim, {
          status: "succeeded",
          authState: mapAuthState("authenticated"),
          encryptedSessionEnvelope,
          evidence: pageStateEvidence(auth),
        });
        if (claim.attemptId && claim.returnUrl) {
          this.tokenStore.setOutcome(claim.attemptId, {
            status: "succeeded",
            returnUrl: claim.returnUrl,
          });
        }
      }
    } catch (error) {
      if (error?.code === "control_plane_report_ambiguous") {
        this.onEvent("command_report_ambiguous", { command: claim.command });
        if (claim.attemptId && claim.returnUrl) {
          this.tokenStore.setOutcome(claim.attemptId, {
            status: "confirming",
            returnUrl: claim.returnUrl,
          });
        }
        return;
      }
      const errorCode = safeFailureCode(error);
      const status = errorCode === "restricted" ? "restricted" : "failed";
      await this.report(claim, {
        status,
        authState: mapAuthState(errorCode),
        errorCode,
        errorMessage: safeFailureMessage(errorCode),
        evidence:
          error instanceof BrowserStateError
            ? pageStateEvidence({ evidence: error.evidence })
            : undefined,
      }).catch(() => undefined);
      this.onEvent("command_failed", { command: claim.command, errorCode });
    } finally {
      if (this.activeAttemptId) {
        const outcomeStatus = this.tokenStore.getOutcome(this.activeAttemptId)?.status;
        if (!["succeeded", "confirming"].includes(outcomeStatus)) {
          this.tokenStore.revokeAttempt(this.activeAttemptId);
        }
      }
      this.activeAttemptId = null;
      this.activeClaim = null;
      this.activeRedemptionEvidence = null;
      claim.transientSessionDataKey = null;
      await this.browserSession.close();
    }
  }

  async run(signal) {
    this.onEvent("poller_started", {});
    while (!signal.aborted) {
      try {
        const claim = await this.controlPlane.claim({ workerId: this.config.workerId });
        if (claim) await this.execute(claim);
      } catch (error) {
        this.onEvent("poll_failed", { errorCode: safeFailureCode(error) });
      }
      if (!signal.aborted) {
        await delay(this.config.pollIntervalMs, undefined, { signal }).catch(() => undefined);
      }
    }
    await this.browserSession.close();
    this.tokenStore.clear();
    this.onEvent("poller_stopped", {});
  }
}
