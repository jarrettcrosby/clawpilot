import { recordAuditEvent } from '@/lib/auditWriter'
import { stageCrmRecordWithClient } from '@/lib/persistence/crm'
import { syncPipelineProductDropdownCatalogInPostgres } from '@/lib/persistence/pipeline'
import { query, withTransaction } from '@/lib/persistence/postgres'

type SyncConfiguration = {
  pipeline_id: string | null
  customer_sync: boolean
  product_sync: boolean
  actor_email: string
}

function clean(value: unknown) {
  return String(value || '').trim()
}

function splitName(displayName: string) {
  const parts = displayName.split(/\s+/).filter(Boolean)
  if (parts.length < 2) return { firstName: displayName, lastName: '' }
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) || '' }
}

function sourceObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

async function configuration(organizationId: string): Promise<SyncConfiguration | null> {
  const result = await query<SyncConfiguration>(
    `SELECT crm_pipeline_id::text AS pipeline_id,
       crm_customer_sync_enabled AS customer_sync,
       crm_product_sync_enabled AS product_sync,
       credential_owner_email AS actor_email
     FROM organization_quickbooks_connections
     WHERE organization_id = $1::uuid
     LIMIT 1`,
    [organizationId],
  )
  return result.rows[0] || null
}

export async function configureQuickBooksCrmSyncInPostgres(input: {
  organizationId: string
  pipelineId: string
  customerSyncEnabled: boolean
  productSyncEnabled: boolean
  actorEmail: string
}) {
  const updated = await query(
    `UPDATE organization_quickbooks_connections connection SET
       crm_pipeline_id = $2::uuid,
       crm_customer_sync_enabled = $3,
       crm_product_sync_enabled = $4,
       last_crm_sync_error = NULL,
       updated_by = lower($5),
       updated_at = now()
     WHERE connection.organization_id = $1::uuid
       AND EXISTS (
         SELECT 1 FROM pipeline_spaces pipeline
         WHERE pipeline.id = $2::uuid
           AND pipeline.workspace_organization_id = connection.organization_id
       )`,
    [input.organizationId, input.pipelineId, input.customerSyncEnabled, input.productSyncEnabled, input.actorEmail],
  )
  if (!updated.rowCount) throw new Error('Connect QuickBooks and select a pipeline in the active organization')
  return reconcileQuickBooksCatalogToCrmInPostgres({ organizationId: input.organizationId, actorEmail: input.actorEmail })
}

export async function reconcileQuickBooksCatalogToCrmInPostgres(input: {
  organizationId: string
  actorEmail?: string | null
}) {
  const configured = await configuration(input.organizationId)
  if (!configured?.pipeline_id || (!configured.customer_sync && !configured.product_sync)) {
    return { configured: false, organizations: 0, contacts: 0, products: 0 }
  }
  const pipelineId = configured.pipeline_id
  const actorEmail = clean(input.actorEmail || configured.actor_email).toLowerCase()
  try {
    const counts = await withTransaction(async (client) => {
      const pipeline = await client.query(
        `SELECT 1 FROM pipeline_spaces
         WHERE id = $1::uuid AND workspace_organization_id = $2::uuid
         LIMIT 1`,
        [pipelineId, input.organizationId],
      )
      if (!pipeline.rowCount) throw new Error('QuickBooks CRM target pipeline is outside the active organization')

      let organizations = 0
      let contacts = 0
      let products = 0
      if (configured.customer_sync) {
        const workspaceRoot = await client.query<{ id: string; suitecrm_id: string | null }>(
          `SELECT id::text, suitecrm_id
           FROM crm_organizations
           WHERE pipeline_id = $1::uuid
             AND workspace_organization_id = $2::uuid
             AND relationship_type = 'workspace_root'
           ORDER BY updated_at DESC
           LIMIT 1`,
          [pipelineId, input.organizationId],
        )
        if (!workspaceRoot.rows[0]) {
          throw new Error('Create the active workspace CRM account before synchronizing QuickBooks customers')
        }
        const customers = await client.query<{
          quickbooks_customer_id: string
          display_name: string
          company_name: string | null
          email: string | null
          phone: string | null
          active: boolean
          source_payload: unknown
        }>(
          `SELECT quickbooks_customer_id, display_name, company_name, email, phone, active, source_payload
           FROM quickbooks_customers
           WHERE organization_id = $1::uuid AND active = true
           ORDER BY quickbooks_customer_id`,
          [input.organizationId],
        )
        for (const customer of customers.rows) {
          const providerId = customer.quickbooks_customer_id
          const sourcePayload = sourceObject(customer.source_payload)
          const linkedOrganization = await client.query<{ crm_record_id: string }>(
            `SELECT crm_record_id::text FROM quickbooks_crm_links
             WHERE organization_id = $1::uuid AND pipeline_id = $2::uuid
               AND provider_entity_type = 'customer' AND provider_entity_id = $3
               AND crm_entity_type = 'organization' LIMIT 1`,
            [input.organizationId, pipelineId, providerId],
          )
          const organizationName = clean(customer.company_name) || clean(customer.display_name)
          const stagedOrganization = await stageCrmRecordWithClient(client, {
            pipelineId,
            localId: linkedOrganization.rows[0]?.crm_record_id || null,
            entity: 'organizations',
            sourceKey: `quickbooks:customer:${providerId}`,
            sourcePayload: { provider: 'quickbooks', customerId: providerId, customer: sourcePayload },
            actorEmail,
            emitSuiteCrmOutbox: true,
            fields: {
              name: organizationName,
              parentOrganizationId: workspaceRoot.rows[0].id,
              parentOrganizationSuiteCrmId: workspaceRoot.rows[0].suitecrm_id,
              relationshipType: 'customer',
              accountType: 'Customer',
              accountManager: actorEmail,
              email: customer.email || undefined,
              phone: customer.phone || undefined,
              description: 'Customer synchronized from QuickBooks Online.',
            },
          })
          await client.query(
            `INSERT INTO quickbooks_crm_links (
               organization_id, pipeline_id, provider_entity_type, provider_entity_id,
               crm_entity_type, crm_record_id, source_hash, synced_at, created_at, updated_at
             ) VALUES ($1::uuid, $2::uuid, 'customer', $3, 'organization', $4::uuid, $5, now(), now(), now())
             ON CONFLICT (organization_id, pipeline_id, provider_entity_type, provider_entity_id, crm_entity_type)
             DO UPDATE SET crm_record_id = EXCLUDED.crm_record_id, source_hash = EXCLUDED.source_hash,
               synced_at = now(), updated_at = now()`,
            [input.organizationId, pipelineId, providerId, stagedOrganization.id, stagedOrganization.sourceHash],
          )
          organizations += 1

          const contactName = clean(customer.display_name)
          const givenName = clean(sourcePayload.GivenName)
          const familyName = clean(sourcePayload.FamilyName)
          const describesPerson = Boolean(givenName || familyName)
            || contactName.toLowerCase() !== organizationName.toLowerCase()
          if (contactName && describesPerson) {
            const linkedContact = await client.query<{ crm_record_id: string }>(
              `SELECT crm_record_id::text FROM quickbooks_crm_links
               WHERE organization_id = $1::uuid AND pipeline_id = $2::uuid
                 AND provider_entity_type = 'customer' AND provider_entity_id = $3
                 AND crm_entity_type = 'contact' LIMIT 1`,
              [input.organizationId, pipelineId, providerId],
            )
            const fallbackName = splitName(contactName)
            const stagedContact = await stageCrmRecordWithClient(client, {
              pipelineId,
              localId: linkedContact.rows[0]?.crm_record_id || null,
              entity: 'contacts',
              sourceKey: `quickbooks:customer-contact:${providerId}`,
              sourcePayload: { provider: 'quickbooks', customerId: providerId, customer: sourcePayload },
              actorEmail,
              emitSuiteCrmOutbox: true,
              fields: {
                organizationId: stagedOrganization.id,
                organizationSuiteCrmId: stagedOrganization.suiteCrmId,
                firstName: givenName || fallbackName.firstName,
                lastName: familyName || fallbackName.lastName,
                fullName: contactName,
                contactType: 'Customer',
                email: customer.email || undefined,
                phoneWork: customer.phone || undefined,
                description: 'Customer contact synchronized from QuickBooks Online.',
              },
            })
            await client.query(
              `INSERT INTO quickbooks_crm_links (
                 organization_id, pipeline_id, provider_entity_type, provider_entity_id,
                 crm_entity_type, crm_record_id, source_hash, synced_at, created_at, updated_at
               ) VALUES ($1::uuid, $2::uuid, 'customer', $3, 'contact', $4::uuid, $5, now(), now(), now())
               ON CONFLICT (organization_id, pipeline_id, provider_entity_type, provider_entity_id, crm_entity_type)
               DO UPDATE SET crm_record_id = EXCLUDED.crm_record_id, source_hash = EXCLUDED.source_hash,
                 synced_at = now(), updated_at = now()`,
              [input.organizationId, pipelineId, providerId, stagedContact.id, stagedContact.sourceHash],
            )
            contacts += 1
          }
        }
      }

      if (configured.product_sync) {
        const items = await client.query<{
          quickbooks_item_id: string
          name: string
          fully_qualified_name: string
          item_type: string
          sku: string | null
          description: string | null
          unit_price: string
          purchase_cost: string
          active: boolean
          source_payload: unknown
        }>(
          `SELECT quickbooks_item_id, name, fully_qualified_name, item_type, sku, description,
             unit_price::text, purchase_cost::text, active, source_payload
           FROM quickbooks_items
           WHERE organization_id = $1::uuid AND lower(item_type) <> 'category'
           ORDER BY quickbooks_item_id`,
          [input.organizationId],
        )
        for (const item of items.rows) {
          const stagedProduct = await stageCrmRecordWithClient(client, {
            pipelineId,
            entity: 'products',
            sourceKey: `quickbooks:item:${item.quickbooks_item_id}`,
            sourcePayload: { provider: 'quickbooks', itemId: item.quickbooks_item_id, item: sourceObject(item.source_payload) },
            actorEmail,
            emitSuiteCrmOutbox: true,
            fields: {
              name: item.fully_qualified_name || item.name,
              sku: item.sku || undefined,
              productType: item.item_type.toLowerCase() === 'service' ? 'Service' : 'Good',
              category: item.item_type,
              status: item.active ? 'Active' : 'Inactive',
              price: Number(item.unit_price || 0),
              cost: Number(item.purchase_cost || 0),
              description: item.description || undefined,
              active: item.active,
            },
          })
          await client.query(
            `INSERT INTO quickbooks_crm_links (
               organization_id, pipeline_id, provider_entity_type, provider_entity_id,
               crm_entity_type, crm_record_id, source_hash, synced_at, created_at, updated_at
             ) VALUES ($1::uuid, $2::uuid, 'item', $3, 'product', $4::uuid, $5, now(), now(), now())
             ON CONFLICT (organization_id, pipeline_id, provider_entity_type, provider_entity_id, crm_entity_type)
             DO UPDATE SET crm_record_id = EXCLUDED.crm_record_id, source_hash = EXCLUDED.source_hash,
               synced_at = now(), updated_at = now()`,
            [input.organizationId, pipelineId, item.quickbooks_item_id, stagedProduct.id, stagedProduct.sourceHash],
          )
          products += 1
        }
      }
      await client.query(
        `UPDATE organization_quickbooks_connections SET
           last_crm_synced_at = now(), last_crm_sync_error = NULL, updated_at = now()
         WHERE organization_id = $1::uuid`,
        [input.organizationId],
      )
      await recordAuditEvent({
        actor: input.actorEmail || 'system',
        eventType: 'quickbooks.crm.reconciled',
        aggregateType: 'workspace_organization',
        aggregateId: input.organizationId,
        organizationId: input.organizationId,
        isSystem: !input.actorEmail,
        payload: { pipelineId, organizations, contacts, products },
      }, client)
      return { configured: true, pipelineId, organizations, contacts, products }
    })
    if (configured.product_sync) {
      await syncPipelineProductDropdownCatalogInPostgres({ pipelineId, actorEmail })
    }
    return counts
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'QuickBooks CRM reconciliation failed').slice(0, 1000)
    await query(
      `UPDATE organization_quickbooks_connections
       SET last_crm_sync_error = $2, updated_at = now()
       WHERE organization_id = $1::uuid`,
      [input.organizationId, message],
    ).catch(() => undefined)
    throw error
  }
}
