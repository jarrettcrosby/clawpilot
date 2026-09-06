import {
  CAREER_LINKEDIN_API_VERSION,
  CAREER_LINKEDIN_JOBS_SOURCE,
  CareerSiteLinkedInJobsError,
  LINKEDIN_JOBS_MAX_PAGES,
  LINKEDIN_JOBS_PAGE_SIZE,
  normalizeCareerSiteLinkedInJob,
  type CareerSiteLinkedInJobCandidate,
  type CareerSiteLinkedInJobsRequest,
} from '@/lib/careerSiteLinkedInJobsContract'
import { resolveUserMatonGatewayCredential } from '@/lib/integrations/matonGatewayCredentials'
import { matonFetch } from '@/lib/maton'

const MAX_PROVIDER_BYTES = 4 * 1024 * 1024
const REQUEST_DEADLINE_MS = 50_000

function providerError() {
  return new CareerSiteLinkedInJobsError('LinkedIn job search is temporarily unavailable; no new matches were imported', 502, 'CAREER_SITE_LINKEDIN_JOBS_PROVIDER_UNAVAILABLE')
}

async function selectedConnection(ownerEmail: string) {
  try {
    const credential = await resolveUserMatonGatewayCredential({ ownerEmail, app: 'linkedin' })
    return credential.connectionId
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
    if (code === 'missing-key' || code === 'missing-connection') {
      throw new CareerSiteLinkedInJobsError('Connect LinkedIn in ClawPilot Maton settings and refresh connections', 503, 'CAREER_SITE_LINKEDIN_MATON_NOT_CONNECTED')
    }
    throw new CareerSiteLinkedInJobsError('The LinkedIn connection registry is temporarily unavailable', 503, 'CAREER_SITE_LINKEDIN_MATON_REGISTRY_UNAVAILABLE')
  }
}

async function providerJson(path: string, ownerEmail: string, connectionId: string, signal?: AbortSignal, budget?: { remaining: number }) {
  let response: Response
  try {
    const get = () => {
      if (budget) {
        if (budget.remaining <= 0) throw providerError()
        budget.remaining -= 1
      }
      return matonFetch(path, {
        method: 'GET', signal,
        headers: { 'LinkedIn-Version': CAREER_LINKEDIN_API_VERSION, 'X-Restli-Protocol-Version': '2.0.0' },
      }, { ownerEmail, app: 'linkedin', boundConnectionId: connectionId })
    }
    response = await get()
    // The upstream archive intermittently returns 500. One bounded retry is
    // safe for GET; never retry permission/version errors or hide final failure.
    if (response.status === 429 || response.status >= 500) {
      const delay = Math.min(2_000, Math.max(500, Number(response.headers.get('retry-after') || 1) * 1_000))
      await response.body?.cancel()
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(providerError()) }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, Number.isFinite(delay) ? delay : 1_000)
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
      response = await get()
    }
  } catch { throw providerError() }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel()
    throw new CareerSiteLinkedInJobsError('The selected Maton LinkedIn connection does not currently grant this read capability', 503, 'CAREER_SITE_LINKEDIN_MATON_PERMISSION_REQUIRED')
  }
  if (response.status === 426) {
    await response.body?.cancel()
    throw new CareerSiteLinkedInJobsError('The LinkedIn API version needs an application update', 503, 'CAREER_SITE_LINKEDIN_MATON_VERSION_EXPIRED')
  }
  if (!response.ok || Number(response.headers.get('content-length') || 0) > MAX_PROVIDER_BYTES) {
    await response.body?.cancel()
    throw providerError()
  }
  const reader = response.body?.getReader()
  if (!reader) throw providerError()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_PROVIDER_BYTES || signal?.aborted) {
        await reader.cancel()
        throw providerError()
      }
      chunks.push(part.value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw providerError()
    return value as Record<string, unknown>
  } catch { throw providerError() }
  finally { reader.releaseLock() }
}

export async function getCareerSiteLinkedInJobsStatus(ownerEmail: string, signal?: AbortSignal) {
  const connectionId = await selectedConnection(ownerEmail)
  const profile = await providerJson('/linkedin/rest/me', ownerEmail, connectionId, signal)
  if (typeof profile.id !== 'string' || !profile.id.trim()) throw providerError()
  return {
    connected: true,
    source: CAREER_LINKEDIN_JOBS_SOURCE,
    coverage: 'paid-job-posts' as const,
    apiVersion: CAREER_LINKEDIN_API_VERSION,
    jobsSupported: true,
    inboxSupported: false,
    capabilities: { profile: 'verified', jobs: 'available-not-checked', inbox: 'not-supported' },
  }
}

export async function searchCareerSiteLinkedInJobs(input: {
  ownerEmail: string
  request: CareerSiteLinkedInJobsRequest
  signal?: AbortSignal
}) {
  const connectionId = await selectedConnection(input.ownerEmail)
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, REQUEST_DEADLINE_MS)
  if (input.signal?.aborted) controller.abort()
  else input.signal?.addEventListener('abort', abort, { once: true })
  const jobs: CareerSiteLinkedInJobCandidate[] = []
  const seen = new Set<string>()
  const observedAt = new Date()
  let scannedCount = 0
  let filteredCount = 0
  const requestBudget = { remaining: 8 }
  try {
    for (let page = 0; page < LINKEDIN_JOBS_MAX_PAGES && jobs.length < input.request.maxJobs && requestBudget.remaining > 0; page += 1) {
      if (controller.signal.aborted) throw providerError()
      // Rebuild only a fixed allowed endpoint; never follow provider paging URLs.
      const path = `/linkedin/rest/jobLibrary?q=criteria&keyword=${encodeURIComponent(input.request.query)}&count=${LINKEDIN_JOBS_PAGE_SIZE}&start=${page * LINKEDIN_JOBS_PAGE_SIZE}`
      const payload = await providerJson(path, input.ownerEmail, connectionId, controller.signal, requestBudget)
      if (!Array.isArray(payload.elements) || payload.elements.length > LINKEDIN_JOBS_PAGE_SIZE) throw providerError()
      for (const item of payload.elements) {
        scannedCount += 1
        const job = normalizeCareerSiteLinkedInJob(item, observedAt)
        if (!job || seen.has(job.externalJobId)) { filteredCount += 1; continue }
        seen.add(job.externalJobId)
        jobs.push(job)
        if (jobs.length >= input.request.maxJobs) break
      }
      if (payload.elements.length < LINKEDIN_JOBS_PAGE_SIZE) break
    }
    return {
      source: CAREER_LINKEDIN_JOBS_SOURCE,
      coverage: 'paid-job-posts' as const,
      availability: 'unverified' as const,
      jobs, scannedCount, filteredCount,
      warning: 'Job Library includes paid posts and can retain closed jobs. Candidates require a live vacancy and salary check before being shown as qualified matches.',
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abort)
  }
}
