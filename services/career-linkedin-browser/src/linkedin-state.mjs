const RESTRICTED_PATTERNS = [
  /account (?:has been |is )?restricted/i,
  /temporarily restricted/i,
  /appeal (?:your |this )?(?:account )?restriction/i,
  /access to your account has been restricted/i,
];

const MFA_PATTERNS = [
  /enter (?:the )?(?:verification|security) code/i,
  /two[- ]step verification/i,
  /check your (?:email|phone)/i,
  /enter the code we sent/i,
];

export function linkedInRouteKind(urlValue) {
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    return "invalid";
  }
  if (!(url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"))) {
    return "external";
  }
  if (/\/jobs\/(?:view|search|search-results)/.test(url.pathname)) return "jobs";
  if (/\/(?:login|uas\/login)/.test(url.pathname)) return "login";
  if (/\/(?:checkpoint|challenge)/.test(url.pathname)) return "checkpoint";
  if (/\/feed(?:\/|$)/.test(url.pathname)) return "feed";
  if (/\/in\//.test(url.pathname)) return "profile";
  return "linkedin_other";
}

export function classifyLinkedInState({
  url,
  title = "",
  visibleText = "",
  selectorSignals = {},
  hasSessionCookie = false,
}) {
  const routeKind = linkedInRouteKind(url);
  const combinedText = `${title}\n${visibleText}`.slice(0, 25_000);

  if (
    selectorSignals.restrictionNotice ||
    RESTRICTED_PATTERNS.some((pattern) => pattern.test(combinedText))
  ) {
    return "restricted";
  }
  if (
    selectorSignals.mfaInput ||
    MFA_PATTERNS.some((pattern) => pattern.test(combinedText))
  ) {
    return "mfa_required";
  }
  if (routeKind === "checkpoint" || selectorSignals.checkpointForm) {
    return "checkpoint_required";
  }
  if (routeKind === "login" || selectorSignals.loginForm) {
    return "login_required";
  }
  if (
    hasSessionCookie &&
    (selectorSignals.globalNavigation || ["jobs", "feed", "profile", "linkedin_other"].includes(routeKind))
  ) {
    return "authenticated";
  }
  if (routeKind === "external" || routeKind === "invalid") {
    return "unknown";
  }
  return "unauthenticated";
}

export function publicAuthEvidence({ memberName, profileUrl, sessionExpiresAt }) {
  return {
    event: "page_state",
    capturedAt: new Date().toISOString(),
    memberName: memberName || null,
    profileUrl: profileUrl || null,
    sessionExpiresAt: sessionExpiresAt || null,
  };
}
