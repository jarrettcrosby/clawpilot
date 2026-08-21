#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import {
  command,
  loadTypeScriptModule,
  postgresAdapter,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const root = process.cwd()

async function rejected(work, code) {
  await assert.rejects(
    work,
    (error) => error?.code === code,
  )
}

function packagingModules(pool, auditEvents) {
  const domain = loadTypeScriptModule(
    'app_src/lib/operations/packagingMaterials.ts',
  )
  const persistence = loadTypeScriptModule(
    'app_src/lib/persistence/packagingMaterials.ts',
    {
      '@/lib/operations/packagingMaterials': domain,
      '@/lib/persistence/postgres': postgresAdapter(pool),
      '@/lib/auditWriter': {
        async recordAuditEvent(event) {
          auditEvents.push(event)
        },
      },
    },
  )
  const parser = loadTypeScriptModule(
    'app_src/lib/operations/shopifyPackagingImport.ts',
  )
  return { persistence, parser }
}

async function verify(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 })
  const suffix = randomUUID().slice(0, 8)
  const organizationId = randomUUID()
  const otherOrganizationId = randomUUID()
  const actorEmail = `packaging-${suffix}@example.test`
  const accountId = randomUUID()
  const warehouseId = randomUUID()
  const auditEvents = []
  const { persistence, parser } = packagingModules(pool, auditEvents)
  try {
    await pool.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active')`,
      [actorEmail],
    )
    await pool.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, created_by, updated_by
       ) VALUES
         ($1::uuid, $3, 'root', $4, $4),
         ($2::uuid, $5, 'root', $4, $4)`,
      [
        organizationId,
        otherOrganizationId,
        `Packaging acceptance ${suffix}`,
        actorEmail,
        `Packaging other ${suffix}`,
      ],
    )
    const account = await pool.query(
      `INSERT INTO operations_integration_accounts (
         id, organization_id, provider, integration_type, environment,
         display_name, status, configuration, external_account_id,
         commerce_credential_generation, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify', 'commerce', 'sandbox',
         'French Florist package fixture', 'active',
         jsonb_build_object(
           'shopDomain', $3::text,
           'submittedShopDomain', 'frenchflorist.myshopify.com'
         ),
         'gid://shopify/Shop/930279', 1, $4, $4
       ) RETURNING global_id`,
      [accountId, organizationId, `package-${suffix}.myshopify.com`, actorEmail],
    )
    await pool.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'gid://shopify/Shop/930279',
         'shopify_client_credentials', decode('01', 'hex'),
         decode(repeat('02', 12), 'hex'), decode(repeat('03', 16), 'hex'),
         1, '0279', 'verified', now(), 'unverified', $3, $3
       )`,
      [organizationId, accountId, actorEmail],
    )
    await pool.query(
      `INSERT INTO operations_warehouses (
         id, organization_id, code, name, status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'PACK-TEST', 'Packaging acceptance warehouse',
         'active', $3, $3
       )`,
      [warehouseId, organizationId, actorEmail],
    )

    const firstStarterCommand = await persistence
      .createStarterPackagingAssortmentInPostgres({
        organizationId,
        actorEmail,
        idempotencyKey: 'starter-assortment-acceptance-0001',
      })
    assert.equal(firstStarterCommand.createdCount, 6)
    assert.equal(firstStarterCommand.totalCount, 6)
    assert.equal(firstStarterCommand.replayed, false)
    const firstStarterReplay = await persistence
      .createStarterPackagingAssortmentInPostgres({
        organizationId,
        actorEmail,
        idempotencyKey: 'starter-assortment-acceptance-0001',
      })
    assert.equal(firstStarterReplay.replayed, true)
    assert.deepEqual(
      firstStarterReplay.materialGlobalIds,
      firstStarterCommand.materialGlobalIds,
      'A network retry must replay the same starter-material identities',
    )
    const firstStarterRows = await pool.query(
      `SELECT global_id, row_version::integer
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid
         AND global_id = ANY($2::text[])
       ORDER BY global_id`,
      [organizationId, firstStarterCommand.materialGlobalIds],
    )
    assert.equal(firstStarterRows.rowCount, 6)
    for (const row of firstStarterRows.rows) {
      const removedStarter = await persistence
        .removePackagingMaterialInPostgres({
          organizationId,
          actorEmail,
          materialGlobalId: row.global_id,
          expectedRowVersion: row.row_version,
          idempotencyKey: `remove-starter-assortment-${row.global_id}`,
        })
      assert.equal(removedStarter.outcome, 'deleted')
    }
    await rejected(
      persistence.createStarterPackagingAssortmentInPostgres({
        organizationId,
        actorEmail,
        idempotencyKey: 'starter-assortment-acceptance-0001',
      }),
      'PACKAGING_MATERIAL_STARTER_REPLAY_STALE',
    )
    const recreatedStarterCommand = await persistence
      .createStarterPackagingAssortmentInPostgres({
        organizationId,
        actorEmail,
        idempotencyKey: 'starter-assortment-acceptance-0002',
      })
    assert.equal(recreatedStarterCommand.createdCount, 6)
    assert.equal(recreatedStarterCommand.totalCount, 6)
    assert.equal(recreatedStarterCommand.replayed, false)
    assert.equal(
      recreatedStarterCommand.materialGlobalIds.some(
        (globalId) => firstStarterCommand.materialGlobalIds.includes(globalId),
      ),
      false,
      'A new intentional command must recreate deleted starters with new identities',
    )
    const recreatedStarterReplay = await persistence
      .createStarterPackagingAssortmentInPostgres({
        organizationId,
        actorEmail,
        idempotencyKey: 'starter-assortment-acceptance-0002',
      })
    assert.equal(recreatedStarterReplay.replayed, true)
    assert.deepEqual(
      recreatedStarterReplay.materialGlobalIds,
      recreatedStarterCommand.materialGlobalIds,
    )
    assert.equal(
      auditEvents.filter((event) => event.eventType
        === 'operations.packaging_material.starter_assortment_created').length,
      2,
      'Each intentional starter recreation must retain its own audit event',
    )

    const providerMaterial = {
      code: `PROVIDER-${suffix}`,
      name: 'Provider-evidenced packaging acceptance',
      materialType: 'carton',
      innerLengthMm: 1727,
      innerWidthMm: 356,
      innerHeightMm: 102,
      ratedOuterLengthMm: 1730,
      ratedOuterWidthMm: 368,
      ratedOuterHeightMm: 114,
      ratedOuterDimensionEvidenceType: 'provider',
      ratedOuterDimensionEvidenceReference:
        'https://supplier.example.test/snowboard-carton/outer',
      dimensionBasis: 'inner',
      dimensionEvidenceType: 'provider',
      dimensionEvidenceReference:
        'https://supplier.example.test/snowboard-carton/inner',
      tareWeightGrams: 1606,
      maxWeightGrams: 13608,
      unitCostMinor: 1131,
      currency: 'USD',
      status: 'draft',
      source: 'manual',
    }
    const createdProvider = await persistence.savePackagingMaterialInPostgres({
      organizationId,
      actorEmail,
      material: providerMaterial,
    })
    const createdProviderRow = await pool.query(
      `SELECT status, row_version::integer,
              dimension_evidence_type, dimension_evidence_reference,
              dimension_confirmed_at, dimension_confirmed_by
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [organizationId, createdProvider.globalId],
    )
    assert.equal(createdProviderRow.rows[0].status, 'draft')
    assert.equal(createdProviderRow.rows[0].dimension_evidence_type, 'provider')
    assert.equal(
      createdProviderRow.rows[0].dimension_evidence_reference,
      providerMaterial.dimensionEvidenceReference,
    )
    assert.ok(
      createdProviderRow.rows[0].dimension_confirmed_at instanceof Date,
      'Provider evidence creation must retain its confirmation timestamp',
    )
    assert.equal(
      createdProviderRow.rows[0].dimension_confirmed_by,
      actorEmail,
      'Provider evidence creation must retain its confirming actor',
    )
    await persistence.savePackagingMaterialStockInPostgres({
      organizationId,
      actorEmail,
      stock: {
        materialGlobalId: createdProvider.globalId,
        warehouseId,
        isAvailable: true,
        onHandQuantity: 100,
        reorderPointQuantity: 20,
        reorderToQuantity: 100,
      },
    })

    await pool.query(
      `UPDATE operations_packaging_materials
       SET dimension_confirmed_at = NULL,
           dimension_confirmed_by = NULL
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [organizationId, createdProvider.globalId],
    )
    const corruptedWorkspace = await persistence
      .readPackagingMaterialsWorkspaceFromPostgres({
        organizationId,
        canView: true,
        canManage: true,
      })
    const corruptedProvider = corruptedWorkspace.materials.find(
      (material) => material.globalId === createdProvider.globalId,
    )
    assert.ok(corruptedProvider)
    assert.equal(corruptedProvider.dimensionConfirmedAt, null)
    assert.equal(corruptedProvider.readiness.eligibleForCartonization, false)
    assert.deepEqual(
      Array.from(corruptedProvider.readiness.missing),
      ['dimension_evidence'],
      'A provider row with a missing retained timestamp must not appear optimizer-ready',
    )

    const forceNullFunction = `force_null_dimension_confirmation_${suffix}`
    const forceNullTrigger = `force_null_dimension_confirmation_${suffix}`
    await pool.query(
      `CREATE FUNCTION ${forceNullFunction}()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.code = '${providerMaterial.code}' THEN
           NEW.dimension_confirmed_at := NULL;
           NEW.dimension_confirmed_by := NULL;
         END IF;
         RETURN NEW;
       END;
       $$`,
    )
    await pool.query(
      `CREATE TRIGGER ${forceNullTrigger}
       BEFORE UPDATE ON operations_packaging_materials
       FOR EACH ROW EXECUTE FUNCTION ${forceNullFunction}()`,
    )
    await rejected(
      persistence.savePackagingMaterialInPostgres({
        organizationId,
        actorEmail,
        material: {
          ...providerMaterial,
          globalId: createdProvider.globalId,
          expectedRowVersion: createdProvider.rowVersion,
          name: 'Provider evidence activation must roll back',
          status: 'active',
        },
      }),
      'PACKAGING_MATERIAL_EVIDENCE_REQUIRED',
    )
    const rejectedProviderRow = await pool.query(
      `SELECT name, status, row_version::integer, dimension_confirmed_at
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [organizationId, createdProvider.globalId],
    )
    assert.equal(rejectedProviderRow.rows[0].name, providerMaterial.name)
    assert.equal(rejectedProviderRow.rows[0].status, 'draft')
    assert.equal(
      rejectedProviderRow.rows[0].row_version,
      createdProvider.rowVersion,
      'Failed provider activation must roll back every material mutation',
    )
    assert.equal(rejectedProviderRow.rows[0].dimension_confirmed_at, null)
    await pool.query(
      `DROP TRIGGER ${forceNullTrigger}
       ON operations_packaging_materials`,
    )
    await pool.query(`DROP FUNCTION ${forceNullFunction}()`)

    const activatedProvider = await persistence.savePackagingMaterialInPostgres({
      organizationId,
      actorEmail,
      material: {
        ...providerMaterial,
        globalId: createdProvider.globalId,
        expectedRowVersion: createdProvider.rowVersion,
        name: 'Provider-evidenced active packaging acceptance',
        status: 'active',
      },
    })
    assert.equal(activatedProvider.status, 'active')
    assert.equal(
      activatedProvider.rowVersion,
      createdProvider.rowVersion + 1,
    )
    const providerWorkspace = await persistence
      .readPackagingMaterialsWorkspaceFromPostgres({
        organizationId,
        canView: true,
        canManage: true,
      })
    const eligibleProvider = providerWorkspace.materials.find(
      (material) => material.globalId === createdProvider.globalId,
    )
    assert.ok(eligibleProvider)
    assert.equal(eligibleProvider.status, 'active')
    assert.equal(eligibleProvider.dimensionEvidenceType, 'provider')
    assert.ok(eligibleProvider.dimensionConfirmedAt)
    assert.equal(eligibleProvider.dimensionConfirmedBy, actorEmail)
    assert.equal(eligibleProvider.readiness.eligibleForCartonization, true)
    assert.deepEqual(Array.from(eligibleProvider.readiness.missing), [])

    const editableMaterial = {
      code: `EDIT-${suffix}`,
      name: 'Editable packaging acceptance',
      materialType: 'carton',
      innerLengthMm: 300,
      innerWidthMm: 200,
      innerHeightMm: 150,
      ratedOuterLengthMm: 310,
      ratedOuterWidthMm: 210,
      ratedOuterHeightMm: 160,
      ratedOuterDimensionEvidenceType: 'measured',
      ratedOuterDimensionEvidenceReference: 'Disposable PostgreSQL acceptance',
      dimensionBasis: 'inner',
      dimensionEvidenceType: 'measured',
      dimensionEvidenceReference: 'Disposable PostgreSQL acceptance',
      tareWeightGrams: 250,
      maxWeightGrams: 5_000,
      unitCostMinor: 125,
      currency: 'USD',
      status: 'draft',
      source: 'manual',
    }
    const createdEditable = await persistence.savePackagingMaterialInPostgres({
      organizationId,
      actorEmail,
      material: editableMaterial,
    })
    await persistence.savePackagingMaterialStockInPostgres({
      organizationId,
      actorEmail,
      stock: {
        materialGlobalId: createdEditable.globalId,
        warehouseId,
        isAvailable: true,
        onHandQuantity: 5,
        reorderPointQuantity: 1,
        reorderToQuantity: 5,
      },
    })
    const activatedEditable = await persistence.savePackagingMaterialInPostgres({
      organizationId,
      actorEmail,
      material: {
        ...editableMaterial,
        globalId: createdEditable.globalId,
        expectedRowVersion: createdEditable.rowVersion,
        name: 'Edited and activated packaging acceptance',
        status: 'active',
      },
    })
    assert.equal(activatedEditable.status, 'active')
    assert.equal(activatedEditable.rowVersion, createdEditable.rowVersion + 1)

    const csv = [
      parser.SHOPIFY_PACKAGING_IMPORT_HEADERS.join(','),
      'gid://shopify/ShippingPackage/1001,CYL5505BK,CYL5505BK,BOX,19,12,12,INCHES,1,POUNDS,true',
      'gid://shopify/ShippingPackage/1002,CYL5505WT,CYL5505WT,BOX,19,12,12,INCHES,1,POUNDS,false',
      'gid://shopify/ShippingPackage/1003,CYL5509-T,CYL5509-T,BOX,23,17,10,INCHES,1,POUNDS,false',
      '',
    ].join('\n')
    const preview = parser.parseShopifyPackagingImportCsv(csv)
    const firstImport = await persistence
      .importShopifyPackagingMaterialsInPostgres({
        organizationId,
        actorEmail,
        accountGlobalId: account.rows[0].global_id,
        idempotencyKey: 'packaging-import-acceptance-0001',
        preview,
      })
    assert.equal(firstImport.createdCount, 3)
    assert.equal(firstImport.updatedCount, 0)
    assert.equal(firstImport.providerReads, 0)
    assert.equal(firstImport.providerWrites, 0)
    assert.equal(firstImport.status, 'draft')
    const replay = await persistence.importShopifyPackagingMaterialsInPostgres({
      organizationId,
      actorEmail,
      accountGlobalId: account.rows[0].global_id,
      idempotencyKey: 'packaging-import-acceptance-0001',
      preview,
    })
    assert.equal(replay.replayed, true)
    const sameFileNewCommand = await persistence
      .importShopifyPackagingMaterialsInPostgres({
        organizationId,
        actorEmail,
        accountGlobalId: account.rows[0].global_id,
        idempotencyKey: 'packaging-import-acceptance-0001-second-command',
        preview,
      })
    assert.equal(sameFileNewCommand.updatedCount, 3)
    assert.equal(
      auditEvents.filter((event) => event.eventType
        === 'operations.packaging_material.shopify_csv_imported').length,
      2,
      'A distinct committed import command must retain its own audit event',
    )

    const imported = await pool.query(
      `SELECT id::text, global_id, code, status, source,
              source_integration_account_id::text, source_external_key,
              source_external_package_id, source_is_default,
              source_file_sha256, row_version::integer
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid
         AND source = 'shopify_import'
       ORDER BY code`,
      [organizationId],
    )
    assert.equal(imported.rowCount, 3)
    assert.deepEqual(
      imported.rows.map((row) => row.source),
      ['shopify_import', 'shopify_import', 'shopify_import'],
    )
    assert.equal(imported.rows[0].source_is_default, true)
    assert.equal(imported.rows[0].source_integration_account_id, accountId)
    assert.equal(imported.rows[0].source_file_sha256, preview.fileSha256)

    const changedPreview = parser.parseShopifyPackagingImportCsv(
      csv.replace('CYL5505BK,BOX,19,12,12', 'CYL5505BK updated,BOX,20,12,12'),
    )
    await pool.query(
      `UPDATE operations_packaging_materials
       SET inner_length_mm = 450, inner_width_mm = 280,
           inner_height_mm = 280, dimension_basis = 'inner',
           dimension_evidence_type = 'measured',
           dimension_evidence_reference = 'Acceptance measurement',
           dimension_confirmed_at = now(), dimension_confirmed_by = $3,
           max_weight_grams = 10000, unit_cost_minor = 100,
           currency = 'USD', status = 'active'
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [organizationId, imported.rows[0].global_id, actorEmail],
    )
    const refreshed = await persistence.importShopifyPackagingMaterialsInPostgres({
      organizationId,
      actorEmail,
      accountGlobalId: account.rows[0].global_id,
      idempotencyKey: 'packaging-import-acceptance-0002',
      preview: changedPreview,
    })
    assert.equal(refreshed.createdCount, 0)
    assert.equal(refreshed.updatedCount, 3)
    const refreshedRow = await pool.query(
      `SELECT name, rated_outer_length_mm, status, row_version::integer
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [organizationId, imported.rows[0].global_id],
    )
    assert.equal(refreshedRow.rows[0].name, 'CYL5505BK updated')
    assert.equal(refreshedRow.rows[0].rated_outer_length_mm, 508)
    assert.equal(refreshedRow.rows[0].status, 'draft')
    const secondDefaultCsv = [
      parser.SHOPIFY_PACKAGING_IMPORT_HEADERS.join(','),
      'gid://shopify/ShippingPackage/1002,CYL5505WT,CYL5505WT,BOX,19,12,12,INCHES,1,POUNDS,true',
      '',
    ].join('\n')
    await persistence.importShopifyPackagingMaterialsInPostgres({
      organizationId,
      actorEmail,
      accountGlobalId: account.rows[0].global_id,
      idempotencyKey: 'packaging-second-default-0001',
      preview: parser.parseShopifyPackagingImportCsv(secondDefaultCsv),
    })
    const durableDefaults = await pool.query(
      `SELECT code
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid
         AND source_integration_account_id = $2::uuid
         AND source = 'shopify_import'
         AND source_is_default = true`,
      [organizationId, accountId],
    )
    assert.deepEqual(
      durableDefaults.rows.map((row) => row.code),
      ['CYL5505WT'],
      'A later partial file moves, rather than duplicates, the account default',
    )
    const postDefaultVersion = await pool.query(
      `SELECT row_version::integer
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [organizationId, imported.rows[0].global_id],
    )

    const sourceGuardInput = {
      globalId: imported.rows[0].global_id,
      expectedRowVersion: postDefaultVersion.rows[0].row_version,
      code: imported.rows[0].code,
      name: 'Guarded import',
      materialType: 'carton',
      innerLengthMm: 450,
      innerWidthMm: 280,
      innerHeightMm: 280,
      ratedOuterLengthMm: 508,
      ratedOuterWidthMm: 305,
      ratedOuterHeightMm: 305,
      ratedOuterDimensionEvidenceType: 'provider',
      ratedOuterDimensionEvidenceReference: 'Acceptance import evidence',
      dimensionBasis: 'inner',
      dimensionEvidenceType: 'measured',
      dimensionEvidenceReference: 'Acceptance measurement',
      tareWeightGrams: 454,
      maxWeightGrams: 10000,
      unitCostMinor: 100,
      currency: 'USD',
      status: 'draft',
      source: 'manual',
    }
    await rejected(
      persistence.savePackagingMaterialInPostgres({
        organizationId,
        actorEmail,
        material: sourceGuardInput,
      }),
      'PACKAGING_MATERIAL_SOURCE_IMMUTABLE',
    )
    await rejected(
      persistence.savePackagingMaterialInPostgres({
        organizationId,
        actorEmail,
        material: {
          ...sourceGuardInput,
          globalId: undefined,
          expectedRowVersion: undefined,
          code: 'FORGED-SHOPIFY',
          source: 'shopify_import',
        },
      }),
      'PACKAGING_MATERIAL_SOURCE_IMMUTABLE',
    )
    await rejected(
      persistence.savePackagingMaterialInPostgres({
        organizationId,
        actorEmail,
        material: {
          ...sourceGuardInput,
          code: 'CHANGED-SHOPIFY-CODE',
          source: 'shopify_import',
        },
      }),
      'PACKAGING_MATERIAL_SHOPIFY_CODE_IMMUTABLE',
    )
    await assert.rejects(
      pool.query(
        `UPDATE operations_packaging_materials SET source = 'manual'
         WHERE organization_id = $1::uuid AND global_id = $2`,
        [organizationId, imported.rows[0].global_id],
      ),
      /source lineage is immutable/u,
    )
    await assert.rejects(
      pool.query(
        `INSERT INTO operations_packaging_materials (
           organization_id, code, name, material_type, status, source,
           created_by, updated_by
         ) VALUES (
           $1::uuid, 'FORGED-DIRECT', 'Forged direct import', 'carton',
           'draft', 'shopify_import', $2, $2
         )`,
        [organizationId, actorEmail],
      ),
      /source account lineage is invalid/u,
    )
    const faireAccountId = randomUUID()
    await pool.query(
      `INSERT INTO operations_integration_accounts (
         id, organization_id, provider, integration_type, environment,
         display_name, status, configuration, external_account_id,
         commerce_credential_generation, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'faire', 'commerce', 'production',
         'Invalid package source', 'active', '{}'::jsonb,
         'brand_invalid_package_source', 1, $3, $3
       )`,
      [faireAccountId, organizationId, actorEmail],
    )
    await assert.rejects(
      pool.query(
        `INSERT INTO operations_packaging_materials (
           organization_id, code, name, material_type, status, source,
           source_integration_account_id, source_external_key,
           source_external_package_id, source_is_default,
           source_imported_at, source_file_sha256,
           created_by, updated_by
         ) VALUES (
           $1::uuid, 'FORGED-FAIRE', 'Forged Faire Shopify import', 'carton',
           'draft', 'shopify_import', $2::uuid, 'code:FORGED-FAIRE',
           NULL, false, now(), repeat('a', 64), $3, $3
         )`,
        [organizationId, faireAccountId, actorEmail],
      ),
      /source account lineage is invalid/u,
    )
    const changedCodeCsv = csv.replace(
      'gid://shopify/ShippingPackage/1001,CYL5505BK,',
      'gid://shopify/ShippingPackage/1001,RENAMED1001,',
    )
    await rejected(
      persistence.importShopifyPackagingMaterialsInPostgres({
        organizationId,
        actorEmail,
        accountGlobalId: account.rows[0].global_id,
        idempotencyKey: 'packaging-changed-code-0001',
        preview: parser.parseShopifyPackagingImportCsv(changedCodeCsv),
      }),
      'SHOPIFY_PACKAGING_IMPORT_SOURCE_CONFLICT',
    )

    const dependent = imported.rows.find((row) => row.code === 'CYL5505BK')
    const removable = imported.rows.find((row) => row.code === 'CYL5505WT')
    const claimed = imported.rows.find((row) => row.code === 'CYL5509-T')
    await pool.query(
      `CREATE TABLE packaging_removal_reference (
         organization_id uuid NOT NULL,
         packaging_material_id uuid NOT NULL,
         FOREIGN KEY (organization_id, packaging_material_id)
           REFERENCES operations_packaging_materials(organization_id, id)
           ON DELETE RESTRICT
       )`,
    )
    await pool.query(
      `INSERT INTO packaging_removal_reference
       VALUES ($1::uuid, $2::uuid)`,
      [organizationId, dependent.id],
    )
    await pool.query(
      `INSERT INTO operations_packaging_material_stock (
         organization_id, packaging_material_id, warehouse_id,
         is_available, on_hand_quantity, created_by, updated_by
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, true, 10, $4, $4)`,
      [organizationId, dependent.id, warehouseId, actorEmail],
    )
    const currentDependent = await pool.query(
      `SELECT row_version::integer
       FROM operations_packaging_materials WHERE id = $1::uuid`,
      [dependent.id],
    )
    const retired = await persistence.removePackagingMaterialInPostgres({
      organizationId,
      actorEmail,
      materialGlobalId: dependent.global_id,
      expectedRowVersion: currentDependent.rows[0].row_version,
      idempotencyKey: 'remove-dependent-packaging-0001',
    })
    assert.equal(retired.outcome, 'retired')
    assert.equal(retired.providerWrites, 0)
    const retiredReplay = await persistence.removePackagingMaterialInPostgres({
      organizationId,
      actorEmail,
      materialGlobalId: dependent.global_id,
      expectedRowVersion: currentDependent.rows[0].row_version,
      idempotencyKey: 'remove-dependent-packaging-0001',
    })
    assert.equal(retiredReplay.replayed, true)
    assert.equal(retiredReplay.outcome, 'retired')
    const retiredEvidence = await pool.query(
      `SELECT material.status, stock.is_available,
              stock.row_version::integer AS stock_row_version
       FROM operations_packaging_materials material
       JOIN operations_packaging_material_stock stock
         ON stock.organization_id = material.organization_id
        AND stock.packaging_material_id = material.id
       WHERE material.id = $1::uuid`,
      [dependent.id],
    )
    assert.equal(retiredEvidence.rows[0].status, 'retired')
    assert.equal(retiredEvidence.rows[0].is_available, false)
    await rejected(
      persistence.savePackagingMaterialStockInPostgres({
        organizationId,
        actorEmail,
        stock: {
          materialGlobalId: dependent.global_id,
          warehouseId,
          expectedRowVersion: retiredEvidence.rows[0].stock_row_version,
          isAvailable: true,
          onHandQuantity: 10,
          reorderPointQuantity: null,
          reorderToQuantity: null,
        },
      }),
      'PACKAGING_MATERIAL_RETIRED',
    )
    await assert.rejects(
      pool.query(
        `UPDATE operations_packaging_material_stock SET is_available = true
         WHERE organization_id = $1::uuid
           AND packaging_material_id = $2::uuid`,
        [organizationId, dependent.id],
      ),
      /Retired packaging materials cannot have available warehouse stock/u,
    )
    assert.equal(
      (await pool.query(
        `SELECT is_available
         FROM operations_packaging_material_stock
         WHERE organization_id = $1::uuid
           AND packaging_material_id = $2::uuid`,
        [organizationId, dependent.id],
      )).rows[0].is_available,
      false,
    )
    const retiredVersion = await pool.query(
      `SELECT row_version::integer
       FROM operations_packaging_materials WHERE id = $1::uuid`,
      [dependent.id],
    )
    await rejected(
      persistence.savePackagingMaterialInPostgres({
        organizationId,
        actorEmail,
        material: {
          ...sourceGuardInput,
          globalId: dependent.global_id,
          expectedRowVersion: retiredVersion.rows[0].row_version,
          code: dependent.code,
          source: 'shopify_import',
          status: 'draft',
        },
      }),
      'PACKAGING_MATERIAL_RETIRED',
    )
    await assert.rejects(
      pool.query(
        `UPDATE operations_packaging_materials SET status = 'draft'
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [organizationId, dependent.id],
      ),
      /Retired packaging materials cannot be restored/u,
    )

    const currentRemovable = await pool.query(
      `SELECT row_version::integer
       FROM operations_packaging_materials WHERE id = $1::uuid`,
      [removable.id],
    )
    const removed = await persistence.removePackagingMaterialInPostgres({
      organizationId,
      actorEmail,
      materialGlobalId: removable.global_id,
      expectedRowVersion: currentRemovable.rows[0].row_version,
      idempotencyKey: 'remove-unused-packaging-0001',
    })
    assert.equal(removed.outcome, 'deleted')
    assert.equal(
      (await pool.query(
        `SELECT count(*)::integer AS count
         FROM operations_packaging_materials WHERE id = $1::uuid`,
        [removable.id],
      )).rows[0].count,
      0,
    )

    const reapplyCsv = [
      parser.SHOPIFY_PACKAGING_IMPORT_HEADERS.join(','),
      'gid://shopify/ShippingPackage/1999,REAPPLY-BOX,Reapply box,BOX,10,8,6,INCHES,0.5,POUNDS,false',
      '',
    ].join('\n')
    const reapplyPreview = parser.parseShopifyPackagingImportCsv(reapplyCsv)
    const reapplyFirst = await persistence.importShopifyPackagingMaterialsInPostgres({
      organizationId,
      actorEmail,
      accountGlobalId: account.rows[0].global_id,
      idempotencyKey: 'packaging-reapply-acceptance-0001',
      preview: reapplyPreview,
    })
    const reapplyFirstRow = await pool.query(
      `SELECT id::text, global_id, row_version::integer
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [organizationId, reapplyFirst.materialGlobalIds[0]],
    )
    const reapplyRemoved = await persistence.removePackagingMaterialInPostgres({
      organizationId,
      actorEmail,
      materialGlobalId: reapplyFirstRow.rows[0].global_id,
      expectedRowVersion: reapplyFirstRow.rows[0].row_version,
      idempotencyKey: 'remove-reapply-packaging-0001',
    })
    assert.equal(reapplyRemoved.outcome, 'deleted')
    const reapplySecond = await persistence.importShopifyPackagingMaterialsInPostgres({
      organizationId,
      actorEmail,
      accountGlobalId: account.rows[0].global_id,
      idempotencyKey: 'packaging-reapply-acceptance-0002',
      preview: reapplyPreview,
    })
    assert.equal(reapplySecond.createdCount, 1)
    assert.notEqual(
      reapplySecond.materialGlobalIds[0],
      reapplyFirst.materialGlobalIds[0],
      'A new Apply command recreates a truly deleted package from the same file',
    )

    const claimedStock = await pool.query(
      `INSERT INTO operations_packaging_material_stock (
         organization_id, packaging_material_id, warehouse_id,
         is_available, on_hand_quantity, created_by, updated_by
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, true, 10, $4, $4)
       RETURNING id::text, row_version::integer`,
      [organizationId, claimed.id, warehouseId, actorEmail],
    )
    await pool.query('SET session_replication_role = replica')
    try {
      await pool.query(
        `INSERT INTO operations_packaging_material_claims (
           organization_id, plan_id, packaging_material_id, warehouse_id,
           packaging_material_stock_id, quantity, status,
           stock_row_version_at_claim, on_hand_quantity_at_claim,
           created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 2, 'active',
           $6, 10, $7, $7
         )`,
        [
          organizationId,
          randomUUID(),
          claimed.id,
          warehouseId,
          claimedStock.rows[0].id,
          claimedStock.rows[0].row_version,
          actorEmail,
        ],
      )
    } finally {
      await pool.query('SET session_replication_role = origin')
    }
    const claimedVersion = await pool.query(
      `SELECT row_version::integer
       FROM operations_packaging_materials WHERE id = $1::uuid`,
      [claimed.id],
    )
    await rejected(
      persistence.removePackagingMaterialInPostgres({
        organizationId,
        actorEmail,
        materialGlobalId: claimed.global_id,
        expectedRowVersion: claimedVersion.rows[0].row_version,
        idempotencyKey: 'remove-claimed-packaging-0001',
      }),
      'PACKAGING_MATERIAL_ACTIVE_CLAIMS_CONFLICT',
    )
    await rejected(
      persistence.importShopifyPackagingMaterialsInPostgres({
        organizationId: otherOrganizationId,
        actorEmail,
        accountGlobalId: account.rows[0].global_id,
        idempotencyKey: 'packaging-cross-tenant-0001',
        preview,
      }),
      'SHOPIFY_PACKAGING_IMPORT_ACCOUNT_UNAVAILABLE',
    )

    const workspace = await persistence
      .readPackagingMaterialsWorkspaceFromPostgres({
        organizationId,
        canView: true,
        canManage: true,
      })
    assert.equal(
      workspace.materials.some((material) => material.globalId === dependent.global_id),
      false,
      'Retired material is hidden from the active packaging catalog',
    )
    assert.equal(workspace.shopifyPackageImport.providerListApiAvailable, false)
    assert.equal(
      workspace.shopifyPackageImport.accounts[0].canonicalDomain,
      `package-${suffix}.myshopify.com`,
    )
    assert.ok(auditEvents.some(
      (event) => event.eventType
        === 'operations.packaging_material.shopify_csv_imported',
    ))
    assert.ok(auditEvents.some(
      (event) => event.eventType === 'operations.packaging_material.retired',
    ))
    assert.ok(auditEvents.some(
      (event) => event.eventType === 'operations.packaging_material.deleted',
    ))
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container =
    `clawpilot-packaging-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=packaging_materials',
      '-e', 'POSTGRES_DB=packaging_materials',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port from ${portOutput}`)
    const databaseUrl =
      `postgresql://postgres:packaging_materials@127.0.0.1:${port}`
      + '/packaging_materials'
    await waitForPostgres(databaseUrl)
    command(process.execPath, ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 300_000,
    })
    await verify(databaseUrl)
    console.log('Operations packaging disposable PostgreSQL acceptance passed')
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
