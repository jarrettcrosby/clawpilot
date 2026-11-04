'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import CircularProgress from '@mui/material/CircularProgress'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import type { RootCrmSettings, RootCrmSettingsRequest } from '@/lib/crm/rootEmployeeCrmSettings'

type Payload = { ok?: boolean; error?: string; settings?: RootCrmSettings }
const selection = (settings: RootCrmSettings) => [...new Set([settings.workspaceId,...settings.workspaces.filter(row=>row.selected).map(row=>row.id)])].sort()

export default function RootCrmAccessPanel({ workspaceId, disabled = false, onBusyChange }: {
  workspaceId: string; disabled?: boolean; onBusyChange?: (busy: boolean) => void
}) {
  const [settings,setSettings] = useState<RootCrmSettings|null>(null)
  const [authorized,setAuthorized] = useState(true)
  const [loading,setLoading] = useState(true)
  const [busy,setBusy] = useState(false)
  const [enabled,setEnabled] = useState(false)
  const [workspaces,setWorkspaces] = useState<string[]>([])
  const [error,setError] = useState('')
  const [notice,setNotice] = useState('')
  const [needsRefresh,setNeedsRefresh] = useState(true)
  const mounted = useRef(false)
  const requestInFlight = useRef(false)
  const accept = useCallback((value: RootCrmSettings) => {
    if(value.workspaceId!==workspaceId)throw new Error('The active organization changed. Reopen settings before editing CRM access.')
    setSettings(value);setEnabled(value.enabled);setWorkspaces(selection(value));setNeedsRefresh(false)
  },[workspaceId])
  useEffect(()=>{
    mounted.current=true
    const controller=new AbortController()
    setLoading(true);setAuthorized(true);setError('');setNotice('');setSettings(null);setNeedsRefresh(true)
    void fetch('/api/crm/root-access',{cache:'no-store',credentials:'same-origin',signal:controller.signal})
      .then(async response=>{
        if(response.status===403){if(!controller.signal.aborted)setAuthorized(false);return}
        const result=await response.json() as Payload
        if(!response.ok||!result.ok||!result.settings)throw new Error(result.error||'CRM access settings are unavailable.')
        if(!controller.signal.aborted)accept(result.settings)
      }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'CRM access settings are unavailable.')})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return ()=>{mounted.current=false;controller.abort()}
  },[accept])
  async function refresh() {
    const response=await fetch('/api/crm/root-access',{cache:'no-store',credentials:'same-origin'})
    if(response.status===403){if(mounted.current){setAuthorized(false);setSettings(null)}return}
    const result=await response.json() as Payload
    if(!response.ok||!result.ok||!result.settings)throw new Error(result.error||'Reload CRM access settings.')
    if(mounted.current)accept(result.settings)
  }
  async function submit(command: RootCrmSettingsRequest) {
    if(requestInFlight.current||disabled||busy||!settings||needsRefresh)return
    requestInFlight.current=true;setBusy(true);onBusyChange?.(true);setError('');setNotice('')
    try{
      const response=await fetch('/api/crm/root-access',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)})
      const result=await response.json() as Payload
      if(!response.ok||!result.ok||!result.settings)throw new Error(result.error||'The save could not be confirmed. Reload to check for a saved change.')
      if(mounted.current){accept(result.settings);setNotice(command.action==='resume'?'Saved CRM access change completed.':'CRM access settings saved.')}
    }catch(reason){
      if(mounted.current){setNeedsRefresh(true);setError(reason instanceof Error?reason.message:'The save could not be confirmed. Reload before trying again.')}
      // A transport error has an unknown outcome. Read only; never replay the
      // mutation. A durable native change is shown with its exact Resume ID.
      try{await refresh()}catch{/* Preserve the original failure and offer Reload. */}
    }finally{requestInFlight.current=false;if(mounted.current)setBusy(false);onBusyChange?.(false)}
  }
  if(!authorized)return null
  const pending=settings?.pending
  const locked=disabled||busy||loading||needsRefresh||!!pending
  const savedSelection=settings?.workspaces.filter(row=>row.selected).map(row=>row.id).sort()??[]
  const dirty=!!settings&&(!settings.configured||enabled!==settings.enabled||JSON.stringify([...workspaces].sort())!==JSON.stringify(savedSelection))
  return <Box component="section" aria-labelledby="root-crm-access-title" sx={{p:2,mb:2.5,border:1,borderColor:'divider',borderRadius:2}}>
    <Typography id="root-crm-access-title" variant="subtitle2" fontWeight={700}>Company-wide CRM access</Typography>
    <Typography variant="body2" color="text.secondary" sx={{mt:0.5,mb:1.5}}>
      The owner chooses which businesses belong to this CRM scope. Selected employees can view every CRM pipeline and its managed project cards in those businesses.
      Private boards and independent editing permissions do not change.
    </Typography>
    {loading?<Stack direction="row" spacing={1} alignItems="center"><CircularProgress size={18}/><Typography variant="body2">Loading CRM access…</Typography></Stack>:null}
    {error?<Alert severity="error" sx={{mb:1.5}}>{error}</Alert>:null}
    {notice?<Alert severity="success" sx={{mb:1.5}}>{notice}</Alert>:null}
    {pending?<Alert severity="warning" sx={{mb:1.5}}>
      <Typography variant="body2" fontWeight={700}>CRM access change pending</Typography>
      <Typography variant="body2">Some access may already be updated. Resume the saved change; this does not submit form edits.</Typography>
      <Button size="small" variant="outlined" disabled={disabled||busy||needsRefresh} sx={{mt:1}} onClick={()=>{void submit({action:'resume',transitionId:pending.transitionId})}}>
        {busy?'Resuming CRM access…':'Resume CRM access'}
      </Button>
    </Alert>:null}
    {settings?<>
      <FormControlLabel label="Enable company-wide CRM scope" control={<Switch checked={enabled} disabled={locked}
        onChange={event=>setEnabled(event.target.checked)} slotProps={{input:{'aria-label':'Enable company-wide CRM scope'}}}/>}/>
      <Typography variant="body2" fontWeight={600} sx={{mt:1}}>Included businesses</Typography>
      <Stack sx={{maxHeight:220,overflowY:'auto',mb:1}}>
        {settings.workspaces.map(row=><FormControlLabel key={row.id} sx={{alignItems:'flex-start',mr:0}}
          label={<Typography variant="body2" sx={{pt:1,overflowWrap:'anywhere'}}>{row.name}{row.id===workspaceId?' (this organization)':!row.available?' — unavailable for new access':''}</Typography>}
          control={<Checkbox checked={workspaces.includes(row.id)} disabled={locked||row.id===workspaceId||!row.available&&!workspaces.includes(row.id)}
            onChange={event=>setWorkspaces(current=>event.target.checked?[...current,row.id].sort():current.filter(id=>id!==row.id))}
            slotProps={{input:{'aria-label':`Include ${row.name} in CRM scope`}}}/>}/>) }
      </Stack>
      <Stack direction={{xs:'column',sm:'row'}} spacing={1}>
        <Button variant="contained" disabled={locked||!dirty} onClick={()=>{void submit({action:'configure',enabled,workspaceIds:workspaces,registryVersion:settings.registryVersion})}}>
          {busy?'Saving CRM access…':'Save CRM business scope'}
        </Button>
        <Button variant="outlined" disabled={disabled||busy} onClick={()=>{setError('');setNotice('');void refresh().catch(reason=>setError(reason instanceof Error?reason.message:'Reload failed.'))}}>Reload CRM access</Button>
      </Stack>
      <Typography variant="body2" fontWeight={600} sx={{mt:2}}>Employee CRM scope</Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{mb:1}}>
        Save the business scope first. CRM module access, active membership and any explicit business-level denial still apply.
        Linking an existing SuiteCRM login remains a separate action on the user card.
      </Typography>
      {settings.employees.length?settings.employees.map(employee=><Stack key={employee.email} direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
        <Box minWidth={0}><Typography variant="body2" sx={{overflowWrap:'anywhere'}}>{employee.displayName||employee.email}</Typography>
          {employee.displayName?<Typography variant="caption" color="text.secondary" sx={{overflowWrap:'anywhere'}}>{employee.email}</Typography>:null}
          {!employee.crmAllowed||employee.status!=='active'?<Typography variant="caption" color="text.secondary" display="block">Not currently eligible: {employee.status!=='active'?employee.status:'CRM module access is off'}</Typography>:null}
        </Box>
        <Checkbox checked={employee.enabled} disabled={locked||dirty||!settings.configured||!settings.enabled}
          onChange={event=>{void submit({action:'employee',userEmail:employee.email,enabled:event.target.checked,registryVersion:settings.registryVersion})}}
          slotProps={{input:{'aria-label':`Company-wide CRM access for ${employee.email}`}}}/>
      </Stack>):<Typography variant="body2" color="text.secondary">No employees in this organization yet.</Typography>}
    </>:!loading?<Button variant="outlined" disabled={disabled||busy} onClick={()=>{void refresh().catch(reason=>setError(reason instanceof Error?reason.message:'Reload failed.'))}}>Reload CRM access</Button>:null}
  </Box>
}
