import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

// This generates SELECTs from an exact private App candidate manifest. Pipe it
// to the separately verified stock SuiteCRM instance using its read-only SQL
// account/session; the generated SQL itself should not go in terminal output.
const [path,pin,...extra]=process.argv.slice(2)
const stat=path&&statSync(path)
const sha=/^[a-f0-9]{64}(?![\s\S])/u
if (!stat?.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||stat.size>30000||!sha.test(pin||'')||extra.length) {
  throw new Error('Exact private candidate inventory and independent digest required')
}
const raw=readFileSync(path,'utf8').trim()
if(createHash('sha256').update(raw).digest('hex')!==pin)throw new Error('Candidate inventory changed')
const data=JSON.parse(raw)
if(data.purpose!=='clawpilot-bpo-terminal-email-candidate-inventory'||data.readOnly!==true
  ||data.original11.length!==11||data.later8.length!==8)throw new Error('Exact 11 + 8 inventory required')
const rows=[...data.original11,...data.later8]
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const globalId=/^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
if(rows.some(r=>!uuid.test(r.nativeId||'')||!globalId.test(r.globalId||''))
  ||['nativeId','globalId'].some(k=>new Set(rows.map(r=>r[k])).size!==19))throw new Error('Duplicate or invalid identity')
const table=rows.map((r,i)=>`SELECT ${i+1} AS slot, '${r.nativeId}' AS native_id, '${r.globalId}' AS global_id`).join('\nUNION ALL ')
process.stdout.write(`START TRANSACTION READ ONLY;
WITH slots AS (${table})
SELECT JSON_OBJECT('slots',(SELECT COUNT(*) FROM slots),
  'emailIdMatches',(SELECT COUNT(*) FROM emails e JOIN slots s ON e.id=s.native_id),
  'customIdMatches',(SELECT COUNT(*) FROM emails_cstm e JOIN slots s ON e.id_c=s.native_id),
  'globalIdMatches',(SELECT COUNT(*) FROM emails_cstm e JOIN slots s ON e.global_id_c=s.global_id),
  'textMatches',(SELECT COUNT(*) FROM emails_text e JOIN slots s ON e.email_id=s.native_id),
  'relationshipMatches',(SELECT COUNT(*) FROM emails_beans e JOIN slots s ON e.email_id=s.native_id OR e.bean_id=s.native_id),
  'addressMatches',(SELECT COUNT(*) FROM emails_email_addr_rel e JOIN slots s ON e.email_id=s.native_id),
  'addressBeanMatches',(SELECT COUNT(*) FROM email_addr_bean_rel e JOIN slots s ON e.bean_id=s.native_id),
  'parentMatches',(SELECT COUNT(*) FROM emails e JOIN slots s ON e.parent_id=s.native_id),
  'noteMatches',(SELECT COUNT(*) FROM notes e JOIN slots s ON e.parent_id=s.native_id),
  'attachmentMatches',(SELECT COUNT(*) FROM attachments_references e JOIN slots s ON e.parent_id=s.native_id OR e.source_record_id=s.native_id),
  'folderMatches',(SELECT COUNT(*) FROM folders_rel e JOIN slots s ON e.polymorphic_id=s.native_id),
  'groupMatches',(SELECT COUNT(*) FROM securitygroups_records e JOIN slots s ON e.record_id=s.native_id),
  'templateSidecarTable',(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='emails_email_templates'),
  'receiptTable',(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='clawpilot_shared_bpo_email_receipts'));
ROLLBACK;
`)
