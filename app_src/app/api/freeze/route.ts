import { NextResponse } from 'next/server'
import { readFreezeState, resolveFreezePath } from '@/lib/freeze'
import { getErrorMessage } from '@/lib/errorUtils'

export async function GET() {
  try {
    const state = readFreezeState()
    return NextResponse.json({
      status: 'ok',
      ...state,
      freezePath: resolveFreezePath(),
    })
  } catch (error: unknown) {
    return NextResponse.json({ status: 'error', error: getErrorMessage(error) }, { status: 500 })
  }
}
