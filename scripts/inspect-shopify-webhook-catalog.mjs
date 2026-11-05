#!/usr/bin/env node
// Diagnostic only, not acceptance: inspect exact source migrations in one
// guarded disposable database. Never reads .env or accepts a target DB URL.
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {createDisposablePostgresRuntime,disposablePostgresDockerArgs} from './lib/disposable-postgres-docker.mjs'
import {applyMigration,command,loadTypeScriptModule,migrations,waitForPostgres} from './test-commerce-order-revisions-postgres.mjs'
assert.equal(process.versions.node.split('.')[0],'24','Use the supported bundled Node24 runtime')
const args=process.argv.slice(2)
assert.ok(args.length===0||args.length===1&&/^--postgres-major=(16|18)$/.test(args[0]),'Use only --postgres-major=16|18')
const major=args[0]?.split('=')[1]??'16'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),{Pool}=require('pg')
const name=`clawpilot-webhook-catalog-${process.pid}-${randomUUID().slice(0,8)}`
const environment={...process.env,CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE:'256m',CLAWPILOT_TEST_POSTGRES_MEMORY:'512m',CLAWPILOT_TEST_POSTGRES_CPUS:'0.5'}
const runtime=createDisposablePostgresRuntime({environment})
const files=migrations(),sourceFiles=[resolve('scripts/inspect-shopify-webhook-catalog.mjs'),
  resolve('scripts/test-commerce-order-revisions-postgres.mjs'),resolve('scripts/lib/postgres-test-migrations.mjs'),
  resolve('scripts/lib/disposable-postgres-docker.mjs'),
  resolve('app_src/lib/persistence/shopifyOrderWebhookReconciliationHealth.ts'),
  resolve('app_src/lib/persistence/operationsOrderEditingReleaseHealth.ts'),...files.map(p=>resolve('db/migrations',p))]
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const sourceHashes=Object.fromEntries(sourceFiles.map(path=>[path,sha(path)]))
const orderEditing=loadTypeScriptModule('app_src/lib/persistence/operationsOrderEditingReleaseHealth.ts')
const health=loadTypeScriptModule('app_src/lib/persistence/shopifyOrderWebhookReconciliationHealth.ts',{
  '@/lib/persistence/operationsOrderEditingReleaseHealth':orderEditing})
const phases=[]
const historicalHashes={
  '0354_operations_sales_shipping_workspace_migration_safety.sql':'7da8e6dea1e15f45734cecc02923b9416e3715aef64bd371910bb20eb6c96759',
  '0375_crm_native_email_publication_admission.sql':'0ff23be2b44e8ee2bc88627d3cf2d52e207479da760121b30a2866182475cf60',
  '0383_crm_native_email_user_eligibility.sql':'d347a1790c2e126e0ad69d0543682a45d36428d73f099f289f6fea2be3e25cb5',
}
let pool
try{
  command('docker',disposablePostgresDockerArgs(['run','--rm','-d','--name',name,'--pull','never',
    '-e','POSTGRES_PASSWORD=webhook_catalog_fixture','-e','POSTGRES_DB=webhook_catalog_fixture',
    '-p','127.0.0.1::5432','pgvector/pgvector:pg'+major],{environment,runtime}))
  const port=Number(command('docker',['port',name,'5432/tcp']).toString().match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]);assert.ok(port)
  const databaseUrl=`postgresql://postgres:webhook_catalog_fixture@127.0.0.1:${port}/webhook_catalog_fixture`
  await waitForPostgres(databaseUrl);pool=new Pool({connectionString:databaseUrl,max:1})
  const client=await pool.connect();let previous
  try{for(const file of files){
    await applyMigration(client,file)
    if(file<'0354_')continue
    const row=(await client.query(`SELECT (${health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_TRIGGER_CATALOG_SQL}) AS hash`)).rows[0]
    if(row.hash===previous)continue
    previous=row.hash
    const triggers=(await client.query(`SELECT n.nspname AS schema_name,c.relname AS table_name,
      t.tgname,t.tgenabled,t.tgtype,t.tgisinternal,t.tgparentid::text AS parent_id,
      t.tgfoid::regprocedure::text AS function_signature,
      t.tgqual IS NULL AS qualification_is_null,
      CASE WHEN t.tgqual IS NULL THEN '' ELSE pg_catalog.pg_get_triggerdef(t.oid,false) END AS qualification,
      pg_catalog.pg_get_triggerdef(t.oid,false) AS definition
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname IN(
        'operations_shopify_order_webhook_commands','operations_shopify_order_webhook_attempts',
        'operations_shopify_order_webhook_outcomes','operations_integration_accounts',
        'operations_commerce_credentials','app_user_organization_memberships')
      ORDER BY c.relname,t.tgname`)).rows
    if(file<'0393_')assert.ok(triggers.every(t=>t.qualification_is_null===true),'Historical catalog qualifications must actually be NULL')
    if(historicalHashes[file])assert.equal(row.hash,historicalHashes[file],'Historical exact catalog pin must remain unchanged')
    const phase={diagnosticOnly:true,postgresMajor:Number(major),migration:file,migrationChecksum:sha(resolve('db/migrations',file)),completeTriggerHash:row.hash,completeTriggers:triggers}
    phases.push(phase);console.log(JSON.stringify(phase))
  }}finally{client.release()}
  for(const [path,expected]of Object.entries(sourceHashes))assert.equal(sha(path),expected,'Consumed source changed: '+path)
  console.log(JSON.stringify({kind:'shopify-webhook-trigger-catalog-diagnostic',diagnosticOnly:true,postgresMajor:Number(major),
    migrationsApplied:files.length,changedPhases:phases.map(p=>({migration:p.migration,migrationChecksum:p.migrationChecksum,completeTriggerHash:p.completeTriggerHash})),
    sourceHashes,productionTouched:false,acceptanceProven:false}))
}finally{try{if(pool)await pool.end()}finally{assert.equal(runtime.cleanup(),true,'Exact owned catalog database/lease cleanup must complete')}}
