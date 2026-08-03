import type {
  CommerceActiveWriteCapability,
} from '@/lib/operations/types'

export const FAIRE_FULFILLMENT_ACTIVE_CAPABILITIES = [
  'order_update',
  'fulfillment_export',
  'tracking_export',
] as const satisfies readonly CommerceActiveWriteCapability[]

export type CommerceActiveContinuation = {
  sourceTransitionGlobalId: string
  sourceActivationRevision: number
  shadowActivationRevision: number
  shopifyAccounts: Array<{
    accountGlobalId: string
    writeCapabilities: CommerceActiveWriteCapability[]
  }>
}

export type CommerceActiveSelectionAccount = {
  accountGlobalId: string
  provider: 'shopify' | 'faire'
  capabilities: Array<{
    capability: CommerceActiveWriteCapability
    selectable: boolean
    unavailableReason: 'not_implemented' | 'missing_scope' | null
  }>
}

export type CommerceActiveInitialSelection = {
  selections: Record<string, CommerceActiveWriteCapability[]>
  preservationBlockers: string[]
  preservedShopifyAccountCount: number
  preservedShopifyCapabilityCount: number
  faireDefaultedAccountCount: number
}

/**
 * Continue the immediately preceding Active Shopify authority exactly while
 * making Faire's three fulfillment claims the only automatic additions.
 * Accounts and capabilities outside those two sets begin unselected.
 */
export function commerceActiveInitialSelection(input: {
  accounts: readonly CommerceActiveSelectionAccount[]
  continuation: CommerceActiveContinuation | null
  expectedShadowActivationRevision: number
}): CommerceActiveInitialSelection {
  const selections = Object.fromEntries(
    input.accounts.map((account) => [account.accountGlobalId, []]),
  ) as Record<string, CommerceActiveWriteCapability[]>
  const accountByGlobalId = new Map(
    input.accounts.map((account) => [account.accountGlobalId, account]),
  )
  const preservationBlockers: string[] = []
  let preservedShopifyAccountCount = 0
  let preservedShopifyCapabilityCount = 0

  if (input.continuation) {
    if (
      input.continuation.shadowActivationRevision
        !== input.expectedShadowActivationRevision
      || input.continuation.sourceActivationRevision + 1
        !== input.expectedShadowActivationRevision
    ) {
      preservationBlockers.push(
        'The prior Shopify authority does not match the current Shadow revision. Reload Operations before preparing Active mode.',
      )
    } else {
      for (const priorAccount of input.continuation.shopifyAccounts) {
        const account = accountByGlobalId.get(priorAccount.accountGlobalId)
        if (!account || account.provider !== 'shopify') {
          preservationBlockers.push(
            `${priorAccount.accountGlobalId} was in the prior Active Shopify cohort but is no longer an eligible verified account.`,
          )
          continue
        }
        const preserved: CommerceActiveWriteCapability[] = []
        for (const priorCapability of priorAccount.writeCapabilities) {
          const option = account.capabilities.find(
            (candidate) => candidate.capability === priorCapability,
          )
          if (!option) {
            preservationBlockers.push(
              `${priorAccount.accountGlobalId} has an unrecognized prior Shopify claim: ${priorCapability}.`,
            )
            continue
          }
          if (!option.selectable) {
            preservationBlockers.push(
              `${priorAccount.accountGlobalId} cannot preserve ${priorCapability} because it is ${option.unavailableReason === 'missing_scope' ? 'missing a required scope' : 'not implemented'}.`,
            )
            continue
          }
          preserved.push(option.capability)
        }
        selections[account.accountGlobalId] = preserved
        preservedShopifyAccountCount += 1
        preservedShopifyCapabilityCount += preserved.length
      }
    }
  }

  let faireDefaultedAccountCount = 0
  for (const account of input.accounts) {
    if (account.provider !== 'faire') continue
    const capabilityByName = new Map(
      account.capabilities.map((option) => [option.capability, option]),
    )
    const exactFaireClaims = FAIRE_FULFILLMENT_ACTIVE_CAPABILITIES.map(
      (capability) => capabilityByName.get(capability),
    )
    if (exactFaireClaims.every((option) => option?.selectable === true)) {
      selections[account.accountGlobalId] = [
        ...FAIRE_FULFILLMENT_ACTIVE_CAPABILITIES,
      ]
      faireDefaultedAccountCount += 1
    }
  }

  return {
    selections,
    preservationBlockers,
    preservedShopifyAccountCount,
    preservedShopifyCapabilityCount,
    faireDefaultedAccountCount,
  }
}
