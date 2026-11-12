import { handleFractionalCrmGateway, type FractionalCrmGatewayServices } from '@/lib/fractionalCrmGatewayHttp'
import {
  readFractionalCrmCredential, readFractionalCrmOrganization, readFractionalCrmCompany, readFractionalCrmContact, listFractionalCrmContacts,
  listFractionalCrmOrganizationContacts, readFractionalCrmOrganizationContact, createFractionalCrmOrganizationContact,
  updateFractionalCrmCompany, updateFractionalCrmContact, resolveOrCreateFractionalCrmOnboarding,
  readFractionalCrmCustomerFolder, updateFractionalCrmCustomerFolder,
  readFractionalCrmProduct, listFractionalCrmProducts,
} from '@/lib/persistence/fractionalCrmGateway'
import { reconcileCrmBoardProjectionsForPipeline } from '@/lib/crm/boardProjection'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const services = {
  readFractionalCrmCredential, readFractionalCrmOrganization, readFractionalCrmCompany, readFractionalCrmContact, listFractionalCrmContacts,
  listFractionalCrmOrganizationContacts, readFractionalCrmOrganizationContact, createFractionalCrmOrganizationContact,
  updateFractionalCrmCompany, updateFractionalCrmContact, resolveOrCreateFractionalCrmOnboarding,
  readFractionalCrmProduct, listFractionalCrmProducts,
  readFractionalCrmCustomerFolder,
  updateFractionalCrmCustomerFolder: (...args: Parameters<FractionalCrmGatewayServices['updateFractionalCrmCustomerFolder']>) =>
    updateFractionalCrmCustomerFolder(...args, reconcileCrmBoardProjectionsForPipeline),
}
const handle = async (request: Request) => {
  if ((request.method === 'POST' || request.method === 'PATCH') &&
      process.env.CLAWPILOT_CRM_SYNC_MAINTENANCE === '1') {
    return Response.json({ error: 'GATEWAY_UNAVAILABLE', message: 'CRM maintenance is in progress. Retry later.' }, {
      status: 503,
      headers: {
        'Cache-Control': 'private, no-store', Vary: 'Authorization', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Retry-After': '60',
      },
    })
  }
  return handleFractionalCrmGateway(request, services)
}
export const GET = handle
export const PATCH = handle
export const POST = handle
