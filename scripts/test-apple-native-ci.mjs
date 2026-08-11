import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(
  new URL('../.github/workflows/apple-picking-phase1.yml', import.meta.url),
  'utf8',
)

test('runs paid macOS validation only for native Apple changes', () => {
  assert.match(workflow, /pull_request:\n    branches: \[dev\]/)
  assert.match(workflow, /push:\n(?:    #.*\n)*    branches: \[dev\]/)
  assert.doesNotMatch(workflow, /push:\n(?:    #.*\n)*    branches: \[[^\]]*main/)
  assert.match(workflow, /- 'clients\/apple\/\*\*'/)
  assert.match(workflow, /- 'scripts\/test-apple-environment-split\.mjs'/)
  assert.match(workflow, /- 'scripts\/test-apple-native-ci\.mjs'/)

  for (const expensiveFalsePositive of [
    "- 'package.json'",
    "- 'app_src/",
    "- 'docs/",
    'npm run test:wearable-server',
    'npm run test:wearable-phase1',
  ]) {
    assert.ok(
      !workflow.includes(expensiveFalsePositive),
      `macOS workflow should not include ${expensiveFalsePositive}`,
    )
  }
})

test('keeps one bounded macOS job focused on native contracts and builds', () => {
  assert.match(workflow, /^  validate:\n    runs-on: macos-26\n    timeout-minutes: 30$/m)
  assert.equal(
    workflow.match(/^    runs-on: macos-26$/gm)?.length,
    1,
    'native validation should allocate exactly one macOS job',
  )
  assert.match(workflow, /node scripts\/test-apple-native-ci\.mjs/)
  assert.match(workflow, /node scripts\/test-apple-environment-split\.mjs/)
  assert.match(workflow, /swift test \\\n+            --package-path clients\/apple/)
  assert.match(workflow, /swift clients\/apple\/Tools\/verify-meta-mock-fixtures\.swift/)
  assert.match(workflow, /run: clients\/apple\/run-xcode-simulator-builds\.sh/)
})

test('keeps cancellation and the native tool generator bounded', () => {
  assert.match(workflow, /cancel-in-progress: true/)
  assert.match(workflow, /XCODEGEN_VERSION: '2\.45\.4'/)
  assert.match(workflow, /XCODEGEN_SHA256: '[0-9a-f]{64}'/)
  assert.match(workflow, /shasum --algorithm 256 --check/)
  assert.match(workflow, /xcodegen --version/)
})
