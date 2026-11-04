import { googleDriveJson, GoogleWorkspaceClientError, type GoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspaceClient'
import { CustomerFolderHeldError, type CustomerFolderDrive, type CustomerFolderScope, type CustomerDriveFile,
  validateCustomerFolderScope } from './customerDriveFolders'

const fields = 'id,name,mimeType,driveId,parents,trashed,appProperties'
const literal = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/** Only the configured Google origin client is used; no supplied folder URL is
 * fetched. Generation/creation supports folders with pre-generated IDs:
 * https://developers.google.com/workspace/drive/api/guides/create-file */
export function customerFolderGoogleDrive(runtime: GoogleWorkspaceRuntime, scope: CustomerFolderScope): CustomerFolderDrive {
  validateCustomerFolderScope(scope)
  if (runtime.sharedDriveId !== scope.sharedDriveId || runtime.serviceAccountEmail !== scope.serviceAccountEmail) {
    throw new CustomerFolderHeldError('customer_folder_runtime_mismatch')
  }
  const get: CustomerFolderDrive['get'] = async id => {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new CustomerFolderHeldError('customer_folder_resource_invalid')
    try { return await googleDriveJson<CustomerDriveFile>(runtime,
      `/drive/v3/files/${id}?${new URLSearchParams({ supportsAllDrives: 'true', fields })}`) }
    catch (error) {
      if (error instanceof GoogleWorkspaceClientError && error.upstreamStatus === 404) return null
      throw error
    }
  }
  return {
    get,
    async namedChildren(parentId, name) {
      const found: CustomerDriveFile[] = []
      let pageToken = ''
      const seen = new Set<string>()
      for (let page = 0; page < 10; page++) {
        const parameters = new URLSearchParams({ supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
          corpora: 'drive', driveId: scope.sharedDriveId, spaces: 'drive', pageSize: '100',
          q: `trashed = false and '${literal(parentId)}' in parents and name = '${literal(name)}'`,
          fields: `nextPageToken,incompleteSearch,files(${fields})`, ...(pageToken ? { pageToken } : {}) })
        const result = await googleDriveJson<{ files?: CustomerDriveFile[]; nextPageToken?: string; incompleteSearch?: boolean }>(runtime,
          `/drive/v3/files?${parameters}`)
        if (result.incompleteSearch || !Array.isArray(result.files)) throw new CustomerFolderHeldError('customer_folder_search_incomplete')
        found.push(...result.files)
        if (!result.nextPageToken) return found
        if (seen.has(result.nextPageToken)) throw new CustomerFolderHeldError('customer_folder_search_incomplete')
        seen.add(result.nextPageToken); pageToken = result.nextPageToken
      }
      throw new CustomerFolderHeldError('customer_folder_search_incomplete')
    },
    async generateIds(count) {
      if (count === 0) return []
      const result = await googleDriveJson<{ ids: string[] }>(runtime,
        `/drive/v3/files/generateIds?${new URLSearchParams({ count: String(count), space: 'drive', type: 'files' })}`)
      return result.ids
    },
    async create(input) {
      try {
        await googleDriveJson(runtime, `/drive/v3/files?${new URLSearchParams({ supportsAllDrives: 'true', fields: 'id' })}`, {
          method: 'POST', idempotent: true, body: { id: input.id, name: input.name,
            mimeType: 'application/vnd.google-apps.folder', parents: [input.parentId], appProperties: input.properties },
        })
      } catch (error) {
        // A pre-generated ID conflict is not success by itself. The coordinator
        // independently verifies that exact ID, parent, drive and identity.
        if (!(error instanceof GoogleWorkspaceClientError && error.upstreamStatus === 409)) throw error
      }
    },
  }
}
