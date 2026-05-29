import { NextResponse } from 'next/server'
import fs from 'fs'
import { getErrorMessage } from '@/lib/errorUtils'

const LOG_PATH = '/tmp/clawd-client-errors.log'
const MAX_ERROR_PAYLOAD_BYTES = 8 * 1024

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    if (!isPlainObject(body)) {
      return NextResponse.json({ ok: false, error: 'invalid payload: expected object body' }, { status: 400 })
    }

    const payloadText = JSON.stringify(body)
    if (Buffer.byteLength(payloadText, 'utf8') > MAX_ERROR_PAYLOAD_BYTES) {
      return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 })
    }

    const line = JSON.stringify({ at: new Date().toISOString(), ...body })
    fs.appendFileSync(LOG_PATH, line + '\n')
    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    return NextResponse.json({ ok: false, error: getErrorMessage(error) }, { status: 500 })
  }
}
