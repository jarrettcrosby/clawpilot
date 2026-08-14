export type CommerceOrderHistoryRequestToken = Readonly<{
  scope: string
  generation: number
}>

export type CommerceOrderHistoryRequestFence = {
  issue: (scope?: string) => CommerceOrderHistoryRequestToken
  reset: (scope: string) => void
  isCurrent: (token: CommerceOrderHistoryRequestToken) => boolean
}

export function createCommerceOrderHistoryRequestFence(
  initialScope: string,
): CommerceOrderHistoryRequestFence {
  let scope = initialScope
  let generation = 0

  return {
    issue(nextScope = scope) {
      scope = nextScope
      generation += 1
      return { scope, generation }
    },
    reset(nextScope) {
      scope = nextScope
      generation += 1
    },
    isCurrent(token) {
      return token.scope === scope && token.generation === generation
    },
  }
}
