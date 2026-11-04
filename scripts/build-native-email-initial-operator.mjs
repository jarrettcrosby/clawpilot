#!/usr/bin/env node
// Compile the actual server DAL/operator graph; not a runtime TS test loader.
// Generated output stays in ignored app_src/dist, never public/ or .next/static.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {dirname,join,relative,resolve} from 'node:path'
import {runStorageGuard} from './local-storage-guard.mjs'

assert.equal(process.versions.node.split('.')[0],'24','Use the supported bundled Node24 runtime')
assert.equal(process.argv.length,2,'This build accepts no caller-selected source/output paths')
// A local Mac may inherit CI/Railway variables from an operator shell. Those
// values must not turn this local compiler's disk check into a hosted bypass.
const buildEnvironment={...process.env}
if(process.platform==='darwin'){
  Object.assign(buildEnvironment,{CI:'',VERCEL:'',VERCEL_ENV:''})
  for(const key of ['RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID','RAILWAY_ENVIRONMENT_NAME','RAILWAY_SERVICE_ID'])delete buildEnvironment[key]
}
assert.equal(runStorageGuard({argv:['--preflight'],environment:buildEnvironment}),0)
const app=resolve('app_src'),require=createRequire(join(app,'package.json')),ts=require('typescript')
const outputParent=join(app,'dist');mkdirSync(outputParent,{recursive:true})
const output=mkdtempSync(join(outputParent,'native-email-initial-operator-'))
const entry=join(app,'ops/native-email-initial.ts')
const compilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,
  strict:true,esModuleInterop:true,skipLibCheck:true,noEmitOnError:true,rootDir:app,outDir:output,types:['node'],
  typeRoots:[join(app,'node_modules/@types')],resolveJsonModule:true}
const program=ts.createProgram([entry],compilerOptions),before=ts.getPreEmitDiagnostics(program)
if(before.length){process.stderr.write(ts.formatDiagnosticsWithColorAndContext(before,{getCurrentDirectory:()=>app,getCanonicalFileName:x=>x,getNewLine:()=> '\n'}));process.exitCode=1}
else{
  const emitted=program.emit();assert.equal(emitted.emitSkipped,false)
  // Next's installed official marker package is bundled as a build dependency.
  // Node still needs --conditions=react-server: ordinary import must throw.
  // Nothing intercepts require(), strips imports or evaluates TS at runtime.
  const marker=dirname(require.resolve('next/dist/compiled/server-only/package.json'))
  const markerPackage=JSON.parse(readFileSync(join(marker,'package.json'),'utf8'))
  assert.equal(markerPackage.name,'server-only');assert.equal(markerPackage.version,'0.0.1')
  assert.equal(markerPackage.exports['.']['react-server'],'./empty.js');assert.equal(markerPackage.exports['.'].default,'./index.js')
  const destination=join(output,'node_modules/server-only');mkdirSync(destination,{recursive:true})
  for(const file of ['package.json','empty.js','index.js'])copyFileSync(join(marker,file),join(destination,file))
  writeFileSync(join(output,'package.json'),JSON.stringify({private:true,type:'commonjs'})+'\n',{flag:'wx',mode:0o600})
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
  const sources=Object.fromEntries(program.getSourceFiles().filter(f=>f.fileName.startsWith(app+'/')&&!f.fileName.includes('/node_modules/')&&!f.isDeclarationFile)
    .map(f=>[relative(app,f.fileName),sha(readFileSync(f.fileName))]).sort(([a],[b])=>a.localeCompare(b)))
  assert.ok(Object.hasOwn(sources,'ops/native-email-initial.ts'));assert.ok(Object.hasOwn(sources,'lib/crm/nativeEmailInitialEnrollmentCliTransport.ts'))
  function files(path){return readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(path,e.name)):[join(path,e.name)])}
  const outputs=Object.fromEntries(files(output).map(path=>[relative(output,path),sha(readFileSync(path))]).sort(([a],[b])=>a.localeCompare(b)))
  const manifest={version:1,purpose:'clawpilot-native-email-initial-private-operator-build',typescriptVersion:ts.version,
    nodeMajor:24,entry:'ops/native-email-initial.js',requiredNodeCondition:'react-server',sources,outputs}
  writeFileSync(join(output,'build-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600})
  assert.ok(existsSync(join(output,manifest.entry)))
  process.stdout.write(JSON.stringify({built:true,output,entry:join(output,manifest.entry),sourceCount:Object.keys(sources).length,
    manifestSha256:sha(readFileSync(join(output,'build-manifest.json'))),runtimeProof:false})+'\n')
}
