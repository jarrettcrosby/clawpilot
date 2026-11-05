import { googleDriveJson, GoogleWorkspaceClientError, type GoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspaceClient'
import { resolveGoogleWorkspacePrivateFileRuntime } from '@/lib/integrations/googleWorkspace'
import { CustomerFolderHeldError, type CustomerFolderDrive, type CustomerFolderScope, type CustomerDriveFile,
  validateCustomerFolderScope } from './customerDriveFolders'

const fields = 'id,name,mimeType,driveId,parents,trashed,appProperties'
const literal = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

const resourceId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)

/** Customer-folder access is scoped to the configured parent, not membership
 * or sharing authority over the entire Shared Drive. Workbook rules stay separate. */
export async function resolveCustomerFolderGoogleRuntime(
  customersParentId: string,
  binding?: Pick<CustomerFolderScope, 'serviceAccountEmail' | 'sharedDriveId'>,
): Promise<GoogleWorkspaceRuntime & { sharedDriveId:string }> {
  if (!resourceId(customersParentId)) throw new CustomerFolderHeldError('customer_folder_resource_invalid')
  if (binding && (!resourceId(binding.sharedDriveId) || typeof binding.serviceAccountEmail !== 'string'
    || !/^[a-z0-9._-]+@[a-z0-9.-]+\.gserviceaccount\.com$/.test(binding.serviceAccountEmail))) {
    throw new CustomerFolderHeldError('customer_folder_runtime_mismatch')
  }
  const runtime = await resolveGoogleWorkspacePrivateFileRuntime()
  if (binding && runtime.serviceAccountEmail !== binding.serviceAccountEmail) {
    throw new CustomerFolderHeldError('customer_folder_runtime_mismatch')
  }
  const folder = await googleDriveJson<{id:string;name:string;mimeType:string;trashed:boolean;driveId:string;
    capabilities?:{canAddChildren?:boolean}}>(runtime, `/drive/v3/files/${customersParentId}?${new URLSearchParams({
      supportsAllDrives:'true',fields:'id,name,mimeType,trashed,driveId,capabilities(canAddChildren)'})}`)
  if (folder.id !== customersParentId || folder.name !== '01 Customers'
    || folder.mimeType !== 'application/vnd.google-apps.folder' || folder.trashed !== false
    || !resourceId(folder.driveId) || folder.capabilities?.canAddChildren !== true) {
    throw new CustomerFolderHeldError('customer_folder_customers_parent_required')
  }
  if (binding && folder.driveId !== binding.sharedDriveId) {
    throw new CustomerFolderHeldError('customer_folder_runtime_mismatch')
  }
  return { ...runtime, sharedDriveId:folder.driveId, sharedDriveName:null }
}

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
      if (!resourceId(parentId)) throw new CustomerFolderHeldError('customer_folder_resource_invalid')
      const found: CustomerDriveFile[] = []
      let pageToken = ''
      const seen = new Set<string>()
      for (let page = 0; page < 10; page++) {
        const parameters = new URLSearchParams({ supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
          // A folder contributor need not be a member of the whole drive.
          // Returned objects still undergo independent drive/parent checks.
          corpora: 'user', spaces: 'drive', pageSize: '100',
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
