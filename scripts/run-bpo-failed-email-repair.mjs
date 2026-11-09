// Private console only. A signed-in release verifier must first independently
// pin both live deployments, install the exact empty native receipt schema,
// stage both protected server configurations, and seal this local config.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createBpoFailedEmailRepairSsh } from './lib/bpo-failed-email-repair-ssh.mjs'
import { createBpoFailedEmailOperatorProofs } from './lib/bpo-failed-email-operator-proof.mjs'
import { createBpoFailedEmailRepairOperator } from './lib/bpo-failed-email-repair-operator.mjs'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const HASH=/^[a-f0-9]{64}(?![\s\S])/u
const need=value=>{if(!value)throw new Error('Exact BPO Email operator needs the independently pinned private configuration')}
try {
  const [action,path,expectedSha,interactionId,...extra]=process.argv.slice(2)
  need(['candidate','inspect','repair'].includes(action)&&typeof path==='string'&&isAbsolute(path)&&realpathSync(path)===path
    &&HASH.test(expectedSha||'')&&UUID.test(interactionId||'')&&extra.length===0)
  const file=lstatSync(path)
  need(file.isFile()&&file.uid===process.getuid()&&file.nlink===1&&(file.mode&0o777)===0o600&&file.size<=200000)
  const data=readFileSync(path)
  let config
  try {need(createHash('sha256').update(data).digest('hex')===expectedSha);config=JSON.parse(data.toString('utf8'))}
  finally {data.fill(0)}
  need(config?.version===1&&(action!=='repair'||config.writeEnabled===true))
  const invoke=createBpoFailedEmailRepairSsh(config.ssh)
  if(action==='candidate'){
    const observation=await invoke('app','candidate',{interactionId})
    need(HASH.test(observation?.projectionFingerprint||''))
    // Never print the body. The pinned review can be prepared using this hash.
    process.stdout.write(JSON.stringify({state:'candidate-observed',interactionId,projectionFingerprint:observation.projectionFingerprint})+'\n')
  }else {
    const trust=createBpoFailedEmailOperatorProofs(config.proofs)
    const run=createBpoFailedEmailRepairOperator({trust,
      app:{inspect:interactionId=>invoke('app','inspect',{interactionId}),
        claim:(interactionId,absenceEvidence)=>invoke('app','claim',{interactionId,absenceEvidence}),
        settle:(interactionId,receiptEnvelope)=>invoke('app','settle',{interactionId,receiptEnvelope}),
        resolve:(interactionId,receiptEnvelope)=>invoke('app','resolve',{interactionId,receiptEnvelope})},
      native:{inspect:input=>invoke('native','inspect',input),create:input=>invoke('native','create',input),
        readback:input=>invoke('native','readback',input)}})
    const result=await run({action,interactionId})
    process.stdout.write(JSON.stringify(result)+'\n')
    if(action==='repair'&&result.state!=='settled')process.exitCode=1
  }
} catch {
  process.stderr.write('Exact BPO Email repair held; do not replay an unverified attempt.\n')
  process.exitCode=1
}
