import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute } from 'node:path'

const project='b5169ebd-8166-4b96-9a81-7cc8adaa9270', environment='058ce52f-1d3b-44bb-afe2-0df2bf24efb9'
const service={app:'f3fdf47c-6645-42ff-9a28-52843f8e4da2',native:'6975e7e2-3986-4453-8cc2-8367aa9b6405'}
const actions={app:['candidate','inspect','claim','settle','resolve'],native:['inspect','create','readback']}
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const HASH=/^[a-f0-9]{64}(?![\s\S])/u
const need=(ok,code)=>{if(!ok)throw new Error(`Exact BPO Email SSH held: ${code}`)}
const match=(value,re)=>typeof value==='string'&&re.test(value)

export function bpoFailedEmailSshArgs({side,action,deploymentInstanceId,pinsFingerprint,identityFile}) {
  need(Object.hasOwn(service,side)&&actions[side].includes(action)&&match(deploymentInstanceId,UUID)
    &&match(pinsFingerprint,HASH)&&typeof identityFile==='string'&&isAbsolute(identityFile),'exact_ssh_selection')
  const remote=side==='app'?`cd /app && exec node /app/scripts/run-bpo-failed-email-app-operator.mjs ${action} --pins-sha256=${pinsFingerprint}`
    :`exec php /opt/clawpilot/native-email-shared-repair-cli.php ${action} --pins-sha256=${pinsFingerprint}`
  return ['ssh','--project',project,'--environment',environment,'--service',service[side],
    '--deployment-instance',deploymentInstanceId,'--identity-file',identityFile,'--',remote]
}

/** One verified private SSH attempt, with a fixed remote action and no
 * stderr disclosure. A killed or nonzero process is never retried here. */
export function createBpoFailedEmailRepairSsh({railwayBinary,railwayFingerprint,identityFile,app,native}) {
  need(typeof railwayBinary==='string'&&isAbsolute(railwayBinary)&&typeof identityFile==='string'&&isAbsolute(identityFile)
    &&realpathSync(railwayBinary)===railwayBinary&&realpathSync(identityFile)===identityFile&&match(railwayFingerprint,HASH),'local_transport_paths')
  const binary=lstatSync(railwayBinary), key=lstatSync(identityFile)
  need(binary.isFile()&&binary.size<=50000000&&(binary.mode&0o022)===0&&key.isFile()
    &&key.uid===process.getuid()&&(key.mode&0o777)===0o600&&key.nlink===1,'local_transport_permissions')
  const verifyBinary=()=>need(createHash('sha256').update(readFileSync(railwayBinary)).digest('hex')===railwayFingerprint,'railway_binary_drift')
  verifyBinary()
  const pins=structuredClone({app,native})
  for(const side of ['app','native']){
    const pin=pins[side]
    need(pin&&Object.keys(pin).sort().join(',')==='deploymentInstanceId,pinsFingerprint'
      &&match(pin.deploymentInstanceId,UUID)&&match(pin.pinsFingerprint,HASH),'deployment_pin')
  }
  const env=Object.fromEntries(['HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL','TZ','SSH_AUTH_SOCK','RAILWAY_CONFIG_DIR']
    .filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))
  env.PATH=[dirname(railwayBinary),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].join(':')
  return async function invoke(side,action,input){
    const args=bpoFailedEmailSshArgs({...pins[side],side,action,identityFile})
    verifyBinary()
    const bytes=Buffer.from(JSON.stringify(input))
    need(bytes.length<=620000,'input_bound')
    return new Promise((resolve,reject)=>{
      const child=spawn(railwayBinary,args,{stdio:['pipe','pipe','pipe'],env,detached:true})
      const stdout=[];let count=0,discarded=0,failed=false,killTimer
      function kill(signal){if(child.pid)try{process.kill(-child.pid,signal)}catch{}}
      function stop(){if(failed)return;failed=true;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),500)}
      const deadline=setTimeout(stop,22000)
      child.stdout.on('data',part=>{count+=part.length;if(count>620000)stop();else stdout.push(part)})
      child.stderr.on('data',part=>{discarded+=part.length;if(discarded>16000)stop()})
      child.stdin.on('error',stop)
      child.once('error',stop)
      child.once('close',(code,signal)=>{
        clearTimeout(deadline);clearTimeout(killTimer);bytes.fill(0)
        if(failed||code!==0||signal){for(const part of stdout)part.fill(0);reject(new Error('Private SSH result unproven'));return}
        const output=Buffer.concat(stdout)
        try {resolve(JSON.parse(output.toString('utf8')))} catch {reject(new Error('Private SSH returned invalid evidence'))}
        finally {output.fill(0);for(const part of stdout)part.fill(0)}
      })
      child.stdin.end(bytes)
    })
  }
}
