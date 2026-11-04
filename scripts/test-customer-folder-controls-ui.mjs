#!/usr/bin/env node
// Real React/MUI browser events with isolated API mocks. No application login,
// production/provider calls or database mutations; PG/API gates are separate.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const root=process.cwd(),require=createRequire(join(root,'app_src/package.json'))
const {chromium,expect}=require('@playwright/test'),webpack=require('next/dist/compiled/webpack/webpack').webpack
const output=await mkdtemp(join(tmpdir(),'clawpilot-customer-folder-ui-'))
const sourcePaths=['app_src/components/projects/CustomerFolderAutomation.tsx','app_src/components/projects/CustomerFolderLinksEditor.tsx',
  'scripts/fixtures/customer-folder-controls-ui.tsx','scripts/test-customer-folder-controls-ui.mjs','scripts/lib/shortlink-ui-ts-loader.cjs']
const sourceHashes=new Map(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(join(root,path))).digest('hex')])))
let server,browser
try{
  await new Promise((done,reject)=>{
    const compiler=webpack({mode:'development',devtool:false,cache:false,entry:join(root,'scripts/fixtures/customer-folder-controls-ui.tsx'),
      output:{path:output,filename:'fixture.js'},resolve:{extensions:['.tsx','.ts','.js','.mjs','.json'],
        modules:[join(root,'app_src/node_modules'),'node_modules'],alias:{'@':join(root,'app_src')}},
      module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:join(root,'scripts/lib/shortlink-ui-ts-loader.cjs')}]}})
    compiler.run((error,stats)=>compiler.close(()=>error||stats?.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):done()))
  })
  const bundle=await readFile(join(output,'fixture.js'))
  server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/fixture.js'?'text/javascript':'text/html')
    res.end(req.url==='/fixture.js'?bundle:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>')})
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  browser=await chromium.launch({headless:true})
  const page=await browser.newPage({viewport:{width:1000,height:900}}),origin=`http://127.0.0.1:${server.address().port}`
  await page.addInitScript(()=>{window.process={env:{NODE_ENV:'development'}}})
  const errors=[],writes=[];page.on('pageerror',error=>errors.push(error.message))
  let reads=0,lostQueueReply=true,slowRead=false,releaseRead,enteredRead
  const state={account:{id:'00000000-0000-4000-8000-000000000002',globalId:'ga1234567',name:'Globus fixture',isCustomer:true,hasManualLink:false},
    canEdit:true,canConfigure:true,settings:{enabled:false,revision:0,parentUrl:null},job:null,folder:null}
  const appliedKeys=new Set()
  await page.route('**/api/crm/customer-folders**',async route=>{
    const request=route.request(),json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
    if(request.method()==='GET'){
      reads++
      if(slowRead){enteredRead?.();await new Promise(resolve=>{releaseRead=resolve})}
      return json({ok:true,state})
    }
    const body=request.postDataJSON();writes.push(body)
    if(body.action==='configure'){
      if(body.expectedRevision!==state.settings.revision)return json({ok:false,code:'customer_folder_settings_changed'},409)
      state.settings={enabled:body.enabled,revision:state.settings.revision+1,parentUrl:body.parentId}
      return json({ok:true,state})
    }
    if(!appliedKeys.has(body.requestKey)){
      appliedKeys.add(body.requestKey);state.job={status:'queued',version:(state.job?.version??0)+1,errorCode:null}
    }
    if(lostQueueReply){lostQueueReply=false;return route.abort('failed')}
    return json({ok:true,state})
  })
  await page.goto(origin)
  assert.equal(reads,0);assert.equal(writes.length,0,'no read/create/configuration on render')
  await page.getByRole('button',{name:'BPO folder setup & status',exact:true}).click()
  await expect(page.getByText('Globus fixture · ga1234567')).toBeVisible()
  await expect(page.getByRole('button',{name:'Create customer folder',exact:true})).toBeDisabled()
  await page.getByRole('button',{name:'Configure organization parent',exact:true}).click()
  const parent='https://drive.google.com/drive/folders/customers-parent'
  await page.getByLabel('01 Customers parent folder',{exact:true}).fill(parent)
  await page.getByLabel('Enable BPO customer-folder creation',{exact:true}).check()
  state.settings.revision=9
  await page.getByRole('button',{name:'Refresh status',exact:true}).click()
  await expect(page.getByRole('button',{name:'Refresh status',exact:true})).toBeEnabled()
  await page.getByRole('button',{name:'Verify & save setup',exact:true}).click()
  await expect(page.getByText('The setup changed. Refresh status and reopen the setup form before saving.')).toBeVisible()
  assert.equal(writes[0].expectedRevision,0,'polling must not pair an old configuration draft with a newer version')
  await expect(page.getByLabel('01 Customers parent folder',{exact:true})).toHaveValue(parent)
  await page.getByRole('button',{name:'Cancel setup',exact:true}).click()
  await page.getByRole('button',{name:'Configure organization parent',exact:true}).click()
  await page.getByLabel('01 Customers parent folder',{exact:true}).fill(parent)
  await page.getByLabel('Enable BPO customer-folder creation',{exact:true}).check()
  await page.getByRole('button',{name:'Verify & save setup',exact:true}).click()
  await expect(page.getByRole('button',{name:'Configure organization parent',exact:true})).toBeVisible()
  assert.equal(writes[1].expectedRevision,9)
  await page.getByLabel('Folder action',{exact:true}).click()
  await page.getByRole('option',{name:'Connect existing folder',exact:true}).click()
  const customer='https://drive.google.com/drive/folders/customer-root'
  await page.getByLabel('Existing customer root folder',{exact:true}).fill(customer)
  await page.getByRole('button',{name:'Connect existing folder',exact:true}).click()
  await expect(page.getByRole('button',{name:'Retry same request',exact:true})).toBeVisible()
  const first=writes.find(body=>body.action==='queue')
  assert.equal(first.adoptRootId,customer);assert.equal(first.expectedRevision,10);assert.equal(first.expectedJobVersion,0)
  assert.ok(!Object.hasOwn(first,'actorEmail'))
  await expect(page.getByLabel('Existing customer root folder',{exact:true})).toBeDisabled()
  await page.getByRole('button',{name:'Retry same request',exact:true}).click()
  await expect(page.getByText('Folder job: queued')).toBeVisible()
  const queued=writes.filter(body=>body.action==='queue');assert.equal(queued.length,2);assert.deepEqual(queued[0],queued[1])
  assert.equal(appliedKeys.size,1,'lost HTTP reply must not create a new command identity')

  // While one read is slower than the polling period, interval ticks must not
  // launch overlapping reads and continually invalidate the pending response.
  slowRead=true
  const entered=new Promise(resolve=>{enteredRead=resolve})
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();await entered
  const before=reads
  await new Promise(resolve=>setTimeout(resolve,6100))
  assert.equal(reads,before,'status polling must not overlap a slow read')
  state.job={...state.job,status:'ready'};state.folder={url:customer,publicationStatus:'manual_override'}
  slowRead=false;releaseRead()
  await expect(page.getByRole('link',{name:'Open customer root',exact:true})).toHaveAttribute('href',customer)
  await expect(page.getByText(/Your manual BPO link or its removal is preserved/)).toBeVisible()
  await expect(page.getByRole('button',{name:'Create customer folder',exact:true})).toHaveCount(0)
  assert.equal(writes.length,4)
  await page.setViewportSize({width:390,height:844})
  await expect(page.getByRole('dialog').locator('..')).toHaveCSS('opacity','1')
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile dialog must not overflow horizontally')
  await page.screenshot({path:join(root,'output/local-validation/customer-folder-controls-dark-mobile-20261102.png'),fullPage:true})
  await page.getByRole('button',{name:'Close',exact:true}).click()
  state.canConfigure=false
  await page.getByRole('button',{name:'BPO folder setup & status',exact:true}).click()
  await expect(page.getByText('Globus fixture · ga1234567')).toBeVisible()
  await expect(page.getByRole('button',{name:'Configure organization parent',exact:true})).toHaveCount(0)
  await page.goto(origin+'?light')
  await page.getByRole('button',{name:'BPO folder setup & status',exact:true}).click()
  await expect(page.getByRole('link',{name:'Open customer root',exact:true})).toBeVisible()
  await expect(page.getByRole('dialog').locator('..')).toHaveCSS('opacity','1')
  const foreground=await page.getByRole('heading',{name:'Customer folder automation',exact:true}).evaluate(element=>getComputedStyle(element).color)
  assert.ok(Number(foreground.match(/[\d.]+/)[0])<50,'light-mode dialog text must have a dark foreground')
  await page.screenshot({path:join(root,'output/local-validation/customer-folder-controls-light-mobile-20261102.png'),fullPage:true})
  const readCount=reads
  await page.goto(origin+'?viewer')
  await expect(page.getByRole('button',{name:'BPO folder setup & status',exact:true})).toHaveCount(0)
  assert.equal(reads,readCount,'read-only component cannot poll behind a hidden control')
  assert.deepEqual(errors,[])
  for(const [path,expected]of sourceHashes)assert.equal(createHash('sha256').update(await readFile(join(root,path))).digest('hex'),expected,
    `Browser candidate changed during verification: ${path}`)
  console.log('PASS actual React/MUI browser: explicit setup, stale-revision protection, retained draft, lost-response exact retry, slow-poll non-overlap, manual override, editor/admin/read-only controls, mobile light/dark; APIs mocked')
}finally{
  await browser?.close()
  if(server)await new Promise(done=>server.close(done))
  await rm(output,{recursive:true,force:true})
}
