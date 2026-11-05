import { resolveGoogleWorkspacePrivateFileRuntime, resolveManagedGoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspace'
import { googleDriveJson } from '@/lib/integrations/googleWorkspaceClient'
import { readCustomerFolderControls, requestCustomerFolderJob, saveVerifiedCustomerFolderSettings, pauseCustomerFolderSettings } from '@/lib/persistence/crmCustomerFolderControls'
import { CustomerFolderHeldError } from './customerDriveFolders'
import type { CustomerFolderCommand } from './customerFolderControls'

export async function applyCustomerFolderCommand(command:CustomerFolderCommand,actorEmail:string) {
  const context={pipelineId:command.pipelineId,accountId:command.accountId,actorEmail}
  // Resolve live scope before obtaining credentials or querying any provider.
  const state=await readCustomerFolderControls(context)
  if(!state.canEdit)throw new CustomerFolderHeldError('customer_folder_customer_editor_required')
  if(command.action==='queue')await requestCustomerFolderJob({...command,actorEmail})
  else {
    if(!state.canConfigure)throw new CustomerFolderHeldError('customer_folder_admin_required')
    if(state.settings.revision!==command.expectedRevision){
      if(state.settings.revision===command.expectedRevision+1&&state.settings.enabled===command.enabled
        &&state.settings.parentUrl===`https://drive.google.com/drive/folders/${command.parentId}`)return state
      throw new CustomerFolderHeldError('customer_folder_settings_changed')
    }
    if(!command.enabled&&state.settings.parentUrl===`https://drive.google.com/drive/folders/${command.parentId}`){
      await pauseCustomerFolderSettings({...context,parentId:command.parentId,expectedRevision:command.expectedRevision})
      return readCustomerFolderControls(context)
    }
    const runtime=await resolveGoogleWorkspacePrivateFileRuntime()
    const folder=await googleDriveJson<{id:string;name:string;mimeType:string;trashed:boolean;driveId:string;
      capabilities?:{canAddChildren?:boolean}}>(runtime,`/drive/v3/files/${command.parentId}?${new URLSearchParams({
        supportsAllDrives:'true',fields:'id,name,mimeType,trashed,driveId,capabilities(canAddChildren)'})}`)
    if(folder.id!==command.parentId||folder.name!=='01 Customers'||folder.mimeType!=='application/vnd.google-apps.folder'
      ||folder.trashed!==false||!/^[A-Za-z0-9_-]{1,256}$/.test(folder.driveId)||folder.capabilities?.canAddChildren!==true) {
      throw new CustomerFolderHeldError('customer_folder_customers_parent_required')
    }
    // Customer folders can live in BPO's existing shared drive, independently
    // of the platform's selected managed-pipeline workbook drive.
    await resolveManagedGoogleWorkspaceRuntime({serviceAccountEmail:runtime.serviceAccountEmail,sharedDriveId:folder.driveId})
    await saveVerifiedCustomerFolderSettings({...context,parentId:folder.id,sharedDriveId:folder.driveId,
      serviceAccountEmail:runtime.serviceAccountEmail,enabled:command.enabled,expectedRevision:command.expectedRevision})
  }
  return readCustomerFolderControls(context)
}
