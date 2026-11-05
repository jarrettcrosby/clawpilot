import { collectRootEmployeeCrmAccessWithClient } from '../persistence/crmRootEmployeeAccess'
import { lockCrmNativeEmailAuthorityWithClient } from '../persistence/crmNativeEmailAuthority'
import { deriveRootEmployeeCrmReadScope, type RootEmployeeCrmAccessSource } from './rootEmployeeCrmAccess'
import { requireNativeEmail } from './nativeEmailPublication'
import type { NativeEmailSqlClient } from './nativeEmailPublicationPostgres'
import type { NativeEmailRootReaderProjection } from './nativeEmailEligibility'
import type { NativeEmailWorkspaceUserEligibilityChange } from './nativeEmailWorkspaceUserEligibility'
import type { NativeEmailUserIdentityLinkChange } from './nativeEmailIdentityLinkChange'
import { collectRootEmployeeCrmRegistryPreviewWithClient } from '../persistence/crmRootEmployeeRegistryPreview'
import { prepareRootEmployeeCrmRegistryChange, type RootEmployeeCrmRegistryChange } from './rootEmployeeCrmRegistryChange'
export { prepareRootEmployeeCrmRegistryChange }

export type NativeEmailRootSource = { source: RootEmployeeCrmAccessSource; registryHash: string }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/

/** Complete native source snapshots retain unrelated operator accounts. New
 * selected intent is projected only by the locked owner-authorized collector;
 * neither this preview nor its context hash is an execution receipt. */
export async function collectNativeEmailRootRegistryPreviewWithClient(client: NativeEmailSqlClient, input: {
  actorEmail: string; actorWorkspaceId: string; change: RootEmployeeCrmRegistryChange
  pipelineIds: string[]; current: 'before' | 'after'
}) {
  const selected = await collectRootEmployeeCrmRegistryPreviewWithClient(client, input)
  const unrelated = (await collectNativeEmailRootSourcesWithClient(client, input.pipelineIds))
    .filter(row => row.source.anchor.id !== input.change.operatorAccountId)
  const merge = (rows: NativeEmailRootSource[]) => {
    const result = [...unrelated, ...rows].sort((a,b) => a.source.grant.id < b.source.grant.id ? -1 : a.source.grant.id > b.source.grant.id ? 1 : 0)
    requireNativeEmail(result.length <= 500 && new Set(result.map(row => row.source.grant.id)).size === result.length, 'authority_root_reader_bound')
    return result
  }
  return { ...selected, before: merge(selected.before), after: merge(selected.after) }
}

/** Private locked source inventory, not public authorization or an activation
 * switch. Disabled/denied intent stays fingerprinted so it cannot disappear
 * from a transition preimage. No target membership or private board is created. */
export async function collectNativeEmailRootSourcesWithClient(client: NativeEmailSqlClient, pipelineIds: string[]): Promise<NativeEmailRootSource[]> {
  requireNativeEmail(pipelineIds.length > 0 && pipelineIds.length <= 100 && pipelineIds.every(id=>UUID.test(id))
    && JSON.stringify(pipelineIds)===JSON.stringify([...new Set(pipelineIds)].sort()), 'authority_pipeline_scope')
  await lockCrmNativeEmailAuthorityWithClient(client)
  const grants = (await client.query(`SELECT DISTINCT g.id::text,a.owner_email FROM crm_root_employee_access_grants g
    JOIN crm_operator_accounts a ON a.id=g.operator_account_id
    JOIN crm_operator_workspace_bindings b ON b.operator_account_id=a.id
    JOIN pipeline_spaces p ON p.workspace_organization_id=b.workspace_id
    WHERE p.id=ANY($1::uuid[]) ORDER BY g.id::text LIMIT 501`, [pipelineIds])).rows
  requireNativeEmail(grants.length <= 500, 'authority_root_reader_bound')
  const result: NativeEmailRootSource[] = []
  for (const grant of grants) {
    const selected = await collectRootEmployeeCrmAccessWithClient(client, {
      actorEmail: String(grant.owner_email), grantId: String(grant.id), readInactivePreimage: true, nativePipelineIds: pipelineIds,
    })
    result.push({source: selected.source,registryHash: selected.registryHash})
  }
  return result
}

/** Rebuild both stages from exact typed lifecycle rows, not a virtual target
 * membership. Ordinary source suspension/CRM denial must revoke root reads in
 * every bound business even when the global user stays active elsewhere. */
export function projectNativeEmailRootReaders(input: {
  sources: NativeEmailRootSource[]; pipelineId: string; workspaceId: string
  lifecycle?: NativeEmailWorkspaceUserEligibilityChange; identityLink?: NativeEmailUserIdentityLinkChange; stage: 'before' | 'after'
}): NativeEmailRootReaderProjection[] {
  requireNativeEmail(UUID.test(input.pipelineId) && UUID.test(input.workspaceId), 'authority_root_pipeline_scope')
  return input.sources.map(evidence=>{
    const source = JSON.parse(JSON.stringify(evidence.source)) as RootEmployeeCrmAccessSource
    // Identity linking changes the source principal, never any inherited
    // target membership or role. The caller has independently checked that
    // this native ID is unclaimed (before) or claimed by this user (after).
    if(input.identityLink && source.user.email===input.identityLink.userEmail){
      const user=JSON.parse(input.identityLink.appUser[input.stage==='before'?'beforeJson':'afterJson'])
      source.user.suiteCrmUserId=user.suitecrm_user_id
      source.user.nativeIdentityCount=user.suitecrm_user_id===null?0:1
    }
    const change = input.lifecycle
    if(change){
      const user = JSON.parse(change.appUser[input.stage==='before'?'beforeJson':'afterJson']) as Record<string,unknown>
      const membership = JSON.parse(change.membership[input.stage==='before'?'beforeJson':'afterJson']) as Record<string,unknown>
      const replace = (value: RootEmployeeCrmAccessSource['sourceMembership']) => {
        if(value.userEmail!==change.userEmail || value.workspaceId!==change.workspaceId)return
        value.status=membership.status as typeof value.status;value.role=membership.role as typeof value.role
        value.trashed=membership.trashed_at!==null
        const permissions=membership.permissions as Record<string,unknown>
        value.viewCrm=value.role==='owner'||permissions.viewCrm!==false
      }
      if(source.user.email===change.userEmail)source.user.status=user.status as typeof source.user.status
      if(source.operator.email===change.userEmail)source.operator.status=user.status as typeof source.operator.status
      replace(source.sourceMembership);replace(source.operator.membership)
      for(const target of source.targets){replace(target.ownerMembership);if(target.employeeMembership)replace(target.employeeMembership)}
    }
    const scope = deriveRootEmployeeCrmReadScope(source)
    return {pipeline_id:input.pipelineId,workspace_id:input.workspaceId,grant_id:scope.grantId,operator_account_id:scope.anchorId,
      email:scope.userEmail,suitecrm_user_id:scope.suiteCrmUserId,native_identity_count:source.user.nativeIdentityCount,
      source_fingerprint:scope.sourceHash,registry_fingerprint:evidence.registryHash,
      allowed:scope.edges.some(edge=>edge.kind==='pipeline'&&edge.resourceId===input.pipelineId&&edge.workspaceId===input.workspaceId)}
  }).sort((a,b)=>a.grant_id<b.grant_id?-1:a.grant_id>b.grant_id?1:0)
}
