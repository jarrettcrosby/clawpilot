import { NextRequest, NextResponse } from 'next/server'
import {
  readWorkspaceOrganizationBranding,
  updateWorkspaceOrganizationBranding,
} from '@/lib/organizationBranding'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole } from '@/lib/users'

export const runtime = 'nodejs'

const MAX_LOGO_BYTES = 2 * 1024 * 1024

function imageMimeType(bytes: Uint8Array) {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) return 'image/webp'
  return ''
}

function statusFor(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'Unauthorized') return 401
  if (/permission|admin/i.test(message)) return 403
  if (/not found/i.test(message)) return 404
  return 400
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    if (!actor.organizationId) throw new Error('Active workspace is not available')
    const role = effectiveAuthorizationRole(actor)
    return NextResponse.json({
      ok: true,
      canEdit: role === 'owner' || role === 'admin',
      branding: await readWorkspaceOrganizationBranding(actor.organizationId),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load organization branding'
    return NextResponse.json({ ok: false, error: message }, { status: statusFor(error) })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const role = effectiveAuthorizationRole(actor)
    if (role !== 'owner' && role !== 'admin') {
      throw new Error('Organization admin permission is required')
    }
    if (!actor.organizationId) throw new Error('Active workspace is not available')
    const form = await req.formData()
    const logo = form.get('logo')
    const removeLogo = String(form.get('removeLogo') || '') === 'true'
    let logoBytes: Uint8Array | null | undefined
    let logoMimeType: string | null | undefined
    if (removeLogo) {
      logoBytes = null
      logoMimeType = null
    } else if (logo && typeof logo !== 'string' && logo.size > 0) {
      if (logo.size > MAX_LOGO_BYTES) throw new Error('Organization logos must be 2 MB or smaller')
      logoBytes = new Uint8Array(await logo.arrayBuffer())
      logoMimeType = imageMimeType(logoBytes)
      if (!logoMimeType) throw new Error('Organization logos must be PNG, JPEG, or WebP images')
    }
    const branding = await updateWorkspaceOrganizationBranding({
      organizationId: actor.organizationId,
      actorEmail: actor.email,
      primaryColor: String(form.get('primaryColor') || ''),
      accentColor: String(form.get('accentColor') || ''),
      logoBytes,
      logoMimeType,
    })
    return NextResponse.json({ ok: true, canEdit: true, branding, workbookRefresh: 'queued' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to save organization branding'
    return NextResponse.json({ ok: false, error: message }, { status: statusFor(error) })
  }
}
