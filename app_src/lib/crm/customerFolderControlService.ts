import { resolveCustomerFolderGoogleRuntime } from './customerDriveFolderGoogle'
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
    const runtime=await resolveCustomerFolderGoogleRuntime(command.parentId)
    await saveVerifiedCustomerFolderSettings({...context,parentId:command.parentId,sharedDriveId:runtime.sharedDriveId,
      serviceAccountEmail:runtime.serviceAccountEmail,enabled:command.enabled,expectedRevision:command.expectedRevision})
  }
  return readCustomerFolderControls(context)
}
