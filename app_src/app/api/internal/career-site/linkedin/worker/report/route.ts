import type { NextRequest } from 'next/server'
import { parseCareerSiteLinkedInWorkerReportRequest } from '@/lib/careerSiteLinkedInContract'
import { careerSiteLinkedInReportBodyDigest } from '@/lib/careerSiteLinkedInReportReceipt'
import {
  authorizeCareerSiteLinkedInWorker,
  careerSiteLinkedInErrorResponse,
  careerSiteLinkedInJson,
  readCareerSiteLinkedInJson,
} from '@/lib/careerSiteLinkedInRoute'
import { reportCareerSiteLinkedInWork } from '@/lib/persistence/careerSiteLinkedIn'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const body = await readCareerSiteLinkedInJson(req, 8 * 1024 * 1024)
    const authorization = await authorizeCareerSiteLinkedInWorker({ req, rawBody: body.raw })
    const report = parseCareerSiteLinkedInWorkerReportRequest(body.value)
    return careerSiteLinkedInJson({
      ok: true,
      result: await reportCareerSiteLinkedInWork({
        workerId: authorization.workerId,
        report,
        reportBodyDigest: careerSiteLinkedInReportBodyDigest(body.raw),
      }),
    })
  } catch (error) {
    return careerSiteLinkedInErrorResponse(error)
  }
}
