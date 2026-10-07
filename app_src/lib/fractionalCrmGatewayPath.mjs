const company = 'ga(?:[0-9]{7}|[0-9a-v]{12})'
const contact = 'gc(?:[0-9]{7}|[0-9a-v]{12})'
const base = '/api/integrations/fractional-crm/v1'
const companyRecord = new RegExp(`^${base}/companies/${company}$`)
const contactList = new RegExp(`^${base}/companies/${company}/contacts$`)
const contactRecord = new RegExp(`^${base}/companies/${company}/contacts/${contact}$`)

/** Proxy bypass only: every matched request still requires gateway machine authentication. */
export function isFractionalCrmGatewayPath(pathname, method) {
  return (method === 'GET' && (companyRecord.test(pathname) || contactList.test(pathname) || contactRecord.test(pathname)))
    || (method === 'PATCH' && (companyRecord.test(pathname) || contactRecord.test(pathname)))
    || (method === 'POST' && pathname === `${base}/onboarding/resolve-or-create`)
}
