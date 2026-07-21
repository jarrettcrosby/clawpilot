const ACCOUNTING_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function accountingExplorerViewParameter(view: string) {
  return view === 'overview' || view === 'actions' ? null : view
}

export function buildAccountingDraftReviewUrl(currentHref: string, requestId: string) {
  const normalizedRequestId = String(requestId || '').trim().toLowerCase()
  if (!ACCOUNTING_REQUEST_ID_PATTERN.test(normalizedRequestId)) {
    throw new Error('Accounting request id is invalid')
  }
  const nextURL = new URL(currentHref)
  for (const parameter of ['posView', 'location', 'date']) nextURL.searchParams.delete(parameter)
  nextURL.searchParams.set('accountingView', 'actions')
  nextURL.searchParams.set('accountingRequest', normalizedRequestId)
  nextURL.hash = 'accounting'
  return nextURL
}

export function consumeAccountingDraftTarget(currentHref: string) {
  const currentURL = new URL(currentHref)
  const view = currentURL.searchParams.get('accountingView')
  const rawRequestId = currentURL.searchParams.get('accountingRequest')
  const requestId = rawRequestId && ACCOUNTING_REQUEST_ID_PATTERN.test(rawRequestId)
    ? rawRequestId.toLowerCase()
    : null
  const hasTarget = currentURL.searchParams.has('accountingView') || currentURL.searchParams.has('accountingRequest')
  currentURL.searchParams.delete('accountingView')
  currentURL.searchParams.delete('accountingRequest')
  return {
    view,
    requestId,
    hasTarget,
    cleanUrl: `${currentURL.pathname}${currentURL.search}${currentURL.hash}`,
  }
}
