import { matonFetch } from '@/lib/maton'
import {
  configurePipelineTabsWithRequest,
  type SheetsRequestInput,
} from '@/lib/pipelineProvisioning'

function safeGatewayErrorDetail(raw: string): string {
  let candidate = raw
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown }
    candidate = String(parsed.error?.message || parsed.message || raw)
  } catch {
    // Plain-text gateway failures are still useful after bounded sanitization.
  }
  return candidate
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800)
}

async function matonSheetsJson<T>(pathname: string, input: SheetsRequestInput = {}): Promise<T> {
  const response = await matonFetch(`/google-sheets${pathname}`, {
    method: input.method || 'GET',
    headers: input.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  })
  const raw = await response.text()
  if (!response.ok) {
    const detail = safeGatewayErrorDetail(raw)
    throw new Error(
      `Pipeline workbook configuration failed (${response.status})${detail ? `: ${detail}` : ''}`,
    )
  }
  if (!raw) return {} as T
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error('Pipeline workbook configuration returned an invalid response')
  }
}

export async function configureLegacyPipelineTabs(sheetId: string) {
  return configurePipelineTabsWithRequest(matonSheetsJson, sheetId)
}
