import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const COOKIE_AUDIENCE = "career-linkedin-live-v1";
const DEFAULT_REDEMPTION_REPLAY_MS = 30_000;

function tokenHash(token) {
  return createHash("sha256").update(token).digest();
}

function safeEqual(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

export class LiveTokenStore {
  constructor({
    hmacSecret,
    now = () => Date.now(),
    redemptionReplayMs = DEFAULT_REDEMPTION_REPLAY_MS,
  }) {
    if (typeof hmacSecret !== "string" || hmacSecret.length < 32) {
      throw new Error("invalid_live_cookie_secret");
    }
    this.hmacSecret = hmacSecret;
    this.now = now;
    if (
      !Number.isSafeInteger(redemptionReplayMs) ||
      redemptionReplayMs < 1_000 ||
      redemptionReplayMs > 60_000
    ) throw new Error("invalid_redemption_replay_window");
    this.redemptionReplayMs = redemptionReplayMs;
    this.records = new Map();
    this.vncRevocationListeners = new Set();
  }

  activate({
    sessionId,
    attemptId,
    authTokenDigest,
    authTokenRedeemedAt = null,
    authTokenAdoptionRequired = false,
    expiresAt,
    returnUrl = null,
  }) {
    if (typeof authTokenDigest !== "string" || !/^[a-f0-9]{64}$/i.test(authTokenDigest)) {
      throw new Error("invalid_auth_token_digest");
    }
    if (typeof authTokenAdoptionRequired !== "boolean") {
      throw new Error("invalid_auth_token_adoption_state");
    }
    if (authTokenAdoptionRequired && !authTokenRedeemedAt) {
      throw new Error("invalid_auth_token_adoption_state");
    }
    const expiresAtMs = new Date(expiresAt).valueOf();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      throw new Error("invalid_auth_token_expiry");
    }
    this.clear();
    this.records.set(attemptId, {
      digest: Buffer.from(authTokenDigest, "hex"),
      sessionId,
      attemptId,
      expiresAtMs,
      locallyRedeemed: Boolean(authTokenRedeemedAt) && !authTokenAdoptionRequired,
      adoptionRequired: authTokenAdoptionRequired,
      issuedCookie: null,
      redemptionReplayUntilMs: 0,
      vncAuthorized: true,
      returnUrl,
      outcome: { status: "pending", returnUrl: null },
    });
  }

  matchToken(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
    const suppliedDigest = tokenHash(token);
    for (const [attemptId, record] of this.records) {
      if (record.expiresAtMs <= this.now()) {
        this.records.delete(attemptId);
        continue;
      }
      const canReplayIssuedResponse = Boolean(
        record.locallyRedeemed &&
        record.issuedCookie &&
        record.redemptionReplayUntilMs > this.now() &&
        record.vncAuthorized &&
        record.outcome?.status === "pending",
      );
      if (
        (!record.locallyRedeemed || canReplayIssuedResponse) &&
        safeEqual(suppliedDigest, record.digest)
      ) {
        return {
          sessionId: record.sessionId,
          attemptId: record.attemptId,
          expiresAtMs: record.expiresAtMs,
          returnUrl: record.returnUrl,
          responseReplay: canReplayIssuedResponse,
        };
      }
    }
    return null;
  }

  issueCookieAfterAcceptedRedemption(attemptId) {
    const record = this.records.get(attemptId);
    if (!record || record.expiresAtMs <= this.now()) return null;
    if (record.locallyRedeemed) {
      return (
        record.issuedCookie &&
        record.redemptionReplayUntilMs > this.now() &&
        record.vncAuthorized &&
        record.outcome?.status === "pending"
      ) ? { ...record.issuedCookie } : null;
    }
    record.locallyRedeemed = true;
    record.adoptionRequired = false;
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        aud: COOKIE_AUDIENCE,
        attemptId: record.attemptId,
        exp: record.expiresAtMs,
        nonce: randomBytes(18).toString("base64url"),
      }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", this.hmacSecret)
      .update(payload)
      .digest("base64url");
    record.redemptionReplayUntilMs = Math.min(
      record.expiresAtMs,
      this.now() + this.redemptionReplayMs,
    );
    record.issuedCookie = {
      cookie: `${payload}.${signature}`,
      expiresAtMs: record.expiresAtMs,
      attemptId: record.attemptId,
    };
    return { ...record.issuedCookie };
  }

  isRedeemed(attemptId) {
    const record = this.records.get(attemptId);
    return Boolean(
      record &&
      record.expiresAtMs > this.now() &&
      record.locallyRedeemed &&
      !record.adoptionRequired,
    );
  }

  verifyCookie(cookie) {
    if (typeof cookie !== "string" || cookie.length > 2_048) return null;
    const [payload, suppliedSignature, extra] = cookie.split(".");
    if (!payload || !suppliedSignature || extra) return null;
    const expectedSignature = createHmac("sha256", this.hmacSecret)
      .update(payload)
      .digest("base64url");
    if (!safeEqual(Buffer.from(suppliedSignature), Buffer.from(expectedSignature))) return null;

    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (
      claims?.v !== 1 ||
      claims.aud !== COOKIE_AUDIENCE ||
      typeof claims.attemptId !== "string" ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= this.now()
    ) return null;

    const active = this.records.get(claims.attemptId);
    if (
      !active ||
      active.expiresAtMs !== claims.exp
    ) return null;
    return {
      attemptId: claims.attemptId,
      sessionId: active.sessionId,
      expiresAtMs: claims.exp,
      adoptionRequired: active.adoptionRequired,
    };
  }

  inspectCookie(cookie) {
    return this.verifyCookie(cookie);
  }

  completeCookieAdoption(attemptId, cookie) {
    const authorization = this.verifyCookie(cookie);
    if (
      !authorization ||
      authorization.attemptId !== attemptId
    ) return null;
    const record = this.records.get(attemptId);
    if (!record || record.outcome?.status !== "pending" || !record.vncAuthorized) return null;
    if (record.adoptionRequired) {
      record.adoptionRequired = false;
      record.locallyRedeemed = true;
    } else if (!record.locallyRedeemed) {
      return null;
    }
    return { ...authorization, adoptionRequired: false };
  }

  authorizeCookieForVnc(cookie) {
    const authorization = this.verifyCookie(cookie);
    if (!authorization) return null;
    const record = this.records.get(authorization.attemptId);
    return (
      record?.vncAuthorized &&
      record.outcome?.status === "pending" &&
      record.locallyRedeemed &&
      !record.adoptionRequired
    )
      ? authorization
      : null;
  }

  authorizeCookieForOutcome(cookie) {
    const authorization = this.verifyCookie(cookie);
    if (!authorization) return null;
    const record = this.records.get(authorization.attemptId);
    return record?.locallyRedeemed && !record.adoptionRequired ? authorization : null;
  }

  setOutcome(attemptId, outcome) {
    const record = this.records.get(attemptId);
    if (!record) return false;
    record.outcome = {
      status: outcome.status,
      returnUrl: outcome.returnUrl || record.returnUrl || null,
    };
    if (outcome.status !== "pending") {
      record.vncAuthorized = false;
      record.issuedCookie = null;
      record.redemptionReplayUntilMs = 0;
      this.notifyVncRevoked(attemptId);
    }
    return true;
  }

  getOutcome(attemptId) {
    return this.records.get(attemptId)?.outcome || null;
  }

  outcomeForCookie(cookie) {
    const authorization = this.authorizeCookieForOutcome(cookie);
    if (!authorization) return null;
    return this.getOutcome(authorization.attemptId) || { status: "pending", returnUrl: null };
  }

  revokeAttempt(attemptId) {
    if (this.records.delete(attemptId)) this.notifyVncRevoked(attemptId);
  }

  disableVncForAttempt(attemptId) {
    const record = this.records.get(attemptId);
    if (!record || !record.vncAuthorized) return false;
    record.vncAuthorized = false;
    record.issuedCookie = null;
    record.redemptionReplayUntilMs = 0;
    this.notifyVncRevoked(attemptId);
    return true;
  }

  disableAllVnc() {
    for (const attemptId of this.records.keys()) this.disableVncForAttempt(attemptId);
  }

  clear() {
    const attemptIds = [...this.records.keys()];
    this.records.clear();
    for (const attemptId of attemptIds) this.notifyVncRevoked(attemptId);
  }

  onVncRevoked(listener) {
    this.vncRevocationListeners.add(listener);
    return () => this.vncRevocationListeners.delete(listener);
  }

  notifyVncRevoked(attemptId) {
    for (const listener of this.vncRevocationListeners) listener(attemptId);
  }
}
