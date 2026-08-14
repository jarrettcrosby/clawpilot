export type CommerceSetupProvider = 'shopify' | 'faire'
export type FaireSetupAuthPath = 'brand_api_key' | 'oauth'
export type FaireSetupScopeProfile =
  | 'connection_test'
  | 'distributed_operations'

export type CommerceSetupPermissionGuidance = {
  mode: 'shopify_app_scopes' | 'faire_oauth_scopes' | 'provider_issued_access'
  heading: string
  description: string
  scopes: readonly string[]
  copyable: boolean
}

export function resolveCommerceSetupPermissionGuidance(input: {
  provider: CommerceSetupProvider | null
  shopifyScopes: readonly string[]
  faireAuthPath: FaireSetupAuthPath
  faireScopeProfile: FaireSetupScopeProfile
  faireScopeProfiles: {
    connection_test: readonly string[]
    distributed_operations: readonly string[]
  }
}): CommerceSetupPermissionGuidance | null {
  if (input.provider === null) return null
  if (input.provider === 'shopify') {
    return {
      mode: 'shopify_app_scopes',
      heading: 'Exact Shopify app scopes ClawPilot expects',
      description:
        'Copy this list into the Shopify app-version permission screen. This profile intentionally reserves future customer, inventory, order, fulfillment, return, shipping, and app-proxy paths. Shopify write scopes include the matching read access, so write_inventory covers both inventory reads and a future separately authorized write path. ClawPilot still blocks every provider write unless its exact outbound workflow is implemented, activated, and authorized.',
      scopes: input.shopifyScopes,
      copyable: true,
    }
  }
  if (input.faireAuthPath === 'brand_api_key') {
    return {
      mode: 'provider_issued_access',
      heading: 'Faire-issued brand access',
      description:
        'Faire determines access when it generates the final single-brand API key. There is no OAuth scope list to copy or configure for this path; paste only the provider-issued key into ClawPilot.',
      scopes: [],
      copyable: false,
    }
  }
  const scopes = input.faireScopeProfiles[input.faireScopeProfile]
  return {
    mode: 'faire_oauth_scopes',
    heading: input.faireScopeProfile === 'connection_test'
      ? 'Faire OAuth connection-test permission'
      : 'Faire OAuth distributed-operations permissions',
    description:
      'Request this exact OAuth permission profile in Faire. ClawPilot verifies the resulting grant before enabling the selected connection path.',
    scopes,
    copyable: true,
  }
}
