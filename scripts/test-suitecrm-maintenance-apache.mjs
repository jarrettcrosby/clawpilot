#!/usr/bin/env node
// Actual local Apache 2.4 component, using the repository vhost with only
// fixture paths/port substituted. No image, PHP module, app, DB, or provider.
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {once} from 'node:events'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

assert.equal(process.argv.length,2,'This loopback fixture takes no external arguments')
assert.equal(process.platform,'darwin','This fixture explicitly exercises the already-installed Mac Apache, not a Docker image')
assert.notEqual(process.getuid(),0,'Never run this isolated component as root')
const root=resolve('.'),apache='/usr/sbin/httpd',modules='/usr/libexec/apache2'
const paths=['services/suitecrm/apache-site.conf','services/suitecrm/native-email-liveness.json','scripts/test-suitecrm-maintenance-apache.mjs']
const digest=path=>createHash('sha256').update(readFileSync(join(root,path))).digest('hex')
const sourceHashes=Object.fromEntries(paths.map(path=>[path,digest(path)]))
const version=execFileSync(apache,['-v'],{encoding:'utf8',timeout:5000}).trim()
assert.match(version,/Apache\/2\.4\./)
const temp=mkdtempSync(join(tmpdir(),'clawpilot-maintenance-apache-'))
const app=join(temp,'app-public'),assets=join(temp,'static'),config=join(temp,'httpd.conf')
mkdirSync(app);mkdirSync(assets)
const expected=readFileSync(join(root,'services/suitecrm/native-email-liveness.json'),'utf8')
writeFileSync(join(assets,'native-email-liveness.json'),expected)
writeFileSync(join(assets,'not-public.txt'),'private fixture asset\n')
writeFileSync(join(app,'index.php'),'fixture-app-normal-route-not-executed-as-php\n')
writeFileSync(join(app,'.htaccess'),'Header set X-ClawPilot-Fixture-App "document-root-only"\n')
const freePort=async()=>{const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;s.close();await once(s,'close');return port}
const request=(port,path,method='GET')=>new Promise((resolveResult,reject)=>{
 const req=http.request({host:'127.0.0.1',port,path,method,headers:{Connection:'close'},timeout:2000},res=>{
  let body='';res.on('data',b=>{body+=b;if(body.length>8192)req.destroy(new Error('Unexpected response size'))})
  res.on('end',()=>resolveResult({status:res.statusCode,headers:res.headers,body}))
 });req.on('connect',(res,socket,head)=>{
  let body=head.toString();socket.on('data',b=>{body+=b;if(body.length>8192)socket.destroy(new Error('Unexpected CONNECT size'))})
  socket.on('error',reject);socket.on('end',()=>resolveResult({status:res.statusCode,headers:res.headers,body}));socket.resume()
 });req.on('timeout',()=>req.destroy(new Error('Apache HTTP timeout')));req.on('error',reject);req.end()
})
let child,exitPromise,output='',checks=0
const check=async(label,run)=>{await run();checks++;console.log('PASS '+label)}
try{
 const port=await freePort()
 const requiredModules=['mpm_prefork','unixd','authz_core','mime','alias','headers','dir','log_config','setenvif','remoteip']
 const loads=requiredModules.map(name=>{
  const path=join(modules,'mod_'+name+'.so');assert.ok(existsSync(path),'Required host module: '+name)
  return `LoadModule ${name}_module "${path}"`
 }).join('\n')
 const vhost=readFileSync(join(root,'services/suitecrm/apache-site.conf'),'utf8')
  .replaceAll('/var/lib/suitecrm/app/public',app).replaceAll('/opt/clawpilot',assets)
  .replace('<VirtualHost *:8080>',`<VirtualHost 127.0.0.1:${port}>`)
  .replace('/proc/self/fd/2',join(temp,'vhost-error.log')).replace('/proc/self/fd/1',join(temp,'access.log'))
 assert.equal(vhost.includes('/var/lib/suitecrm/'),false);assert.equal(vhost.includes('/opt/clawpilot'),false)
 writeFileSync(config,`ServerRoot "${temp}"
DefaultRuntimeDir "${temp}"
PidFile "${join(temp,'httpd.pid')}"
ErrorLog "${join(temp,'error.log')}"
Listen 127.0.0.1:${port}
ServerName 127.0.0.1
${loads}
User #${process.getuid()}
Group #${process.getgid()}
StartServers 1
MinSpareServers 1
MaxSpareServers 1
ServerLimit 1
MaxRequestWorkers 1
MaxConnectionsPerChild 0
Timeout 2
KeepAlive Off
ServerTokens Prod
ServerSignature Off
TraceEnable Off
TypesConfig /dev/null
LogFormat "%h %l %u %t \\"%r\\" %>s %b" combined
<Directory />
    AllowOverride None
    Require all denied
</Directory>
${vhost}`)
 await check('real Apache accepts the repository Alias/Directory/Location directives',async()=>{
  const syntax=execFileSync(apache,['-t','-f',config],{encoding:'utf8',stdio:'pipe',timeout:5000})
  assert.equal(syntax,'')
 })
 // Apache may signal its process group during shutdown. Give this exact owned
 // fixture a separate session/group so it cannot signal Node or its shell.
 child=spawn(apache,['-f',config,'-DFOREGROUND'],{stdio:['ignore','pipe','pipe'],detached:true})
 exitPromise=once(child,'exit');child.stdout.on('data',b=>{output+=b});child.stderr.on('data',b=>{output+=b})
 await check('actual isolated Apache binds only its loopback component',async()=>{
  const deadline=Date.now()+5000
  for(;;){
   if(child.exitCode!==null)throw new Error('Isolated Apache exited: '+output)
   try{if((await request(port,'/')).status===200)break}catch(e){if(!['ECONNREFUSED','ECONNRESET'].includes(e.code))throw e}
   assert.ok(Date.now()<deadline,'Apache did not bind its fixture listener: '+output);await new Promise(r=>setTimeout(r,20))
  }
 })
 await check('normal application fixture remains served under its own htaccess, without PHP execution',async()=>{
  const r=await request(port,'/');assert.equal(r.status,200);assert.equal(r.body,'fixture-app-normal-route-not-executed-as-php\n')
  assert.equal(r.headers['x-clawpilot-fixture-app'],'document-root-only')
  const modulesLoaded=execFileSync(apache,['-M','-f',config],{encoding:'utf8',stdio:'pipe',timeout:5000})
  assert.doesNotMatch(modulesLoaded,/php|cgi|proxy|fcgi/i,'The component must contain no PHP or forwarding execution module')
 })
 await check('actual Apache merges deny-directory with GET/HEAD-only location for static liveness',async()=>{
  for(const path of ['/_clawpilot/liveness','/_clawpilot/liveness?probe=1']){
   const r=await request(port,path);assert.equal(r.status,200);assert.equal(r.body,expected)
   assert.deepEqual(JSON.parse(r.body),{service:'suitecrm',mode:'normal',live:true,ready:null})
   assert.equal(r.headers['content-type'],'application/json');assert.equal(r.headers['cache-control'],'no-store')
   assert.equal(r.headers['x-content-type-options'],'nosniff');assert.equal(r.headers['x-clawpilot-fixture-app'],undefined)
   const h=await request(port,path,'HEAD');assert.equal(h.status,200);assert.equal(h.body,'')
   assert.equal(h.headers['content-length'],String(Buffer.byteLength(expected)))
  }
 })
 await check('write/unknown methods and all other static paths cannot expose the liveness asset',async()=>{
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS','TRACE','CONNECT','BREW']){
   const r=await request(port,'/_clawpilot/liveness',method)
   assert.ok([400,403,405,501].includes(r.status),method+' must be refused, got '+r.status)
   assert.notEqual(r.body,expected,method+' must not return the liveness asset')
  }
  for(const path of ['/_clawpilot/liveness/','/_clawpilot/liveness/not-public.txt','/opt/clawpilot/native-email-liveness.json','/opt/clawpilot/not-public.txt']){
   const r=await request(port,path);assert.ok([403,404].includes(r.status),path+' must not be aliased')
   assert.notEqual(r.body,expected);assert.doesNotMatch(r.body,/private fixture asset/)
  }
 })
 await check('terminating the owned Apache releases its listener',async()=>{
  child.kill('SIGTERM');const [code,signal]=await exitPromise;assert.equal(code,0);assert.equal(signal,null)
  await assert.rejects(request(port,'/_clawpilot/liveness'),e=>['ECONNREFUSED','ECONNRESET'].includes(e.code))
 })
 for(const [path,sha]of Object.entries(sourceHashes))assert.equal(digest(path),sha,'Source changed during Apache fixture: '+path)
 console.log(JSON.stringify({kind:'suitecrm-maintenance-apache-component-proof',checks,apacheVersion:version,hostPlatform:process.platform,
  sourceHashes,realApache:true,realHttp:true,fullDockerImage:false,productionPythonImports:false,nativeQuiescence:false,
  nativeStartupRelease:false,database:false,production:false}))
}finally{
 if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exitPromise.catch(()=>{})}
 rmSync(temp,{recursive:true,force:true})
}
