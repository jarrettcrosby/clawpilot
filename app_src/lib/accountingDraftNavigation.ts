const ACCOUNTING_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function accountingExplorerViewParameter(view: string) {
  return view === 'overview' || view === 'actions' ? null : view
}

export function accountingSectionFromNavigationUrl(currentHref: string): 'accounting' | null {
  const currentURL = new URL(currentHref)
  const view = currentURL.searchParams.get('accountingView')
  const requestId = currentURL.searchParams.get('accountingRequest')
  return view === 'actions' || Boolean(requestId && ACCOUNTING_REQUEST_ID_PATTERN.test(requestId))
    ? 'accounting'
    : null
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
  const targetSection = accountingSectionFromNavigationUrl(currentHref)
  const view = currentURL.searchParams.get('accountingView')
  const rawRequestId = currentURL.searchParams.get('accountingRequest')
  const requestId = rawRequestId && ACCOUNTING_REQUEST_ID_PATTERN.test(rawRequestId)
    ? rawRequestId.toLowerCase()
    : null
  const hasTarget = currentURL.searchParams.has('accountingView') || currentURL.searchParams.has('accountingRequest')
  currentURL.searchParams.delete('accountingView')
  currentURL.searchParams.delete('accountingRequest')
  if (targetSection) currentURL.hash = targetSection
  return {
    view,
    requestId,
    hasTarget,
    cleanUrl: `${currentURL.pathname}${currentURL.search}${currentURL.hash}`,
  }
}

export function buildPosPostingReviewUrl(currentHref: string, input: {
  draftId: string
  businessDate: string
}) {
  const draftId = String(input.draftId || '').trim().toLowerCase()
  const businessDate = String(input.businessDate || '').trim()
  if (!ACCOUNTING_REQUEST_ID_PATTERN.test(draftId)) {
    throw new Error('POS accounting draft id is invalid')
  }
  if (!BUSINESS_DATE_PATTERN.test(businessDate)) {
    throw new Error('POS accounting business date is invalid')
  }
  const nextURL = new URL(currentHref)
  for (const parameter of ['posView', 'location', 'date', 'accountingRequest']) {
    nextURL.searchParams.delete(parameter)
  }
  nextURL.searchParams.set('accountingView', 'pos-parity')
  nextURL.searchParams.set('posPostingDraft', draftId)
  nextURL.searchParams.set('posPostingDate', businessDate)
  nextURL.hash = 'accounting'
  return nextURL
}

export function consumePosPostingReviewTarget(currentHref: string) {
  const currentURL = new URL(currentHref)
  const rawDraftId = currentURL.searchParams.get('posPostingDraft')
  const rawBusinessDate = currentURL.searchParams.get('posPostingDate')
  const draftId = rawDraftId && ACCOUNTING_REQUEST_ID_PATTERN.test(rawDraftId)
    ? rawDraftId.toLowerCase()
    : null
  const businessDate = rawBusinessDate && BUSINESS_DATE_PATTERN.test(rawBusinessDate)
    ? rawBusinessDate
    : null
  const hasTarget = currentURL.searchParams.has('posPostingDraft') || currentURL.searchParams.has('posPostingDate')
  currentURL.searchParams.delete('posPostingDraft')
  currentURL.searchParams.delete('posPostingDate')
  return {
    draftId,
    businessDate,
    hasTarget,
    cleanUrl: `${currentURL.pathname}${currentURL.search}${currentURL.hash}`,
  }
}
