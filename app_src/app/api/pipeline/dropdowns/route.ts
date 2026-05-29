import { NextRequest, NextResponse } from 'next/server'
import { pullDropdownsFromSheet, pushDropdownsToSheet } from '@/lib/pipelineDropdownSync'

export async function GET() {
  try {
    const out = await pullDropdownsFromSheet()
    return NextResponse.json({ ok: true, ...out })
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const out = await pushDropdownsToSheet(body)
    return NextResponse.json({ ok: true, ...out })
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
