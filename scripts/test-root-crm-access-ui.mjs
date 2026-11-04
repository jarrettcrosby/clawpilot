#!/usr/bin/env node
// Real React/MUI controls; isolated API responses, no production/provider writes.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const root=process.cwd(),require=createRequire(join(root,'app_src/package.json'))
const {chromium,expect}=require('@playwright/test'),webpack=require('next/dist/compiled/webpack/webpack').webpack
const output=await mkdtemp(join(tmpdir(),'clawpilot-root-crm-ui-'))
let browser,server
try{
 await new Promise((done,reject)=>{
  const compiler=webpack({mode:'development',devtool:false,cache:false,
   entry:join(root,'scripts/fixtures/root-crm-access-ui.tsx'),output:{path:output,filename:'fixture.js'},
   resolve:{extensions:['.tsx','.ts','.js','.mjs','.json'],modules:[join(root,'app_src/node_modules'),'node_modules'],alias:{'@':join(root,'app_src')}},
   module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:join(root,'scripts/lib/shortlink-ui-ts-loader.cjs')}]}})
  compiler.run((error,stats)=>compiler.close(()=>error||stats?.hasErrors()?reject(error||new Error(stats.toString({all:false,errors:true}))):done()))
 })
 const bundle=await readFile(join(output,'fixture.js'))
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html')
  res.end(req.url==='/fixture.js'?bundle:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>')})
 await new Promise(done=>server.listen(0,'127.0.0.1',done))
 browser=await chromium.launch({headless:true})
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[],writes=[]
 await page.addInitScript(()=>{window.process={env:{NODE_ENV:'development'}}})
 page.on('pageerror',error=>errors.push(error.message))
 const workspace='00000000-0000-4000-8000-000000000001',peer='00000000-0000-4000-8000-000000000002'
 const unavailable='00000000-0000-4000-8000-000000000003',email='employee@example.invalid'
 const url=`http://127.0.0.1:${server.address().port}`
 let revision=1,behavior='normal',readBehavior='normal',holdRelease=null,state
 const reset=()=>{revision=1;behavior='normal';readBehavior='normal';state={workspaceId:workspace,workspaceName:'BPO Supply Chain',registryVersion:'1'.repeat(64),
  configured:false,enabled:false,workspaces:[{id:workspace,name:'BPO Supply Chain',selected:false,available:true},
   {id:peer,name:'Suburbia Sandwich Co',selected:false,available:true},{id:unavailable,name:'Other operator',selected:false,available:false}],
  employees:[{email,displayName:'Employee',status:'active',enabled:false,crmAllowed:true}],pending:null}}
 const advance=()=>{state.registryVersion=(++revision).toString(16).padStart(64,'0')}
 reset()
 await page.route('**/api/crm/root-access',async route=>{
  const request=route.request(),reply=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
  if(request.method()==='GET'){
   if(readBehavior==='forbidden')return reply({ok:false,error:'Owner access required'},403)
   if(readBehavior==='failed')return reply({ok:false,error:'Read unavailable'},503)
   return reply({ok:true,settings:readBehavior==='wrong-workspace'?{...state,workspaceId:peer}:state})
  }
  const body=request.postDataJSON();writes.push(body)
  if(behavior==='stale')return reply({ok:false,error:'CRM access changed. Reload and review the latest settings.'},409)
  if(behavior==='hold')await new Promise(resolve=>{holdRelease=resolve})
  if(body.action==='resume'){
   assert.deepEqual(body,{action:'resume',transitionId:state.pending.transitionId});state.pending=null
  }else if(body.action==='configure'){
   assert.deepEqual(Object.keys(body).sort(),['action','enabled','registryVersion','workspaceIds'])
   assert.equal(body.registryVersion,state.registryVersion);state.configured=true;state.enabled=body.enabled
   for(const row of state.workspaces)row.selected=body.workspaceIds.includes(row.id)
  }else{
   assert.deepEqual(Object.keys(body).sort(),['action','enabled','registryVersion','userEmail'])
   assert.equal(body.registryVersion,state.registryVersion);state.employees.find(row=>row.email===body.userEmail).enabled=body.enabled
  }
  advance()
  if(['pending','lost'].includes(behavior)){
   state.pending={transitionId:'b'.repeat(64),changes:2}
   if(behavior==='lost'){readBehavior='failed';return route.abort('connectionreset')}
   return reply({ok:false,error:'CRM access change is pending.'},409)
  }
  return reply({ok:true,settings:state})
 })
 const save=page.getByRole('button',{name:'Save CRM business scope',exact:true})
 const employee=page.getByRole('checkbox',{name:`Company-wide CRM access for ${email}`,exact:true})
 const reload=page.getByRole('button',{name:'Reload CRM access',exact:true})
 await page.goto(url)
 await expect(page.getByRole('checkbox',{name:'Include BPO Supply Chain in CRM scope',exact:true})).toBeChecked()
 await expect(page.getByRole('checkbox',{name:'Include BPO Supply Chain in CRM scope',exact:true})).toBeDisabled()
 await expect(page.getByRole('checkbox',{name:'Include Other operator in CRM scope',exact:true})).toBeDisabled()
 await expect(employee).toBeDisabled();assert.equal(writes.length,0)
 await page.getByRole('checkbox',{name:'Enable company-wide CRM scope',exact:true}).check()
 await page.getByRole('checkbox',{name:'Include Suburbia Sandwich Co in CRM scope',exact:true}).check()
 behavior='hold';await save.click()
 await expect(page.locator('main')).toHaveAttribute('data-busy','true')
 await expect(employee).toBeDisabled();assert.equal(writes.length,1)
 assert.deepEqual(writes[0].workspaceIds,[workspace,peer])
 assert.ok(holdRelease);behavior='normal';holdRelease();holdRelease=null
 await expect(save).toBeDisabled();await expect(employee).toBeEnabled()
 await employee.click();await expect(employee).toBeChecked();await expect(page.getByText('CRM access settings saved.',{exact:true})).toBeVisible()
 await page.reload();await expect(employee).toBeChecked()
 console.log('PASS explicit business choices, saved employee readback, parent busy fencing and no rendering writes')

 behavior='pending';await employee.click()
 const resume=page.getByRole('button',{name:'Resume CRM access',exact:true})
 await expect(resume).toBeVisible();await expect(employee).toBeDisabled()
 assert.ok(!(await page.locator('body').innerText()).includes('b'.repeat(64)))
 await page.reload();await expect(resume).toBeEnabled();behavior='normal';await resume.click()
 await expect(resume).toHaveCount(0);await expect(employee).toBeEnabled()
 assert.deepEqual(writes.at(-1),{action:'resume',transitionId:'b'.repeat(64)})
 console.log('PASS durable pending readback and receipt-only Resume; no form or private authority replay')

 behavior='lost';const before=writes.length;await employee.click()
 await expect(page.getByRole('alert')).toContainText(/save could not be confirmed|Failed to fetch/i)
 await expect(employee).toBeDisabled();await expect(save).toBeDisabled()
 assert.equal(writes.length,before+1,'Unknown writes are never automatically repeated')
 readBehavior='normal';await reload.click();await expect(resume).toBeEnabled()
 behavior='normal';await resume.click();await expect(employee).toBeChecked()
 console.log('PASS lost write response plus failed read locks all writes until read-only recovery')

 behavior='stale';await employee.click()
 await expect(page.getByText('CRM access changed. Reload and review the latest settings.',{exact:true})).toBeVisible()
 await expect(employee).toBeChecked();behavior='normal'
 console.log('PASS stale form refusal restores server-confirmed intent without optimistic success')

 for(const mode of ['light','dark']){
  await page.setViewportSize({width:360,height:800});await page.goto(`${url}/?mode=${mode}`)
  await expect(employee).toBeVisible()
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile controls must not overflow')
  await page.screenshot({path:join(root,`output/local-validation/root-crm-access-${mode}-20261103-r315.png`),fullPage:true})
 }
 console.log('PASS light/dark mobile controls have accessible names and no horizontal overflow')

 readBehavior='wrong-workspace';await page.reload()
 await expect(page.getByText('The active organization changed. Reopen settings before editing CRM access.',{exact:true})).toBeVisible()
 await expect(employee).toHaveCount(0)
 readBehavior='forbidden';await page.reload()
 await expect(page.getByText('Company-wide CRM access',{exact:true})).toHaveCount(0)
 assert.deepEqual(errors,[])
 console.log('PASS fresh owner refusal and wrong-organization responses never expose usable stale controls')
 console.log('PASS 6 actual React/MUI browser groups with mocked API; no actual DAL/native/provider/production proof')
}finally{
 await browser?.close()
 if(server)await new Promise(resolve=>server.close(resolve))
 await rm(output,{recursive:true,force:true})
}
