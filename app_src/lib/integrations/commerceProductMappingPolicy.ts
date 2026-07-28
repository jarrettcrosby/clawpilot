export type ExactProductMappingMutation =
  | 'create'
  | 'reuse'
  | 'preserve'
  | 'replace'

export function exactProductMappingMutation(input: {
  activeProductId: string | null
  requestedProductId: string
  allowReplacement: boolean
}): ExactProductMappingMutation {
  if (!input.activeProductId) return 'create'
  if (input.activeProductId === input.requestedProductId) return 'reuse'
  return input.allowReplacement ? 'replace' : 'preserve'
}
