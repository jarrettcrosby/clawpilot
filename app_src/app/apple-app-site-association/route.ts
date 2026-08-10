import { appleAppSiteAssociationResponse } from '@/lib/appleAppLinks'

export const dynamic = 'force-static'

export function GET() {
  return appleAppSiteAssociationResponse()
}
