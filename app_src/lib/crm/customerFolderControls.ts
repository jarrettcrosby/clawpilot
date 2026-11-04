/** Client-safe command/DTO contract. Never resolves or fetches a supplied URL. */
export type CustomerFolderControlsState = {
  account: { id: string; globalId: string; name: string; isCustomer: boolean; hasManualLink: boolean };
  canEdit: boolean; canConfigure: boolean;
  settings: { enabled: boolean; revision: number; parentUrl: string | null };
  job: { status: 'queued'|'processing'|'ready'|'held'; version: number; errorCode: string | null } | null;
  folder: { url: string; publicationStatus: 'pending'|'published'|'manual_override' } | null;
}
export class CustomerFolderCommandError extends Error {
  readonly status = 400
  constructor(readonly code = 'customer_folder_command_invalid') { super(code); this.name='CustomerFolderCommandError' }
}
export function customerFolderUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw new CustomerFolderCommandError()
  return value
}
export function customerDriveFolderId(value: unknown): string {
  if (typeof value !== 'string') throw new CustomerFolderCommandError('customer_folder_google_url_required')
  const input=value.trim()
  if (/^[A-Za-z0-9_-]{1,256}$/.test(input)) return input
  // Only Google's exact folder URL is parsed. Custom shortlinks must be opened
  // by the operator to select the actual root, never fetched server-side.
  const match=/^https:\/\/drive\.google\.com\/drive\/folders\/([A-Za-z0-9_-]{1,256})(?:\?[^\s#\\]*)?$/.exec(input)
  if (!match) throw new CustomerFolderCommandError('customer_folder_google_url_required')
  const url=new URL(input)
  if (url.username || url.password || url.hash) throw new CustomerFolderCommandError('customer_folder_google_url_required')
  return match[1]
}
export type CustomerFolderCommand = { pipelineId: string; accountId: string } & (
  { action:'configure'; parentId:string; enabled:boolean; expectedRevision:number } |
  { action:'queue'; adoptRootId?:string; expectedRevision:number; expectedJobVersion:number; requestKey:string })
export function parseCustomerFolderCommand(input: unknown): CustomerFolderCommand {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw new CustomerFolderCommandError()
  const body=input as Record<string,unknown>,base={pipelineId:customerFolderUuid(body.pipelineId),accountId:customerFolderUuid(body.accountId)}
  const keys=body.action==='configure'?['action','pipelineId','accountId','parentId','enabled','expectedRevision']
    :['action','pipelineId','accountId','adoptRootId','expectedRevision','expectedJobVersion','requestKey']
  if (Object.keys(body).some(key=>!keys.includes(key)) || !Number.isSafeInteger(body.expectedRevision)
    || Number(body.expectedRevision)<0) throw new CustomerFolderCommandError()
  if (body.action==='configure') {
    if (typeof body.enabled!=='boolean') throw new CustomerFolderCommandError()
    return {...base,action:'configure',parentId:customerDriveFolderId(body.parentId),enabled:body.enabled,expectedRevision:Number(body.expectedRevision)}
  }
  if (body.action!=='queue' || !Number.isSafeInteger(body.expectedJobVersion) || Number(body.expectedJobVersion)<0) throw new CustomerFolderCommandError()
  return {...base,action:'queue',expectedRevision:Number(body.expectedRevision),expectedJobVersion:Number(body.expectedJobVersion),
    requestKey:customerFolderUuid(body.requestKey),...(body.adoptRootId===undefined?{}:{adoptRootId:customerDriveFolderId(body.adoptRootId)})}
}
