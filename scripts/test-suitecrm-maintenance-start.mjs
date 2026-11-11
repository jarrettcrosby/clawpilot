#!/usr/bin/env node
// Real entrypoint + real host Python HTTP/process/socket acceptance. A narrow
// PATH wrapper maps the image's fixed Python script path to these repo bytes.
// No image build, DB, SuiteCRM bootstrap, credentials or external requests.
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {once} from 'node:events'
import {existsSync,mkdtempSync,readFileSync,writeFileSync,chmodSync,rmSync} from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

assert.equal(process.argv.length,2,'This local fixture takes no image or remote arguments')
const root=resolve('.'),entry=join(root,'services/suitecrm/entrypoint.sh'),script=join(root,'services/suitecrm/native-email-maintenance.py')
const paths=['services/suitecrm/entrypoint.sh','services/suitecrm/native-email-maintenance.py','services/suitecrm/native-email-liveness.json',
 'services/suitecrm/apache-site.conf','services/suitecrm/Dockerfile','services/suitecrm/railway.json',
 'services/suitecrm/native-email-startup-check.php','scripts/test-suitecrm-maintenance-start.mjs']
const digest=path=>createHash('sha256').update(readFileSync(join(root,path))).digest('hex')
const sourceHashes=Object.fromEntries(paths.map(path=>[path,digest(path)]))
execFileSync('/bin/bash',['-n',entry],{stdio:'pipe'})
const python=execFileSync('python3',['-c','import sys; print(sys.executable)'],{encoding:'utf8',timeout:5000}).trim()
execFileSync(python,['-B','-c','import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())',script],{stdio:'pipe',timeout:5000})
const temp=mkdtempSync(join(tmpdir(),'clawpilot-maintenance-start-')),sentinel=join(temp,'bootstrap-called')
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'"
const wrapper=(name,body)=>{const path=join(temp,name);writeFileSync(path,'#!/bin/bash\nset -euo pipefail\n'+body+'\n',{mode:0o700});chmodSync(path,0o700)}
wrapper('python3',`[[ "$#" == 2 && "$1" == -B && "$2" == /opt/clawpilot/native-email-maintenance.py ]] || exit 91\nexec ${quote(python)} -B ${quote(script)}`)
wrapper('php',`printf '%s\\n' php-startup-check >> ${quote(sentinel)}\nexit 73`)
for(const name of ['su','cp','chown','chmod','touch','openssl','sed','supervisord'])wrapper(name,
 `printf '%s\\n' ${quote('unexpected-'+name)} >> ${quote(sentinel)}\nexit 74`)
const children=new Set()
const start=(env,args=[])=>{const child=spawn('/bin/bash',[entry,...args],{cwd:root,env:{PATH:temp+':'+process.env.PATH,...env},stdio:['ignore','pipe','pipe']})
 children.add(child);child.exit=once(child,'exit');child.exit.finally(()=>children.delete(child))
 let out='',err='';child.stdout.on('data',b=>{out+=b;if(out.length>10000)child.kill('SIGTERM')});child.stderr.on('data',b=>{err+=b;if(err.length>10000)child.kill('SIGTERM')})
 return {child,output:()=>({out,err})}}
const freePort=async()=>{const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;s.close();await once(s,'close');return port}
const request=(port,path,method='GET')=>new Promise((resolveResult,reject)=>{
 const req=http.request({host:'127.0.0.1',port,path,method,headers:{Connection:'close'},timeout:2000},res=>{
  let body='';res.on('data',b=>{body+=b;if(body.length>4096)req.destroy(new Error('Unbounded maintenance body'))});res.on('end',()=>resolveResult({status:res.statusCode,headers:res.headers,body}))
 });req.on('connect',(res,socket,head)=>{
  let body=head.toString();socket.on('data',b=>{body+=b;if(body.length>4096)socket.destroy(new Error('Unbounded CONNECT body'))})
  socket.on('error',reject);socket.on('end',()=>resolveResult({status:res.statusCode,headers:res.headers,body}));socket.resume()
 });req.on('timeout',()=>req.destroy(new Error('Maintenance HTTP timeout')));req.on('error',reject);req.end()
})
let checks=0
const check=async(label,run)=>{await run();checks++;console.log('PASS '+label)}
try{
 const port=await freePort(),running=start({CLAWPILOT_NATIVE_INITIAL_MAINTENANCE:'1',PORT:String(port)})
 await check('actual entrypoint enters maintenance without SuiteCRM version, DB or bootstrap environment',async()=>{
  const deadline=Date.now()+5000
  while(!running.output().err.includes('"mode":"maintenance"')){
   if(running.child.exitCode!==null)throw new Error('Maintenance exited early: '+running.output().err)
   assert.ok(Date.now()<deadline,'actual responder must bind');await new Promise(r=>setTimeout(r,10))
  }
  assert.equal(existsSync(sentinel),false,'no PHP or bootstrap writer may have run')
  assert.equal(running.output().out,'')
 })
 await check('canary arguments never release or bootstrap a nonmaintenance process',async()=>{
  for(const args of [['--upgrade-canary'],['--upgrade-canary','--port=8080'],['--release']]){
   const run=start({SUITECRM_VERSION:'8.10.2',CLAWPILOT_NATIVE_INITIAL_MAINTENANCE:'0'},args)
   assert.equal((await run.child.exit)[0],1)
   assert.match(run.output().err,/upgrade canary held/)
  }
  assert.equal(existsSync(sentinel),false)
 })
 await check('actual maintenance HTTP distinguishes liveness from readiness and closes every app path',async()=>{
  for(const [path,status]of [['/_clawpilot/liveness',200],['/_clawpilot/liveness?probe=1',200],['/',503],['/ready',503],['/api/health',503],['/Api/V8/custom/clawpilot-email-publish',503]]){
   const r=await request(port,path);assert.equal(r.status,status);assert.deepEqual(JSON.parse(r.body),{service:'suitecrm',mode:'maintenance',live:true,ready:false})
   assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-content-type-options'],'nosniff')
   if(status===503)assert.equal(r.headers['retry-after'],'60')
   const h=await request(port,path,'HEAD');assert.equal(h.status,status);assert.equal(h.body,'');assert.equal(h.headers['content-length'],String(Buffer.byteLength(r.body)))
  }
 })
 await check('actual responder permits only GET/HEAD and never forwards write or unknown methods',async()=>{
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS','TRACE','CONNECT','BREW']){
   const r=await request(port,'/_clawpilot/liveness',method);assert.equal(r.status,405,method);assert.equal(r.headers.allow,'GET, HEAD')
   assert.equal(JSON.parse(r.body).ready,false);assert.equal(JSON.parse(r.body).error,'method_not_allowed')
  }
  assert.equal(existsSync(sentinel),false)
 })
 await check('real entrypoint PID is Python, with no Apache/PHP/supervisor/cron or child processes',async()=>{
  const rows=execFileSync('ps',['-eo','pid=,ppid=,comm='],{encoding:'utf8',timeout:5000}).trim().split('\n').map(line=>{
   const [,pid,ppid,comm]=line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)??[];return {pid:Number(pid),ppid:Number(ppid),comm}
  })
  const mine=rows.find(row=>row.pid===running.child.pid);assert.ok(mine&&/python/i.test(mine.comm),'bash must exec the actual Python responder')
  assert.equal(rows.filter(row=>row.ppid===running.child.pid).length,0,'responder must not launch any native subprocess')
  assert.equal(existsSync(sentinel),false)
 })
 await check('SIGTERM exits the real process and releases its listening socket',async()=>{
  running.child.kill('SIGTERM');const [code,signal]=await running.child.exit;assert.equal(code,0);assert.equal(signal,null)
  await assert.rejects(request(port,'/_clawpilot/liveness'),e=>['ECONNREFUSED','ECONNRESET'].includes(e.code))
 })
 await check('clearing maintenance does not bypass the unchanged startup gate; malformed mode/ports never bootstrap',async()=>{
  for(const flag of [undefined,'0']){
   const env={SUITECRM_VERSION:'8.10.1'}
   if(flag!==undefined)env.CLAWPILOT_NATIVE_INITIAL_MAINTENANCE=flag
   const run=start(env),[code]=await run.child.exit;assert.equal(code,73,'normal path still reaches mandatory PHP startup check')
  }
  assert.equal(readFileSync(sentinel,'utf8'),'php-startup-check\nphp-startup-check\n')
  const badMode=start({CLAWPILOT_NATIVE_INITIAL_MAINTENANCE:'true'});assert.equal((await badMode.child.exit)[0],1)
  for(const value of ['0','65536',' 8080','8\n80','1e3']){
   const bad=start({CLAWPILOT_NATIVE_INITIAL_MAINTENANCE:'1',PORT:value});assert.notEqual((await bad.child.exit)[0],0);assert.match(bad.output().err,/PORT must be an integer/)
  }
  assert.equal(readFileSync(sentinel,'utf8'),'php-startup-check\nphp-startup-check\n')
 })
 await check('normal Apache liveness is explicitly static outside SuiteCRM, with no readiness claim',async()=>{
  const apache=readFileSync(join(root,'services/suitecrm/apache-site.conf'),'utf8'),image=readFileSync(join(root,'services/suitecrm/Dockerfile'),'utf8')
  assert.match(apache,/AliasMatch "\^\/_clawpilot\/liveness\$" "\/opt\/clawpilot\/native-email-liveness\.json"/)
  assert.match(apache,/SetHandler default-handler/);assert.match(apache,/Require method GET HEAD/)
  assert.deepEqual(JSON.parse(readFileSync(join(root,'services/suitecrm/native-email-liveness.json'),'utf8')),{service:'suitecrm',mode:'normal',live:true,ready:null})
  assert.equal(JSON.parse(readFileSync(join(root,'services/suitecrm/railway.json'),'utf8')).deploy.healthcheckPath,'/_clawpilot/liveness')
  assert.match(image,/openssl python3 supervisor/);assert.doesNotMatch(image,/python3-minimal/)
  assert.match(image,/python3 -B -c 'import json, os, re, signal, sys, threading; from http\.server import BaseHTTPRequestHandler, ThreadingHTTPServer'/)
  assert.match(image,/COPY native-email-maintenance\.py native-email-liveness\.json \/opt\/clawpilot\//)
 })
 for(const [path,sha]of Object.entries(sourceHashes))assert.equal(digest(path),sha,'Source changed during maintenance fixture: '+path)
 console.log(JSON.stringify({kind:'suitecrm-maintenance-component-proof',checks,python,sourceHashes,realEntrypoint:true,realHttp:true,realProcess:true,
  realApache:false,fullDockerImage:false,nativeQuiescence:false,nativeStartupRelease:false,database:false,production:false}))
}finally{
 for(const child of children){child.kill('SIGTERM');await child.exit.catch(()=>{})}
 rmSync(temp,{recursive:true,force:true})
}
