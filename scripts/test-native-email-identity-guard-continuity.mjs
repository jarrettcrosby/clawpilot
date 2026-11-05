// Read-only migration continuity. Real SQL/rollback/native gates are separate.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const read=file=>readFileSync(new URL('../db/migrations/'+file,import.meta.url),'utf8')
const latest=read('0395_crm_native_email_existing_identity_links.sql')
const body=(sql,name)=>{
 const match=sql.match(new RegExp('CREATE (?:OR REPLACE )?FUNCTION '+name+'\\([\\s\\S]*?END \\$\\$;'))
 assert.ok(match,name);return match[0]
}
const normalized=sql=>sql.replace(/\s+/g,'')
const snapshot='clawpilot_native_email_transition_snapshot_guard'
const priorSnapshot=body(read('0384_crm_native_email_member_role_changes.sql'),snapshot)
 .replaceAll("desired->>'kind'='workspace_user_eligibility_v1'","desired->>'kind' IN ('workspace_user_eligibility_v1','user_identity_link_v1')")
assert.equal(normalized(body(latest,snapshot)),normalized(priorSnapshot),
 'First-link snapshot extension must retain the complete later role/ancestry guard, not the older pre-role function')
const row='clawpilot_native_email_authority_row_guard'
const newRow=body(latest,row).replace(/    ELSIF kind='user_identity_link_v1' AND TG_TABLE_NAME='app_users' THEN[\s\S]*?(?=    ELSIF kind='workspace_user_eligibility_v1')/,'')
assert.equal(normalized(newRow),normalized(body(read('0391_crm_native_email_unshared_workspace_enrollment.sql'),row)),
 'First-link row extension must preserve the newer unshared-workspace enrollment exception and every existing exact-delta fence')
console.log('PASS latest identity migration preserves the complete reviewed role-change and workspace-enrollment guards')
