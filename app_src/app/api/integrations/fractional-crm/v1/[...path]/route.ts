import { handleFractionalCrmGateway } from '@/lib/fractionalCrmGatewayHttp'
import {
  readFractionalCrmCredential, readFractionalCrmOrganization, readFractionalCrmCompany, readFractionalCrmContact, listFractionalCrmContacts,
  updateFractionalCrmCompany, updateFractionalCrmContact, resolveOrCreateFractionalCrmOnboarding,
} from '@/lib/persistence/fractionalCrmGateway'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const services = {
  readFractionalCrmCredential, readFractionalCrmOrganization, readFractionalCrmCompany, readFractionalCrmContact, listFractionalCrmContacts,
  updateFractionalCrmCompany, updateFractionalCrmContact, resolveOrCreateFractionalCrmOnboarding,
}
const handle = (request: Request) => handleFractionalCrmGateway(request, services)
export const GET = handle
export const PATCH = handle
export const POST = handle
