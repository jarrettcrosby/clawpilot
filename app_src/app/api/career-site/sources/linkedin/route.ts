import type { NextRequest } from 'next/server'
import {
  authorizeCareerSiteLinkedInActor,
  careerSiteLinkedInErrorResponse,
  careerSiteLinkedInJson,
} from '@/lib/careerSiteLinkedInRoute'
import {
  disconnectCareerSiteLinkedIn,
  getCareerSiteLinkedInOverview,
} from '@/lib/persistence/careerSiteLinkedIn'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const { actor } = await authorizeCareerSiteLinkedInActor(req)
    return careerSiteLinkedInJson({
      ok: true,
      ...await getCareerSiteLinkedInOverview(actor),
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
      connection: await disconnectCareerSiteLinkedIn(actor),
    })
  } catch (error) {
    return careerSiteLinkedInErrorResponse(error)
  }
}
