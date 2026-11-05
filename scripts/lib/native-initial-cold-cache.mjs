import assert from 'node:assert/strict'

// Reviewed behavior of the pinned official SuiteCRM 8.10.1 sources. Audit has
// no fields; DynamicField atomically replaces its byte-identical vardef on real
// bean construction. This admits ONLY that file's inode/timestamps and its
// existing directory's timestamps, not a cache
// write prohibition or a general cache/content/ownership exception.
export const STOCK_AUDIT_CACHE_PATH='modules/Audit/Auditvardefs.php'
export const STOCK_AUDIT_CACHE_PARENT='modules/Audit'
export const STOCK_AUDIT_SOURCE_HASHES=Object.freeze({
  'public/legacy/modules/Audit/vardefs.php':'0639772c062c5d509919cdcf6b77e80d804df41a1a9742fd9ecd4f112478418d',
  'public/legacy/modules/Audit/Audit.php':'e71603454d14143c44cba1bff9477e159add938507450ed8f1a30b3e313bd9de',
  'public/legacy/modules/DynamicFields/DynamicField.php':'39b244d65b02214d529daf19a94a38bc2be3db4a9d4108b96cfe775d3aeb83d6',
  'public/legacy/include/SugarObjects/VardefManager.php':'3ad363489bbf2f7a7eb7aa05f0160dd1d3759445f870748c308ca684a17ed360',
  'public/legacy/include/utils/sugar_file_utils.php':'8f199e0b72f14ff18f89929d526fa0d228b0ec855f2027c9581bc5ac1895110b',
})
const CACHE_KEYS=['ctime','gid','ino','mode','mtime','nlink','sha256','size','uid']
const SAME_KEYS=['gid','mode','nlink','sha256','size','uid']
const PARENT_KEYS=['ctime','directory','gid','ino','mode','mtime','nlink','uid']
export function auditNativeInitialColdCache(before,after,beforeStock,afterStock){
  const evidence=stock=>{
    assert.deepEqual(stock.sources,STOCK_AUDIT_SOURCE_HASHES,'Official Audit/DynamicField source drift')
    assert.deepEqual(stock.vardef,{table:'does_not_exist'},'Audit must retain its real empty official vardef')
    assert.equal(stock.auditCustomFields,0,'Audit custom fields are not the reviewed empty profile')
    assert.match(stock.fieldsMetaDataHash,/^[a-f0-9]{64}$/)
  }
  evidence(beforeStock);evidence(afterStock);assert.deepEqual(afterStock,beforeStock,'Audit/custom-field evidence changed')
  assert.deepEqual(Object.keys(after).sort(),Object.keys(before).sort(),'Cold CLI created or deleted a cache path')
  for(const cache of [before,after]){
    const audit=cache[STOCK_AUDIT_CACHE_PATH]
    assert.ok(audit,'The reviewed Audit cache must already exist')
    assert.deepEqual(Object.keys(audit).sort(),CACHE_KEYS,'Audit cache metadata incomplete')
    assert.equal(audit.sha256,'d105b295b6a1387d34c68e1ec061b2dd65405bf662b5db622ef2aee879e37847','Audit cache content is not the reviewed empty vardef')
    assert.equal(audit.size,81);assert.equal(audit.nlink,1)
    for(const key of ['ctime','gid','ino','mode','mtime','nlink','size','uid'])assert.ok(Number.isSafeInteger(audit[key])&&audit[key]>=0,'Invalid Audit metadata '+key)
  }
  const changedPaths=Object.keys(before).filter(path=>JSON.stringify(before[path])!==JSON.stringify(after[path]))
  const stockAuditAtomicReplacementObserved=changedPaths.includes(STOCK_AUDIT_CACHE_PATH)
  const knownStockAuditCacheTouches=[]
  for(const path of changedPaths){
    if(path===STOCK_AUDIT_CACHE_PARENT){
      assert.ok(stockAuditAtomicReplacementObserved,'Parent timestamp change without qualifying Audit replacement')
      const a=before[path],b=after[path]
      assert.deepEqual(Object.keys(a).sort(),PARENT_KEYS);assert.deepEqual(Object.keys(b).sort(),PARENT_KEYS)
      assert.equal(a.directory,true)
      for(const key of ['directory','gid','ino','mode','nlink','uid'])assert.equal(b[key],a[key],'Audit parent changed '+key)
      for(const key of ['mtime','ctime'])assert.ok(Number.isSafeInteger(a[key])&&Number.isSafeInteger(b[key])&&b[key]>=a[key],'Invalid Audit parent timestamp')
      knownStockAuditCacheTouches.push({path,changedFields:['mtime','ctime'].filter(key=>a[key]!==b[key]),before:a,after:b})
      continue
    }
    assert.equal(path,STOCK_AUDIT_CACHE_PATH,'Unreviewed cold cache change: '+path)
    const a=before[path],b=after[path]
    for(const key of SAME_KEYS)assert.equal(b[key],a[key],'Audit cache changed '+key)
    const timestampChanges=['ino','mtime','ctime'].filter(key=>a[key]!==b[key])
    for(const key of ['mtime','ctime'])assert.ok(Number.isSafeInteger(a[key])&&Number.isSafeInteger(b[key])&&b[key]>=a[key],'Invalid Audit cache timestamp')
    assert.ok(timestampChanges.length>0)
    knownStockAuditCacheTouches.push({path,changedFields:timestampChanges,before:a,after:b})
  }
  return {cacheUnchanged:changedPaths.length===0,stockAuditAtomicReplacementObserved,knownStockAuditCacheTouchCount:knownStockAuditCacheTouches.length,
    knownStockAuditCacheTouches,allUnreviewedCacheUnchanged:true,zeroCacheWritesProven:false}
}
