/** Customer folders are independent of pipeline workbook folders. The store
 * must durably reserve the entire plan before the first provider create. */
export const BPO_CUSTOMER_FOLDER_LAYOUT = [
  ['root', ''], ['account', '00 Account'], ['discovery', '01 Discovery & Data'],
  ['proposals', '02 Proposals'], ['contracts', '03 Contracts'],
  ['delivery', '04 Delivery'], ['reporting', '05 Reporting'], ['meetings', '06 Meetings'],
] as const
export type CustomerFolderNodeKey = (typeof BPO_CUSTOMER_FOLDER_LAYOUT)[number][0]
export type CustomerFolderScope = {
  workspaceId: string; pipelineId: string; accountId: string; accountGlobalId: string;
  sharedDriveId: string; customersParentId: string; serviceAccountEmail: string;
}
export type CustomerFolderNode = { key: CustomerFolderNodeKey; id: string; name: string; adopted: boolean }
export type CustomerFolderPlan = { version: 1; scope: CustomerFolderScope; nodes: CustomerFolderNode[] }
export type CustomerDriveFile = {
  id: string; name: string; mimeType: string; driveId: string; parents: string[];
  trashed: boolean; appProperties?: Record<string, string>;
}
export interface CustomerFolderDrive {
  get(id: string): Promise<CustomerDriveFile | null>;
  namedChildren(parentId: string, name: string): Promise<CustomerDriveFile[]>;
  generateIds(count: number): Promise<string[]>;
  create(input: { id: string; name: string; parentId: string; properties: Record<string, string> }): Promise<void>;
}
export interface CustomerFolderStore {
  read(scope: CustomerFolderScope): Promise<CustomerFolderPlan | null>;
  /** Atomic compare/insert. Concurrent callers must receive the same winner. */
  reserve(plan: CustomerFolderPlan): Promise<CustomerFolderPlan>;
  complete(plan: CustomerFolderPlan): Promise<void>;
}
export class CustomerFolderHeldError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CustomerFolderHeldError' }
}
function requireFolder(value: unknown, code: string): asserts value {
  if (!value) throw new CustomerFolderHeldError(code)
}
const resourceId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
export function validateCustomerFolderScope(scope: CustomerFolderScope): void {
  requireFolder(scope && Object.keys(scope).sort().join(',') === [
    'workspaceId','pipelineId','accountId','accountGlobalId','sharedDriveId','customersParentId','serviceAccountEmail',
  ].sort().join(',') && [scope.workspaceId, scope.pipelineId, scope.accountId].every(uuid)
    && /^ga(?:[0-9]{7}|[0-9a-v]{12})$/.test(scope.accountGlobalId)
    && resourceId(scope.sharedDriveId) && resourceId(scope.customersParentId)
    && typeof scope.serviceAccountEmail === 'string'
    && /^[a-z0-9._-]+@[a-z0-9.-]+\.gserviceaccount\.com$/.test(scope.serviceAccountEmail), 'customer_folder_scope_invalid')
}
export function assertCustomerFolderPlan(plan: CustomerFolderPlan, scope: CustomerFolderScope): void {
  validateCustomerFolderScope(scope)
  requireFolder(plan?.version === 1 && Object.keys(plan).sort().join(',') === 'nodes,scope,version'
    && Object.keys(plan.scope).length === Object.keys(scope).length
    && Object.entries(scope).every(([key, value]) => plan.scope[key as keyof CustomerFolderScope] === value)
    && Array.isArray(plan.nodes) && plan.nodes.length === BPO_CUSTOMER_FOLDER_LAYOUT.length, 'customer_folder_plan_mismatch')
  const ids = new Set<string>([scope.sharedDriveId, scope.customersParentId])
  for (const [index, node] of plan.nodes.entries()) {
    requireFolder(Object.keys(node).sort().join(',') === 'adopted,id,key,name'
      && node.key === BPO_CUSTOMER_FOLDER_LAYOUT[index][0] && resourceId(node.id) && !ids.has(node.id)
      && typeof node.adopted === 'boolean' && typeof node.name === 'string' && node.name.length > 0
      && node.name.length <= 100 && !/[\u0000-\u001f\u007f/\\]/.test(node.name)
      && (index === 0 || node.name === BPO_CUSTOMER_FOLDER_LAYOUT[index][1]), 'customer_folder_plan_invalid')
    ids.add(node.id)
  }
}
function properties(scope: CustomerFolderScope, key: CustomerFolderNodeKey) {
  return { clawpilotResource: 'customer-folder-v1', workspaceId: scope.workspaceId,
    pipelineId: scope.pipelineId, accountGlobalId: scope.accountGlobalId, customerFolderNode: key }
}
function verifyFile(file: CustomerDriveFile | null, id: string, scope: CustomerFolderScope, parentId?: string) {
  requireFolder(file && file.id === id && file.mimeType === 'application/vnd.google-apps.folder'
    && file.driveId === scope.sharedDriveId && file.trashed === false && Array.isArray(file.parents)
    && (!parentId || file.parents.length === 1 && file.parents[0] === parentId), 'customer_folder_provider_mismatch')
  return file
}
function verifyNode(file: CustomerDriveFile | null, node: CustomerFolderNode, plan: CustomerFolderPlan) {
  const parent = node.key === 'root' ? plan.scope.customersParentId : plan.nodes[0].id
  const verified = verifyFile(file, node.id, plan.scope, parent)
  const expected = properties(plan.scope, node.key), tags = verified.appProperties ?? {}
  // Explicit adoption may leave existing metadata untouched, but never adopt
  // an object claimed by another account/pipeline or another managed resource.
  requireFolder(Object.entries(expected).every(([key, value]) => node.adopted
    ? tags[key] === undefined || tags[key] === value : tags[key] === value), 'customer_folder_identity_conflict')
}
function folderName(value: string) {
  requireFolder(typeof value === 'string', 'customer_folder_name_invalid')
  const name = value.replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
  requireFolder(name.length > 0, 'customer_folder_name_invalid')
  return name
}

/** No name-only root adoption, sharing changes, folder moves or deletion.
 * Retries use persisted Drive IDs, including after a successful create whose
 * response was lost. GET failure is not interpreted as provider absence. */
export async function provisionBpoCustomerFolders(input: {
  scope: CustomerFolderScope; customerName: string; adoptRootId?: string;
  drive: CustomerFolderDrive; store: CustomerFolderStore;
}): Promise<{ rootId: string; url: string; plan: CustomerFolderPlan }> {
  const { scope, drive, store } = input
  validateCustomerFolderScope(scope)
  if (input.adoptRootId !== undefined) requireFolder(resourceId(input.adoptRootId), 'customer_folder_adoption_invalid')
  let plan = await store.read(scope)
  await drive.get(scope.customersParentId).then(file => verifyFile(file, scope.customersParentId, scope))
  if (!plan) {
    const name = folderName(input.customerName)
    const adopted = new Map<CustomerFolderNodeKey, string>()
    if (input.adoptRootId) {
      verifyFile(await drive.get(input.adoptRootId), input.adoptRootId, scope, scope.customersParentId)
      adopted.set('root', input.adoptRootId)
      for (const [key, childName] of BPO_CUSTOMER_FOLDER_LAYOUT.slice(1)) {
        const matches = await drive.namedChildren(input.adoptRootId, childName)
        requireFolder(matches.length <= 1, 'customer_folder_duplicate_children')
        if (matches[0]) {
          verifyFile(matches[0], matches[0].id, scope, input.adoptRootId)
          adopted.set(key, matches[0].id)
        }
      }
    } else {
      const matches = await drive.namedChildren(scope.customersParentId, name)
      requireFolder(matches.length === 0, 'customer_folder_existing_root_requires_adoption')
    }
    const ids = await drive.generateIds(BPO_CUSTOMER_FOLDER_LAYOUT.length - adopted.size)
    requireFolder(ids.length === BPO_CUSTOMER_FOLDER_LAYOUT.length - adopted.size
      && ids.every(resourceId) && new Set(ids).size === ids.length, 'customer_folder_generated_ids_invalid')
    let next = 0
    const candidate: CustomerFolderPlan = { version: 1, scope: { ...scope },
      nodes: BPO_CUSTOMER_FOLDER_LAYOUT.map(([key, childName]) => ({ key, name: key === 'root' ? name : childName,
        id: adopted.get(key) ?? ids[next++], adopted: adopted.has(key) })) }
    assertCustomerFolderPlan(candidate, scope)
    // Inspect adopted identity before ANY create or durable association.
    for (const node of candidate.nodes.filter(node => node.adopted)) verifyNode(await drive.get(node.id), node, candidate)
    plan = await store.reserve(candidate)
  }
  assertCustomerFolderPlan(plan, scope)
  if (input.adoptRootId) requireFolder(plan.nodes[0].id === input.adoptRootId, 'customer_folder_adoption_changed')
  for (const node of plan.nodes) {
    const found = await drive.get(node.id)
    if (!found) {
      requireFolder(!node.adopted, 'customer_folder_adopted_folder_missing')
      await drive.create({ id: node.id, name: node.name,
        parentId: node.key === 'root' ? scope.customersParentId : plan.nodes[0].id,
        properties: properties(scope, node.key) })
    }
    verifyNode(found ?? await drive.get(node.id), node, plan)
  }
  // Completion requires independent readback of the entire hierarchy.
  for (const node of plan.nodes) verifyNode(await drive.get(node.id), node, plan)
  await store.complete(plan)
  return { rootId: plan.nodes[0].id, url: `https://drive.google.com/drive/folders/${plan.nodes[0].id}`, plan }
}
