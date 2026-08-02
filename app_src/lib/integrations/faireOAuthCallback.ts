const FAIRE_OAUTH_AUTHORIZATION_CODE_PARAMETER_NAMES = Object.freeze([
  'authorizationCode',
  'authorization_code',
  'code',
] as const)

/**
 * OAuth authorization responses may use the standard `code` parameter,
 * while earlier Faire provider material used `authorizationCode`.
 * Accept the bounded aliases, but fail closed when the callback supplies
 * conflicting values instead of guessing which credential to exchange.
 */
export function readFaireOAuthCallbackAuthorizationCode(
  searchParams: Pick<URLSearchParams, 'getAll'>,
) {
  const values = FAIRE_OAUTH_AUTHORIZATION_CODE_PARAMETER_NAMES.flatMap(
    (name) => searchParams.getAll(name),
  )
    .map((value) => value.trim())
    .filter(Boolean)
  if (values.length === 0) return null
  const unique = new Set(values)
  return unique.size === 1 ? values[0] : null
}
