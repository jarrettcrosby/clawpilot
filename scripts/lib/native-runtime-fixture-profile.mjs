// Named local dependency profiles only. This does not relax source, native
// policy, matrix coverage or the five-second transaction deadline.
import assert from 'node:assert/strict'
const profiles=Object.freeze({
  '8.3.35':Object.freeze({image:'clawpilot-suitecrm-native-acceptance:8.10.1-php83',phpVersion:'8.3.35'}),
  '8.3.36':Object.freeze({image:'clawpilot-suitecrm-native-acceptance:8.10.1-php83-8.3.36',phpVersion:'8.3.36'}),
})
export function nativeRuntimeFixtureProfile(version='8.3.35'){
  assert.ok(typeof version==='string'&&Object.hasOwn(profiles,version),'Select an explicit supported PHP fixture profile: 8.3.35 or 8.3.36')
  return profiles[version]
}
