import type { NextRequest } from 'next/server'
import {
  assertLinkedInUuid,
  parseCareerSiteLinkedInScanRequest,
} from '@/lib/careerSiteLinkedInContract'
import {
  authorizeCareerSiteLinkedInActor,
  careerSiteLinkedInErrorResponse,
  careerSiteLinkedInJson,
  readCareerSiteLinkedInJson,
} from '@/lib/careerSiteLinkedInRoute'
import {
  createCareerSiteLinkedInScan,
  getCareerSiteLinkedInScan,
} from '@/lib/persistence/careerSiteLinkedIn'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const { actor } = await authorizeCareerSiteLinkedInActor(req)
    const scanId = assertLinkedInUuid(req.nextUrl.searchParams.get('scanId'), 'scanId')
    return careerSiteLinkedInJson({
      ok: true,
      scan: await getCareerSiteLinkedInScan({ actor, scanId }),
    })
  } catch (error) {
    return careerSiteLinkedInErrorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const { actor } = await authorizeCareerSiteLinkedInActor(req)
    const body = await readCareerSiteLinkedInJson(req, 16 * 1024)
    const request = parseCareerSiteLinkedInScanRequest(body.value)
    return careerSiteLinkedInJson({
      ok: true,
      scan: await createCareerSiteLinkedInScan({ actor, request }),
    }, 202)
  } catch (error) {
    return careerSiteLinkedInErrorResponse(error)
  }
}
