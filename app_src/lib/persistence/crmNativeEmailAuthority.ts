type AuthorityControlClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

/** Call before a transaction that may change CRM reader authority takes any
 * authority/source locks. The database triggers remain the permission fence;
 * this helper only establishes control-first ordering, never authorizes a
 * change or bypasses an enabled native policy. Do not use for ordinary reads,
 * profile timestamps or unrelated transactions, and never hold over provider I/O. */
export async function lockCrmNativeEmailAuthorityWithClient(client: AuthorityControlClient): Promise<void> {
  const result = await client.query(
    'SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE',
  )
  if (result.rows.length !== 1 || result.rows[0].singleton !== true) {
    throw new Error('Native Email authority control is missing or inconsistent')
  }
}
