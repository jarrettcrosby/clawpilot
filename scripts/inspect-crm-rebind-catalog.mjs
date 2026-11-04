#!/usr/bin/env node
// Diagnostic only. Exact source migrations in an owned disposable database;
// no target URL, saved environment, production rebind or attestation enrollment.
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {disposablePostgresDockerArgs,createDisposablePostgresRuntime} from './lib/disposable-postgres-docker.mjs'
import {applyMigration,command,migrations,waitForPostgres} from './test-commerce-order-revisions-postgres.mjs'
import {inspectProductionRebindHistorySchema,inspectPreCrmProductionRebindSchemaMetadata,
  inspectPreInitialEnrollmentProductionRebindSchemaMetadata,PRE_INITIAL_ENROLLMENT_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  inspectPreInitialReplanProductionRebindSchemaMetadata,PRE_INITIAL_REPLAN_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  inspectPreInitialDemoQuarantineProductionRebindSchemaMetadata,
  inspectPreRootOwnerSourceFenceProductionRebindSchemaMetadata,
  inspectPreUnmanagedPipelineProductionRebindSchemaMetadata,PRE_UNMANAGED_PIPELINE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  productionRebindHistorySchemaDigest} from './production-rebind-history-schema-attestation.mjs'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),{Pool}=require('pg')
const legacyOnlyTriggerFields=['physicalRelation','attributeNumbers','oldTransitionTable','newTransitionTable','constraintIndex','foreignKey']
const sortKeys=value=>Array.isArray(value)?value.map(sortKeys):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,sortKeys(v)])):value
assert.equal(process.argv.length,2,'No target or write/enrollment options are supported')
assert.equal(process.versions.node.split('.')[0],'24','Use the supported bundled Node24 runtime')
const image=process.env.CLAWPILOT_TEST_POSTGRES_IMAGE||'pgvector/pgvector:pg16'
assert.match(image,/^pgvector\/pgvector:pg(?:16|18)$/u)
const name=`clawpilot-crm-catalog-${process.pid}-${randomUUID().slice(0,8)}`
const environment={...process.env,CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE:'256m',CLAWPILOT_TEST_POSTGRES_MEMORY:'512m',CLAWPILOT_TEST_POSTGRES_CPUS:'0.5'}
const runtime=createDisposablePostgresRuntime()
const consumed=['scripts/inspect-crm-rebind-catalog.mjs','scripts/production-rebind-history-schema-attestation.mjs',
  'scripts/lib/disposable-postgres-docker.mjs','scripts/lib/postgres-test-migrations.mjs',
  ...migrations().map(file=>'db/migrations/'+file)]
const sourceHashes=Object.fromEntries(consumed.map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]))
let pool,started=false
try{
  const launch=disposablePostgresDockerArgs(['run','--rm','-d','--name',name,'--pull','never',
    '-e','POSTGRES_PASSWORD=crm_catalog_fixture','-e','POSTGRES_DB=crm_catalog_fixture',
    '-p','127.0.0.1::5432',image],{environment,runtime})
  started=true;command('docker',launch)
  const port=Number(command('docker',['port',name,'5432/tcp']).toString().match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]);assert.ok(port)
  const url=`postgresql://postgres:crm_catalog_fixture@127.0.0.1:${port}/crm_catalog_fixture`
  await waitForPostgres(url);pool=new Pool({connectionString:url,max:1})
  const client=await pool.connect();let previous
  try{
    // The production runner creates the ledger before migration 0001. Without
    // this exact bootstrap the helper appends checksum last, changing attnum
    // and invalidating any comparison with the enrolled production catalog.
    const runner=readFileSync(new URL('./db-migrate.mjs',import.meta.url),'utf8')
    const bootstrap=runner.match(/CREATE TABLE IF NOT EXISTS schema_migrations \(\s+filename text PRIMARY KEY,\s+checksum text,\s+applied_at timestamptz NOT NULL DEFAULT now\(\)\s+\)/)?.[0]
    assert.ok(bootstrap,'Review changed production migration-ledger bootstrap before diagnosing catalog drift')
    await client.query(bootstrap)
    for(const file of migrations()){
      await applyMigration(client,file)
      if(file<'0374_')continue
      const current=await (file<'0398_' ? inspectPreInitialEnrollmentProductionRebindSchemaMetadata(client)
        : file<'0399_' ? inspectPreInitialReplanProductionRebindSchemaMetadata(client)
        : file<'0400_' ? inspectPreInitialDemoQuarantineProductionRebindSchemaMetadata(client)
        : file<'0401_' ? inspectPreRootOwnerSourceFenceProductionRebindSchemaMetadata(client)
        : file<'0402_' ? inspectPreUnmanagedPipelineProductionRebindSchemaMetadata(client)
        : inspectProductionRebindHistorySchema(client))
      if(file==='0397_crm_native_root_registry_changes.sql'){
        assert.equal(current.schemaDigest,PRE_INITIAL_ENROLLMENT_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[current.postgresMajor],
          'The exact through-0397 catalog must preserve its frozen v13 digest before enrolling 0398')
        console.log(JSON.stringify({diagnosticOnly:true,image,pre0398V13Digest:current.schemaDigest}))
      }
      if(file==='0398_crm_native_email_initial_enrollment.sql'){
        assert.equal(current.schemaDigest,PRE_INITIAL_REPLAN_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[current.postgresMajor],
          'The exact through-0398 catalog must preserve its frozen v14 digest before enrolling 0399')
        console.log(JSON.stringify({diagnosticOnly:true,image,pre0399V14Digest:current.schemaDigest}))
      }
      if(file==='0401_crm_native_root_owner_source_fence.sql'){
        assert.equal(current.format,'clawpilot-production-rebind-v17-metadata-only')
        assert.equal(current.schemaDigest,PRE_UNMANAGED_PIPELINE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[current.postgresMajor],
          'The exact through-0401 catalog must preserve its independently accepted v17 digest')
        console.log(JSON.stringify({diagnosticOnly:true,image,through0401V17Digest:current.schemaDigest}))
      }
      if(file==='0396_crm_root_native_read_receipts.sql'){
        const priorCatalog={...current.catalog,relations:current.catalog.relations.filter(row=>row.expected!=='public.crm_native_email_authority_root_changes')}
        const priorDigest=productionRebindHistorySchemaDigest(priorCatalog)
        assert.equal(priorDigest,{16:'1f168c782a8b4debb70c9227d3f567196944d99ac7b1c037198b688f45a4774a',
          18:'2e30ee54c523693e2d4332e560ced93a669b3a5cd0839cc6b59bd75c4c543008'}[current.postgresMajor],
          'The exact pre-0397 catalog, excluding only the new absent relation target, must preserve its frozen v12 digest')
        console.log(JSON.stringify({diagnosticOnly:true,image,pre0397V12Digest:priorDigest}))
      }
      if(file==='0374_crm_interaction_organizations.sql'){
        const historical=await inspectPreCrmProductionRebindSchemaMetadata(client)
        const legacy={...historical.catalog,triggers:historical.catalog.triggers.map(t=>
          Object.fromEntries(Object.entries(t).filter(([key])=>!legacyOnlyTriggerFields.includes(key))))}
        assert.equal(createHash('sha256').update(JSON.stringify(sortKeys(legacy))).digest('hex'),{
        16:'e17b81771769049dbcbb4e0296ab259be229775cbc0b3625fb37153ea9dffc29',
        18:'495b6c9b15e80039faf1323c4ceb2508e6c3c9e2fa363dacbeafc9a8fb2cdb50',
        }[current.postgresMajor],'Original byte-preserving v9 projection must match its frozen receipt before semantic enrollment')
        console.log(JSON.stringify({diagnosticOnly:true,image,historicalSemantic:true,
          postgresMajor:historical.postgresMajor,schemaDigest:historical.schemaDigest,catalog:historical.catalog}))
      }
      if(current.schemaDigest===previous?.schemaDigest)continue
      const changes={}
      if(previous)for(const field of ['relations','columns','constraints','indexes','triggers','functions']){
        const before=previous.catalog[field],after=current.catalog[field]
        assert.ok(Array.isArray(before)&&Array.isArray(after),field)
        const oldSet=new Set(before.map(row=>JSON.stringify(row))),newSet=new Set(after.map(row=>JSON.stringify(row)))
        const added=after.filter(row=>!oldSet.has(JSON.stringify(row))),removed=before.filter(row=>!newSet.has(JSON.stringify(row)))
        if(added.length||removed.length)changes[field]={added,removed}
      }
      console.log(JSON.stringify({diagnosticOnly:true,image,postgresMajor:current.postgresMajor,migration:file,
        previousDigest:previous?.schemaDigest??null,completeDigest:current.schemaDigest,changes}))
      previous=current
    }
  }finally{client.release()}
  for(const [path,expected]of Object.entries(sourceHashes))assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),expected,
    'Consumed catalog source changed during capture: '+path)
  console.log(JSON.stringify({diagnosticOnly:true,image,migrationCount:migrations().length,sourceHashes,productionTouched:false,attestationEnrolled:false}))
}finally{try{if(pool)await pool.end()}finally{if(started)assert.equal(runtime.cleanup(),true,'Exact owned catalog DB/container/lease cleanup required')}}
