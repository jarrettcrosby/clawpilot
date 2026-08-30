import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import {
  decodeTransientDataKey,
  decryptStorageState,
  encryptStorageState,
} from "./crypto-envelope.mjs";
import {
  buildLinkedInJobsSearchUrl,
  canonicalLinkedInJobUrl,
  deduplicateJobs,
  extractLinkedInJobId,
} from "./linkedin-jobs.mjs";
import {
  classifyLinkedInState,
  publicAuthEvidence,
} from "./linkedin-state.mjs";

const AUTH_SELECTORS = Object.freeze({
  loginForm: 'form[action*="login"], input[name="session_key"], input[name="session_password"]',
  mfaInput:
    'input[name*="verification"], input[id*="verification"], input[autocomplete="one-time-code"]',
  checkpointForm: 'form[action*="checkpoint"], form[action*="challenge"]',
  restrictionNotice: '[data-test-id*="restriction"], [class*="restriction"]',
  globalNavigation: 'nav.global-nav, [data-test-global-nav-link], header.global-nav',
});

const JOB_SELECTORS = Object.freeze({
  title: [
    ".job-details-jobs-unified-top-card__job-title h1",
    ".job-details-jobs-unified-top-card__job-title",
    ".top-card-layout__title",
    "main h1",
  ],
  company: [
    ".job-details-jobs-unified-top-card__company-name a",
    ".job-details-jobs-unified-top-card__company-name",
    ".topcard__org-name-link",
    ".topcard__flavor-row a",
  ],
  location: [
    ".job-details-jobs-unified-top-card__primary-description-container .tvm__text",
    ".job-details-jobs-unified-top-card__bullet",
    ".topcard__flavor--bullet",
    ".topcard__flavor-row span",
  ],
  description: ["#job-details", ".jobs-description__content", ".show-more-less-html__markup"],
  salaryText: [
    ".job-details-jobs-unified-top-card__job-insight--highlight",
    "[class*=" + '"compensation"' + "]",
    "[class*=" + '"salary"' + "]",
  ],
});

export const JOB_RESULT_SCOPES = Object.freeze([
  ".jobs-search-results-list",
  "ul.scaffold-layout__list-container",
  '[data-view-name="job-search-job-card"]',
  ".job-card-container",
  "li[data-occludable-job-id]",
]);

const JOB_LINK_SELECTOR = 'a[href*="/jobs/view/"], a[href*="currentJobId="]';
const JOB_ID_SELECTOR = "[data-job-id], [data-occludable-job-id]";
const JOB_RESULT_SCOPE_SELECTOR = `:is(${JOB_RESULT_SCOPES.join(", ")})`;
const SCOPED_JOB_LINK_SELECTOR = [
  `${JOB_RESULT_SCOPE_SELECTOR} :is(${JOB_LINK_SELECTOR})`,
  `${JOB_RESULT_SCOPE_SELECTOR}:is(${JOB_LINK_SELECTOR})`,
].join(", ");
const SCOPED_JOB_ID_SELECTOR = [
  JOB_RESULT_SCOPE_SELECTOR,
  `${JOB_RESULT_SCOPE_SELECTOR} :is(${JOB_ID_SELECTOR})`,
].join(", ");
const VERIFIED_EMPTY_STATE_SELECTOR = [
  ".jobs-search-no-results-banner",
  ".jobs-search-results-list__empty-state",
  '[data-view-name="jobs-search-no-results"]',
  ".jobs-search-results-list .artdeco-empty-state",
].join(", ");
const RECOMMENDATION_CONTAINER_SELECTOR = [
  '[class*="recommend" i]',
  '[data-view-name*="recommend" i]',
  '[aria-label*="recommend" i]',
  ".jobs-similar-jobs",
].join(", ");

export class BrowserStateError extends Error {
  constructor(code, evidence) {
    super(code);
    this.name = "BrowserStateError";
    this.code = code;
    this.evidence = evidence;
  }
}

export class ExtractionIncompleteError extends Error {
  constructor(diagnostics) {
    super("extraction_incomplete");
    this.name = "ExtractionIncompleteError";
    this.code = "extraction_incomplete";
    this.diagnostics = diagnostics;
  }
}

async function firstText(page, selectors, maximumLength = 30_000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    const text = await locator.innerText({ timeout: 2_000 }).catch(() => "");
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (cleaned) return cleaned.slice(0, maximumLength);
  }
  return "";
}

async function selectorSignals(page) {
  const signals = {};
  for (const [name, selector] of Object.entries(AUTH_SELECTORS)) {
    signals[name] = (await page.locator(selector).count().catch(() => 0)) > 0;
  }
  return signals;
}

function isAllowedTopLevelUrl(value) {
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"))
    );
  } catch {
    return false;
  }
}

export class LinkedInBrowserSession {
  constructor(config) {
    this.config = config;
    this.sessionId = null;
    this.ownerId = null;
    this.leaseId = null;
    this.dataKey = null;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async open({ ownerId, leaseId, encryptedSessionEnvelope, transientDataKey }) {
    if (ownerId !== this.config.ownerId) throw new Error("owner_mismatch");
    await this.close();

    const dataKey = decodeTransientDataKey(transientDataKey);
    let storageState;
    try {
      storageState = encryptedSessionEnvelope
        ? decryptStorageState({
            envelope: encryptedSessionEnvelope,
            dataKey,
            leaseId,
            ownerId,
          })
        : undefined;
    } catch (error) {
      dataKey.fill(0);
      throw error;
    }

    this.sessionId = randomUUID();
    this.ownerId = ownerId;
    this.leaseId = leaseId;
    this.dataKey = dataKey;
    this.browser = await chromium.launch({
      executablePath: this.config.chromiumExecutablePath,
      headless: false,
      env: { ...process.env, DISPLAY: this.config.display },
      args: [
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--window-size=1280,800",
        "--disable-background-networking",
      ],
    });
    this.context = await this.browser.newContext({
      storageState,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      let targetProtocol;
      try {
        targetProtocol = new URL(request.url()).protocol;
      } catch {
        targetProtocol = "invalid:";
      }
      if (targetProtocol === "http:" || targetProtocol === "invalid:") {
        await route.abort("blockedbyclient");
        return;
      }
      if (
        request.isNavigationRequest() &&
        request.frame() === request.frame().page().mainFrame() &&
        !isAllowedTopLevelUrl(request.url())
      ) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    this.context.on("page", (newPage) => {
      newPage.on("framenavigated", (frame) => {
        if (frame === newPage.mainFrame() && !isAllowedTopLevelUrl(frame.url())) {
          void newPage.close().catch(() => undefined);
        }
      });
    });
    this.page = await this.context.newPage();
    return this.sessionId;
  }

  async prepareAuthentication() {
    const current = await this.detectAuthState();
    if (["authenticated", "mfa_required", "checkpoint_required", "restricted"].includes(current.state)) {
      return current;
    }
    await this.page.goto("https://www.linkedin.com/login", {
      waitUntil: "domcontentloaded",
      timeout: this.config.navigationTimeoutMs,
    });
    return this.detectAuthState();
  }

  async detectAuthState() {
    if (!this.context || !this.page) throw new Error("browser_session_not_open");
    const [title, visibleText, signals, cookies] = await Promise.all([
      this.page.title().catch(() => ""),
      this.page.locator("body").innerText({ timeout: 2_000 }).catch(() => ""),
      selectorSignals(this.page),
      this.context.cookies("https://www.linkedin.com").catch(() => []),
    ]);
    const sessionCookie = cookies.find((cookie) => cookie.name === "li_at");
    const hasSessionCookie = Boolean(sessionCookie);
    const state = classifyLinkedInState({
      url: this.page.url(),
      title,
      visibleText: visibleText.slice(0, 25_000),
      selectorSignals: signals,
      hasSessionCookie,
    });
    let memberName = null;
    let profileUrl = null;
    if (state === "authenticated") {
      const profileLink = this.page.locator('a[href*="/in/"]').first();
      const rawHref = await profileLink.getAttribute("href").catch(() => null);
      const rawName = await profileLink.innerText({ timeout: 1_000 }).catch(() => "");
      if (rawHref) {
        try {
          const url = new URL(rawHref, "https://www.linkedin.com");
          if (
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
      memberName = rawName.replace(/\s+/g, " ").trim().slice(0, 200) || null;
    }
    const sessionExpiresAt =
      sessionCookie?.expires && sessionCookie.expires > 0
        ? new Date(sessionCookie.expires * 1_000).toISOString()
        : null;
    return {
      state,
      evidence: publicAuthEvidence({
        memberName,
        profileUrl,
        sessionExpiresAt,
      }),
    };
  }

  async exportEncryptedState() {
    if (!this.context || !this.dataKey || !this.leaseId || !this.ownerId) {
      throw new Error("browser_session_not_open");
    }
    const storageState = await this.context.storageState({ indexedDB: true });
    return encryptStorageState({
      storageState,
      dataKey: this.dataKey,
      leaseId: this.leaseId,
      ownerId: this.ownerId,
    });
  }

  async discoverJobIds(maxResults) {
    const ids = new Set();
    const scopedIds = new Set();
    const add = (value) => {
      const id = extractLinkedInJobId(value);
      if (id) ids.add(id);
    };
    const addScoped = (value) => {
      const id = extractLinkedInJobId(value);
      if (!id) return;
      scopedIds.add(id);
      ids.add(id);
    };
    const addScopedDataId = (value) => {
      const id = String(value || "");
      if (!/^\d{5,30}$/.test(id)) return;
      scopedIds.add(id);
      ids.add(id);
    };
    const addDataId = (value) => {
      const id = String(value || "");
      if (/^\d{5,30}$/.test(id)) ids.add(id);
    };
    add(this.page.url());

    for (let pass = 0; pass < 5 && ids.size < maxResults; pass += 1) {
      const hrefs = await this.page
        .locator(SCOPED_JOB_LINK_SELECTOR)
        .evaluateAll((anchors) => anchors.map((anchor) => anchor.href))
        .catch(() => []);
      hrefs.forEach(addScoped);
      const dataIds = await this.page
        .locator(SCOPED_JOB_ID_SELECTOR)
        .evaluateAll((elements) =>
          elements.flatMap((element) => [
            element.getAttribute("data-job-id"),
            element.getAttribute("data-occludable-job-id"),
          ]),
        )
        .catch(() => []);
      dataIds
        .filter(Boolean)
        .forEach(addScopedDataId);
      if (ids.size >= maxResults) break;
      await this.page.evaluate(() => window.scrollBy(0, Math.min(window.innerHeight, 900)));
      await this.page.waitForTimeout(500);
    }

    let fallbackCount = 0;
    if (scopedIds.size === 0 && ids.size < maxResults) {
      const fallbackHrefs = await this.page
        .locator(`main :is(${JOB_LINK_SELECTOR})`)
        .evaluateAll(
          (anchors, recommendationSelector) =>
            anchors
              .filter((anchor) => !anchor.closest(recommendationSelector))
              .map((anchor) => anchor.href),
          RECOMMENDATION_CONTAINER_SELECTOR,
        )
        .catch(() => []);
      for (const href of fallbackHrefs) {
        const before = ids.size;
        add(href);
        if (ids.size > before) fallbackCount += 1;
      }
      const fallbackDataIds = await this.page
        .locator(`main :is(${JOB_ID_SELECTOR})`)
        .evaluateAll(
          (elements, recommendationSelector) =>
            elements
              .filter((element) => !element.closest(recommendationSelector))
              .flatMap((element) => [
                element.getAttribute("data-job-id"),
                element.getAttribute("data-occludable-job-id"),
              ]),
          RECOMMENDATION_CONTAINER_SELECTOR,
        )
        .catch(() => []);
      for (const id of fallbackDataIds.filter(Boolean)) {
        const before = ids.size;
        addDataId(id);
        if (ids.size > before) fallbackCount += 1;
      }
    }

    const emptyStateSeen =
      (await this.page.locator(VERIFIED_EMPTY_STATE_SELECTOR).count().catch(() => 0)) > 0;
    if (ids.size === 0 && !emptyStateSeen) {
      throw new ExtractionIncompleteError({
        scopedCount: scopedIds.size,
        fallbackCount,
        emptyStateSeen,
      });
    }
    return {
      ids: [...ids].slice(0, maxResults),
      scopedCount: scopedIds.size,
      fallbackCount,
      emptyStateSeen,
    };
  }

  async readCurrentJob(externalId) {
    const title = await firstText(this.page, JOB_SELECTORS.title, 500);
    const company = await firstText(this.page, JOB_SELECTORS.company, 500);
    const location = await firstText(this.page, JOB_SELECTORS.location, 500);
    const description = await firstText(this.page, JOB_SELECTORS.description, 30_000);
    const salaryText = await firstText(this.page, JOB_SELECTORS.salaryText, 1_000);
    const postedAt = await this.page
      .locator("time[datetime]")
      .first()
      .getAttribute("datetime", { timeout: 1_000 })
      .catch(() => null);
    return { externalId, title, company, location, description, salaryText, postedAt };
  }

  async scanJobs({ searchUrl, query, maxResults, onProgress = async () => {} }) {
    const auth = await this.detectAuthState();
    if (auth.state !== "authenticated") {
      throw new BrowserStateError(auth.state, auth.evidence);
    }

    const boundedMaximum = Math.max(
      1,
      Math.min(this.config.maxScanResults, 50, Number(maxResults) || 10),
    );
    const sourceUrl = buildLinkedInJobsSearchUrl({ searchUrl, query });
    let blockedNonReadRequests = 0;
    const readOnlyRoute = async (route) => {
      if (["GET", "HEAD"].includes(route.request().method())) {
        await route.fallback();
      } else {
        blockedNonReadRequests += 1;
        await route.abort("blockedbyclient");
      }
    };
    await this.context.route("**/*", readOnlyRoute);

    const candidates = [];
    let discovery = { ids: [], scopedCount: 0, fallbackCount: 0, emptyStateSeen: false };
    let restrictedEvidence = null;
    try {
      await this.page.goto(sourceUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.config.navigationTimeoutMs,
      });
      await onProgress({ phase: "search_navigation_complete" });
      const afterSearchNavigation = await this.detectAuthState();
      if (afterSearchNavigation.state !== "authenticated") {
        throw new BrowserStateError(
          afterSearchNavigation.state,
          afterSearchNavigation.evidence,
        );
      }

      discovery = await this.discoverJobIds(boundedMaximum);
      await onProgress({ phase: "discovery_complete" });
      for (const externalId of discovery.ids) {
        await this.page.goto(canonicalLinkedInJobUrl(externalId), {
          waitUntil: "domcontentloaded",
          timeout: this.config.navigationTimeoutMs,
        });
        const pageState = await this.detectAuthState();
        if (pageState.state === "restricted") {
          restrictedEvidence = pageState.evidence;
          break;
        }
        if (pageState.state !== "authenticated") {
          throw new BrowserStateError(pageState.state, pageState.evidence);
        }
        candidates.push(await this.readCurrentJob(externalId));
        await onProgress({ phase: "job_complete" });
      }
    } finally {
      await this.context.unroute("**/*", readOnlyRoute).catch(() => undefined);
    }

    if (restrictedEvidence) {
      throw new BrowserStateError("restricted", restrictedEvidence);
    }
    const jobs = deduplicateJobs(candidates, boundedMaximum);
    if (discovery.ids.length > 0 && jobs.length === 0) {
      throw new ExtractionIncompleteError({
        discoveredCount: discovery.ids.length,
        candidateCount: candidates.length,
        validCount: 0,
        missingTitleCount: candidates.filter((candidate) => !candidate.title?.trim()).length,
        missingCompanyCount: candidates.filter((candidate) => !candidate.company?.trim()).length,
        shortDescriptionCount: candidates.filter(
          (candidate) => (candidate.description?.replace(/\s+/g, " ").trim().length || 0) < 40,
        ).length,
      });
    }
    return {
      jobs,
      evidence: {
        sourceKind: "linkedin_jobs",
        maxResults: boundedMaximum,
        discovered: candidates.length,
        returned: jobs.length,
        blockedNonReadRequests,
        observedAt: new Date().toISOString(),
      },
    };
  }

  async close() {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
    this.page = null;
    this.sessionId = null;
    this.ownerId = null;
    this.leaseId = null;
    this.dataKey?.fill(0);
    this.dataKey = null;
  }
}
