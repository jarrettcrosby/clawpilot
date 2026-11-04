import { normalizeCustomerFolderLinks, parseCustomerFolderLinks, updateCustomerFolderLinks } from './customerFolderLinks'

/** A reference only: never fetch this URL, create a folder or alter sharing. */
export function fractionalFolderUrl(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !value) throw new Error('INVALID_FOLDER_URL')
  return normalizeCustomerFolderLinks({ bpoDriveUrl: '', fractionalCustomerFolderUrl: value }).fractionalCustomerFolderUrl
}

export function fractionalFolderState(description: string, previous: { lastPublishedUrl: string | null } | null) {
  const parsed = parseCustomerFolderLinks(description)
  if (parsed.hasDuplicates || parsed.invalidLabels.length) throw new Error('FOLDER_DESCRIPTION_REPAIR_REQUIRED')
  const folderUrl = parsed.values.fractionalCustomerFolderUrl || null
  return { folderUrl, status: previous
    ? folderUrl === previous.lastPublishedUrl ? 'published' as const : 'manual_override' as const
    : folderUrl ? 'manual_override' as const : 'unlinked' as const }
}

export function mergeFractionalCustomerFolder(input: {
  description: string; previous: { lastPublishedUrl: string | null } | null; folderUrl: string | null;
}) {
  const desired = fractionalFolderUrl(input.folderUrl), state = fractionalFolderState(input.description, input.previous)
  // A matching initial reference may be adopted. A different reference or a
  // later manual replacement/removal must never be overwritten by a sync.
  if (input.previous ? state.status === 'manual_override' : state.folderUrl && state.folderUrl !== desired) {
    throw new Error('FOLDER_MANUAL_REVIEW_REQUIRED')
  }
  const parsed = parseCustomerFolderLinks(input.description)
  return updateCustomerFolderLinks(input.description, { ...parsed.values, fractionalCustomerFolderUrl: desired ?? '' })
}
