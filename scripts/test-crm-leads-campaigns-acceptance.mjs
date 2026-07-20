#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const { chromium } = requireFromApp('@playwright/test')
const contractsOnly = process.argv.includes('--contracts-only')
const actorEmail = 'crm.acceptance@example.test'
const shortLinkOrigin = 'https://links.acceptance.example.test'
const sessionSecret = 'crm-acceptance-session-secret-00000000000000000000'

const FIXTURES = Object.freeze({
  account: {
    name: 'Northstar Acceptance Manufacturing',
    priority: 'A',
    accountType: 'Customer',
    accountManager: actorEmail,
    website: 'https://northstar.example.test',
    phone: '+1 555 0100',
    email: 'operations@northstar.example.test',
    city: 'Raleigh',
    state: 'NC',
    country: 'US',
    description: 'Disposable CRM acceptance account.',
  },
  contact: {
    firstName: 'Maya',
    lastName: 'Chen',
    fullName: 'Maya Chen',
    accountManager: actorEmail,
    jobTitle: 'Operations Director',
    email: 'maya.chen@northstar.example.test',
    phoneWork: '+1 555 0101',
    phoneMobile: '+1 555 0102',
    description: 'Primary acceptance contact.',
  },
  lead: {
    firstName: 'Rafael',
    lastName: 'Torres',
    fullName: 'Rafael Torres',
    companyName: 'Blue Mesa Logistics',
    jobTitle: 'VP Operations',
    email: 'rafael.torres@bluemesa.example.test',
    phoneWork: '+1 555 0110',
    status: 'Qualified',
    source: 'Trade Show',
    assignedTo: actorEmail,
    description: 'Lead used to verify conversion relationships.',
  },
  archivedLead: {
    fullName: 'Archive Lead Fixture',
    companyName: 'Archive Fixture Company',
    email: 'archive.lead@example.test',
    status: 'New',
    source: 'Acceptance Fixture',
    assignedTo: actorEmail,
  },
  opportunity: {
    name: 'Northstar Expansion',
    status: 'Open',
    stage: 'Proposal',
    source: 'Customer Expansion',
    value: 125000,
    probability: 60,
    expectedClose: '2026-10-31',
    notes: 'Representative opportunity fixture.',
  },
  meeting: {
    subject: 'Northstar acceptance review',
    startsAt: '2026-08-12T14:00:00.000Z',
    endsAt: '2026-08-12T14:30:00.000Z',
    timezone: 'America/New_York',
    location: 'Video',
    attendeeEmails: ['maya.chen@northstar.example.test'],
    status: 'planned',
    description: 'Representative meeting fixture.',
  },
  campaign: {
    name: 'Fall Operations Briefing',
    status: 'draft',
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    senderEmail: actorEmail,
    subjectTemplate: 'Operations briefing for {{firstName}}',
    bodyTemplate: 'Hello {{firstName}}, review the fall operations briefing.',
    description: 'Representative campaign fixture.',
  },
  archivedCampaign: {
    name: 'Archive Campaign Fixture',
    status: 'draft',
    subjectTemplate: 'Archive fixture subject',
    bodyTemplate: 'Archive fixture body',
    senderEmail: actorEmail,
  },
  interaction: {
    subject: 'Acceptance activity attribution',
    interactionType: 'email',
    occurredAt: '2026-08-01T16:15:00.000Z',
    agentEmail: actorEmail,
    agentName: 'CRM Acceptance Operator',
    description: 'Representative interaction linked to lead and campaign.',
    direction: 'outbound',
    deliveryStatus: 'sent',
  },
})

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function verifySourceContracts() {
  assert.deepEqual(
    Object.keys(FIXTURES).filter((key) => !key.startsWith('archived')),
    ['account', 'contact', 'lead', 'opportunity', 'meeting', 'campaign', 'interaction'],
  )
  const route = read('app_src/app/api/crm/route.ts')
  const persistence = read('app_src/lib/persistence/crm.ts')
  const component = read('app_src/components/crm/CrmSection.tsx')
  const integrations = read('app_src/lib/crm/integrationActions.ts')
  const globalRoute = read('app_src/app/crm/[reference]/route.ts')

  assert.match(route, /export async function PATCH/)
  assert.match(route, /action === 'archive'/)
  assert.match(route, /action === 'convert-lead'/)
  assert.match(route, /relatedEntity/)
  assert.match(persistence, /export async function archiveCrmRecordInPostgres/)
  assert.match(persistence, /export async function convertCrmLeadInPostgres/)
  assert.match(persistence, /eventType: 'crm\.lead\.converted'/)
  assert.match(persistence, /operation, target_system, payload,[\s\S]*'delete_record', 'suitecrm'/)
  assert.match(persistence, /listCrmCampaignRecipientsInPostgres/)
  assert.match(component, /aria-label="Campaign recipients"/)
  assert.match(component, /aria-label="Related CRM activity"/)
  assert.match(component, /openLifecycleDialog\('convert-lead'/)
  assert.match(component, /openLifecycleDialog\('archive'/)
  assert.match(component, /width: \{ xs: '100%', sm: 460 \}/)
  assert.match(integrations, /campaignId: target\.id/)
  assert.match(integrations, /campaignRecipientId: recipient\.id/)
  assert.match(integrations, /stageActionInteraction/)
  assert.match(globalRoute, /if \(isPostgresStorageEnabled\(\) && !resolved\.found\)/)
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${commandName} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
  return String(result.stdout || '').trim()
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForPostgres(pool) {
  const deadline = Date.now() + 45_000
  let lastError
  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw lastError || new Error('PostgreSQL did not become ready')
}

async function waitForHttp(url, serverLogs) {
  const deadline = Date.now() + 90_000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`ClawPilot did not become ready: ${lastError?.message || 'timeout'}\n${serverLogs().slice(-4000)}`)
}

function sessionTokenHash(token) {
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(`clawpilot-browser-session:v1\n${token}`)
    .digest('hex')
}

async function seedTenant(pool) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const organization = await client.query(
      `INSERT INTO workspace_organizations (name, organization_type)
       VALUES ('CRM Acceptance Workspace', 'root')
       RETURNING id::text`,
    )
    const organizationId = organization.rows[0].id
    const permissions = {
      inviteUsers: true,
      manageUserAccess: true,
      createBoards: true,
      createPipelines: true,
      viewFullReleaseHistory: true,
      manageBackups: true,
      manageLinks: true,
      viewOrganizationAudit: true,
      viewSystemAudit: true,
    }
    await client.query(
      `INSERT INTO app_users (
         email, role, status, display_name, organization_id, organization_name,
         permissions, crm_user_enabled, reference_code, activated_at
       ) VALUES ($1, 'owner', 'active', 'CRM Acceptance Operator', $2::uuid,
         'CRM Acceptance Workspace', $3::jsonb, true, allocate_crm_reference('gu'), now())`,
      [actorEmail, organizationId, JSON.stringify(permissions)],
    )
    await client.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, permissions, status, is_default, created_by, updated_by
       ) VALUES ($1, $2::uuid, 'owner', $3::jsonb, 'active', true, $1, $1)`,
      [actorEmail, organizationId, JSON.stringify(permissions)],
    )
    await client.query(
      `UPDATE workspace_organizations SET created_by = $2, updated_by = $2 WHERE id = $1::uuid`,
      [organizationId, actorEmail],
    )
    const pipeline = await client.query(
      `INSERT INTO pipeline_spaces (name, owner_email, is_default, workspace_organization_id)
       VALUES ('CRM Acceptance Pipeline', $1, true, $2::uuid)
       RETURNING id::text`,
      [actorEmail, organizationId],
    )
    const token = crypto.randomBytes(32).toString('base64url')
    await client.query(
      `INSERT INTO app_sessions (
         token_hash, authenticated_user_email, effective_user_email, auth_method,
         device_label, idle_timeout_seconds, idle_expires_at, absolute_expires_at,
         active_workspace_organization_id
       ) VALUES ($1, $2, $2, 'demo', 'CRM acceptance harness', 3600,
         now() + interval '1 hour', now() + interval '12 hours', $3::uuid)`,
      [sessionTokenHash(token), actorEmail, organizationId],
    )
    await client.query('COMMIT')
    return { organizationId, pipelineId: pipeline.rows[0].id, token }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function apiJson(baseUrl, token, pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Cookie: `clawpilot_session=${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.ok !== true) {
    throw new Error(`${init.method || 'GET'} ${pathname} failed (${response.status}): ${payload.error || 'invalid response'}`)
  }
  return payload
}

function fields(entity, fixture, relationships = {}) {
  return { entity, fields: { ...fixture, ...relationships } }
}

async function runApiAcceptance(baseUrl, token, pool) {
  await apiJson(baseUrl, token, '/api/crm?entity=leads&limit=10')

  const account = (await apiJson(baseUrl, token, '/api/crm', {
    method: 'POST', body: JSON.stringify(fields('organizations', FIXTURES.account)),
  })).record
  const contact = (await apiJson(baseUrl, token, '/api/crm', {
    method: 'POST', body: JSON.stringify(fields('contacts', FIXTURES.contact, { organizationId: account.id })),
  })).record
  const lead = (await apiJson(baseUrl, token, '/api/crm', {
    method: 'POST', body: JSON.stringify(fields('leads', FIXTURES.lead)),
  })).record
  const archivedLead = (await apiJson(baseUrl, token, '/api/crm', {
    method: 'POST', body: JSON.stringify(fields('leads', FIXTURES.archivedLead)),
  })).record
  const opportunity = (await apiJson(baseUrl, token, '/api/crm', {
    method: 'POST',
    body: JSON.stringify(fields('opportunities', FIXTURES.opportunity, {
      organizationId: account.id,
      contactIds: [contact.id],
    })),
  })).record
  const meeting = (await apiJson(baseUrl, token, '/api/crm', {
    method: 'POST',
    body: JSON.stringify(fields('meetings', FIXTURES.meeting, {
      organizationId: account.id,
      contactId: contact.id,
      leadId: lead.id,
      opportunityId: opportunity.id,
    })),
  })).record
  const campaign = (await apiJson(baseUrl, token, '/api/crm', {
    method: 'POST', body: JSON.stringify(fields('campaigns', FIXTURES.campaign)),
  })).record
  const archivedCampaign = (await apiJson(baseUrl, token, '/api/crm', {
    method: 'POST', body: JSON.stringify(fields('campaigns', FIXTURES.archivedCampaign)),
  })).record
  const interaction = (await apiJson(baseUrl, token, '/api/crm', {
    method: 'POST',
    body: JSON.stringify(fields('interactions', FIXTURES.interaction, {
      organizationId: account.id,
      contactId: contact.id,
      leadId: lead.id,
      opportunityId: opportunity.id,
      campaignId: campaign.id,
    })),
  })).record

  for (const [entity, record, prefix] of [
    ['organizations', account, 'ga'], ['contacts', contact, 'gc'], ['leads', lead, 'gl'],
    ['opportunities', opportunity, 'go'], ['meetings', meeting, 'gm'],
    ['campaigns', campaign, 'gk'], ['interactions', interaction, 'gi'],
  ]) {
    assert.match(record.referenceCode, new RegExp(`^${prefix}[0-9]{7}$`), `${entity} Global ID`)
    assert.equal(record.shortUrl, `${shortLinkOrigin}/s/${record.referenceCode}`)
  }

  const editedLeadFields = { ...FIXTURES.archivedLead, status: 'Nurture', description: 'Edited before archival.' }
  await apiJson(baseUrl, token, '/api/crm', {
    method: 'POST',
    body: JSON.stringify({ entity: 'leads', id: archivedLead.id, fields: editedLeadFields }),
  })
  const leadSearch = await apiJson(baseUrl, token, '/api/crm?entity=leads&query=Nurture&limit=20')
  assert.equal(leadSearch.records.some((record) => record.id === archivedLead.id && record.status === 'Nurture'), true)

  const editedCampaignFields = { ...FIXTURES.archivedCampaign, subjectTemplate: 'Edited archive fixture subject' }
  await apiJson(baseUrl, token, '/api/crm', {
    method: 'POST',
    body: JSON.stringify({ entity: 'campaigns', id: archivedCampaign.id, fields: editedCampaignFields }),
  })
  const campaignSearch = await apiJson(baseUrl, token, '/api/crm?entity=campaigns&query=Edited%20archive&limit=20')
  assert.equal(campaignSearch.records.some((record) => record.id === archivedCampaign.id), true)

  for (const referenceCode of [lead.referenceCode, campaign.referenceCode]) {
    const globalResponse = await fetch(`${baseUrl}/crm/${referenceCode}`, {
      headers: { Cookie: `clawpilot_session=${token}` }, redirect: 'manual',
    })
    assert.equal(globalResponse.status, 307)
    assert.match(globalResponse.headers.get('location') || '', new RegExp(`crm=${referenceCode}`))
    const shortResponse = await fetch(`${baseUrl}/s/${referenceCode}`, { redirect: 'manual' })
    assert.equal(shortResponse.status, 307)
    assert.match(shortResponse.headers.get('location') || '', new RegExp(`/crm/${referenceCode}$`))
  }

  const conversion = await apiJson(baseUrl, token, '/api/crm', {
    method: 'PATCH',
    body: JSON.stringify({
      action: 'convert-lead', entity: 'leads', id: lead.id,
      fields: { accountName: 'Blue Mesa Logistics', opportunityName: 'Blue Mesa Platform Rollout', opportunityValue: 85000 },
    }),
  })
  assert.equal(conversion.result.created, true)
  assert.match(conversion.result.accountReferenceCode, /^ga[0-9]{7}$/)
  assert.match(conversion.result.contactReferenceCode, /^gc[0-9]{7}$/)
  assert.match(conversion.result.opportunityReferenceCode, /^go[0-9]{7}$/)
  const replayedConversion = await apiJson(baseUrl, token, '/api/crm', {
    method: 'PATCH',
    body: JSON.stringify({ action: 'convert-lead', entity: 'leads', id: lead.id, fields: {} }),
  })
  assert.equal(replayedConversion.result.created, false)

  const convertedSearch = await apiJson(baseUrl, token, `/api/crm?entity=leads&query=${lead.referenceCode}&limit=20`)
  const convertedLead = convertedSearch.records.find((record) => record.id === lead.id)
  assert.equal(convertedLead.status, 'Converted')
  assert.equal(convertedLead.convertedContactReferenceCode, conversion.result.contactReferenceCode)
  assert.equal(convertedLead.convertedOpportunityReferenceCode, conversion.result.opportunityReferenceCode)

  const campaignAction = await apiJson(baseUrl, token, '/api/crm/actions', {
    method: 'POST',
    body: JSON.stringify({
      actionType: 'send_campaign',
      referenceCode: campaign.referenceCode,
      payload: {
        recipientReferences: [contact.referenceCode, lead.referenceCode],
        subject: FIXTURES.campaign.subjectTemplate,
        text: FIXTURES.campaign.bodyTemplate,
      },
      idempotencyKey: 'crm-acceptance-campaign-send-v1',
      processNow: true,
    }),
  })
  assert.equal(
    campaignAction.action.status,
    'succeeded',
    `Campaign expansion failed: ${JSON.stringify(campaignAction.action)}`,
  )
  const campaignActivity = await apiJson(
    baseUrl,
    token,
    `/api/crm?entity=interactions&relatedEntity=campaigns&relatedId=${campaign.id}&limit=100`,
  )
  assert.equal(campaignActivity.campaignRecipients.length, 2)
  assert.deepEqual(
    new Set(campaignActivity.campaignRecipients.map((recipient) => recipient.referenceCode)),
    new Set([contact.referenceCode, lead.referenceCode]),
  )
  assert.equal(campaignActivity.records.some((record) => record.id === interaction.id), true)
  assert.equal(campaignActivity.records.some((record) => record.interactionType === 'campaign'), true)

  const leadActivity = await apiJson(
    baseUrl,
    token,
    `/api/crm?entity=interactions&relatedEntity=leads&relatedId=${lead.id}&limit=100`,
  )
  assert.equal(leadActivity.records.some((record) => record.subject === `Lead converted: ${FIXTURES.lead.fullName}`), true)
  assert.equal(leadActivity.records.some((record) => record.id === interaction.id), true)

  await apiJson(baseUrl, token, '/api/crm', {
    method: 'PATCH', body: JSON.stringify({ action: 'archive', entity: 'leads', id: archivedLead.id }),
  })
  await apiJson(baseUrl, token, '/api/crm', {
    method: 'PATCH', body: JSON.stringify({ action: 'archive', entity: 'campaigns', id: archivedCampaign.id }),
  })
  const archivedLeadSearch = await apiJson(baseUrl, token, `/api/crm?entity=leads&query=${archivedLead.referenceCode}&limit=20`)
  const archivedCampaignSearch = await apiJson(baseUrl, token, `/api/crm?entity=campaigns&query=${archivedCampaign.referenceCode}&limit=20`)
  assert.equal(archivedLeadSearch.records.length, 0)
  assert.equal(archivedCampaignSearch.records.length, 0)
  for (const referenceCode of [archivedLead.referenceCode, archivedCampaign.referenceCode]) {
    const globalResponse = await fetch(`${baseUrl}/crm/${referenceCode}`, {
      headers: { Cookie: `clawpilot_session=${token}` }, redirect: 'manual',
    })
    assert.equal(globalResponse.status, 404)
    const shortResponse = await fetch(`${baseUrl}/s/${referenceCode}`, { redirect: 'manual' })
    assert.equal(shortResponse.status, 404)
  }

  const databaseProof = await pool.query(
    `SELECT
       (SELECT count(*) FROM crm_reference_registry WHERE reference_code = ANY($1::text[]))::integer AS permanent_ids,
       (SELECT count(*) FROM sync_outbox
        WHERE operation = 'delete_record' AND target_system = 'suitecrm'
          AND aggregate_id = ANY($2::text[]))::integer AS suitecrm_deletes,
       (SELECT count(*) FROM audit_events
        WHERE event_type = 'crm.record.archived' AND aggregate_id = ANY($2::text[]))::integer AS archive_audits,
       (SELECT count(*) FROM audit_events
        WHERE event_type = 'crm.lead.converted' AND aggregate_id = $3)::integer AS conversion_audits`,
    [
      [archivedLead.referenceCode, archivedCampaign.referenceCode],
      [archivedLead.id, archivedCampaign.id],
      lead.id,
    ],
  )
  assert.deepEqual(databaseProof.rows[0], {
    permanent_ids: 2,
    suitecrm_deletes: 2,
    archive_audits: 2,
    conversion_audits: 1,
  })

  const ownerProof = await pool.query(
    `SELECT contact.owner_email, contact.owner_user_reference_code,
       opportunity.owner_name, relationship.contact_id::text AS linked_contact_id
     FROM crm_leads lead
     JOIN crm_contacts contact ON contact.id = lead.converted_contact_id
     JOIN crm_opportunities opportunity ON opportunity.id = lead.converted_opportunity_id
     JOIN crm_opportunity_contacts relationship
       ON relationship.opportunity_id = opportunity.id
      AND relationship.contact_id = contact.id
     WHERE lead.id = $1::uuid`,
    [lead.id],
  )
  assert.equal(ownerProof.rows[0].owner_email, actorEmail)
  assert.match(ownerProof.rows[0].owner_user_reference_code, /^gu[0-9]{7}$/)
  assert.equal(ownerProof.rows[0].owner_name, actorEmail)
  assert.equal(ownerProof.rows[0].linked_contact_id, convertedLead.convertedContactId)

  const projectionProof = await pool.query(
    `SELECT payload
     FROM sync_outbox
     WHERE target_system = 'suitecrm' AND operation = 'upsert_record'
       AND payload->>'localId' = ANY($1::text[])
     ORDER BY updated_at DESC`,
    [[account.id, contact.id, lead.id, convertedLead.convertedContactId, convertedLead.convertedOpportunityId, meeting.id, campaign.id, interaction.id]],
  )
  const projectedGlobalIds = new Set(projectionProof.rows.map((row) => row.payload?.attributes?.global_id_c).filter(Boolean))
  for (const referenceCode of [
    account.referenceCode, contact.referenceCode, lead.referenceCode, conversion.result.contactReferenceCode,
    conversion.result.opportunityReferenceCode, meeting.referenceCode, campaign.referenceCode, interaction.referenceCode,
  ]) {
    assert.equal(projectedGlobalIds.has(referenceCode), true, `SuiteCRM projection for ${referenceCode}`)
  }
  const childActions = await pool.query(
    `SELECT payload FROM crm_integration_actions
     WHERE aggregate_type = 'crm_campaign_recipient' AND payload->>'campaignId' = $1`,
    [campaign.id],
  )
  assert.equal(childActions.rowCount, 2)
  assert.equal(childActions.rows.every((row) => row.payload.campaignRecipientId), true)

  return { account, contact, lead, campaign, convertedLead, conversion }
}

async function runMobileAcceptance(baseUrl, token, records, serverLogs) {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    await context.addCookies([{
      name: 'clawpilot_session', value: token, url: baseUrl, httpOnly: true, sameSite: 'Lax',
    }])
    const page = await context.newPage()
    const pageResponse = await page.goto(`${baseUrl}/#crm`, { waitUntil: 'domcontentloaded' })
    assert.ok(
      pageResponse?.ok(),
      `CRM mobile page returned ${pageResponse?.status() || 'no response'}\n${serverLogs().slice(-4_000)}`,
    )
    try {
      await page.locator('h5').filter({ hasText: /^CRM$/ }).waitFor()
    } catch (error) {
      const body = await page.locator('body').innerText().catch(() => '')
      throw new Error(`CRM mobile page did not render at ${page.url()}: ${body.slice(0, 1_000)}`, { cause: error })
    }
    await page.getByRole('tab', { name: 'Leads' }).click()
    await page.getByPlaceholder('Search leads').waitFor()
    const leadRow = page.getByRole('row').filter({ hasText: records.lead.referenceCode })
    await leadRow.waitFor()
    await leadRow.click({ position: { x: 280, y: 20 } })
    await page.getByText('Edit Lead', { exact: true }).waitFor()
    await page.getByRole('region', { name: 'Converted records' }).waitFor()
    await page.getByRole('region', { name: 'Related CRM activity' }).waitFor()

    const editorDrawer = page.getByLabel('Close editor')
      .locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
    await page.waitForTimeout(450)
    const portraitGeometry = await editorDrawer.evaluate((drawer) => {
      const rect = drawer.getBoundingClientRect()
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        drawerLeft: rect.left,
        drawerRight: rect.right,
        drawerWidth: rect.width,
      }
    })
    assert.ok(
      portraitGeometry.documentWidth <= portraitGeometry.viewportWidth + 1,
      `CRM portrait document overflowed: ${JSON.stringify(portraitGeometry)}`,
    )
    assert.ok(portraitGeometry.drawerLeft >= -1, `CRM portrait drawer began offscreen: ${JSON.stringify(portraitGeometry)}`)
    assert.ok(
      portraitGeometry.drawerRight <= portraitGeometry.viewportWidth + 1,
      `CRM portrait drawer ended offscreen: ${JSON.stringify(portraitGeometry)}`,
    )
    assert.ok(portraitGeometry.drawerWidth > 300)
    await page.getByLabel('Close editor').click()

    await page.getByRole('tab', { name: 'Campaigns' }).click()
    await page.getByPlaceholder('Search campaigns').waitFor()
    const campaignRow = page.getByRole('row').filter({ hasText: records.campaign.referenceCode })
    await campaignRow.waitFor()
    await campaignRow.click({ position: { x: 280, y: 20 } })
    await page.getByText('Edit Campaign', { exact: true }).waitFor()
    await page.getByRole('region', { name: 'Campaign recipients' }).waitFor()
    await page.getByText(records.contact.referenceCode, { exact: false }).waitFor()
    await page.getByRole('region', { name: 'Related CRM activity' }).waitFor()

    await page.setViewportSize({ width: 844, height: 390 })
    await page.waitForTimeout(450)
    const campaignDrawer = page.getByLabel('Close editor')
      .locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
    const landscapeGeometry = await campaignDrawer.evaluate((drawer) => {
      const rect = drawer.getBoundingClientRect()
      const visibleControls = Array.from(drawer.querySelectorAll('button, a, input, textarea'))
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0)
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        drawerRight: rect.right,
        controlsInsideViewport: visibleControls.every((control) => control.left >= -1 && control.right <= window.innerWidth + 1),
      }
    })
    assert.ok(landscapeGeometry.documentWidth <= landscapeGeometry.viewportWidth + 1)
    assert.ok(landscapeGeometry.drawerRight <= landscapeGeometry.viewportWidth + 1)
    assert.equal(landscapeGeometry.controlsInsideViewport, true)
    await context.close()
  } finally {
    await browser.close()
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function main() {
  verifySourceContracts()
  if (contractsOnly) {
    console.log('CRM Leads/Campaigns source contracts passed')
    return
  }

  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-crm-acceptance-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  let app
  let pool
  let logs = ''
  const runtimeDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpilot-crm-acceptance-'))
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_acceptance',
      '-e', 'POSTGRES_DB=clawpilot_acceptance',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const postgresPort = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(postgresPort > 0, `Unable to resolve disposable PostgreSQL port from ${portOutput}`)
    const databaseUrl = `postgresql://postgres:clawpilot_acceptance@127.0.0.1:${postgresPort}/clawpilot_acceptance`
    pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 })
    await waitForPostgres(pool)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })
    const tenant = await seedTenant(pool)
    const appPort = await freePort()
    const baseUrl = `http://127.0.0.1:${appPort}`
    app = spawn(path.join(root, 'app_src', 'node_modules', '.bin', 'next'), [
      'dev', '--hostname', '127.0.0.1', '--port', String(appPort),
    ], {
      cwd: path.join(root, 'app_src'),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        RUNTIME_LANE: 'test',
        CLAWPILOT_REPO_ROOT: root,
        CLAWPILOT_STORAGE: 'postgres',
        DATABASE_URL: databaseUrl,
        PGSSLMODE: 'disable',
        TASKS_PATH: path.join(runtimeDataRoot, 'tasks.json'),
        PIPELINE_NORMALIZED_PATH: path.join(runtimeDataRoot, 'pipeline', 'normalized', 'current.json'),
        PIPELINE_LOG_PATH: path.join(runtimeDataRoot, 'logs', 'pipeline-events.jsonl'),
        PIPELINE_DROPDOWN_CACHE_PATH: path.join(runtimeDataRoot, 'pipeline', 'dropdowns', 'catalog.json'),
        AGENT_THREADS_PATH: path.join(runtimeDataRoot, 'agents', 'threads.json'),
        AGENT_ASSIGNMENTS_PATH: path.join(runtimeDataRoot, 'agents', 'assignments.json'),
        APP_AUTH_REQUIRED: '1',
        APP_LOGIN_EMAIL: actorEmail,
        APP_SESSION_SECRET: sessionSecret,
        CLAWPILOT_PUBLIC_URL: 'https://acceptance.clawpilot.test',
        SHORTLINK_PUBLIC_ORIGIN: shortLinkOrigin,
        NEXT_PUBLIC_APP_URL: baseUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    app.stdout.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-20_000) })
    app.stderr.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-20_000) })
    await waitForHttp(`${baseUrl}/api/health`, () => logs)
    const records = await runApiAcceptance(baseUrl, tenant.token, pool)
    await runMobileAcceptance(baseUrl, tenant.token, records, () => logs)
    console.log('CRM Leads/Campaigns disposable acceptance passed')
    console.log('validated: create edit archive search Global-ID short-link SuiteCRM conversion activity campaign-membership mobile')
  } finally {
    await stopProcess(app)
    if (pool) await pool.end().catch(() => undefined)
    spawnSync('docker', ['stop', '-t', '1', container], { cwd: root, encoding: 'utf8', timeout: 20_000 })
    fs.rmSync(runtimeDataRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
