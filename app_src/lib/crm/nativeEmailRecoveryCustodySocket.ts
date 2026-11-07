import 'server-only'
import {lstatSync} from 'node:fs'
import {createConnection,type Socket} from 'node:net'
import {dirname,join} from 'node:path'
import {TextDecoder} from 'node:util'
import {assertNativeEmailRecoveryCustodyChallenge,assertNativeEmailRecoveryCustodyEnvelopeVersion} from './nativeEmailRecoveryCustodyProof'
import {nativeEmailCanonicalJson,NativeEmailPublicationHeld,requireNativeEmail} from './nativeEmailPublication'

type CustodyRequest=Readonly<{socketPath:string;custodianUid:number;challenge:Readonly<Record<string,unknown>>}>
const MAX_FRAME_BYTES=8192, TIMEOUT_MS=5000, LF=10
const ZERO=BigInt(0), ONE=BigInt(1), MODE=BigInt(0o7777), WRITABLE=BigInt(0o022), UNSAFE_SOCKET=BigInt(0o7007)
const PARENT_MODE=[BigInt(0o750),BigInt(0o710)]
// sun_path is 104 bytes on macOS, including the terminator. A shorter,
// simple ASCII path also avoids abstract sockets and silent OS truncation.
const PATH=/^\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?![\s\S])/u
const prefix='legacy_dispatch_custody_socket_'
function need(value:unknown,code:string):asserts value {requireNativeEmail(value,prefix+code)}

function pinSocket(path:string,parts:readonly string[],uid:bigint):string {
  // Walk from root instead of normalizing through realpath: any symlink,
  // writable prefix, or untrusted directory owner invalidates the path.
  try {
    let cursor='/'
    const chain=['/']
    for(const part of parts.slice(0,-1)){cursor=join(cursor,part);chain.push(cursor)}
    const parent=dirname(path)
    const pins=chain.map(component=>{
      const stat=lstatSync(component,{bigint:true})
      const mode=stat.mode&MODE
      need(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.uid===ZERO||stat.uid===uid)&&(mode&WRITABLE)===ZERO,'path')
      if(component===parent)need(stat.uid===uid&&PARENT_MODE.includes(mode),'path')
      // Unrelated activity in a shared /run directory may change its mtime.
      return `${stat.dev}:${stat.ino}:${stat.uid}:${stat.gid}:${mode}${component===parent?`:${stat.ctimeNs}`:''}`
    })
    const socket=lstatSync(path,{bigint:true}), mode=socket.mode&MODE
    need(socket.isSocket()&&!socket.isSymbolicLink()&&socket.uid===uid&&socket.nlink===ONE
      &&(mode&UNSAFE_SOCKET)===ZERO,'path')
    pins.push(`${socket.dev}:${socket.ino}:${socket.uid}:${socket.gid}:${mode}:${socket.ctimeNs}:${socket.birthtimeNs}`)
    return pins.join('/')
  } catch {need(false,'path')}
}

/** Request one fresh proof from a separate local custodian. Path checks do
 * not prove peer identity or prove the writer pause. The operator must
 * independently authenticate the returned signature and exact challenge. */
export async function requestNativeEmailRecoveryCustody(input:CustodyRequest):Promise<unknown> {
  const {socketPath,custodianUid,challenge}=input
  const controller=process.geteuid?.()
  need(typeof socketPath==='string'&&PATH.test(socketPath)&&Buffer.byteLength(socketPath)<=103
    &&typeof controller==='number'&&controller>0&&Number.isSafeInteger(custodianUid)
    &&custodianUid>=0&&custodianUid<0xffffffff&&custodianUid!==controller,'configuration')
  const parts=socketPath.slice(1).split('/')
  need(parts.every(part=>part!=='.'&&part!=='..'),'configuration')
  const uid=BigInt(custodianUid)
  let packet:string
  try {
    assertNativeEmailRecoveryCustodyChallenge(challenge)
    packet=nativeEmailCanonicalJson(challenge)+'\n'
    need(Buffer.byteLength(packet)<=MAX_FRAME_BYTES,'request')
  } catch {need(false,'request')}
  const initial=pinSocket(socketPath,parts,uid)
  let socket:Socket
  try {socket=createConnection({path:socketPath})} catch {need(false,'connection')}
  return new Promise((resolve,reject)=>{
    const chunks:Buffer[]=[]
    let bytes=0,receivedFrame=false,sent=false,settled=false
    const finish=(code:string|null,value?:unknown)=>{
      if(settled)return
      settled=true
      clearTimeout(deadline)
      socket.destroy()
      if(code)reject(new NativeEmailPublicationHeld(prefix+code));else resolve(value)
    }
    // Absolute deadline, not an inactivity timeout (trickled bytes do not
    // extend it). The peer sends its response, then closes cleanly.
    const deadline=setTimeout(()=>finish('timeout'),TIMEOUT_MS)
    socket.once('connect',()=>{
      if(settled)return
      try {
        if(pinSocket(socketPath,parts,uid)!==initial){finish('path');return}
      } catch {finish('path');return}
      sent=true
      try {socket.write(packet,error=>{if(error)finish('connection')})} catch {finish('connection')}
    })
    socket.on('data',(chunk:Buffer)=>{
      if(settled)return
      const newline=chunk.indexOf(LF)
      if(!sent||receivedFrame||bytes+chunk.length>MAX_FRAME_BYTES||(newline!==-1&&newline!==chunk.length-1)){
        finish('frame');return
      }
      receivedFrame=newline!==-1
      bytes+=chunk.length;chunks.push(chunk)
    })
    socket.once('end',()=>{
      if(settled)return
      if(!receivedFrame){finish('frame');return}
      try {
        if(pinSocket(socketPath,parts,uid)!==initial){finish('path');return}
      } catch {finish('path');return}
      try {
        const wire=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks,bytes))
        const value:unknown=JSON.parse(wire)
        assertNativeEmailRecoveryCustodyEnvelopeVersion(value)
        if(nativeEmailCanonicalJson(value)+'\n'!==wire){finish('frame');return}
        finish(null,value)
      } catch {finish('frame')}
    })
    socket.on('error',()=>finish('connection'))
    socket.once('close',()=>finish('connection'))
  })
}
