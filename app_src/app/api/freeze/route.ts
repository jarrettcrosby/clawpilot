import { NextResponse } from 'next/server'
import { readFreezeState, resolveFreezePath } from '@/lib/freeze'

export async function GET() {
  try {
    const state = readFreezeState()
    return NextResponse.json({
      status: 'ok',
      ...state,
      freezePath: resolveFreezePath(),
    })
  } catch (e: any) {
    return NextResponse.json({ status: 'error', error: e.message }, { status: 500 })
  }
}
