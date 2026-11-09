import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomBytes,randomUUID} from 'node:crypto'
import {lstatSync,mkdtempSync,readFileSync,realpathSync,rmSync,unlinkSync,writeFileSync} from 'node:fs'
import {createServer} from 'node:net'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {runStorageGuard} from '../local-storage-guard.mjs'

/** Opt-in fixture transport only. It cannot select an existing server or use
 * application credentials. The owner must close its pools before cleanup. */
export async function startDisposableNativePostgres({major,fixturePrefix}){
  assert.match(major,/^(16|18)$/u)
  assert.match(fixturePrefix,/^clawpilot-[a-z0-9-]{1,22}-$/u)
  const repositoryRoot=fileURLToPath(new URL('../../',import.meta.url))
  const environment={...process.env,CI:'',VERCEL:'',VERCEL_ENV:''}
  for(const key of ['RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID','RAILWAY_ENVIRONMENT_NAME','RAILWAY_SERVICE_ID'])delete environment[key]
  assert.equal(runStorageGuard({argv:['--preflight'],environment,repositoryRoot}),0,'Native PostgreSQL fixture requires local disk headroom')
  const nativeBin=join('/opt/homebrew/opt',`postgresql@${major}`,'bin')
  const command=(executable,args,timeout=30000)=>execFileSync(join(nativeBin,executable),args,{
    env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},stdio:'pipe',encoding:'utf8',timeout})
  assert.match(command('pg_config',['--version']),new RegExp(`^PostgreSQL ${major}\\.`,'u'))
  const root=mkdtempSync(join(realpathSync('/tmp'),fixturePrefix)),owner=randomUUID()
  const marker=join(root,'owner')
  writeFileSync(marker,owner,{mode:0o600,flag:'wx'})
  let data,closed=false
  function cleanup(){
    if(closed)return
    const directory=lstatSync(root),mark=lstatSync(marker)
    assert.ok(directory.isDirectory()&&directory.uid===process.getuid()&&realpathSync(root)===root
      &&mark.isFile()&&mark.uid===process.getuid()&&(mark.mode&0o777)===0o600
      &&readFileSync(marker,'utf8')===owner,'Temporary fixture ownership changed; not removing it')
    if(data){
      let running=true
      try{command('pg_ctl',['-D',data,'status'],10000)}
      catch(error){if(error.status!==3)throw error;running=false}
      if(running){
        const [pid,directory]=readFileSync(join(data,'postmaster.pid'),'utf8').split('\n')
        assert.ok(/^[1-9][0-9]*$/u.test(pid)&&directory===data,'Refusing to stop an unowned PostgreSQL process')
        command('pg_ctl',['-D',data,'-m','fast','-w','-t','15','stop'],20000)
      }
    }
    rmSync(root,{recursive:true})
    closed=true
    process.off('exit',onExit)
    process.off('SIGINT',onInterrupt)
    process.off('SIGTERM',onTerminate)
  }
  function onExit(){
    try{cleanup()}catch{process.stderr.write(`Could not clean owned PostgreSQL fixture ${root}; inspect only that path.\n`)}
  }
  function onInterrupt(){onExit();process.exit(130)}
  function onTerminate(){onExit();process.exit(143)}
  process.once('exit',onExit)
  process.once('SIGINT',onInterrupt)
  process.once('SIGTERM',onTerminate)
  try{
    const password=randomBytes(32).toString('hex'),passwordPath=join(root,'password'),pgData=join(root,'data')
    writeFileSync(passwordPath,password+'\n',{mode:0o600,flag:'wx'})
    command('initdb',['-D',pgData,'-U','postgres','--auth-local=scram-sha-256','--auth-host=scram-sha-256',
      '--pwfile',passwordPath,'--no-locale','--encoding=UTF8','--no-instructions'])
    data=pgData
    unlinkSync(passwordPath)
    const server=createServer()
    const port=await new Promise((resolve,reject)=>{
      server.once('error',reject)
      server.listen(0,'127.0.0.1',()=>{
        const selected=server.address().port
        server.close(error=>error?reject(error):resolve(selected))
      })
    })
    command('pg_ctl',['-D',data,'-l',join(root,'postgres.log'),
      '-o',`-h 127.0.0.1 -p ${port} -k ${root} -c timezone=UTC -c shared_buffers=16MB -c max_connections=12`,
      '-w','-t','15','start'],20000)
    return {
      connection:{host:'127.0.0.1',port,database:'postgres',user:'postgres',password,ssl:false,options:'-c timezone=UTC'},
      async assertOwned(queryable){
        const {rows}=await queryable.query("SELECT current_setting('data_directory') AS path")
        assert.equal(rows.length,1)
        assert.equal(rows[0].path,data)
      },
      cleanup,
    }
  }catch(error){
    try{cleanup()}catch(cleanupError){throw new AggregateError([error,cleanupError],'Native fixture startup and owned cleanup both failed')}
    throw error
  }
}
