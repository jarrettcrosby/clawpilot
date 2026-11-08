#!/usr/bin/env node
// Emit the private recovery CLI and separately operated custodian library as
// Node24 JavaScript. No app route, bundler shim, runtime alias loader or eval.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {runStorageGuard} from './local-storage-guard.mjs'

assert.equal(process.versions.node.split('.')[0],'24','Use the supported bundled Node24 runtime')
assert.equal(process.argv.length,2,'This build accepts no caller-selected source/output paths')
const script=fileURLToPath(import.meta.url),repo=resolve(dirname(script),'..'),app=join(repo,'app_src')
assert.equal(realpathSync(repo),repo,'Use the canonical repository path')
const buildEnvironment={...process.env}
if(process.platform==='darwin'){
  Object.assign(buildEnvironment,{CI:'',VERCEL:'',VERCEL_ENV:''})
  for(const key of ['RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID','RAILWAY_ENVIRONMENT_NAME','RAILWAY_SERVICE_ID'])delete buildEnvironment[key]
}
assert.equal(runStorageGuard({argv:['--preflight'],environment:buildEnvironment,repositoryRoot:repo}),0)
const require=createRequire(join(app,'package.json')),ts=require('typescript')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const inside=(parent,file)=>{
  const rel=relative(parent,file)
  return rel!==''&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)
}
const appSource=file=>inside(app,file)&&!relative(app,file).split(sep).some(part=>['node_modules','dist','.next'].includes(part))
const pinSources=(files,read)=>Object.fromEntries(files.map(file=>[relative(app,file),sha(read(file))]).sort(([a],[b])=>a.localeCompare(b)))
function emittedFiles(path){
  return readdirSync(path,{withFileTypes:true}).flatMap(file=>{
    const target=join(path,file.name)
    assert.ok(file.isDirectory()||file.isFile(),'Non-regular build output')
    return file.isDirectory()?emittedFiles(target):[target]
  })
}

const outputParent=join(app,'dist');mkdirSync(outputParent,{recursive:true})
assert.equal(realpathSync(outputParent),outputParent,'Private build output may not follow a symbolic link')
const output=mkdtempSync(join(outputParent,'native-email-recovery-operator-'))
const entry='ops/native-email-recovery.js',entrySource=join(app,'ops/native-email-recovery.ts')
const custodianLibraryEntry='lib/crm/nativeEmailRecoveryCustodian.js'
const custodianSource=join(app,'lib/crm/nativeEmailRecoveryCustodian.ts')
const terminalHoldLibraryEntries=[
  'lib/crm/legacyEmailTerminalHoldPreview.js',
  'lib/crm/legacyEmailTerminalHoldPrivateOperator.js',
  'lib/crm/legacyEmailTerminalHoldStockNativeObserver.js',
  'lib/persistence/crmLegacyEmailTerminalHoldAppObserver.js',
]
const terminalHoldSources=terminalHoldLibraryEntries.map(path=>join(app,path.replace(/\.js$/u,'.ts')))
const compilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,
  strict:true,esModuleInterop:true,skipLibCheck:true,noEmitOnError:true,rootDir:app,outDir:output,types:['node'],
  typeRoots:[join(app,'node_modules/@types')],resolveJsonModule:true,allowJs:true,baseUrl:app,paths:{'@/*':['./*']}}
const host=ts.createCompilerHost(compilerOptions,true),compilerRead=host.readFile,consumed=new Map()
host.getCurrentDirectory=()=>app
host.readFile=(file)=>{
  if(!appSource(file))return compilerRead(file)
  if(!consumed.has(file)){
    if(!existsSync(file))return undefined
    assert.equal(realpathSync(file),file,'Source dependency may not follow a symbolic link')
    consumed.set(file,readFileSync(file))
  }
  // Hash the same raw bytes supplied to TypeScript, not a later read after it
  // has already cached the AST. Decode only UTF-8 with an optional UTF-8 BOM.
  return new TextDecoder('utf-8',{fatal:true}).decode(consumed.get(file))
}
// Check the controller on its own before adding the independently operated
// signing library as another root. Do not let a shared artifact add a signer
// dependency to the controller's module graph (even a type-only import).
const controllerSources=[entrySource,...terminalHoldSources]
const controllerProgram=ts.createProgram(controllerSources,compilerOptions,host)
assert.ok(!controllerProgram.getSourceFile(custodianSource),'The recovery controller must not import the custody signer')
const program=ts.createProgram({rootNames:[...controllerSources,custodianSource],options:compilerOptions,host,oldProgram:controllerProgram})
const before=ts.getPreEmitDiagnostics(program)
if(before.length){
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(before,{getCurrentDirectory:()=>app,getCanonicalFileName:x=>x,getNewLine:()=> '\n'}))
  rmSync(output,{recursive:true}) // Only the new, empty directory created above.
  process.exitCode=1
}else{
  const files=program.getSourceFiles().map(file=>file.fileName).filter(appSource)
  const sources=pinSources(files,file=>consumed.get(file))
  assert.ok(Object.hasOwn(sources,'ops/native-email-recovery.ts'))
  assert.ok(Object.hasOwn(sources,'lib/crm/nativeEmailRecoveryCustodian.ts'))
  for(const path of terminalHoldSources)assert.ok(Object.hasOwn(sources,relative(app,path)))
  for(const path of ['nativeEmailRecoveryCustodyProof','nativeEmailRecoveryCustodySocket','nativeEmailRecoveryStoreBinding','nativeEmailRecoveryPrivatePostgres','nativeEmailRecoveryMaintenanceOperator',
    'nativeEmailAccountRepairOperator','nativeEmailAccountRepairJournal','nativeEmailArchiveOperator','nativeEmailArchiveJournal'])
    assert.ok(Object.hasOwn(sources,`lib/crm/${path}.ts`),'Missing private operator dependency: '+path)

  // TypeScript understands @/ aliases for type resolution but does not rewrite
  // them for Node. Change only actual import/export/require string nodes, and
  // only to a TypeScript-resolved application source in this exact build graph.
  // Local .mjs retain their format under TypeScript allowJs; Node24 supports
  // loading the synchronous modules from the CommonJS entry's graph.
  let rewrittenAliases=0
  const resolution=ts.createModuleResolutionCache(app,file=>file,compilerOptions)
  const aliasRewriter=context=>file=>{
    const visit=node=>{
      if(ts.isStringLiteralLike(node)&&node.text.startsWith('@/')){
        const parent=node.parent
        const specifier=parent&&((ts.isImportDeclaration(parent)||ts.isExportDeclaration(parent))&&parent.moduleSpecifier===node
          ||ts.isExternalModuleReference(parent)&&parent.expression===node
          ||ts.isCallExpression(parent)&&parent.arguments[0]===node&&(parent.expression.kind===ts.SyntaxKind.ImportKeyword
            ||ts.isIdentifier(parent.expression)&&parent.expression.text==='require'))
        if(specifier){
          const target=ts.resolveModuleName(node.text,file.fileName,compilerOptions,ts.sys,resolution).resolvedModule?.resolvedFileName
          assert.ok(target&&appSource(target)&&Object.hasOwn(sources,relative(app,target)),'Alias escaped the private build graph')
          assert.ok(!/\.d\.[cm]?ts$/.test(target),'Runtime alias has no emitted implementation')
          const ext=/\.[cm]?tsx?$/.exec(target)?.[0],extensions={'.ts':'.js','.tsx':'.js','.mts':'.mjs','.cts':'.cjs'}
          const destination=ext?target.slice(0,-ext.length)+extensions[ext]:target
          assert.match(destination,/\.(?:[cm]?js|json)$/)
          const path=relative(dirname(file.fileName),destination).split(sep).join('/')
          rewrittenAliases++
          return context.factory.createStringLiteral(path.startsWith('.')?path:'./'+path)
        }
      }
      return ts.visitEachChild(node,visit,context)
    }
    return ts.visitNode(file,visit)
  }
  const emitted=program.emit(undefined,undefined,undefined,undefined,{before:[aliasRewriter]})
  assert.equal(emitted.emitSkipped,false)
  assert.deepEqual(emitted.diagnostics,[])
  assert.deepEqual(pinSources(files,file=>readFileSync(file)),sources,'Application source changed during private operator compilation')

  // Preserve the actual installed Next server-only package, including the
  // default rejection branch. Never replace the marker with an empty shim.
  const marker=dirname(require.resolve('next/dist/compiled/server-only/package.json'))
  const markerPackage=JSON.parse(readFileSync(join(marker,'package.json'),'utf8'))
  assert.equal(markerPackage.name,'server-only');assert.equal(markerPackage.version,'0.0.1')
  assert.equal(markerPackage.exports['.']['react-server'],'./empty.js');assert.equal(markerPackage.exports['.'].default,'./index.js')
  const destination=join(output,'node_modules/server-only');mkdirSync(destination,{recursive:true})
  for(const file of ['package.json','empty.js','index.js'])copyFileSync(join(marker,file),join(destination,file))
  writeFileSync(join(output,'package.json'),JSON.stringify({private:true,type:'commonjs'})+'\n',{flag:'wx',mode:0o600})
  assert.ok(existsSync(join(output,entry)))
  assert.ok(existsSync(join(output,custodianLibraryEntry)))

  // Argument-free invocation exercises the whole emitted module graph and
  // stops at the runtime/action guard, before configuration, DB or network I/O.
  // Do not inherit NODE_OPTIONS, database credentials or Railway state.
  const smoke=(args)=>spawnSync(process.execPath,args,{cwd:repo,env:{},encoding:'utf8',timeout:10000,maxBuffer:128*1024})
  const withoutCondition=smoke([join(output,entry)])
  assert.equal(withoutCondition.error,undefined)
  assert.equal(withoutCondition.status,1)
  assert.match(withoutCondition.stderr,/cannot be imported from a Client Component module/)
  const withCondition=smoke(['--conditions=react-server',join(output,entry)])
  assert.equal(withCondition.error,undefined)
  assert.equal(withCondition.status,1)
  assert.equal(withCondition.stdout,'')
  const unprivileged=process.geteuid?.()!==0
  assert.equal(withCondition.stderr,JSON.stringify({code:unprivileged?'private_native_email_recovery_action':'private_native_email_recovery_runtime',
    releaseWriterPause:false,retryAutomatically:false})+'\n')
  // The custodian is a library, not a CLI that may start a service by itself.
  const custodianDefault=smoke([join(output,custodianLibraryEntry)])
  assert.equal(custodianDefault.error,undefined)
  assert.equal(custodianDefault.status,1)
  assert.match(custodianDefault.stderr,/cannot be imported from a Client Component module/)
  const custodianWithCondition=smoke(['--conditions=react-server',join(output,custodianLibraryEntry)])
  assert.equal(custodianWithCondition.error,undefined)
  assert.equal(custodianWithCondition.status,0)
  assert.equal(custodianWithCondition.stdout,'')
  assert.equal(custodianWithCondition.stderr,'')
  // The batch-hold tools are private libraries, not executable operations.
  for(const path of terminalHoldLibraryEntries){
    const defaultImport=smoke([join(output,path)])
    assert.equal(defaultImport.error,undefined)
    assert.equal(defaultImport.status,1)
    assert.match(defaultImport.stderr,/cannot be imported from a Client Component module/)
    const privateImport=smoke(['--conditions=react-server',join(output,path)])
    assert.equal(privateImport.error,undefined)
    assert.equal(privateImport.status,0)
    assert.equal(privateImport.stdout,'')
    assert.equal(privateImport.stderr,'')
  }

  const outputs=Object.fromEntries(emittedFiles(output).map(file=>[relative(output,file),sha(readFileSync(file))]).sort(([a],[b])=>a.localeCompare(b)))
  const manifest={version:1,purpose:'clawpilot-native-email-recovery-private-operator-build',typescriptVersion:ts.version,
    nodeMajor:24,entry,custodianLibraryEntry,terminalHoldLibraryEntries,requiredNodeCondition:'react-server',buildScriptSha256:sha(readFileSync(script)),
    appPackageLockSha256:sha(readFileSync(join(app,'package-lock.json'))),rewrittenAliases,sources,outputs}
  const manifestFile=join(output,'build-manifest.json')
  writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600})
  process.stdout.write(JSON.stringify({built:true,output,entry:join(output,entry),custodianLibraryEntry:join(output,custodianLibraryEntry),sourceCount:files.length,
    outputCount:Object.keys(outputs).length,rewrittenAliases,manifestSha256:sha(readFileSync(manifestFile)),
    emittedEarlyGuardSmokePassed:true,defaultServerOnlyRefusalPassed:true,custodianLibrarySmokePassed:true,
    terminalHoldLibrarySmokePassed:true,runtimeProof:false})+'\n')
}
