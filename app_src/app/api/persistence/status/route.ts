import { NextResponse } from 'next/server'
import { getStorageDriver } from '@/lib/persistence/config'
import { query } from '@/lib/persistence/postgres'

export async function GET() {
  const driver = getStorageDriver()

  if (driver !== 'postgres') {
    return NextResponse.json({
      ok: true,
      driver,
      database: 'not-configured',
    })
  }

  try {
    const result = await query<{ now: string }>('SELECT now()::text AS now')
    return NextResponse.json({
      ok: true,
      driver,
      database: 'reachable',
      checkedAt: result.rows[0]?.now || new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json({
      ok: false,
      driver,
      database: 'unreachable',
      error: error instanceof Error ? error.message : String(error),
    }, { status: 503 })
  }
}

