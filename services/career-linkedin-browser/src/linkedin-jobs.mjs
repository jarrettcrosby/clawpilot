const LINKEDIN_HOST = "www.linkedin.com";
const MAX_TEXT = Object.freeze({
  title: 240,
  company: 240,
  location: 240,
  description: 20_000,
  salaryText: 500,
});

function isLinkedInHostname(hostname) {
  return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function extractLinkedInJobId(value) {
  let url;
  try {
    url = new URL(value, `https://${LINKEDIN_HOST}`);
  } catch {
    return null;
  }
  if (!isLinkedInHostname(url.hostname)) return null;

  const pathMatch = url.pathname.match(/\/jobs\/view\/(\d+)(?:\/|$)/);
  if (pathMatch && /^\d{5,30}$/.test(pathMatch[1])) return pathMatch[1];

  const queryJobId = url.searchParams.get("currentJobId");
  return /^\d{5,30}$/.test(queryJobId || "") ? queryJobId : null;
}

export function canonicalLinkedInJobUrl(externalId) {
  if (!/^\d{5,30}$/.test(String(externalId))) {
    throw new Error("invalid_linkedin_job_id");
  }
  return `https://${LINKEDIN_HOST}/jobs/view/${externalId}/`;
}

export function validateLinkedInJobsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_jobs_url");
  }
  if (url.protocol !== "https:" || !isLinkedInHostname(url.hostname)) {
    throw new Error("invalid_jobs_url");
  }
  if (!/^\/jobs\/(?:view|search|search-results)(?:\/|$)/.test(url.pathname)) {
    throw new Error("invalid_jobs_url");
  }
  url.hostname = LINKEDIN_HOST;
  url.hash = "";
  return url.toString();
}

export function buildLinkedInJobsSearchUrl({ searchUrl, query = {} } = {}) {
  if (searchUrl) return validateLinkedInJobsUrl(searchUrl);

  const url = new URL(`https://${LINKEDIN_HOST}/jobs/search/`);
  const allowedTextFields = ["keywords", "location"];
  for (const field of allowedTextFields) {
    const value = cleanText(query[field], 300);
    if (value) url.searchParams.set(field, value);
  }
  const allowedFilterFields = ["f_WT", "f_E", "f_JT", "f_TPR", "sortBy"];
  for (const field of allowedFilterFields) {
    const value = cleanText(query[field], 100);
    if (value && /^[A-Za-z0-9_,=-]+$/.test(value)) {
      url.searchParams.set(field, value);
    }
  }
  return url.toString();
}

export function normalizeJobCandidate(candidate) {
  const externalId = String(candidate.externalId || "");
  if (!/^\d{5,30}$/.test(externalId)) return null;

  let postedAt;
  if (candidate.postedAt) {
    const parsed = new Date(candidate.postedAt);
    if (!Number.isNaN(parsed.valueOf())) postedAt = parsed.toISOString();
  }

  const title = cleanText(candidate.title, MAX_TEXT.title);
  const company = cleanText(candidate.company, MAX_TEXT.company);
  const description = cleanText(candidate.description, MAX_TEXT.description);
  if (!title || !company || description.length < 40) return null;
  const location = cleanText(candidate.location, MAX_TEXT.location);
  const salaryText = cleanText(candidate.salaryText, MAX_TEXT.salaryText);

  return {
    externalId,
    url: canonicalLinkedInJobUrl(externalId),
    title,
    company,
    location: location || null,
    description,
    salaryText: salaryText || null,
    postedAt: postedAt || null,
  };
}

export function deduplicateJobs(candidates, maxResults = 50) {
  const boundedMaximum = Math.max(1, Math.min(50, Number(maxResults) || 10));
  const byId = new Map();
  for (const candidate of candidates) {
    const normalized = normalizeJobCandidate(candidate);
    if (!normalized) continue;
    if (!byId.has(normalized.externalId)) byId.set(normalized.externalId, normalized);
    if (byId.size >= boundedMaximum) break;
  }
  return [...byId.values()];
}
