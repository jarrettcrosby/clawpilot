import assert from 'node:assert/strict'
import {auditNativeInitialColdCache,STOCK_AUDIT_CACHE_PATH,STOCK_AUDIT_CACHE_PARENT,STOCK_AUDIT_SOURCE_HASHES} from './lib/native-initial-cold-cache.mjs'
const clone=x=>JSON.parse(JSON.stringify(x))
const stock={sources:{...STOCK_AUDIT_SOURCE_HASHES},vardef:{table:'does_not_exist'},auditCustomFields:0,fieldsMetaDataHash:'a'.repeat(64)}
const cache={[STOCK_AUDIT_CACHE_PATH]:{ctime:100,gid:0,ino:4,mode:493,mtime:100,nlink:1,
  sha256:'d105b295b6a1387d34c68e1ec061b2dd65405bf662b5db622ef2aee879e37847',size:81,uid:0},other:{directory:true,mode:493},
  [STOCK_AUDIT_CACHE_PARENT]:{ctime:100,directory:true,gid:0,ino:2,mode:493,mtime:100,nlink:2,uid:0}}
const touched=clone(cache);touched[STOCK_AUDIT_CACHE_PATH].mtime=101;touched[STOCK_AUDIT_CACHE_PATH].ctime=101;touched[STOCK_AUDIT_CACHE_PATH].ino=5
touched[STOCK_AUDIT_CACHE_PARENT].mtime=101;touched[STOCK_AUDIT_CACHE_PARENT].ctime=101
assert.equal(auditNativeInitialColdCache(cache,cache,stock,stock).cacheUnchanged,true)
const result=auditNativeInitialColdCache(cache,touched,stock,stock);assert.equal(result.knownStockAuditCacheTouchCount,2)
assert.equal(result.stockAuditAtomicReplacementObserved,true)
assert.equal(result.cacheUnchanged,false);assert.equal(result.zeroCacheWritesProven,false)
let denied=0
const reject=(mutate)=>{const after=clone(touched),e=clone(stock);mutate(after,e);assert.throws(()=>auditNativeInitialColdCache(cache,after,stock,e));denied++}
for(const key of ['sha256','size','mode','uid','gid','nlink'])reject(a=>{a[STOCK_AUDIT_CACHE_PATH][key]=key==='sha256'?'b'.repeat(64):999})
for(const key of ['mode','ino'])reject(a=>{a[STOCK_AUDIT_CACHE_PARENT][key]=999})
reject(a=>{delete a[STOCK_AUDIT_CACHE_PATH]});reject(a=>{a.unknown={directory:true}})
reject(a=>{a.other.mode=448});reject(a=>{a[STOCK_AUDIT_CACHE_PATH].mtime=99})
reject((a,e)=>{e.sources['public/legacy/modules/Audit/Audit.php']='b'.repeat(64)})
reject((a,e)=>{e.vardef.fields={id:{type:'id'}}});reject((a,e)=>{e.auditCustomFields=1})
reject((a,e)=>{e.fieldsMetaDataHash='b'.repeat(64)})
reject(a=>{a['modules/Audit/temp-unknown']={directory:false}})
reject(a=>{a[STOCK_AUDIT_CACHE_PATH]=clone(cache[STOCK_AUDIT_CACHE_PATH])})
console.log('PASS cold cache policy: exact stock atomic replacement only; '+denied+' negative regressions; zero cache writes explicitly NOT proven')
