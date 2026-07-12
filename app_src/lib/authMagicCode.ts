import crypto from 'crypto'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { sendAuthMagicCodeEmail } from '@/lib/matonMail'

const RESEND_COOLDOWN_SECONDS = 60
const MAX_ATTEMPTS = 5
const DIGEST_CONTEXT = 'clawpilot-auth-magic-code:v1'

const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i

export type RequestAuthMagicCodeInput = {
  email: string
}

export type RequestAuthMagicCodeResult =
  | { status: 'sent'; expiresAt: string }
  | { status: 'cooldown'; retryAfterSeconds: number }
  | { status: 'not-authorized' }

export type VerifyAuthMagicCodeInput = {
  email: string
  code: string
}

export type VerifyAuthMagicCodeResult =
  | { status: 'verified'; email: string }
  | { status: 'invalid'; attemptsRemaining: number }
  | { status: 'locked' | 'expired' | 'consumed' | 'not-found' | 'not-authorized' }

type IssuedRow = {
  id: string
  expires_at: string
}

type CooldownRow = {
  retry_after_seconds: number
}

type VerificationRow = {
  status: 'verified' | 'invalid' | 'locked' | 'expired' | 'consumed'
  attempts: number
}

function normalizeEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

function authorizedEmail(): string {
  const email = normalizeEmail(process.env.APP_LOGIN_EMAIL)
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email) || !/^[\x21-\x7e]+$/.test(email)) {
    throw new Error('APP_LOGIN_EMAIL must contain one valid ASCII email address')
  }
  return email
}

function sessionSecret(): string {
  const secret = String(process.env.APP_SESSION_SECRET || '')
  if (secret.length < 32) throw new Error('APP_SESSION_SECRET must contain at least 32 characters')
  return secret
}

function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
}

function digestCode(email: string, code: string): string {
  return crypto
    .createHmac('sha256', sessionSecret())
    .update(`${DIGEST_CONTEXT}\n${email}\n${code}`)
    .digest('hex')
}

function normalizeIso(value: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error('Postgres returned an invalid magic-code expiry')
  return new Date(parsed).toISOString()
}

export async function requestAuthMagicCode(
  input: RequestAuthMagicCodeInput,
): Promise<RequestAuthMagicCodeResult> {
  const expectedEmail = authorizedEmail()
  const requestedEmail = normalizeEmail(input.email)
  if (requestedEmail !== expectedEmail) return { status: 'not-authorized' }

  const code = generateCode()
  const digest = digestCode(expectedEmail, code)
  const issuance = await withTransaction(async (client) => {
    const issued = await client.query<IssuedRow>(
      `
        INSERT INTO auth_magic_codes (
          id,
          email,
          code_digest,
          attempts,
          created_at,
          updated_at,
          expires_at,
          last_attempt_at,
          consumed_at
        )
        VALUES (
          gen_random_uuid(),
          $1,
          $2,
          0,
          now(),
          now(),
          now() + interval '15 minutes',
          NULL,
          NULL
        )
        ON CONFLICT (email) DO UPDATE SET
          id = EXCLUDED.id,
          code_digest = EXCLUDED.code_digest,
          attempts = 0,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          expires_at = EXCLUDED.expires_at,
          last_attempt_at = NULL,
          consumed_at = NULL
        WHERE auth_magic_codes.created_at <= now() - interval '60 seconds'
        RETURNING id::text AS id, expires_at::text AS expires_at
      `,
      [expectedEmail, digest],
    )

    const row = issued.rows[0]
    if (row) return { kind: 'issued' as const, row }

    const cooldown = await client.query<CooldownRow>(
      `
        SELECT GREATEST(
          1,
          CEIL(EXTRACT(EPOCH FROM (created_at + interval '60 seconds' - now())))::integer
        ) AS retry_after_seconds
        FROM auth_magic_codes
        WHERE email = $1
      `,
      [expectedEmail],
    )

    return {
      kind: 'cooldown' as const,
      retryAfterSeconds: Math.max(1, Number(cooldown.rows[0]?.retry_after_seconds || RESEND_COOLDOWN_SECONDS)),
    }
  })

  if (issuance.kind === 'cooldown') {
    return { status: 'cooldown', retryAfterSeconds: issuance.retryAfterSeconds }
  }

  try {
    await sendAuthMagicCodeEmail({ to: expectedEmail, code })
  } catch {
    await query(
      `
        DELETE FROM auth_magic_codes
        WHERE id = $1::uuid
          AND email = $2
          AND code_digest = $3
          AND consumed_at IS NULL
      `,
      [issuance.row.id, expectedEmail, digest],
    ).catch(() => undefined)
    throw new Error('Unable to deliver sign-in code')
  }

  return {
    status: 'sent',
    expiresAt: normalizeIso(issuance.row.expires_at),
  }
}

export async function verifyAuthMagicCode(
  input: VerifyAuthMagicCodeInput,
): Promise<VerifyAuthMagicCodeResult> {
  const expectedEmail = authorizedEmail()
  const requestedEmail = normalizeEmail(input.email)
  if (requestedEmail !== expectedEmail) return { status: 'not-authorized' }

  const submittedCode = String(input.code || '').trim().slice(0, 128)
  const submittedDigest = digestCode(expectedEmail, submittedCode)
  const result = await withTransaction(async (client) => client.query<VerificationRow>(
    `
      WITH candidate AS (
        SELECT
          id,
          code_digest,
          attempts,
          expires_at,
          last_attempt_at,
          consumed_at
        FROM auth_magic_codes
        WHERE email = $1
        FOR UPDATE
      ),
      evaluation AS (
        SELECT
          candidate.*,
          code_digest = $2 AS matches,
          consumed_at IS NULL
            AND expires_at > now()
            AND attempts < 5 AS eligible
        FROM candidate
      ),
      outcome AS (
        SELECT
          evaluation.*,
          CASE
            WHEN consumed_at IS NOT NULL THEN 'consumed'
            WHEN expires_at <= now() THEN 'expired'
            WHEN attempts >= 5 THEN 'locked'
            WHEN matches THEN 'verified'
            WHEN attempts + 1 >= 5 THEN 'locked'
            ELSE 'invalid'
          END AS status,
          CASE
            WHEN eligible AND NOT matches THEN LEAST(attempts + 1, 5)::smallint
            ELSE attempts
          END AS next_attempts,
          CASE WHEN eligible AND matches THEN now() ELSE consumed_at END AS next_consumed_at,
          CASE WHEN eligible THEN now() ELSE last_attempt_at END AS next_last_attempt_at
        FROM evaluation
      ),
      updated AS (
        UPDATE auth_magic_codes AS codes
        SET attempts = outcome.next_attempts,
            consumed_at = outcome.next_consumed_at,
            last_attempt_at = outcome.next_last_attempt_at,
            updated_at = CASE WHEN outcome.eligible THEN now() ELSE codes.updated_at END
        FROM outcome
        WHERE codes.id = outcome.id
        RETURNING codes.id
      )
      SELECT outcome.status, outcome.next_attempts::integer AS attempts
      FROM outcome
      INNER JOIN updated ON updated.id = outcome.id
    `,
    [expectedEmail, submittedDigest],
  ))

  const row = result.rows[0]
  if (!row) return { status: 'not-found' }
  if (row.status === 'verified') return { status: 'verified', email: expectedEmail }
  if (row.status === 'invalid') {
    return { status: 'invalid', attemptsRemaining: Math.max(0, MAX_ATTEMPTS - Number(row.attempts || 0)) }
  }
  return { status: row.status }
}
