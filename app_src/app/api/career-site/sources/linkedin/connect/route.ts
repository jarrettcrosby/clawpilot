import type { NextRequest } from 'next/server'
import { parseCareerSiteLinkedInConnectRequest } from '@/lib/careerSiteLinkedInContract'
import {
  authorizeCareerSiteLinkedInActor,
  careerSiteLinkedInErrorResponse,
  careerSiteLinkedInJson,
  readCareerSiteLinkedInJson,
} from '@/lib/careerSiteLinkedInRoute'
import { createCareerSiteLinkedInAuthAttempt } from '@/lib/persistence/careerSiteLinkedIn'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const { actor, configuration } = await authorizeCareerSiteLinkedInActor(req)
    const body = await readCareerSiteLinkedInJson(req, 4 * 1024)
    const request = parseCareerSiteLinkedInConnectRequest(body.value)
    return careerSiteLinkedInJson({
      ok: true,
      authAttempt: await createCareerSiteLinkedInAuthAttempt({ actor, configuration, request }),
    }, 202)
  } catch (error) {
    return careerSiteLinkedInErrorResponse(error)
  }
}
