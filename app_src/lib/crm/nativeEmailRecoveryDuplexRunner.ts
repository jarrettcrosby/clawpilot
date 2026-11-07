import {spawn} from 'node:child_process'
import {isAbsolute} from 'node:path'
import {TextDecoder} from 'node:util'

export type NativeEmailRecoveryDuplexCommand = Readonly<{
  program:string; args:readonly string[]; stdin:string|(()=>Promise<string>);
  /** A synchronous verifier for the one UTF-8 ready line, without LF. */
  verifyReady:(line:string)=>boolean;
}>
export type NativeEmailRecoveryDuplexCommandRunner = (command:NativeEmailRecoveryDuplexCommand)=>Promise<string>

const COMMAND_INVALID='legacy_dispatch_transport_command_invalid'
const DESTINATION_UNVERIFIED='legacy_dispatch_transport_destination_unverified'
const REMOTE_OUTCOME_UNKNOWN='legacy_dispatch_transport_remote_outcome_unknown'
const MAX_INPUT=650_000, MAX_READY=4096, MAX_REPLY=1_250_000
const LF=10
const isTime=(value:number,max:number)=>Number.isSafeInteger(value)&&value>=1&&value<=max
const validInput=(value:unknown):value is string=>typeof value==='string'&&Buffer.byteLength(value)>0&&Buffer.byteLength(value)<=MAX_INPUT
function inputBytes(value:unknown):Buffer {
  if(!validInput(value))throw new Error(COMMAND_INVALID)
  const bytes=Buffer.from(value,'utf8')
  if(bytes.toString('utf8')!==value){bytes.fill(0);throw new Error(COMMAND_INVALID)}
  return bytes
}

/** Launch one no-shell, no-PTY child. Never put packet bytes on its stdin
 * until this SAME child produces the only initial frame and the caller's
 * nonce/identity verifier accepts it. A failure after end(packet) is unknown,
 * never permission to reconnect or replay. Bytes arriving later cannot
 * retroactively cancel dispatch; reject a duplicate ready line in the reply. */
export function createNativeEmailRecoveryDuplexCommandRunner(timeoutMs=20_000,terminationGraceMs=1_000):NativeEmailRecoveryDuplexCommandRunner {
  if(!isTime(timeoutMs,60_000)||!isTime(terminationGraceMs,2_000))throw new Error(COMMAND_INVALID)
  return async command=>{
    if(!command||typeof command.program!=='string'||!isAbsolute(command.program)||command.program.includes('\0')
      ||Buffer.byteLength(command.program)>4096||!Array.isArray(command.args)||command.args.length>64
      ||(!validInput(command.stdin)&&typeof command.stdin!=='function')
      ||typeof command.verifyReady!=='function')throw new Error(COMMAND_INVALID)
    const args=Array.from(command.args)
    if(args.some(value=>typeof value!=='string'||value.includes('\0')||Buffer.byteLength(value)>4096))throw new Error(COMMAND_INVALID)
    const {program,verifyReady,stdin}=command
    let packet=typeof stdin==='string'?inputBytes(stdin):undefined
    return new Promise<string>((resolve,reject)=>{
      // Match the operator CLI's authentication allowlist, without passing
      // database credentials, signer material, or process injection flags.
      const env:NodeJS.ProcessEnv={NODE_ENV:'production'}
      for(const key of ['PATH','HOME','USER','LOGNAME','TMPDIR','SSH_AUTH_SOCK','RAILWAY_API_TOKEN','RAILWAY_TOKEN','RAILWAY_CONFIG_DIR'])
        if(process.env[key]!==undefined)env[key]=process.env[key]
      const detached=process.platform!=='win32'
      let child
      try { child=spawn(program,args,{env,stdio:['pipe','pipe','pipe'],shell:false,detached,windowsHide:true}) }
      catch { packet?.fill(0);reject(new Error(DESTINATION_UNVERIFIED));return }

      const decode=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)
      let ready=Buffer.alloc(0), frame:string|undefined, replySize=0
      const reply:Buffer[]=[]
      let dispatched=false, closed=false, settled=false, failure:string|undefined
      let escalation:ReturnType<typeof setTimeout>|undefined
      let flushInput:ReturnType<typeof setImmediate>|undefined
      const errorCode=()=>dispatched?REMOTE_OUTCOME_UNKNOWN:DESTINATION_UNVERIFIED
      const finish=(error?:string,value?:string)=>{
        if(settled)return
        settled=true
        if(deadline)clearTimeout(deadline)
        if(escalation)clearTimeout(escalation)
        if(flushInput)clearImmediate(flushInput)
        packet?.fill(0)
        if(error)reject(new Error(error));else resolve(value!)
      }
      const terminate=(signal:NodeJS.Signals)=>{
        if(closed||!child.pid)return
        try { if(detached)process.kill(-child.pid,signal);else child.kill(signal) }
        catch { /* the owned process/group may already have exited */ }
      }
      const stop=()=>{
        if(settled||failure)return
        failure=errorCode()
        if(deadline)clearTimeout(deadline)
        if(flushInput)clearImmediate(flushInput)
        // Closing a pre-authentication stream transmits EOF, never data.
        child.stdin.destroy()
        if(closed||!child.pid){finish(failure);return}
        terminate('SIGTERM')
        escalation=setTimeout(()=>{
          terminate('SIGKILL')
          child.stdout.destroy();child.stderr.destroy()
          finish(failure)
        },terminationGraceMs)
      }

      child.stderr.on('data',()=>{}) // drain only; never surface remote stderr
      child.stderr.on('error',stop)
      child.stdin.on('error',stop)
      child.stdout.on('error',stop)
      child.on('error',stop)
      child.on('exit',(code,signal)=>{if(!dispatched||code!==0||signal!==null)stop()})
      child.stdout.on('data',(bytes:Buffer)=>{
        if(failure||settled)return
        if(dispatched){
          if(bytes.length>MAX_REPLY-replySize){stop();return}
          replySize+=bytes.length;reply.push(bytes);return
        }
        // No extra byte (including another frame) may precede the packet.
        if(frame!==undefined){stop();return}
        const end=bytes.indexOf(LF)
        const length=end===-1?bytes.length:end
        if(length>MAX_READY-ready.length||(end!==-1&&end!==bytes.length-1)){stop();return}
        ready=Buffer.concat([ready,bytes.subarray(0,length)])
        if(end===-1)return
        try {
          const line=decode(ready)
          if(!line||line.includes('\r')||line.includes('\0')||verifyReady(line)!==true){stop();return}
          frame=line
        } catch {stop();return}
        // Give already-readable stdout and an early child exit a chance to
        // invalidate the frame. The authenticated endpoint must then wait.
        flushInput=setImmediate(()=>{
          flushInput=undefined
          const unusable=()=>failure||settled||closed||child.exitCode!==null||child.signalCode!==null||!child.stdin.writable
          if(unusable()){stop();return}
          const send=(bytes:Buffer)=>{
            if(unusable()){bytes.fill(0);stop();return}
            dispatched=true // end() can enqueue bytes even if it subsequently fails
            try {child.stdin.end(bytes)} catch {stop()}
          }
          if(typeof stdin==='string'){send(packet!);return}
          // The private publish CAS and signature may only be requested now.
          // If it commits while the child closes, the controller must inspect
          // durable state, not infer it from whether this runner wrote bytes.
          void Promise.resolve().then(()=>{
            if(unusable())throw new Error(DESTINATION_UNVERIFIED)
            return stdin()
          }).then(value=>{
            if(unusable()){stop();return}
            packet=inputBytes(value);send(packet)
          }).catch(stop)
        })
      })
      child.on('close',(code,signal)=>{
        closed=true
        if(failure){finish(failure);return}
        if(!dispatched||code!==0||signal!==null||replySize===0){finish(errorCode());return}
        try {
          const output=decode(Buffer.concat(reply,replySize))
          if(output===frame||output.startsWith(frame+'\n')||output.endsWith('\n'+frame)||output.includes('\n'+frame+'\n')){
            finish(REMOTE_OUTCOME_UNKNOWN);return
          }
          finish(undefined,output)
        } catch {finish(REMOTE_OUTCOME_UNKNOWN)}
      })
      const deadline=setTimeout(stop,timeoutMs)
    })
  }
}
