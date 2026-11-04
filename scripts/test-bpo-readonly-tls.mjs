#!/usr/bin/env node
// Offline synthetic TLS only. No Railway, DB, Gmail, credentials or real certs.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import crypto from 'node:crypto'
import tls from 'node:tls'
const require=createRequire(import.meta.url)
const {SCOPE,validateReadOnlyPostgresTrust,readOnlyDatabaseConfig,REVIEWED_POSTGRES_LEAF}=require('./inspect-bpo-email-recovery-readonly.cjs')
const directory=mkdtempSync(join(tmpdir(),'clawpilot-readonly-tls-'))
const path=name=>join(directory,name)
let server
try{
 writeFileSync(path('root.conf'),'[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ca\n[dn]\nCN=root-ca\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',{mode:0o600})
 writeFileSync(path('leaf.conf'),'[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n',{mode:0o600})
 const openssl=args=>execFileSync('openssl',args,{stdio:'ignore',timeout:30000})
 openssl(['req','-new','-x509','-nodes','-newkey','rsa:2048','-sha256','-days','2','-config',path('root.conf'),'-keyout',path('root.key'),'-out',path('root.crt')])
 openssl(['req','-new','-nodes','-newkey','rsa:2048','-sha256','-subj','/CN=localhost','-keyout',path('leaf.key'),'-out',path('leaf.csr')])
 openssl(['x509','-req','-in',path('leaf.csr'),'-CA',path('root.crt'),'-CAkey',path('root.key'),'-CAcreateserial','-days','2','-sha256','-extfile',path('leaf.conf'),'-extensions','leaf','-out',path('leaf.crt')])
 const caPem=readFileSync(path('root.crt'),'utf8'),leafPem=readFileSync(path('leaf.crt'),'utf8')
 const leaf=new crypto.X509Certificate(leafPem),fingerprint=leaf.fingerprint256
 const bundle={version:1,projectId:SCOPE.projectId,environmentId:SCOPE.environmentId,service:'Postgres',caPem,leafPem}
 const verified=validateReadOnlyPostgresTrust(bundle,fingerprint)
 assert.equal(verified.serverName,'localhost');assert.equal(verified.leafFingerprint256,fingerprint)
 assert.notEqual(fingerprint,REVIEWED_POSTGRES_LEAF)
 assert.throws(()=>validateReadOnlyPostgresTrust(bundle),/TRUST_CHANGED/u,'Production trust never accepts a generated fixture pin')
 for(const value of [{...bundle,service:'clawpilot'},{...bundle,projectId:'other'},
  {...bundle,environmentId:'development'},{...bundle,extra:true},{...bundle,caPem:leafPem},
  {...bundle,leafPem:caPem},{...bundle,caPem:'PRIVATE_BYTES'},{...bundle,leafPem:leafPem+leafPem}])
  assert.throws(()=>validateReadOnlyPostgresTrust(value,fingerprint),/TRUST_INVALID/u)
 console.log('PASS real synthetic X509 chain, validity, hostname, exact scope, shape and non-production pin refusals')
 // Substitute only the fixture trust anchor/pin dependency. The actual config
 // function body, TLS verification and identity callback are executed intact.
 const configure=new Function('validateReadOnlyPostgresTrust','tls',`return (${readOnlyDatabaseConfig.toString()})`)(
  value=>validateReadOnlyPostgresTrust(value,fingerprint),tls)
 const env={DATABASE_URL:'postgresql://fixture:fixture@db.railway.internal/fixture?sslmode=no-verify&sslrootcert=wrong',
  CLAWPILOT_BPO_READONLY_TLS_TRUST:JSON.stringify(bundle)}
 const {config,trust}=configure(env)
 assert.equal(config.ssl.rejectUnauthorized,true);assert.equal(config.ssl.servername,'localhost')
 assert.equal(new URL(config.connectionString).search,'');assert.equal(trust.source,'authenticated-exact-service-ssh')
 const peer=leaf.toLegacyObject()
 assert.equal(config.ssl.checkServerIdentity('db.railway.internal',peer),undefined)
 assert.match(config.ssl.checkServerIdentity('db.railway.internal',{...peer,fingerprint256:REVIEWED_POSTGRES_LEAF}).message,/PEER_MISMATCH/u)
 assert.ok(config.ssl.checkServerIdentity('db.railway.internal',{...peer,subjectaltname:'DNS:other.invalid'}))
 for(const [value,error]of [[{...env,CLAWPILOT_BPO_READONLY_TLS_TRUST:''},/TRUST_REQUIRED/u],
  [{...env,CLAWPILOT_BPO_READONLY_PUBLIC_ENDPOINT:'1'},/INSECURE_DIAGNOSTIC_MODE_REMOVED/u],
  [{...env,DATABASE_URL:'postgresql://fixture:fixture@foreign.invalid/fixture'},/EXACT_PRIVATE_ENDPOINT_REQUIRED/u],
  [{...env,CLAWPILOT_BPO_READONLY_TLS_TRUST:'PRIVATE_BYTES'},/TRUST_INVALID/u]])assert.throws(()=>configure(value),error)
 console.log('PASS verified TLS cannot be replaced by URL SSL options, unpinned peers, wrong SAN, missing trust or public fallback')
 server=tls.createServer({key:readFileSync(path('leaf.key')),cert:leafPem},socket=>socket.end())
 server.on('tlsClientError',()=>{})
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const port=server.address().port
 await new Promise((resolve,reject)=>{
  const socket=tls.connect({host:'127.0.0.1',port,...config.ssl},()=>{
   try{assert.equal(socket.authorized,true);assert.equal(socket.getPeerCertificate().fingerprint256,fingerprint);socket.end();resolve()}
   catch(error){socket.destroy();reject(error)}
  });socket.setTimeout(5000,()=>socket.destroy(new Error('Fixture TLS timeout')));socket.once('error',reject)
 })
 await assert.rejects(new Promise((resolve,reject)=>{
  const socket=tls.connect({host:'127.0.0.1',port,...config.ssl,ca:leafPem},()=>{socket.destroy();resolve()})
  socket.setTimeout(5000,()=>socket.destroy(new Error('Fixture TLS timeout')));socket.once('error',reject)
 }))
 console.log('PASS actual loopback TLS handshake verifies the pinned chain; an untrusted chain fails closed')
 const runner=readFileSync(new URL('./run-bpo-email-recovery-readonly.mjs',import.meta.url),'utf8')
 assert.doesNotMatch(runner,/variable.*list|DATABASE_PUBLIC_URL|rejectUnauthorized\s*:\s*false/u)
 assert.match(runner,/validateReadOnlyPostgresTrust\(bundle\)/u)
 console.log('PASS BPO read-only TLS fixture; no real provider, database query, TLS setting or recovery changed')
}finally{
 if(server?.listening)await new Promise(resolve=>server.close(resolve))
 rmSync(directory,{recursive:true,force:true})
}
