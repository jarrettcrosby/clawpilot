import { matonFetch } from '@/lib/maton'
import {
  configurePipelineTabsWithRequest,
  type SheetsRequestInput,
} from '@/lib/pipelineProvisioning'

async function matonSheetsJson<T>(pathname: string, input: SheetsRequestInput = {}): Promise<T> {
  const response = await matonFetch(`/google-sheets${pathname}`, {
    method: input.method || 'GET',
    headers: input.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`Pipeline workbook configuration failed (${response.status})`)
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
