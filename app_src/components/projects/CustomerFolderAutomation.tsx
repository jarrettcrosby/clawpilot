'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import Link from '@mui/material/Link'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { CustomerFolderCommand, CustomerFolderControlsState } from '@/lib/crm/customerFolderControls'

const messages:Record<string,string>={
  customer_folder_existing_root_requires_adoption:'An existing folder needs to be connected explicitly. Choose “Connect existing folder” and paste the customer root’s Google Drive URL.',
  customer_folder_existing_link_requires_adoption:'This customer already has a BPO link. Connect its existing customer root; the saved link will not be repointed.',
  customer_folder_customers_parent_required:'Select the shared-drive folder named “01 Customers” where the connected Google account can add folders.',
  customer_folder_settings_changed:'The setup changed. Refresh status and reopen the setup form before saving.',
  customer_folder_job_changed:'Another request changed this job. Refresh its status before retrying.',
  customer_folder_job_busy:'This customer folder is already being processed. Refresh its status.',
  customer_folder_adoption_changed:'A different customer root has already been reserved. Review the existing job rather than creating another folder.',
  customer_folder_google_url_required:'Use the actual Google Drive folder URL or folder ID, not a shortlink or document URL.',
  customer_folder_description_requires_repair:'Repair duplicate or malformed folder-link lines in the customer description first.',
}
type Props={pipelineId:string;accountId:string;readOnly:boolean;disabled?:boolean}
type QueueCommand=Extract<CustomerFolderCommand,{action:'queue'}>

export default function CustomerFolderAutomation({pipelineId,accountId,readOnly,disabled=false}:Props) {
  const titleId=useId(),[open,setOpen]=useState(false),[state,setState]=useState<CustomerFolderControlsState|null>(null)
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('')
  const [configure,setConfigure]=useState(false),[parent,setParent]=useState(''),[enabled,setEnabled]=useState(false)
  const [configRevision,setConfigRevision]=useState(0),[mode,setMode]=useState<'create'|'adopt'>('create'),[adoptRoot,setAdoptRoot]=useState('')
  const submitting=useRef(false),reading=useRef(false),sequence=useRef(0),pending=useRef<QueueCommand|null>(null)
  const endpoint=`/api/crm/customer-folders?${new URLSearchParams({pipelineId,accountId})}`
  const jobStatus=state?.job?.status??null
  const explain=(body:{code?:string;error?:string})=>body.code&&messages[body.code]||body.error||'Folder controls are unavailable. Refresh status before retrying.'

  const refresh=useCallback(async(signal?:AbortSignal)=>{
    if(submitting.current||reading.current)return
    reading.current=true
    const request=++sequence.current
    setLoading(true)
    try{
      const response=await fetch(endpoint,{cache:'no-store',signal}),body=await response.json()
      if(!response.ok||body.ok!==true)throw Error(body.code&&messages[body.code]||body.error||'Unable to load folder status.')
      if(signal?.aborted||request!==sequence.current)return
      const next=body.state as CustomerFolderControlsState
      setState(next);setError('')
      if(pending.current&&next.job&&(next.job.version>pending.current.expectedJobVersion||next.job.status==='ready'))pending.current=null
    }catch(failure){if(!signal?.aborted&&request===sequence.current)setError(failure instanceof Error?failure.message:'Unable to load folder status.')}
    finally{reading.current=false;if(request===sequence.current)setLoading(false)}
  },[endpoint])

  useEffect(()=>{
    if(readOnly||!open||!jobStatus||!['queued','processing'].includes(jobStatus))return
    const controller=new AbortController()
    const timer=setInterval(()=>{void refresh(controller.signal)},5000)
    return()=>{clearInterval(timer);controller.abort()}
  },[readOnly,open,jobStatus,refresh])
  useEffect(()=>()=>{sequence.current++},[])

  async function send(command:CustomerFolderCommand) {
    if(submitting.current||readOnly||disabled)return
    submitting.current=true;sequence.current++;setLoading(false);setBusy(true);setError('')
    try{
      const response=await fetch('/api/crm/customer-folders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)})
      const body=await response.json()
      if(!response.ok||body.ok!==true){if(command.action==='queue'&&response.status<500)pending.current=null;throw Error(explain(body))}
      setState(body.state);pending.current=null
      if(command.action==='configure')setConfigure(false)
    }catch(failure){setError(failure instanceof Error?failure.message:'The result is unknown. Refresh status or retry this same request.')}
    finally{submitting.current=false;setBusy(false)}
  }
  function beginSetup(){if(!state)return
    setParent(state.settings.parentUrl??'');setEnabled(state.settings.enabled);setConfigRevision(state.settings.revision);setConfigure(true)}
  function queue(){if(!state)return
    if(!pending.current)pending.current={action:'queue',pipelineId,accountId,expectedRevision:state.settings.revision,
      expectedJobVersion:state.job?.version??0,requestKey:crypto.randomUUID(),...(mode==='adopt'?{adoptRootId:adoptRoot}:{})}
    void send(pending.current)
  }
  if(readOnly)return null
  const active=state?.job?.status==='queued'||state?.job?.status==='processing'
  return <>
    <Button size="small" variant="outlined" disabled={disabled} onClick={()=>{setOpen(true);setConfigure(false);void refresh()}}
      sx={{textTransform:'none',mb:1,ml:1}}>BPO folder setup &amp; status</Button>
    <Dialog open={open} aria-labelledby={titleId} onClose={()=>{if(!busy)setOpen(false)}} fullWidth maxWidth="sm">
      <DialogTitle id={titleId}>Customer folder automation</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{pt:1}}>
          <Typography variant="body2">Create or connect this customer’s BPO folder using the established seven-subfolder structure. Sharing permissions are unchanged. Fractional’s folder is managed separately.</Typography>
          {loading&&!state&&<Typography role="status">Loading folder status…</Typography>}
          {state&&<>
            <Typography variant="subtitle2">{state.account.name} · {state.account.globalId}</Typography>
            <Alert severity={state.settings.enabled?'info':'warning'}>
              {state.settings.enabled?'BPO folder creation is enabled for this organization.':'The ClawPilot owner must configure and enable the organization’s Customers parent first.'}
              {state.settings.parentUrl&&<> <Link href={state.settings.parentUrl} target="_blank" rel="noopener noreferrer">Open Customers parent</Link></>}
            </Alert>
            {state.canConfigure&&!configure&&<Button variant="text" onClick={beginSetup} disabled={busy}>Configure organization parent</Button>}
            {configure&&state.canConfigure&&<Stack spacing={1}>
              <Typography variant="body2">Organization setup applies to future customer accounts. It does not change any customer’s manually saved BPO or Fractional link.</Typography>
              <TextField label="01 Customers parent folder" value={parent} disabled={busy} onChange={event=>setParent(event.target.value)}
                helperText="Paste the actual Google Drive URL of the existing shared-drive folder named 01 Customers." slotProps={{htmlInput:{maxLength:2048}}}/>
              <FormControlLabel control={<Checkbox checked={enabled} disabled={busy} onChange={event=>setEnabled(event.target.checked)}/>}
                label="Enable BPO customer-folder creation"/>
              <Typography variant="caption" color="text.secondary">Saving verifies access to the parent. It does not create folders or backfill existing customers. Disabling stops new jobs; already-started work may finish.</Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="contained" disabled={busy||!parent.trim()} onClick={()=>{void send({action:'configure',pipelineId,accountId,
                  parentId:parent,enabled,expectedRevision:configRevision})}}>Verify &amp; save setup</Button>
                <Button disabled={busy} onClick={()=>setConfigure(false)}>Cancel setup</Button>
              </Stack>
            </Stack>}
            {!state.account.isCustomer&&<Alert severity="info">Only non-workspace accounts typed Customer can receive a managed customer folder. Suppliers and other records can keep manually supplied links.</Alert>}
            {state.folder&&<Alert severity="success">Folder verified. <Link href={state.folder.url} target="_blank" rel="noopener noreferrer">Open customer root</Link>
              {state.folder.publicationStatus==='manual_override'?' Your manual BPO link or its removal is preserved.':' Its link is saved in ClawPilot; SuiteCRM follows the normal synchronization queue.'}</Alert>}
            {state.job&&<Typography role="status">Folder job: {state.job.status}{state.job.errorCode?` — ${messages[state.job.errorCode]||'Review setup and retry this customer’s job.'}`:''}</Typography>}
            {!state.folder&&state.account.isCustomer&&state.canEdit&&<>
              {state.account.hasManualLink&&<Alert severity="info">A BPO link is already saved. Connect its existing customer root rather than creating a second folder.</Alert>}
              <TextField select label="Folder action" value={mode} disabled={busy||active||Boolean(pending.current)} onChange={event=>setMode(event.target.value as 'create'|'adopt')}>
                <MenuItem value="create">Create customer folder</MenuItem><MenuItem value="adopt">Connect existing folder</MenuItem>
              </TextField>
              {mode==='adopt'&&<TextField label="Existing customer root folder" value={adoptRoot} disabled={busy||active||Boolean(pending.current)}
                onChange={event=>setAdoptRoot(event.target.value)} helperText="Use the customer root’s Google Drive URL, not an invoice subfolder or shortlink."
                slotProps={{htmlInput:{maxLength:2048}}}/>}
            </>}
            {state.account.isCustomer&&state.canEdit&&state.job?.status!=='ready'&&<Button variant="contained"
              disabled={busy||active||!state.settings.enabled||(!pending.current&&mode==='adopt'&&!adoptRoot.trim())
                ||(!pending.current&&!state.folder&&state.account.hasManualLink&&mode==='create')}
              onClick={queue}>{pending.current?'Retry same request':state.job?.status==='held'?'Retry folder job':mode==='adopt'?'Connect existing folder':'Create customer folder'}</Button>}
          </>}
          {error&&<Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions><Button disabled={busy||loading} onClick={()=>{void refresh()}}>Refresh status</Button>
        <Button disabled={busy} onClick={()=>setOpen(false)}>Close</Button></DialogActions>
    </Dialog>
  </>
}
