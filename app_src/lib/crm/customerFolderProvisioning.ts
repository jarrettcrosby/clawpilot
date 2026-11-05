import { postgresCustomerFolderStore } from '@/lib/persistence/crmCustomerFolders'
import { reconcileCrmBoardProjectionsForPipeline } from './boardProjection'
import { provisionBpoCustomerFolders, type CustomerFolderScope } from './customerDriveFolders'
import { customerFolderGoogleDrive, resolveCustomerFolderGoogleRuntime } from './customerDriveFolderGoogle'

/** Internal composition; callers must select the configured customer parent,
 * not a browser-supplied arbitrary Drive location. Storage independently
 * rechecks exact live account/editor authority at reservation and publication. */
export async function provisionCustomerAccountFolder(input: {
  scope: CustomerFolderScope; customerName: string; actorEmail: string; adoptRootId?: string;
}) {
  const runtime = await resolveCustomerFolderGoogleRuntime(input.scope.customersParentId, {
    serviceAccountEmail: input.scope.serviceAccountEmail, sharedDriveId: input.scope.sharedDriveId,
  })
  const result = await provisionBpoCustomerFolders({ scope: input.scope, customerName: input.customerName,
    adoptRootId: input.adoptRootId, drive: customerFolderGoogleDrive(runtime,input.scope),
    store: postgresCustomerFolderStore(input.actorEmail) })
  // Same existing projection path used by account edits. If reconciliation
  // fails after commit, retry the exact reservation: publication is idempotent
  // and manual overrides remain intact, while card reconciliation runs again.
  await reconcileCrmBoardProjectionsForPipeline({ pipelineId: input.scope.pipelineId })
  return result
}
