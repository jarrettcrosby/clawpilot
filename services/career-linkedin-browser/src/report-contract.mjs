const REPORT_KEYS = Object.freeze([
  "leaseId",
  "leaseToken",
  "status",
  "authState",
  "encryptedSessionEnvelope",
  "jobs",
  "evidence",
  "errorCode",
  "errorMessage",
]);

const STATUS_VALUES = new Set([
  "awaiting_auth",
  "running",
  "succeeded",
  "failed",
  "restricted",
]);

export function mapAuthState(state, message = null) {
  const kind =
    state === "login_required"
      ? "login"
      : state === "mfa_required"
        ? "mfa"
        : state === "checkpoint_required"
          ? "checkpoint"
          : "none";
  return { kind, message };
}

export function liveTokenRedeemedEvidence(sessionExpiresAt) {
  return {
    event: "live_token_redeemed",
    capturedAt: new Date().toISOString(),
    memberName: null,
    profileUrl: null,
    sessionExpiresAt: sessionExpiresAt || null,
  };
}

export function pageStateEvidence(auth) {
  const evidence = auth?.evidence || {};
  const observedAt = evidence.observedAt || evidence.capturedAt;
  const memberName =
    typeof evidence.memberName === "string"
      ? evidence.memberName.replace(/\s+/g, " ").trim().slice(0, 200) || null
      : null;
  let profileUrl = null;
  if (typeof evidence.profileUrl === "string") {
    try {
      const url = new URL(evidence.profileUrl);
      if (
        url.protocol === "https:" &&
        (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) &&
        url.pathname.startsWith("/in/")
      ) {
        const slug = url.pathname.split("/")[2];
        if (/^[A-Za-z0-9%._~-]+$/.test(slug || "")) {
          url.pathname = `/in/${slug}/`;
          url.search = "";
          url.hash = "";
          profileUrl = url.toString().slice(0, 500);
        }
      }
    } catch {}
  }
  const sessionExpiresAt =
    typeof evidence.sessionExpiresAt === "string" &&
    !Number.isNaN(new Date(evidence.sessionExpiresAt).valueOf())
      ? new Date(evidence.sessionExpiresAt).toISOString()
      : null;
  return {
    event: "page_state",
    capturedAt: observedAt || new Date().toISOString(),
    memberName,
    profileUrl,
    sessionExpiresAt,
  };
}

export function buildReport(claim, values) {
  const report = {
    leaseId: claim.leaseId,
    leaseToken: claim.leaseToken,
    status: values.status,
    authState: values.authState ?? null,
    encryptedSessionEnvelope: values.encryptedSessionEnvelope ?? null,
    jobs: values.jobs ?? [],
    evidence: values.evidence ?? null,
    errorCode: values.errorCode ?? null,
    errorMessage: values.errorMessage ?? null,
  };
  if (!STATUS_VALUES.has(report.status)) throw new Error("invalid_report_status");
  if (Object.keys(report).some((key) => !REPORT_KEYS.includes(key))) {
    throw new Error("invalid_report_field");
  }
  if (
    !report.authState ||
    typeof report.authState !== "object" ||
    Array.isArray(report.authState) ||
    Object.keys(report.authState).some((key) => !["kind", "message"].includes(key)) ||
    !["login", "mfa", "checkpoint", "none"].includes(report.authState.kind) ||
    !(report.authState.message === null || typeof report.authState.message === "string")
  ) throw new Error("invalid_report_auth_state");
  if (!Array.isArray(report.jobs) || report.jobs.length > 50) {
    throw new Error("invalid_report_jobs");
  }
  if (report.evidence !== null) {
    const evidenceKeys = [
      "event",
      "capturedAt",
      "memberName",
      "profileUrl",
      "sessionExpiresAt",
    ];
    if (
      typeof report.evidence !== "object" ||
      Array.isArray(report.evidence) ||
      Object.keys(report.evidence).some((key) => !evidenceKeys.includes(key)) ||
      !["live_token_redeemed", "page_state"].includes(report.evidence.event) ||
      Number.isNaN(new Date(report.evidence.capturedAt).valueOf()) ||
      !["memberName", "profileUrl", "sessionExpiresAt"].every(
        (key) =>
          report.evidence[key] === null || typeof report.evidence[key] === "string",
      )
    ) throw new Error("invalid_report_evidence");
  }
  return report;
}
