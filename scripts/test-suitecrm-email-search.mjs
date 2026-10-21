#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

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
  const nativeFiles = {
    'SugarBean.php': ['data/SugarBean.php', '5edf1050ee0ad01c1de57f235ebae55bab2e5476f58d979ebfc8eb14fc155547'],
    'BeanFactory.php': ['data/BeanFactory.php', '240a50bd7e8878223230ac466e453de91c1332091d6acf960afb6abf75b75640'],
    'listvardefoverride.php': ['include/VarDefHandler/listvardefoverride.php', '6deaec13faa7047e64e81774d80740cfa6106220955d6d56efbb775a042fa435'],
  }
  for (const [name, [source, checksum]] of Object.entries(nativeFiles)) {
    const upstream = await fetch(`https://raw.githubusercontent.com/SuiteCRM/SuiteCRM-Core/v8.10.1/public/legacy/${source}`, { signal: AbortSignal.timeout(60_000) })
    if (!upstream.ok) throw new Error(`Pinned native source failed: HTTP ${upstream.status}`)
    const content = Buffer.from(await upstream.arrayBuffer())
    if (content.length > 1024 * 1024 || createHash('sha256').update(content).digest('hex') !== checksum) {
      throw new Error(`Pinned native ${name} checksum mismatch`)
    }
    await writeFile(join(dependencyRoot, name), content, { mode: 0o600 })
  }
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
  const queryOutput = execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '64', '--memory', '256m', '--cpus', '1',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--mount', `type=bind,source=${repoRoot},target=/repo,readonly`,
    '--mount', `type=bind,source=${dependencyRoot},target=/native,readonly`,
    '--env', 'CLAWPILOT_TEST_NATIVE_ROOT=/native', '--workdir', '/repo', phpImage,
    'php', 'scripts/test-suitecrm-meeting-list.php',
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
  const queryLine = queryOutput.split('\n').find(line => line.startsWith('CLAWPILOT_MEETING_QUERIES='))
  if (!queryLine) throw new Error('Pinned native query fixture produced no SQL')
  const queries = JSON.parse(queryLine.slice('CLAWPILOT_MEETING_QUERIES='.length))
  const sql = new DatabaseSync(':memory:')
  try {
    sql.function('CONCAT', { varargs: true }, (...values) => values.some(value => value === null) ? null : values.join(''))
    sql.exec(`
      CREATE TABLE meetings(id TEXT PRIMARY KEY,name TEXT,date_modified TEXT,assigned_user_id TEXT,deleted INTEGER);
      CREATE TABLE meetings_cstm(id_c TEXT PRIMARY KEY,global_id_c TEXT);
      CREATE TABLE contacts(id TEXT PRIMARY KEY,first_name TEXT,last_name TEXT,deleted INTEGER);
      CREATE TABLE meetings_contacts(meeting_id TEXT,contact_id TEXT,deleted INTEGER);
      INSERT INTO meetings VALUES
        ('m1','Weekly Connect','2026-10-21','allowed-owner',0),
        ('m2','Weekly Next','2026-10-22','allowed-owner',0),
        ('m3','Weekly No Access','2026-10-23','other-owner',0),
        ('m4','Weekly Deleted','2026-10-24','allowed-owner',1);
      INSERT INTO meetings_cstm VALUES ('m1','gmicboburacp2l'),('m2','gm-next'),('m3','gm-other'),('m4','gm-deleted');
      INSERT INTO contacts VALUES ('adrian','Adrian','Tanner',0),('joe','Joe','Cook',0),('zack','Zack','Next',0),('removed','Aardvark','Deleted',1);
      INSERT INTO meetings_contacts VALUES ('m1','adrian',0),('m1','joe',0),('m1','removed',0),('m2','zack',0),('m2','adrian',1),('m3','adrian',0),('m4','adrian',0);
    `)
    const ids = query => sql.prepare(query).all().map(row => row.id)
    assert.deepEqual(ids(queries['global-id'].before), ['m1', 'm1', 'm1'])
    const expected = { all: ['m1', 'm2'], 'global-id': ['m1'], title: ['m1', 'm2'], 'contact-name': ['m1'], 'all-contacts': ['m1', 'm2'], 'contact-sort': ['m1', 'm2'], 'contact-id-sort': ['m2', 'm1'] }
    for (const [name, expectation] of Object.entries(expected)) {
      assert.deepEqual(ids(queries[name].after), expectation, `${name}: unique rows/order/ACL`)
      assert.equal(sql.prepare(queries[name].count).get().c, expectation.length, `${name}: exact unique total`)
      assert.deepEqual(ids(`${queries[name].after} LIMIT 1 OFFSET 0`), expectation.slice(0, 1), `${name}: first page`)
      assert.deepEqual(ids(`${queries[name].after} LIMIT 1 OFFSET 1`), expectation.slice(1, 2), `${name}: next page`)
    }
    assert.equal(sql.prepare('SELECT COUNT(*) c FROM meetings_contacts WHERE meeting_id=\'m1\' AND deleted=0').get().c, 3, 'No attendee relation may be removed')
    console.log('SuiteCRM Meeting query acceptance: 7 native-generated SQL cases passed (duplicate reproduction, unique IDs/counts/pages, contact filters/sorts, ACL/deleted preservation; in-memory SQLite, no provider/database writes).')
  } finally { sql.close() }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'SuiteCRM Email search test failed')
  if (error && typeof error === 'object' && typeof error.stdout === 'string') {
    console.error(error.stdout.split('\n').filter(line => !line.startsWith('CLAWPILOT_MEETING_QUERIES=')).join('\n'))
  }
  process.exitCode = 1
} finally {
  // This exact directory was created by this process, and contains only the
  // checksum-verified test dependency. Never clean repository or shared caches.
  await rm(dependencyRoot, { recursive: true, force: true })
}
