import 'server-only'
import { types } from 'node:util'
import type { LegacyEmailTerminalHoldNativeObservation, LegacyEmailTerminalHoldNativeObservationRequest,
  LegacyEmailTerminalHoldPreviewTarget } from './legacyEmailTerminalHoldPreview'
import { nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'
import { nativeEmailMariaStoreFingerprint } from './nativeEmailRecoveryStoreBinding'

type Store = Parameters<typeof nativeEmailMariaStoreFingerprint>[0]
type Scope = LegacyEmailTerminalHoldPreviewTarget['scope']
type Observer = Readonly<{ user: string; host: string }>
type Target = Readonly<{ scope: Scope; store: Store; observer: Observer }>
type Session = Readonly<{ query(sql: string, values?: string[]): Promise<{ rows: unknown[] }> }>
type WithReadOnlySession = <T>(signal: AbortSignal, run: (session: Session) => Promise<T>) => Promise<T>
type Observation = LegacyEmailTerminalHoldNativeObservation

const STOCK = Object.freeze(['emails', 'emails_beans', 'emails_cstm', 'emails_email_addr_rel', 'emails_text', 'securitygroups_records'])
// Exact CP_INITIAL_TABLES in install-native-email-initial-state.php. A mixed or
// installed schema is not stock and must use a different, separately reviewed path.
const MANAGED = Object.freeze(['clawpilot_email_authority_approvals', 'clawpilot_email_authority_operations',
  'clawpilot_email_bindings', 'clawpilot_email_identities', 'clawpilot_email_initial_enrollments',
  'clawpilot_email_operations', 'clawpilot_email_write_permissions', 'clawpilot_email_write_scopes'])
const INVENTORY = [...STOCK, ...MANAGED]
const scopeKeys = ['projectId', 'environmentId', 'postgresDatabaseFingerprint', 'appCommit', 'nativeDeploymentId',
  'nativeReplicaId', 'nativeCommit', 'nativeDatabaseFingerprint', 'nativeAuthorityInstanceId'] as const
const storeKeys = ['database', 'hostname', 'serverId', 'serverVersion', 'serverUid'] as const
const identityKeys = ['outboxId', 'localId', 'nativeId', 'globalId'] as const
const countKeys = ['emails', 'customById', 'customByGlobal', 'emailText', 'beanLinks', 'addressLinks', 'securityGroupLinks'] as const
const sessionKeys = ['database_name', 'hostname', 'server_id', 'server_version', 'server_uid', 'effective_user', 'login_user',
  'active_role', 'connection_id', 'active_transaction', 'session_read_only', 'repeatable_read', 'observed_at_ms'] as const
const targetKeys = ['operationId', 'scope', 'actorEmail', 'operatorAccountId', 'rootWorkspaceId', 'fenceEpoch', 'outboxIds',
  'postgresObserverFingerprint', 'nativeObserverFingerprint'] as const
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const HASH = /^[0-9a-f]{64}(?![\s\S])/u
const COMMIT = /^[0-9a-f]{40}(?![\s\S])/u
const GLOBAL = /^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
const POSITIVE = /^[1-9][0-9]{0,19}(?![\s\S])/u
const USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}(?![\s\S])/u
const HOST = /^[A-Za-z0-9%_:.][A-Za-z0-9%_:./-]{0,254}(?![\s\S])/u
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9-]{0,35}(?![\s\S])/u
const MAX_ROWS = 25

const IDENTITY = `SELECT DATABASE() AS database_name, @@GLOBAL.hostname AS hostname,
  CAST(@@GLOBAL.server_id AS CHAR) AS server_id, VERSION() AS server_version, @@GLOBAL.server_uid AS server_uid,
  CURRENT_USER() AS effective_user, SUBSTRING_INDEX(SESSION_USER(),'@',1) AS login_user, CURRENT_ROLE() AS active_role,
  CAST(CONNECTION_ID() AS CHAR) AS connection_id, CAST(@@SESSION.in_transaction=1 AS CHAR) AS active_transaction,
  CAST(@@SESSION.tx_read_only=1 AS CHAR) AS session_read_only,
  CAST(@@SESSION.tx_isolation='REPEATABLE-READ' AS CHAR) AS repeatable_read,
  CAST(CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS CHAR) AS observed_at_ms`
const GRANT = `SELECT CAST(CONNECTION_ID() AS CHAR) AS connection_id, GRANTEE AS grantee, TABLE_SCHEMA AS schema_grant,
  PRIVILEGE_TYPE AS privilege_type FROM information_schema.SCHEMA_PRIVILEGES
  WHERE BINARY GRANTEE=BINARY ? AND BINARY TABLE_SCHEMA=BINARY ? AND PRIVILEGE_TYPE='SELECT' LIMIT 2`
const TABLES = `SELECT CAST(CONNECTION_ID() AS CHAR) AS connection_id, TABLE_NAME AS table_name,
  TABLE_TYPE AS table_type, ENGINE AS engine FROM information_schema.TABLES
  WHERE BINARY TABLE_SCHEMA=BINARY DATABASE() AND LOWER(TABLE_NAME) IN (${INVENTORY.map(() => '?').join(',')})
  ORDER BY BINARY TABLE_NAME LIMIT ${INVENTORY.length + 1}`
// No deleted filter or joins to a parent: orphaned children, text, custom data,
// and even a colliding SecurityGroup link must stop absence approval.
const COUNTS = `SELECT CAST(CONNECTION_ID() AS CHAR) AS connection_id,
  CAST((SELECT COUNT(*) FROM emails WHERE LOWER(id)=?) AS CHAR) AS emails,
  CAST((SELECT COUNT(*) FROM emails_cstm WHERE LOWER(id_c)=?) AS CHAR) AS customById,
  CAST((SELECT COUNT(*) FROM emails_cstm WHERE LOWER(global_id_c)=?) AS CHAR) AS customByGlobal,
  CAST((SELECT COUNT(*) FROM emails_text WHERE LOWER(email_id)=?) AS CHAR) AS emailText,
  CAST((SELECT COUNT(*) FROM emails_beans WHERE LOWER(email_id)=?) AS CHAR) AS beanLinks,
  CAST((SELECT COUNT(*) FROM emails_email_addr_rel WHERE LOWER(email_id)=?) AS CHAR) AS addressLinks,
  CAST((SELECT COUNT(*) FROM securitygroups_records WHERE LOWER(record_id)=?) AS CHAR) AS securityGroupLinks`

function need(ok: unknown, code: string): asserts ok {
  requireNativeEmail(ok, 'legacy_terminal_hold_stock_observer_' + code)
}
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value)
function exact(value: unknown, keys: readonly string[], code: string): asserts value is Record<string, unknown> {
  need(value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => {
      const field = Object.getOwnPropertyDescriptor(value, key)
      return field?.enumerable && 'value' in field
    }), code)
}
function list(value: unknown, max: number, code: string): unknown[] {
  need(Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= max && Reflect.ownKeys(value).length === value.length + 1, code)
  return Array.from({ length: value.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(value, String(index))
    need(item?.enumerable && 'value' in item, code)
    return item.value
  })
}
function pinTarget(supplied: unknown) {
  exact(supplied, ['scope', 'store', 'observer'], 'target')
  const { scope, store, observer } = supplied
  exact(scope, scopeKeys, 'target_scope'); exact(store, storeKeys, 'target_store'); exact(observer, ['user', 'host'], 'target_observer')
  need([scope.projectId, scope.environmentId, scope.nativeDeploymentId, scope.nativeReplicaId].every(value => matches(value, UUID))
    && [scope.appCommit, scope.nativeCommit].every(value => matches(value, COMMIT))
    && matches(scope.nativeAuthorityInstanceId, INSTANCE) && matches(scope.postgresDatabaseFingerprint, HASH)
    && matches(observer.user, USER) && matches(observer.host, HOST), 'target_pins')
  const target = Object.freeze({ scope: Object.freeze({ ...scope }), store: Object.freeze({ ...store }),
    observer: Object.freeze({ ...observer }) }) as Target
  const storeFingerprint = nativeEmailMariaStoreFingerprint(target.store)
  need(target.scope.nativeDatabaseFingerprint === storeFingerprint
    && target.scope.postgresDatabaseFingerprint !== storeFingerprint, 'target_store')
  return { target, storeFingerprint }
}

/** Private stock-schema observer. The trusted port must open one fresh direct
 * session (no pool reuse, previous commands or temp tables) and own a bounded
 * REPEATABLE READ READ ONLY transaction with its session read-only default
 * also set. Session defaults alone cannot rule out transaction-mode override.
 * This adapter issues only the fixed SELECTs, binds their actual session and
 * refuses incomplete metadata. Its result does not prove continuous closure. */
export function createLegacyEmailTerminalHoldStockNativeObserver(options: {
  target: Target
  withReadOnlySession: WithReadOnlySession
}) {
  exact(options, ['target', 'withReadOnlySession'], 'configuration')
  const { target, storeFingerprint } = pinTarget(options.target)
  const { withReadOnlySession } = options
  need(typeof withReadOnlySession === 'function', 'session_provider')
  const observerFingerprint = nativeEmailDigest({ version: 1, purpose: 'clawpilot-legacy-terminal-hold-stock-maria-observer-v1',
    scope: target.scope, storeFingerprint, observer: target.observer, stock: STOCK, expectedAbsent: MANAGED })
  const schemaGrant = target.store.database.replace(/[\\_%]/g, value => '\\' + value)
  const principal = `${target.observer.user}@${target.observer.host}`
  const grantee = `'${target.observer.user}'@'${target.observer.host}'`

  async function observeNative(request: LegacyEmailTerminalHoldNativeObservationRequest, signal: AbortSignal): Promise<Observation> {
    exact(request, ['phase', 'observationId', 'candidateFingerprint', 'target', 'identities'], 'request')
    const { phase, observationId, candidateFingerprint, target: requested, identities } = request
    exact(requested, targetKeys, 'request_target'); exact(requested.scope, scopeKeys, 'request_scope')
    need(phase === 'nativeAbsence' && matches(observationId, UUID) && matches(candidateFingerprint, HASH)
      && scopeKeys.every(key => requested.scope[key] === target.scope[key])
      && requested.nativeObserverFingerprint === observerFingerprint, 'request_binding')
    need([requested.operationId, requested.operatorAccountId, requested.rootWorkspaceId, requested.fenceEpoch]
      .every(value => matches(value, UUID)) && matches(requested.postgresObserverFingerprint, HASH)
      && typeof requested.actorEmail === 'string' && requested.actorEmail.length <= 254, 'request_target')
    const ids = list(requested.outboxIds, MAX_ROWS, 'request_ids')
    need(ids.length > 0 && ids.every((id, index) => matches(id, UUID) && (index === 0 || id > (ids[index - 1] as string))), 'request_ids')
    const selected = list(identities, MAX_ROWS, 'request_rows').map((identity, index) => {
      exact(identity, identityKeys, 'request_row')
      need(identity.outboxId === ids[index] && matches(identity.outboxId, UUID) && matches(identity.localId, UUID)
        && matches(identity.nativeId, UUID) && matches(identity.globalId, GLOBAL), 'request_row')
      return Object.freeze({ outboxId: identity.outboxId, localId: identity.localId, nativeId: identity.nativeId, globalId: identity.globalId })
    })
    need(selected.length === ids.length && identityKeys.every(key => new Set(selected.map(row => row[key])).size === ids.length), 'request_rows')
    const pinnedRequestTarget = { ...requested, scope: target.scope, outboxIds: ids }
    need(nativeEmailDigest({ version: 1, purpose: 'clawpilot-legacy-terminal-hold-preview-target-v1',
      target: pinnedRequestTarget }) === candidateFingerprint, 'request_candidate')
    need(signal instanceof AbortSignal && !signal.aborted, 'cancelled')

    let active = true, calls = 0, completed: Observation | undefined
    let operationError: unknown
    const inScope = () => need(active && calls === 1 && !signal.aborted, 'session_scope')
    try {
      const result = await withReadOnlySession(signal, session => {
        const operation = (async () => {
          calls++; inScope()
          need(typeof session?.query === 'function', 'session_query')
          const read = async (sql: string, parameters: string[] | undefined, max: number) => {
            inScope()
            let value: unknown
            try { value = await session.query(sql, parameters) } catch { need(false, 'observation_failed') }
            inScope(); exact(value, ['rows'], 'query_shape')
            return list(value.rows, max, 'query_rows')
          }
          const one = async (sql: string, parameters?: string[]) => {
            const rows = await read(sql, parameters, 1)
            need(rows.length === 1, 'query_rows')
            return rows[0]
          }
          const inspectSession = async () => {
            const row = await one(IDENTITY)
            exact(row, sessionKeys, 'session_identity')
            need(row.database_name === target.store.database && row.hostname === target.store.hostname
              && row.server_id === target.store.serverId && row.server_version === target.store.serverVersion
              && row.server_uid === target.store.serverUid && row.effective_user === principal && row.login_user === target.observer.user
              && row.active_role === null && matches(row.connection_id, POSITIVE)
              && row.active_transaction === '1' && row.session_read_only === '1' && row.repeatable_read === '1'
              && matches(row.observed_at_ms, POSITIVE) && Number.isSafeInteger(Number(row.observed_at_ms)), 'session_identity')
            return { connectionId: row.connection_id, observedAtMs: Number(row.observed_at_ms) }
          }
          const before = await inspectSession()
          const grant = await one(GRANT, [grantee, schemaGrant])
          exact(grant, ['connection_id', 'grantee', 'schema_grant', 'privilege_type'], 'metadata_visibility')
          need(grant.connection_id === before.connectionId && grant.grantee === grantee
            && grant.schema_grant === schemaGrant && grant.privilege_type === 'SELECT', 'metadata_visibility')
          const inspectStock = async () => {
            const tableRows = await read(TABLES, [...INVENTORY], INVENTORY.length)
            need(tableRows.length === STOCK.length, 'not_stock_schema')
            const tables = tableRows.map((table, index) => {
              exact(table, ['connection_id', 'table_name', 'table_type', 'engine'], 'table_metadata')
              need(table.connection_id === before.connectionId && table.table_name === STOCK[index]
                && table.table_type === 'BASE TABLE' && table.engine === 'InnoDB', 'not_stock_schema')
              return Object.freeze({ name: table.table_name, type: table.table_type, engine: table.engine })
            })
            return Object.freeze(tables)
          }
          const stock = await inspectStock()
          const rows: Observation['rows'][number][] = []
          for (const row of selected) {
            const { nativeId, globalId } = row
            const count = await one(COUNTS, [nativeId, nativeId, globalId, nativeId, nativeId, nativeId, nativeId])
            exact(count, ['connection_id', ...countKeys], 'count_shape')
            need(count.connection_id === before.connectionId && countKeys.every(key => count[key] === '0'), 'native_not_absent')
            rows.push(Object.freeze({ ...row, counts: Object.freeze({ emails: 0, customById: 0, customByGlobal: 0,
              emailText: 0, beanLinks: 0, addressLinks: 0, securityGroupLinks: 0, managedIdentities: 0, nativeOperations: 0 }) }))
          }
          const afterStock = await inspectStock(), after = await inspectSession()
          need(nativeEmailDigest(afterStock) === nativeEmailDigest(stock) && after.connectionId === before.connectionId
            && after.observedAtMs >= before.observedAtMs, 'session_changed')
          const stockSchemaAbsenceFingerprint = nativeEmailDigest({ version: 1,
            purpose: 'clawpilot-legacy-terminal-hold-stock-schema-absent-v1', observerFingerprint, storeFingerprint,
            candidateFingerprint, observationId, visibility: 'direct_exact_database_select', schemaGrant,
            connectionId: before.connectionId, startedAtMs: before.observedAtMs, observedAtMs: after.observedAtMs,
            stock, absent: MANAGED })
          inScope()
          completed = Object.freeze({ phase, observationId, candidateFingerprint, storeFingerprint, observerFingerprint,
            observedAtMs: after.observedAtMs, stockSchemaAbsenceFingerprint, rows: Object.freeze(rows) })
          return completed
        })()
        // A faulty scope that returns early is rejected below and cannot leak
        // an unhandled rejection or continue issuing queries after it closes.
        void operation.catch(error => { operationError = error })
        return operation
      })
      inScope(); need(completed && result === completed, 'session_result')
      return result
    } catch (error) {
      if (operationError && error === operationError) throw operationError
      need(false, 'session_provider_failed')
    } finally { active = false }
  }

  return Object.freeze({ observeNative, observerFingerprint, storeFingerprint })
}
