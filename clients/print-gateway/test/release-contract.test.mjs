import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertNoConcreteSecretsInPaths,
  assertUniversalMachOPayload,
} from '../src/lib/release-payload-verification.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
const read = (relativePath) => readFileSync(path.join(repositoryRoot, relativePath), 'utf8')

function shellRunBlocks(workflow) {
  const lines = workflow.split('\n')
  const blocks = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*(.*)$/)
    if (!match) continue
    const indentation = match[1].length
    const block = [match[2]]
    while (index + 1 < lines.length) {
      const next = lines[index + 1]
      if (next.trim() && next.match(/^\s*/)[0].length <= indentation) break
      block.push(next)
      index += 1
    }
    blocks.push(block.join('\n'))
  }
  return blocks
}

test('customer release is fail-closed, secret-safe, exact-SHA tested, and action-pinned', () => {
  const workflow = read('.github/workflows/print-gateway-release.yml')
  for (const gate of [
    "confirmation == 'SIGN_AND_PUBLISH'",
    'refs/heads/main',
    'print-gateway-customer-release',
    'npm --prefix clients/print-gateway test',
    'node scripts/test-local-print-device.mjs',
    'node scripts/test-operation-print-agent-pairing.mjs',
    'node scripts/test-operation-print-agent-cleanup-status.mjs',
    'node scripts/test-operation-print-agent-runtime.mjs',
    'node scripts/test-operations-print-delivery.mjs --contracts-only',
    'run smoke:packaged',
    'Execute the exact mounted, signed, stapled DMG payload',
    'Install, execute, verify autostart, and uninstall exact signed NSIS release',
    'CLAWPILOT_PACKAGED_PAYLOAD_DIRECTORY',
    'Get-AuthenticodeSignature',
    'WIN_SIGNING_THUMBPRINT',
    "'--release-smoke-login-item'",
    'git ls-remote --exit-code --refs origin',
    'gh release upload',
    'tag_commit=',
    'prepublish_commit=',
    'published_commit=',
    'cosign verify-blob',
    'assert-release-asset-set.mjs',
    '--draft',
    '--draft=false',
  ]) assert.ok(workflow.includes(gate), `Release workflow is missing ${gate}`)
  assert.equal((workflow.match(/run build:dir/g) || []).length, 0)
  assert.equal((workflow.match(/run smoke:packaged/g) || []).length, 2)
  assert.equal((workflow.match(/rm -rf clients\/print-gateway\/dist/g) || []).length, 1)
  assert.equal((workflow.match(/Remove-Item -Recurse -Force -ErrorAction SilentlyContinue clients\/print-gateway\/dist/g) || []).length, 1)
  assert.equal((workflow.match(/gh release create "\$tag"/g) || []).length, 1)
  assert.equal((workflow.match(/gh release edit "\$tag" --draft=false/g) || []).length, 1)
  assert.match(
    workflow,
    /gh release upload[\s\S]*prepublish_commit=.*[\s\S]*if \[ "\$prepublish_commit" != "\$SOURCE_COMMIT" \][\s\S]*gh release edit "\$tag" --draft=false/,
  )
  assert.match(
    workflow,
    /Start-Process -FilePath \$installedApp -ArgumentList '--release-smoke-login-item' -Wait -PassThru/,
  )
  assert.doesNotMatch(workflow, /& \$installedApp '--release-smoke-login-item'/)
  assert.doesNotMatch(workflow, /SignerCertificate\.Subject\.Contains/)
  assert.match(
    workflow,
    /SignerCertificate\.Subject -ne \$env:WIN_SIGNING_SUBJECT[\s\S]*SignerCertificate\.Thumbprint\.ToUpperInvariant\(\) -ne \$env:WIN_SIGNING_THUMBPRINT\.ToUpperInvariant\(\)/,
  )
  assert.doesNotMatch(workflow, /^\s*push:/m)

  for (const runBlock of shellRunBlocks(workflow)) {
    assert.doesNotMatch(runBlock, /\$\{\{\s*secrets\./)
    assert.doesNotMatch(runBlock, /\$\{\{\s*inputs\.version\s*\}\}/)
  }
  const environmentFileBlocks = workflow.split('>> "$GITHUB_ENV"')
    .slice(0, -1)
    .map((prefix) => prefix.slice(-400))
  for (const block of environmentFileBlocks) {
    for (const forbidden of [
      'CSC_KEY_PASSWORD',
      'CSC_NAME',
      'MACOS_DEVELOPER_ID_APPLICATION',
      'APPLE_TEAM_ID',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER',
      'WIN_CSC_KEY_PASSWORD',
      'WIN_SIGNING_SUBJECT',
      'WIN_SIGNING_THUMBPRINT',
    ]) assert.doesNotMatch(block, new RegExp(forbidden))
  }

  for (const line of workflow.split('\n').filter((value) => value.includes('uses:'))) {
    assert.match(line, /uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}(?:\s+#\s+v\d+)?\s*$/)
  }
})

test('packaging contains exact runtime, native Windows helper, and no PowerShell delivery path', () => {
  const packageSource = read('clients/print-gateway/package.json')
  const packageJson = JSON.parse(packageSource)
  assert.equal(packageJson.build.appId, 'com.clawpilot.site-print-gateway')
  assert.equal(packageJson.build.productName, 'ClawPilot Print Agent')
  assert.equal(packageJson.build.mac.hardenedRuntime, true)
  assert.equal(packageJson.build.win.signAndEditExecutable, true)
  assert.equal(packageJson.build.nsis.deleteAppDataOnUninstall, false)
  const resources = [
    ...packageJson.build.extraResources,
    ...packageJson.build.mac.extraResources,
    ...packageJson.build.win.extraResources,
  ].map((entry) => entry.to)
  for (const required of [
    'runtime/run-local-print-agent.mjs',
    'runtime/lib/local-print-device.mjs',
    'runtime/lib/submit-raw-print.mjs',
    'runtime/lib/print-agent-pairing-credential.mjs',
    'runtime/lib/clawpilot-print-lock',
    'runtime/lib/clawpilot-print-lock.exe',
  ]) assert.ok(resources.includes(required), `Missing exact runtime resource ${required}`)
  assert.doesNotMatch(packageSource, /\.ps1|PowerShell|ExecutionPolicy/i)
  assert.doesNotMatch(
    packageSource,
    /cppair\.v1\.[0-9a-f-]{36}\.|cpprint\.v1\.[0-9a-f-]{36}\./i,
  )

  const afterPack = read('clients/print-gateway/scripts/after-pack.cjs')
  const localNetworkDelete = afterPack.indexOf(
    "plist(infoPlist, 'Delete :NSLocalNetworkUsageDescription', false)",
  )
  const localNetworkAdd = afterPack.indexOf(
    "'Add :NSLocalNetworkUsageDescription string ClawPilot uses the local network only to reach the Zebra printer you configure.'",
  )
  assert.ok(localNetworkDelete >= 0, 'macOS packaging must clear the existing local-network usage key')
  assert.ok(localNetworkAdd > localNetworkDelete, 'macOS packaging must replace the local-network usage key idempotently')
})

test('release verifier proves signatures, hardened runtime, and payload architectures', () => {
  const verifier = read('clients/print-gateway/scripts/verify-release-artifacts.mjs')
  for (const proof of [
    "'stapler', 'validate'",
    "'--assess'",
    'flags=0x',
    "'/usr/bin/lipo', ['-verify_arch', 'x86_64', 'arm64'",
    'assertUniversalMachOPayload',
    'assertWindowsX64PayloadTree',
    'for (const filePath of pePayloads) assertValidWindowsSignature(filePath)',
    "'Uninstall ClawPilot Print Agent.exe'",
    'assertNoConcreteSecretsInPaths([appPath])',
    'The native macOS endpoint-lock helper is missing from the packaged app',
    'assertNoConcreteSecretsInPaths([unpackedDirectory])',
    'sourceCommit',
  ]) assert.ok(verifier.includes(proof), `Release verifier is missing ${proof}`)
  assert.doesNotMatch(verifier, /filter\([^)]*Uninstall ClawPilot Print Agent/)
  assert.doesNotMatch(verifier, /signature\.subject\.includes/)
  assert.match(verifier, /signature\.subject !== subject/)
  assert.match(verifier, /WIN_SIGNING_THUMBPRINT/)
  const exactAssetGate = read('clients/print-gateway/scripts/assert-release-asset-set.mjs')
  assert.match(exactAssetGate, /exact 14-file customer contract/)
})

test('recursive release scan rejects hidden credentials and a single-arch nested Mach-O', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-release-adversarial-'))
  const resources = path.join(temporary, 'ClawPilot Print Agent.app', 'Contents', 'Resources')
  const frameworks = path.join(temporary, 'ClawPilot Print Agent.app', 'Contents', 'Frameworks')
  mkdirSync(resources, { recursive: true })
  mkdirSync(frameworks, { recursive: true })
  const concrete = `cpprint.v1.00000000-0000-4000-8000-000000000001.${'Z'.repeat(43)}`
  writeFileSync(path.join(resources, 'app.asar'), Buffer.concat([
    Buffer.alloc(65_500, 0x41),
    Buffer.from(concrete),
  ]))
  const nestedHelper = path.join(frameworks, 'ClawPilot Helper')
  const machHeader = Buffer.alloc(64)
  machHeader.writeUInt32BE(0xcffaedfe, 0)
  writeFileSync(nestedHelper, machHeader)
  try {
    assert.throws(
      () => assertNoConcreteSecretsInPaths([temporary]),
      /concrete ClawPilot secret.*app\.asar/,
    )
    writeFileSync(path.join(resources, 'app.asar'), 'secret-free asar fixture')
    assert.doesNotThrow(() => assertNoConcreteSecretsInPaths([temporary]))
    assert.throws(() => assertUniversalMachOPayload(temporary, {
      architecturesFor: () => ['arm64'],
    }), /not exactly universal.*ClawPilot Helper.*arm64/)
    assert.doesNotThrow(() => assertUniversalMachOPayload(temporary, {
      architecturesFor: () => ['arm64', 'x86_64'],
    }))
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('customer app states the per-user sign-in and powered-on requirement', () => {
  const renderer = read('clients/print-gateway/src/renderer/index.html')
  assert.match(
    renderer,
    /computer must stay powered on and the user must remain signed in for background printing/i,
  )
  assert.match(renderer, /Closing this window leaves the tray agent running/i)
  assert.match(renderer, /Start gateway when I sign in/i)
})
