#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Match the SuiteCRM 8.10.1 composer lock. Neither dependency is vendored or
// resolved from a floating version during the test run.
const smartyCommit = 'a8d77c86660ca0562ec2fb781fbbda737fb7a62b'
const smartyArchiveSha256 = '386235661892c00ca565f4e03168a72355b7403057461ef39e23a0432b3bc85e'
const phpImage = 'php@sha256:6cb44388b6ffc8c9a35b4cfdf518d0565e0cf9150e479add338b498874d7e971'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dependencyRoot = await mkdtemp(join(tmpdir(), 'clawpilot-email-search-deps-'))

try {
  const response = await fetch(`https://codeload.github.com/smarty-php/smarty/tar.gz/${smartyCommit}`, {
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`Pinned Smarty download failed: HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  if (archive.length > 10 * 1024 * 1024) throw new Error('Pinned Smarty archive exceeded the size limit')
  if (createHash('sha256').update(archive).digest('hex') !== smartyArchiveSha256) {
    throw new Error('Pinned Smarty archive checksum mismatch; refusing extraction')
  }
  const archivePath = join(dependencyRoot, 'smarty.tar.gz')
  await writeFile(archivePath, archive, { mode: 0o600 })
  const expectedPrefix = `smarty-${smartyCommit}/`
  const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
    .split('\n').filter(Boolean)
  if (!entries.length || entries.some(entry => !entry.startsWith(expectedPrefix) || entry.split('/').includes('..'))) {
    throw new Error('Pinned Smarty archive contains an unexpected path; refusing extraction')
  }
  execFileSync('tar', ['-xzf', archivePath, '-C', dependencyRoot], { stdio: 'inherit' })
  const smartyRoot = join(dependencyRoot, `smarty-${smartyCommit}`)
  // --mount uses comma-separated fields. Refuse an ambiguous host path rather
  // than interpreting it as extra mount settings. Arguments never use a shell.
  if ([repoRoot, smartyRoot].some(path => path.includes(','))) {
    throw new Error('Docker test mount paths cannot contain commas')
  }
  console.log('Verified Smarty 4.5.6 archive; running pinned PHP with network disabled and read-only source/dependencies.')
  execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '64', '--memory', '256m', '--cpus', '1',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--mount', `type=bind,source=${repoRoot},target=/repo,readonly`,
    '--mount', `type=bind,source=${smartyRoot},target=/smarty,readonly`,
    '--env', 'CLAWPILOT_TEST_SMARTY_ROOT=/smarty',
    '--workdir', '/repo', phpImage,
    'php', 'scripts/test-suitecrm-email-search.php',
  ], { stdio: 'inherit', timeout: 300_000 })
} catch (error) {
  console.error(error instanceof Error ? error.message : 'SuiteCRM Email search test failed')
  process.exitCode = 1
} finally {
  // This exact directory was created by this process, and contains only the
  // checksum-verified test dependency. Never clean repository or shared caches.
  await rm(dependencyRoot, { recursive: true, force: true })
}
