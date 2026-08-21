import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const packageRoot = path.resolve(import.meta.dirname, '..')

function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(packageRoot, 'scripts', script), ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0 || result.error) {
    throw result.error || new Error(`${script} failed:\n${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

test('deterministic fixture drives release index into the exact 14-asset contract', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-release-index-fixture-'))
  const input = path.join(temporary, 'input')
  const release = path.join(temporary, 'release')
  const version = '7.8.9'
  const sourceCommit = '0123456789abcdef0123456789abcdef01234567'
  mkdirSync(release)
  try {
    const fixture = run('create-release-index-test-fixture.mjs', [
      '--output', input,
      '--version', version,
      '--source-commit', sourceCommit,
    ])
    assert.equal(fixture.fixtureOnly, true)
    assert.equal(fixture.sourceCommit, sourceCommit)
    for (const name of readdirSync(input)) {
      copyFileSync(path.join(input, name), path.join(release, name))
    }
    const generated = run('create-release-index.mjs', [
      '--input', input,
      '--output', release,
    ])
    assert.equal(generated.version, version)
    const indexName = `ClawPilot-Print-Agent-${version}-release.json`
    const index = JSON.parse(readFileSync(path.join(release, indexName), 'utf8'))
    assert.equal(index.sourceCommit, sourceCommit)
    assert.deepEqual(index.artifacts.map((artifact) => artifact.platform), ['macos', 'windows'])
    assert.deepEqual(
      index.artifacts.map((artifact) => artifact.filename),
      fixture.artifacts.map((artifact) => artifact.filename),
    )
    const signedMetadata = [
      ...fixture.artifacts.flatMap((artifact) => [
        `${artifact.filename}.artifact.json`,
        `${artifact.filename}.sha256`,
      ]),
      indexName,
      'SHA256SUMS.txt',
    ]
    for (const filename of signedMetadata) {
      writeFileSync(
        path.join(release, `${filename}.sigstore.json`),
        `${JSON.stringify({ fixtureOnly: true, filename })}\n`,
      )
    }
    const exact = run('assert-release-asset-set.mjs', [
      '--directory', release,
      '--version', version,
    ])
    assert.equal(exact.assets.length, 14)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
