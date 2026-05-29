import { NextResponse } from 'next/server'
import fs from 'fs'

const LOG_PATH = '/tmp/clawd-client-errors.log'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const line = JSON.stringify({ at: new Date().toISOString(), ...body })
    fs.appendFileSync(LOG_PATH, line + '\n')
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 })
  }
}
