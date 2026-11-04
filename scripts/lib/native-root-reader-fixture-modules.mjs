// Load actual source modules into an existing owned SQL fixture, not a mock
// root audience. Empty registries stay empty; no identities or grants are seeded.
export function loadNativeRootReaderFixtureModules(load,protocol){
  const root=load('app_src/lib/crm/rootEmployeeCrmAccess.ts',{'./nativeEmailPublication':protocol})
  const control=load('app_src/lib/persistence/crmNativeEmailAuthority.ts',{})
  const collector=load('app_src/lib/persistence/crmRootEmployeeAccess.ts',{'./crmNativeEmailAuthority':control,
    '../crm/rootEmployeeCrmAccess':root,'../crm/nativeEmailPublication':protocol})
  const registry=load('app_src/lib/crm/rootEmployeeCrmRegistryChange.ts',{'./nativeEmailPublication':protocol})
  const preview=load('app_src/lib/persistence/crmRootEmployeeRegistryPreview.ts',{
    '../crm/nativeEmailPublication':protocol,'../crm/rootEmployeeCrmRegistryChange':registry,
    './crmNativeEmailAuthority':control,'./crmRootEmployeeAccess':collector})
  return load('app_src/lib/crm/nativeEmailRootReaders.ts',{'../persistence/crmRootEmployeeAccess':collector,
    '../persistence/crmRootEmployeeRegistryPreview':preview,'./rootEmployeeCrmRegistryChange':registry,
    '../persistence/crmNativeEmailAuthority':control,'./rootEmployeeCrmAccess':root,'./nativeEmailPublication':protocol})
}
