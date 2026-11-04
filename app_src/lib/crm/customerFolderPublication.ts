import { parseCustomerFolderLinks, updateCustomerFolderLinks } from './customerFolderLinks'
import { CustomerFolderHeldError } from './customerDriveFolders'

export type CustomerFolderPublicationStatus = 'pending' | 'published' | 'manual_override'

/** Merge into the locked CURRENT description, not an old form/job snapshot.
 * An explicit adoption can preserve an existing operator shortlink, including
 * a link to an invoice subfolder. Neither adoption nor retries repoint it. */
export function prepareCustomerFolderPublication(input: {
  description: string; rootId: string; status: CustomerFolderPublicationStatus; adopted: boolean;
}): { description: string; status: CustomerFolderPublicationStatus } {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(input.rootId)
    || !['pending','published','manual_override'].includes(input.status)) {
    throw new CustomerFolderHeldError('customer_folder_publication_invalid')
  }
  const parsed = parseCustomerFolderLinks(input.description)
  if (parsed.hasDuplicates || parsed.invalidLabels.length) {
    throw new CustomerFolderHeldError('customer_folder_description_requires_repair')
  }
  const expected = `https://drive.google.com/drive/folders/${input.rootId}`
  const current = parsed.values.bpoDriveUrl
  if (input.status === 'manual_override' || input.status === 'published' && current !== expected) {
    return { description: input.description, status: 'manual_override' }
  }
  if (current && current !== expected) {
    if (!input.adopted) throw new CustomerFolderHeldError('customer_folder_existing_link_requires_adoption')
    return { description: input.description, status: 'manual_override' }
  }
  return { description: updateCustomerFolderLinks(input.description, { ...parsed.values, bpoDriveUrl: expected }), status: 'published' }
}
