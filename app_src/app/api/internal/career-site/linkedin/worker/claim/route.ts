import type { NextRequest } from 'next/server'
import {
  CareerSiteLinkedInRequestError,
  parseCareerSiteLinkedInWorkerClaimRequest,
} from '@/lib/careerSiteLinkedInContract'
import {
  authorizeCareerSiteLinkedInWorker,
  careerSiteLinkedInErrorResponse,
  careerSiteLinkedInJson,
  readCareerSiteLinkedInJson,
} from '@/lib/careerSiteLinkedInRoute'
import { claimCareerSiteLinkedInWork } from '@/lib/persistence/careerSiteLinkedIn'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const body = await readCareerSiteLinkedInJson(req, 4 * 1024)
    const authorization = await authorizeCareerSiteLinkedInWorker({ req, rawBody: body.raw })
    const request = parseCareerSiteLinkedInWorkerClaimRequest(body.value)
    if (request.workerId !== authorization.workerId) {
      throw new CareerSiteLinkedInRequestError(
        'LinkedIn worker identity does not match signed headers',
        401,
        'CAREER_SITE_LINKEDIN_WORKER_UNAUTHORIZED',
      )
    }
    return careerSiteLinkedInJson({
      ok: true,
      claim: await claimCareerSiteLinkedInWork(request),
    })
  } catch (error) {
    return careerSiteLinkedInErrorResponse(error)
  }
}
