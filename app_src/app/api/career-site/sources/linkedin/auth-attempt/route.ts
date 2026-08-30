import type { NextRequest } from 'next/server'
import { assertLinkedInUuid } from '@/lib/careerSiteLinkedInContract'
import {
  authorizeCareerSiteLinkedInActor,
  careerSiteLinkedInErrorResponse,
  careerSiteLinkedInJson,
} from '@/lib/careerSiteLinkedInRoute'
import {
  cancelCareerSiteLinkedInAuthAttempt,
  getCareerSiteLinkedInAuthAttempt,
} from '@/lib/persistence/careerSiteLinkedIn'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function attemptId(req: NextRequest) {
  return assertLinkedInUuid(req.nextUrl.searchParams.get('attemptId'), 'attemptId')
}

export async function GET(req: NextRequest) {
  try {
    const { actor } = await authorizeCareerSiteLinkedInActor(req)
    return careerSiteLinkedInJson({
      ok: true,
      authAttempt: await getCareerSiteLinkedInAuthAttempt({ actor, attemptId: attemptId(req) }),
    })
  } catch (error) {
    return careerSiteLinkedInErrorResponse(error)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { actor } = await authorizeCareerSiteLinkedInActor(req)
    return careerSiteLinkedInJson({
      ok: true,
      authAttempt: await cancelCareerSiteLinkedInAuthAttempt({ actor, attemptId: attemptId(req) }),
    })
  } catch (error) {
    return careerSiteLinkedInErrorResponse(error)
  }
}
