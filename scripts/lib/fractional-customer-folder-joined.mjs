// Opt-in local acceptance only. The other checkout is read and invoked, never
// copied, edited, built, staged or pointed at its ordinary database/environment.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FRACTIONAL_ROOT = '/Users/agentsuburbiasandwich/Desktop/Fractional'
const APP = `${FRACTIONAL_ROOT}/app`
const WORKER = `${APP}/tests/fixtures/customer-folder-publication-worker.ts`
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const helperPath = fileURLToPath(import.meta.url)
const CLAWPILOT_ROOT = resolve(dirname(helperPath), '../..')

/** Static, read-only preflight; called before the guarded container starts. */
export function inspectFractionalFolderSenderSources(ts) {
  assert.match(process.version, /^v24\./, 'Joined acceptance requires Node 24')
  assert.equal(realpathSync(FRACTIONAL_ROOT), FRACTIONAL_ROOT)
  const queue = [WORKER, `${APP}/src/worker.ts`, `${APP}/scripts/migration-runner.mjs`, `${APP}/scripts/migrate.mjs`]
  const hashes = {}, consumed = new Set()
  while (queue.length) {
    const path = queue.shift()
    if (consumed.has(path)) continue
    consumed.add(path)
    assert.ok(consumed.size <= 256, 'Unexpected Fractional source closure growth')
    assert.ok(path.startsWith(`${APP}/`) && !relative(APP, path).split('/').includes('..'))
    const stat = lstatSync(path)
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, 'Expected regular bounded source')
    const bytes = readFileSync(path)
    hashes[path] = sha(bytes)
    // The full ordinary worker is evidence of wiring, not executed. Its other
    // independent modules are outside this bounded sender invocation.
    if (path === `${APP}/src/worker.ts`) continue
    for (const imported of ts.preProcessFile(bytes.toString('utf8'), true, true).importedFiles) {
      if (imported.fileName.startsWith('.')) {
        const dependency = resolve(dirname(path), imported.fileName)
        assert.ok(/\.(?:ts|mjs)$/u.test(dependency), 'Explicit source extensions are required')
        queue.push(dependency)
      } else assert.ok(imported.fileName === 'pg' || imported.fileName.startsWith('node:'), 'Unexpected sender package dependency')
    }
  }
  const migrations = readdirSync(`${APP}/migrations`).filter(name => /^\d+.*\.sql$/u.test(name)).sort()
  assert.ok(migrations.includes('069_customer_folder_publication_index.sql'))
  for (const name of migrations) {
    const path = `${APP}/migrations/${name}`, stat = lstatSync(path)
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024)
    hashes[path] = sha(readFileSync(path))
  }
  for (const name of ['package.json', 'package-lock.json']) if (existsSync(`${APP}/${name}`)) hashes[`${APP}/${name}`] = sha(readFileSync(`${APP}/${name}`))
  hashes[helperPath] = sha(readFileSync(helperPath))
  for (const path of ['scripts/test-fractional-crm-gateway-postgres.mjs',
    'app_src/app/api/integrations/fractional-crm/v1/[...path]/route.ts', 'app_src/lib/fractionalCrmGatewayHttp.ts',
    'app_src/lib/fractionalCrmGatewayAuth.ts', 'app_src/lib/persistence/fractionalCrmGateway.ts',
    'app_src/lib/persistence/crm.ts', 'app_src/lib/persistence/crmNativeEmailAuthority.ts',
    'app_src/lib/crm/boardProjection.ts', 'app_src/lib/crm/customerFolderLinks.ts', 'app_src/lib/crm/fractionalCustomerFolder.ts']) {
    hashes[resolve(CLAWPILOT_ROOT, path)] = sha(readFileSync(resolve(CLAWPILOT_ROOT, path)))
  }
  return Object.freeze({ root: FRACTIONAL_ROOT, hashes: Object.freeze(hashes), migrationCount: migrations.length })
}

function unchanged(capture) {
  for (const [path, digest] of Object.entries(capture.hashes)) assert.equal(sha(readFileSync(path)), digest, 'Pinned joined source changed')
  const captured = Object.keys(capture.hashes).filter(path => path.startsWith(`${APP}/migrations/`)).sort()
  assert.deepEqual(readdirSync(`${APP}/migrations`).filter(name => /^\d+.*\.sql$/u.test(name)).sort().map(name => `${APP}/migrations/${name}`), captured,
    'The complete Fractional migration set must remain frozen')
}

// This private child command invokes the real administrator recheck, so an
// actual retry receipt becomes due without sleeping or rewriting ledger rows.
async function administratorChild(mode) {
  assert.equal(process.env.FRACTIONAL_TEST_DATABASE, '1')
  const url = new URL(process.env.FRACTIONAL_DATABASE_URL || 'invalid:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.match(url.pathname, /^\/fractional_test_joined_[a-z0-9_]+$/u)
  globalThis.fetch = async () => { throw new Error('Recheck cannot call a provider') }
  const { database, transaction, closeDatabase } = await import(pathToFileURL(`${APP}/src/server/db.ts`).href)
  try {
    if (mode === '--private-opt-in') {
      const { setCrmExclusion } = await import(pathToFileURL(`${APP}/src/server/crm-exclusions.ts`).href)
      const result = await transaction(client => setCrmExclusion(client, process.env.JOINED_ACTOR_ID, process.env.JOINED_ORGANIZATION_ID,
        { entity: 'customer', customerId: process.env.JOINED_CUSTOMER_ID },
        { excluded: false, expectedVersion: 0, idempotencyKey: `joined-fixture-explicit-crm-opt-in-${process.env.JOINED_CUSTOMER_ID}` }))
      assert.equal(result.effectiveExcluded, false)
      process.send?.({ type: 'rechecked', passed: true })
      return
    }
    const publication = await import(pathToFileURL(`${APP}/src/server/customer-folder-publication.ts`).href)
    const row = (await database().query(`SELECT id::text FROM audit_events WHERE organization_id=$1 AND customer_id=$2
      AND action='customer.drive.crm.publication' ORDER BY audit_events.id DESC LIMIT 1`,
    [process.env.JOINED_ORGANIZATION_ID, process.env.JOINED_CUSTOMER_ID])).rows[0]
    assert.ok(row)
    const result = await transaction(client => publication.retryCustomerFolderPublication(client, process.env.JOINED_ACTOR_ID,
      { organizationId: process.env.JOINED_ORGANIZATION_ID, customerId: process.env.JOINED_CUSTOMER_ID }, row.id))
    assert.equal(result.status, 'retry')
    process.send?.({ type: 'rechecked', passed: true })
  } finally { await closeDatabase(); process.disconnect?.() }
}

if (process.argv[1] === helperPath && process.argv[2] === '--private-sender') {
  assert.equal(process.argv.length, 3)
  assert.equal(process.env.FRACTIONAL_TEST_DATABASE, '1')
  assert.equal(typeof process.send, 'function', 'Private sender requires owned IPC')
  const originalSend = process.send.bind(process)
  // The existing read-only sender fixture forwards fetch through Node's JSON
  // IPC. Serialize Web API containers before that boundary; otherwise a real
  // URLSearchParams form silently becomes {} and cannot be strictly checked.
  process.send = (message, ...args) => {
    if (message?.type === 'fetch' && message.init) {
      const init = { ...message.init }
      if (init.body instanceof URLSearchParams) init.body = init.body.toString()
      if (init.headers instanceof Headers) init.headers = Object.fromEntries(init.headers)
      message = { ...message, init }
    }
    return originalSend(message, ...args)
  }
  await import(pathToFileURL(WORKER).href)
}

if (process.argv[1] === helperPath && ['--private-recheck', '--private-opt-in'].includes(process.argv[2])) {
  assert.equal(process.argv.length, 3)
  try { await administratorChild(process.argv[2]) } catch { process.send?.({ type: 'failure' }); process.exitCode = 1; process.disconnect?.() }
}

export async function runFractionalCustomerFolderJoined({ Pool, connectionOptions, capture, load, query, gateway,
  projection, stage, onboardingRequest, fixture }) {
  const deadline = Date.now() + 120_000
  unchanged(capture)
  assert.equal(connectionOptions.host, '127.0.0.1')
  assert.ok(Number.isInteger(connectionOptions.port) && connectionOptions.port > 0)
  const databaseName = `fractional_test_joined_${process.pid}_${randomUUID().slice(0, 8).replaceAll('-', '_')}`
  assert.match(databaseName, /^fractional_test_joined_[a-z0-9_]+$/u)
  await query(`CREATE DATABASE "${databaseName}"`)
  const fractional = new Pool({ ...connectionOptions, database: databaseName, max: 3, statement_timeout: 15_000 })
  let workDirectory
  let failureDiagnostics = async () => ({ phase: 'before-fixture-readiness', sourceHashes: capture.hashes })
  try {
  workDirectory = mkdtempSync(resolve(tmpdir(), 'clawpilot-folder-sender-'))
  const fQuery = (sql, values) => fractional.query(sql, values)
  const { org, pipeline, rootGlobalId, instance, deployment, credentialId, token, board } = fixture
  const fractionalOrg = fixture.fractionalOrganizationId, actor = 'joined-folder-administrator'
  assert.equal(fractionalOrg, 'fractional-fixture', 'Only the parent synthetic organization is admitted')
  const origin = 'https://clawpilot.example.invalid', parent = 'fractional_joined_customers', driveId = 'fractional_joined_shared_drive'
  const account = 'fractional-drive@example.invalid', counters = { workers: 0, requests: 0, driveReads: 0, oauth: 0, crmGets: 0, crmPatches: 0, droppedAcknowledgements: 0, responseBytes: 0 }
  const records = [], requests = []
  const gatewayEnv = { FRACTIONAL_CRM_GATEWAY_ENABLED: '1', FRACTIONAL_CRM_GATEWAY_ORIGIN: origin, FRACTIONAL_CRM_GATEWAY_SOURCE_INSTANCE_ID: instance }
  // Default parameters close over the boundary module's own environment. Load
  // both production layers with the same isolated configuration, not a wrapper
  // supplying a fabricated principal or bypassing the real machine boundary.
  const http = load('app_src/lib/fractionalCrmGatewayHttp.ts', {
    './fractionalCrmGatewayAuth': fixture.auth,
    './fractionalCrmGatewayPath.mjs': { isFractionalCrmGatewayPath: fixture.isGatewayPath },
    './crm/fractionalCustomerFolder': fixture.folderContract,
  }, gatewayEnv)
  const route = load('app_src/app/api/integrations/fractional-crm/v1/[...path]/route.ts', {
    '@/lib/fractionalCrmGatewayHttp': http,
    '@/lib/persistence/fractionalCrmGateway': gateway,
    '@/lib/crm/boardProjection': projection,
  }, gatewayEnv)
  assert.equal(typeof route.GET, 'function'); assert.equal(typeof route.PATCH, 'function')
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', TZ: 'UTC', NODE_ENV: 'test', FRACTIONAL_TEST_DATABASE: '1',
    FRACTIONAL_DATABASE_URL: `postgresql://${encodeURIComponent(connectionOptions.user)}:${encodeURIComponent(connectionOptions.password)}@127.0.0.1:${connectionOptions.port}/${databaseName}`,
    FRACTIONAL_CRM_FOLDER_PUBLICATION_ENABLED: '1', FRACTIONAL_CUSTOMER_DRIVE_SHARED_DRIVE_ID: driveId,
    FRACTIONAL_CUSTOMER_DRIVE_ENABLED: '1', FRACTIONAL_CUSTOMER_DRIVE_ORGANIZATION_ID: fractionalOrg,
    FRACTIONAL_CUSTOMER_DRIVE_PARENT_FOLDER_ID: parent, FRACTIONAL_CUSTOMER_DRIVE_ACCOUNT: account, FRACTIONAL_DEPLOYMENT_ID: deployment,
    FRACTIONAL_GOOGLE_DRIVE_CLIENT_ID: 'joined-fixture.apps.googleusercontent.com', FRACTIONAL_GOOGLE_DRIVE_CLIENT_SECRET: 'synthetic-only',
    FRACTIONAL_GOOGLE_DRIVE_REFRESH_TOKEN: 'synthetic-only', FRACTIONAL_SHARED_CRM_ENABLED: '1', FRACTIONAL_SHARED_CRM_REVIEWED: '1',
    FRACTIONAL_SHARED_CRM_ORIGIN: origin, FRACTIONAL_SHARED_CRM_TOKEN: token, FRACTIONAL_SHARED_CRM_ORGANIZATION_ID: fractionalOrg,
    FRACTIONAL_SHARED_CRM_SOURCE_INSTANCE_ID: instance, FRACTIONAL_SHARED_CRM_WORKSPACE_ORGANIZATION_ID: org,
    FRACTIONAL_SHARED_CRM_PIPELINE_ID: pipeline, FRACTIONAL_SHARED_CRM_ROOT_COMPANY_GLOBAL_ID: rootGlobalId }
  const client = await fractional.connect()
  try {
    const { applyMigrations, migrationFiles } = await import(pathToFileURL(`${APP}/scripts/migration-runner.mjs`).href)
    const migrationResult = await applyMigrations(client, { migrations: await migrationFiles() })
    assert.equal(migrationResult.existing, 0)
    assert.equal(migrationResult.applied.length, capture.migrationCount)
    const ledger = (await client.query('SELECT name,sha256 FROM fractional_migrations ORDER BY name')).rows
    assert.deepEqual(ledger, Object.keys(capture.hashes).filter(path => path.startsWith(`${APP}/migrations/`)).sort()
      .map(path => ({ name: path.slice(`${APP}/migrations/`.length), sha256: capture.hashes[path] })))
  } finally { client.release() }
  const bpoJobsBefore = (await query('SELECT * FROM crm_customer_folder_jobs ORDER BY account_id')).rows
  const card = async row => (await query('SELECT card_id,payload FROM crm_board_cards WHERE board_id=$1 AND entity_id=$2', [board, row.localId])).rows[0]
  const receipts = row => fQuery(`SELECT id::text,detail FROM audit_events WHERE organization_id=$1 AND customer_id=$2
    AND action='customer.drive.crm.publication' ORDER BY audit_events.id`, [fractionalOrg, row.customerId]).then(result => result.rows)
  const effects = row => query(`SELECT (SELECT count(*) FROM fractional_crm_gateway_operations WHERE credential_id=$1 AND operation='update-customer-folder') AS operations,
    (SELECT count(*) FROM sync_outbox WHERE aggregate_id=$2::text) AS outbox,
    (SELECT count(*) FROM audit_events WHERE aggregate_id=$2::text) AS audits`, [credentialId, row.localId]).then(result => result.rows[0])
  let dropNextSuccessfulPatch = true
  async function transport(urlString, init = {}) {
    assert.ok(Date.now() < deadline, 'Joined deadline exceeded')
    assert.ok(++counters.requests <= 100, 'Joined request bound exceeded')
    const url = new URL(urlString), method = init.method || 'GET', headers = new Headers(init.headers)
    assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.hash, '')
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store')
    let response
    if (url.origin === 'https://oauth2.googleapis.com') {
      assert.equal(url.pathname, '/token'); assert.equal(method, 'POST'); counters.oauth++
      const body = new URLSearchParams(init.body)
      assert.ok(body.get('client_secret') === 'synthetic-only' && body.get('refresh_token') === 'synthetic-only', 'Only isolated fixture credentials are admitted')
      response = Response.json({ access_token: 'synthetic-drive-access-token' })
    } else if (url.origin === 'https://www.googleapis.com') {
      assert.equal(method, 'GET', 'Publication cannot create, move, rename or share a Drive folder')
      assert.ok(headers.get('authorization') === 'Bearer synthetic-drive-access-token', 'Unexpected Drive credential')
      counters.driveReads++
      if (url.pathname === '/drive/v3/about') response = Response.json({ user: { emailAddress: account } })
      else {
        const id = url.pathname.slice('/drive/v3/files/'.length)
        assert.equal(url.pathname, `/drive/v3/files/${id}`)
        const row = records.find(row => row.folderId === id)
        assert.ok(id === parent || row, 'Only exact existing folder IDs may be inspected')
        response = Response.json({ id, name: 'Synthetic Fractional customer', parents: [id === parent ? 'fractional_organization_root' : parent],
          driveId: row?.scenario === 'wrong-drive' ? 'bpo_other_drive' : driveId, mimeType: 'application/vnd.google-apps.folder', trashed: false,
          version: '1', capabilities: { canAddChildren: true, canEdit: true },
          appProperties: row ? { fractionalDeployment: deployment, fractionalOrganization: fractionalOrg, fractionalCustomer: row.customerId, fractionalFolder: 'root' } : {},
          webViewLink: `https://drive.google.com/drive/folders/${id}` })
      }
    } else {
      assert.equal(url.origin, origin); assert.ok(['GET', 'PATCH'].includes(method), 'Unexpected CRM method')
      const row = records.find(row => url.pathname === `/api/integrations/fractional-crm/v1/companies/${row.globalId}/customer-folder`)
      assert.ok(row, 'Unexpected CRM customer path')
      assert.equal(url.searchParams.get('customerId'), row.customerId)
      assert.ok(headers.get('authorization') === `Bearer ${token}`, 'Unexpected machine credential')
      const recorded = { customerId: row.customerId, method, key: headers.get('idempotency-key'), ifMatch: headers.get('if-match'), body: init.body || null,
        status: null, acknowledgementDropped: false }
      requests.push(recorded)
      const request = new Request(url, { method, headers, ...(method === 'PATCH' ? { body: init.body } : {}) })
      response = await route[method](request)
      recorded.status = response.status
      if (method === 'GET') counters.crmGets++; else counters.crmPatches++
      if (method === 'PATCH' && response.ok && dropNextSuccessfulPatch) {
        dropNextSuccessfulPatch = false; counters.droppedAcknowledgements++
        recorded.acknowledgementDropped = true
        await response.body?.cancel()
        throw new Error('Synthetic lost acknowledgement after real receiver commit')
      }
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.ok(bytes.length <= 65_536, 'Bounded fixture response required')
    counters.responseBytes += bytes.length
    assert.ok(counters.responseBytes <= 512 * 1024)
    return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(bytes).toString('utf8') }
  }
  failureDiagnostics = async () => {
    const publications = []
    for (const row of records) {
      const retained = (await receipts(row)).map(event => ({
        resultId: String(event.id), status: ['published', 'retry', 'held'].includes(event.detail.status) ? event.detail.status : 'unknown',
        errorCode: typeof event.detail.errorCode === 'string' && /^[A-Z0-9_]{1,100}$/u.test(event.detail.errorCode) ? event.detail.errorCode : null,
        sourceEventId: /^\d+$/u.test(String(event.detail.sourceEventId)) ? String(event.detail.sourceEventId) : null,
        intentId: /^\d+$/u.test(String(event.detail.intentId)) ? String(event.detail.intentId) : null,
        attempts: Number.isSafeInteger(event.detail.attempts) ? event.detail.attempts : null,
        nextAttemptAt: Number.isFinite(Date.parse(event.detail.nextAttemptAt)) ? new Date(event.detail.nextAttemptAt).toISOString() : null,
      }))
      const latest = retained.at(-1)
      const scheduling = (await fQuery(`SELECT clock_timestamp() AS database_now,
        CASE WHEN $1::timestamptz IS NULL THEN NULL ELSE $1::timestamptz<=clock_timestamp() END AS retry_due`, [latest?.nextAttemptAt || null])).rows[0]
      publications.push({ scenario: row.scenario, receipts: retained, scheduling })
    }
    return { phase: 'joined-publication', sourceHashes: capture.hashes, counters, publications,
      requests: requests.map(({ customerId, method, status, acknowledgementDropped }) => ({ customerId, method, status, acknowledgementDropped })),
      boundary: 'Synthetic local diagnostics only; no token, body, credential, URL or child stderr output' }
  }
  async function child(recheck = null, administrativeMode = '--private-recheck') {
    unchanged(capture)
    assert.ok(Date.now() < deadline)
    counters.workers++
    const childEnv = recheck ? { ...env, JOINED_ORGANIZATION_ID: fractionalOrg, JOINED_ACTOR_ID: actor, JOINED_CUSTOMER_ID: recheck.customerId } : env
    const worker = fork(helperPath, [recheck ? administrativeMode : '--private-sender'], {
      execPath: process.execPath, execArgv: [], cwd: workDirectory, env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let closed = false
    const closedPromise = new Promise(resolveClose => worker.once('close', () => { closed = true; resolveClose() }))
    let result, failure, outputBytes = 0, requestChain = Promise.resolve()
    const capOutput = chunk => { outputBytes += chunk.length; if (outputBytes > 16_384) { failure = new Error('Unexpected sender output volume'); worker.kill('SIGTERM') } }
    worker.stdout.on('data', capOutput); worker.stderr.on('data', capOutput)
    const timeout = setTimeout(() => { failure = new Error('Bounded sender process timed out'); worker.kill('SIGTERM') }, Math.min(30_000, deadline - Date.now()))
    let killTimer
    worker.on('message', message => {
      if (message.type === 'result') result = message.worked
      else if (message.type === 'rechecked') result = message.passed
      else if (message.type === 'failure') failure = new Error('Sender private operation failed')
      else if (message.type === 'fetch') requestChain = requestChain.then(async () => {
        try { const response = await transport(message.url, message.init); if (worker.connected) worker.send({ id: message.id, ...response }) }
        catch (error) {
          // Only the deliberate lost acknowledgement is a simulated transport
          // outcome. Any assertion/unexpected request fails the whole fixture.
          if (!(error instanceof Error) || error.message !== 'Synthetic lost acknowledgement after real receiver commit') failure = error
          if (worker.connected) worker.send({ id: message.id, error: true })
        }
      })
      else { failure = new Error('Unexpected sender IPC command'); worker.kill('SIGTERM') }
    })
    try {
      const code = await new Promise((resolveExit, reject) => {
        worker.once('error', reject)
        worker.once('exit', code => resolveExit(code))
        killTimer = setTimeout(() => worker.kill('SIGKILL'), Math.min(35_000, deadline - Date.now() + 5_000))
      })
      await requestChain
      if (failure) throw failure
      assert.equal(code, 0, 'Isolated sender worker failed; raw output is not emitted')
      assert.equal(typeof result, 'boolean')
      unchanged(capture)
      return result
    } finally {
      clearTimeout(timeout); clearTimeout(killTimer)
      if (!closed && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL')
      let cleanupTimer
      try { await Promise.race([closedPromise, new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('Owned sender child cleanup did not complete')), 5_000) })]) }
      finally { clearTimeout(cleanupTimer) }
    }
  }
    await fQuery('INSERT INTO organizations(id,name) VALUES($1,$2)', [fractionalOrg, 'Synthetic joined folder organization'])
    await fQuery('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [actor, 'joined-folder@example.invalid', 'not-login'])
    await fQuery('INSERT INTO memberships(organization_id,user_id,organization_admin) VALUES($1,$2,true)', [fractionalOrg, actor])
    for (const scenario of ['happy', 'manual-override', 'wrong-drive']) {
      const customerId = `joined_${scenario.replaceAll('-', '_')}`, folderId = `fractional_joined_${scenario.replaceAll('-', '_')}`
      const bpoUrl = `https://bposupplychain.com/s/joined_${scenario.replaceAll('-', '_')}`, folderUrl = `https://drive.google.com/drive/folders/${folderId}`
      const description = `Retained joined customer notes\nBPO Supply Chain Drive: ${bpoUrl}`
        + (scenario === 'manual-override' ? '\nFractional Customer Folder: https://drive.google.com/drive/folders/manual_operator_reference' : '')
      const accountRecord = await stage({ name: `Synthetic joined folder ${scenario}`, accountType: 'Customer', description })
      await query('UPDATE fractional_crm_gateway_credentials SET allowed_company_global_ids=array_append(allowed_company_global_ids,$2) WHERE id=$1', [credentialId, accountRecord.referenceCode])
      const principal = await gateway.readFractionalCrmCredential(credentialId)
      // Existing canonical account first; onboarding only establishes this
      // synthetic reciprocal mapping, never a replacement account/global ID.
      const onboarding = onboardingRequest(customerId, `Synthetic joined folder ${scenario}`, `joined-${scenario}@example.invalid`, accountRecord.referenceCode)
      onboarding.origin.organizationId = fractionalOrg
      const linked = await gateway.resolveOrCreateFractionalCrmOnboarding(principal, onboarding, `joined-map-${scenario}`)
      assert.equal(linked.company.record.recordId, accountRecord.id)
      assert.equal(linked.company.record.globalId, accountRecord.referenceCode)
      const row = { scenario, customerId, folderId, folderUrl, bpoUrl, description, localId: accountRecord.id, globalId: accountRecord.referenceCode }
      records.push(row)
      await fQuery('INSERT INTO customers(organization_id,id,name) VALUES($1,$2,$3)', [fractionalOrg, customerId, `Synthetic ${scenario}`])
      await fQuery(`INSERT INTO shared_crm_links(organization_id,customer_id,entity,local_id,source_instance_id,workspace_organization_id,pipeline_id,
        root_company_global_id,global_id,company_global_id,record_id,remote_version,remote_snapshot,local_version,linked_by)
        VALUES($1,$2,'company',$2,$3,$4,$5,$6,$7,$7,$8,'fixture','{}',0,$9)`,
      [fractionalOrg, customerId, instance, org, pipeline, rootGlobalId, row.globalId, row.localId, actor])
      for (const [action, detail] of [['customer.setup.drive.reserved', { folderId, organizationId: fractionalOrg, parentFolderId: parent, account, deploymentId: deployment }],
        ['customer.setup.drive', { status: 'ready', folderId, parentFolderId: parent, url: folderUrl, globalAccountId: row.globalId }]]) {
        await fQuery('INSERT INTO audit_events(organization_id,customer_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,$4,$2,$5)', [fractionalOrg, customerId, actor, action, detail])
      }
      assert.equal(await child(row, '--private-opt-in'), true)
    }
    await projection.reconcileCrmBoardProjectionsForPipeline({ pipelineId: pipeline })
    for (const row of records) {
      row.originalCard = await card(row)
      assert.ok(row.originalCard)
      await query(`UPDATE crm_board_cards SET payload=jsonb_set(payload,'{comments}',$2::jsonb) WHERE card_id=$1`,
        [row.originalCard.card_id, JSON.stringify([{ id: `joined-${row.scenario}`, text: 'Retained operator comment' }])])
    }
    const happy = records[0]
    const authProbeUrl = new URL(`${origin}/api/integrations/fractional-crm/v1/companies/${happy.globalId}/customer-folder`)
    for (const [key, value] of Object.entries({ sourceInstanceId: instance, workspaceOrganizationId: org, pipelineId: pipeline,
      rootCompanyGlobalId: rootGlobalId, customerId: happy.customerId })) authProbeUrl.searchParams.set(key, value)
    const beforeAuthProbes = { effects: await effects(happy), card: await card(happy) }
    const deniedBearer = await route.GET(new Request(authProbeUrl, { headers: { authorization: `Bearer ${'x'.repeat(48)}` } }))
    assert.equal(deniedBearer.status, 401); await deniedBearer.body?.cancel()
    authProbeUrl.searchParams.set('customerId', 'wrong_joined_customer')
    const deniedCustomer = await route.GET(new Request(authProbeUrl, { headers: { authorization: `Bearer ${token}` } }))
    assert.equal(deniedCustomer.status, 404); await deniedCustomer.body?.cancel()
    assert.deepEqual({ effects: await effects(happy), card: await card(happy) }, beforeAuthProbes)
    assert.equal(await child(), true)
    assert.equal((await receipts(happy)).at(-1).detail.status, 'retry')
    const afterLostAck = await effects(happy), retainedCard = await card(happy)
    assert.equal(retainedCard.card_id, happy.originalCard.card_id)
    assert.equal(retainedCard.payload.crm.referenceCode, happy.globalId)
    const expectedDescription = `${happy.description}\nFractional Customer Folder: ${happy.folderUrl}`
    assert.equal(retainedCard.payload.desc, expectedDescription)
    assert.equal((await query('SELECT description FROM crm_organizations WHERE id=$1', [happy.localId])).rows[0].description, expectedDescription)
    assert.deepEqual(retainedCard.payload.comments.map(({ id, text }) => ({ id, text })),
      [{ id: 'joined-happy', text: 'Retained operator comment' }])
    assert.equal(await child(happy), true)
    assert.equal(await child(), true)
    assert.equal((await receipts(happy)).at(-1).detail.status, 'published')
    assert.deepEqual(await effects(happy), afterLostAck, 'Exact lost-ACK replay cannot repeat CRM writes, audit or outbox')
    assert.deepEqual(await card(happy), retainedCard, 'Lost acknowledgement replay preserves the exact card identity, notes and comments')
    const patches = requests.filter(row => row.customerId === happy.customerId && row.method === 'PATCH')
    assert.equal(patches.length, 2)
    assert.equal(patches[0].key, patches[1].key); assert.equal(patches[0].body, patches[1].body)
    assert.equal(patches[0].ifMatch, patches[1].ifMatch)
    assert.ok(requests.filter(row => row.customerId === happy.customerId && row.method === 'GET').length >= 2, 'Published outcome requires fresh receiver readback')
    assert.equal(await child(), true)
    assert.equal((await receipts(records[1])).at(-1).detail.status, 'held')
    assert.equal((await receipts(records[1])).at(-1).detail.errorCode, 'FOLDER_PUBLICATION_MANUAL_REVIEW_REQUIRED')
    assert.equal(requests.filter(row => row.customerId === records[1].customerId && row.method === 'PATCH').length, 0)
    assert.ok((await card(records[1])).payload.desc.includes('manual_operator_reference'))
    assert.equal(await child(), true)
    assert.equal((await receipts(records[2])).at(-1).detail.status, 'held')
    assert.equal((await receipts(records[2])).at(-1).detail.errorCode, 'DRIVE_FOLDER_BINDING_CHANGED')
    assert.equal(requests.filter(row => row.customerId === records[2].customerId).length, 0)
    assert.equal(await child(), false, 'Published and held results do not loop or recreate folders')
    assert.deepEqual((await query('SELECT * FROM crm_customer_folder_jobs ORDER BY account_id')).rows, bpoJobsBefore)
    assert.equal(counters.droppedAcknowledgements, 1)
    unchanged(capture)
    return { passed: true, kind: 'actual-fractional-sender-clawpilot-receiver-local-joined', fixtureDataSynthetic: true,
      actualSenderProcess: true, actualReceiverNextRoute: true, actualMachineAuth: true, actualSeparateDatabases: true,
      actualProjectCardProjection: true, providerIoControlled: true, providerFolderWrites: 0, productionTouched: false,
      migrationCount: capture.migrationCount, sourceFiles: Object.keys(capture.hashes).length, counters,
      sourceHashes: capture.hashes, isolatedDatabaseName: databaseName,
      sourceManifestSha256: sha(JSON.stringify(Object.entries(capture.hashes).sort(([a], [b]) => a.localeCompare(b)))),
      cleanupOwner: 'Parent guarded container; helper awaits every child and closes its separate database pool',
      checks: ['actual-route-rejects-wrong-bearer-and-customer-without-write', 'same-global-id-and-card', 'independent-folder-urls', 'bpo-comments-preserved', 'lost-ack-same-command-no-second-effect',
        'fresh-receiver-readback', 'manual-override-held', 'wrong-drive-held', 'no-folder-recreation-or-bpo-job-consumption'],
      limitations: ['Synthetic local fixtures and controlled Google Drive, not live provider or deployment proof',
        'Existing sender ready-folder receipts are seeded; folder creation/adoption is not proved here',
        'Existing projection fixture excludes ensurePipelineCrmReferenceLinks upkeep and uses synthetic shortLinkUrl; no signed-in UI or short-link delivery proof'] }
  } catch (error) {
    let detail
    try { detail = await failureDiagnostics() } catch { detail = { phase: 'diagnostics-unavailable', sourceHashes: capture.hashes } }
    console.log(`FRACTIONAL_FOLDER_JOINED_FAILURE=${JSON.stringify({ version: 1, passed: false, ...detail })}`)
    throw error
  } finally {
    try { await fractional.end() }
    finally { try { if (workDirectory) rmdirSync(workDirectory) } finally { unchanged(capture) } }
  }
}
