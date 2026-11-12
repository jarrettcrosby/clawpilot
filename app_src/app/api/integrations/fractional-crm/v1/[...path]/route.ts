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
const handle = (request: Request) => handleFractionalCrmGateway(request, services)
export const GET = handle
export const PATCH = handle
export const POST = handle
