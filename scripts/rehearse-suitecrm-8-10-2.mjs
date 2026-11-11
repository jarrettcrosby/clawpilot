#!/usr/bin/env node
// Disposable, checksum-pinned stock SuiteCRM upgrade. No provider credentials,
// production data, image pulls, published Docker ports, or Internet egress.
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { createDisposablePostgresRuntime, DISPOSABLE_POSTGRES_LABEL, DISPOSABLE_POSTGRES_OWNER_LABEL } from './lib/disposable-postgres-docker.mjs'
import { assessHeadroom, readThresholds, runStorageGuard } from './local-storage-guard.mjs'

const [, , oldInput, newInput, mode, ...extra] = process.argv
assert.ok(isAbsolute(oldInput || '') && isAbsolute(newInput || '') && !extra.length
  && (!mode || ['--loopback-ui', '--oauth-smoke', '--cold-boot', '--normal-boot'].includes(mode)),
  'Usage: node scripts/rehearse-suitecrm-8-10-2.mjs /absolute/8.10.1.zip /absolute/8.10.2.zip [--loopback-ui | --oauth-smoke | --cold-boot | --normal-boot]')
const uiOption = mode === '--loopback-ui', oauthSmoke = mode === '--oauth-smoke'
const coldBoot = mode === '--cold-boot' || mode === '--normal-boot'
const archive = (input, hash) => {
  const path = realpathSync(input), metadata = lstatSync(path)
  assert.ok(metadata.isFile() && metadata.uid === process.getuid() && metadata.size < 180_000_000 && !path.includes(','))
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash, 'Official archive checksum required')
  return path
}
const oldArchive = archive(oldInput, 'b72da32ca7702452537cdd11e1157bc41a283accdadca66ef88f42684a571ef7')
const newArchive = archive(newInput, 'ac4693d10ea2d6cd20b3256098781d134599d88878fb24e8dc127038d624f5a8')
const localEnvironment = { ...process.env, CI: '', VERCEL: '', VERCEL_ENV: '' }
for (const key of ['RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_SERVICE_ID']) delete localEnvironment[key]
assert.equal(runStorageGuard({ argv: ['--preflight'], environment: localEnvironment }), 0)
const storageThresholds = readThresholds(localEnvironment)
const checkHostDisk = path => {
  const { bavail, bsize } = statfsSync(path, { bigint: true })
  assert.notEqual(assessHeadroom(Number(bavail * bsize), storageThresholds), 'fail',
    `Host storage fell below ${storageThresholds.minimumGiB} GiB; stopping the disposable fixture`)
}
const dockerOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
const execute = (command, args, extraOptions = {}) => execFileSync(command, args, { ...dockerOptions, ...extraOptions })
const docker = (...args) => execute('docker', args)
const inspect = (kind, tag) => JSON.parse(docker(kind, 'inspect', tag))[0]
const dbImage = inspect('image', 'mariadb:11.4.13')
const candidateImage = coldBoot ? inspect('image', 'clawpilot-suitecrm:upgrade-8.10.2-local') : null
// Native Linux CI can use the packaged PHP runtime for both steps; the old
// application still comes solely from the separately pinned 8.10.1 archive.
const appImage = candidateImage && process.platform === 'linux'
  ? candidateImage : inspect('image', 'clawpilot-suitecrm-native-acceptance:8.10.1-php83-8.3.36')
if (candidateImage) {
  assert.equal(candidateImage.Architecture, 'amd64')
  assert.ok(candidateImage.Config.Env.includes('SUITECRM_VERSION=8.10.2'))
  assert.deepEqual(candidateImage.Config.Entrypoint, ['/usr/local/bin/entrypoint.sh'])
  assert.deepEqual(Object.keys(candidateImage.Config.Volumes || {}), [])
}
assert.ok(appImage.Config.Env.includes('PHP_VERSION=8.3.36'))
assert.deepEqual(Object.keys(appImage.Config.Volumes || {}), [])
assert.deepEqual(Object.keys(dbImage.Config.Volumes || {}), ['/var/lib/mysql'])
const root = mkdtempSync(join(tmpdir(), 'clawpilot-suitecrm-upgrade-rehearsal.'))
const token = randomUUID(), stem = `clawpilot-upgrade-${process.pid}-${token.slice(0, 8)}`
const db = stem + '-db', app = stem + '-app', network = stem + '-net'
const ownerLabel = 'com.clawpilot.suitecrm-upgrade-rehearsal.owner'
const lease = createDisposablePostgresRuntime({ environment: localEnvironment })
const fixtureRoot = join(root, 'fixture')
const coldVolume = join(root, 'persisted')
mkdirSync(fixtureRoot, { mode: 0o755 })
const writeFixture = (name, source) => writeFileSync(join(fixtureRoot, name), source, { flag: 'wx', mode: 0o644 })
writeFileSync(join(root, 'owner'), token, { flag: 'wx', mode: 0o600 })

const fixture = String.raw`<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli' || !chdir('/app/public/legacy') || !is_file('config.php')) {
    throw new RuntimeException('Disposable native CLI fixture required');
}
define('sugarEntry', true);
require_once 'include/entryPoint.php';
require_once 'modules/ACLActions/ACLAction.php';
function must(bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
}
function rows(string $query): array {
    $db = DBManagerFactory::getInstance();
    $result = $db->query($query, true);
    $rows = [];
    while ($row = $db->fetchByAssoc($result, false)) $rows[] = $row;
    return $rows;
}
function saveFixture(string $module, array $fields): string {
    $bean = BeanFactory::newBean($module);
    foreach ($fields as $field => $value) $bean->$field = $value;
    must((bool)$bean->save(false) && $bean->id !== '', 'Could not save ' . $module);
    return $bean->id;
}
must(($sugar_config['dbconfig']['db_name'] ?? '') === 'suitecrm_upgrade_fixture'
    && ($sugar_config['dbconfig']['db_host_name'] ?? '') === 'db', 'Synthetic database required');
$admins = rows("SELECT id FROM users WHERE user_name='fixture-admin' AND deleted=0 AND is_admin=1");
must(count($admins) === 1, 'Synthetic administrator required');
$admin = BeanFactory::getBean('Users', $admins[0]['id']);
$GLOBALS['current_user'] = $admin;
$_SESSION = [];
ACLAction::getUserActions($admin->id, true);
$subject = 'Synthetic upgrade: one email, two company histories';
if (($argv[1] ?? '') === 'seed') {
    $accounts = $contacts = [];
    foreach (['Customer', 'Supplier'] as $kind) {
        $account = saveFixture('Accounts', ['name'=>'Synthetic Upgrade '.$kind, 'assigned_user_id'=>$admin->id]);
        $contact = saveFixture('Contacts', ['last_name'=>'Synthetic Upgrade '.$kind.' Contact',
            'account_id'=>$account, 'assigned_user_id'=>$admin->id]);
        $accounts[] = $account;
        $contacts[] = $contact;
    }
    $id = saveFixture('Emails', ['name'=>$subject, 'type'=>'archived', 'status'=>'read',
        'parent_type'=>'Accounts', 'parent_id'=>$accounts[0], 'assigned_user_id'=>$admin->id,
        'date_sent_received'=>'2026-11-09 13:00:00', 'description'=>'Synthetic version rehearsal.']);
    $email = BeanFactory::newBean('Emails');
    must((bool)$email->retrieve($id), 'Native email must be retrievable');
    foreach (['accounts'=>$accounts, 'contacts'=>$contacts] as $link=>$ids) {
        must($email->load_relationship($link), 'Native email relationship ' . $link . ' required');
        foreach ($ids as $related) $email->$link->add($related);
    }
    file_put_contents('/tmp/rehearsal-record.json', json_encode(compact('id','accounts','contacts'), JSON_THROW_ON_ERROR));
}
$expected = json_decode(file_get_contents('/tmp/rehearsal-record.json'), true, 8, JSON_THROW_ON_ERROR);
$emailId = $expected['id'];
must((bool)preg_match('/^[a-f0-9-]{36}$/D', $emailId), 'Synthetic email ID required');
$version = trim(file_get_contents('/app/VERSION'));
must($version === ($argv[2] ?? ''), 'Wrong installed version: '.$version);
must(rows("SELECT value FROM config WHERE category='info' AND name='suitecrm_version'") === [['value'=>$version]],
    'SuiteCRM installed database version must match application source');
$emailRows = rows("SELECT id,parent_type,parent_id FROM emails WHERE name='$subject' AND deleted=0");
must($emailRows === [['id'=>$emailId,'parent_type'=>'Accounts','parent_id'=>$expected['accounts'][0]]],
    'Expected exactly one Email with its original ID and primary account');
$relationships = rows("SELECT bean_module,bean_id FROM emails_beans WHERE email_id='$emailId' AND deleted=0 ORDER BY bean_module,bean_id");
$wanted = [];
foreach (['Accounts'=>'accounts','Contacts'=>'contacts'] as $module=>$link) {
    $ids = $expected[$link]; sort($ids, SORT_STRING);
    foreach ($ids as $id) $wanted[] = ['bean_module'=>$module,'bean_id'=>$id];
}
must($relationships === $wanted, 'Expected the original two account and two contact links: '.json_encode($relationships));
$email = BeanFactory::newBean('Emails');
must((bool)$email->retrieve($emailId), 'Native email must be retrievable');
foreach (['accounts','contacts'] as $link) {
    must($email->load_relationship($link), 'Native email relationship ' . $link . ' required');
    $linked = array_values($email->$link->get());
    $wanted = $expected[$link];
    sort($linked, SORT_STRING); sort($wanted, SORT_STRING);
    must($linked === $wanted, 'Native email links changed for '.$link);
}
printf("PASS suitecrm=%s email=%s one_email two_accounts two_contacts primary_preserved\n", $version, $emailId);
foreach ($expected['accounts'] as $index => $id) printf("ACCOUNT_%d=%s\n", $index+1, $id);
`
const bootstrap = String.raw`#!/bin/sh
set -eu
cp -R /source/suitecrm/. /app/
cd /app
export APP_ENV=prod
step() {
  name=$1
  shift
  if ! php -d memory_limit=512M bin/console "$@" >"/tmp/$name.log" 2>&1; then
    tail -n 80 "/tmp/$name.log"
    return 1
  fi
  if grep -q '^.*\[ERROR\]' "/tmp/$name.log"; then
    tail -n 80 "/tmp/$name.log"
    return 1
  fi
  tail -n 9 "/tmp/$name.log"
  printf 'PASS command=%s\n' "$name"
}
step install suitecrm:app:install --no-interaction -u fixture-admin -p Synthetic-native-admin-password-only \
  -U fixture -P Synthetic-native-db-password-only -H db -Z 3306 -N suitecrm_upgrade_fixture -S "$FIXTURE_ORIGIN" -d no -W true
php -d display_errors=stderr -d error_reporting=22527 /fixture/seed.php seed 8.10.1
mkdir -p tmp/package/upgrade
cp /upgrade/SuiteCRM-8.10.2.zip tmp/package/upgrade/SuiteCRM-8.10.2.zip
step upgrade suitecrm:app:upgrade --no-interaction -t SuiteCRM-8.10.2
# Fixture files were created by www-data; restore owner read/write and
# directory traversal after SuiteCRM's own copy operations, without broad chmod.
chmod -R u+rwX /app
step finalize suitecrm:app:upgrade-finalize --no-interaction -t SuiteCRM-8.10.2
php -d display_errors=stderr -d error_reporting=22527 /fixture/seed.php check 8.10.2
if [ "$CLAWPILOT_UPGRADE_OAUTH_FIXTURE" = 1 ]; then
  php -d display_errors=stderr -d error_reporting=22527 /fixture/oauth-smoke.php
fi
printf 'PASS rehearsal_complete=1\n'
if [ "$FIXTURE_LOOPBACK_UI" = 1 ]; then
  touch /tmp/ui-ready
  exec php -d display_errors=0 -S 127.0.0.1:8099 -t /app/public /fixture/router.php
fi
if [ "$FIXTURE_COLD_BOOT" = 1 ]; then exec sleep 420; fi
`
// Mirrors public/.htaccess's front-controller fallback in the PHP CLI server.
// The local relay cannot select a destination other than this exact listener.
const router = String.raw`<?php
$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '');
$file = realpath('/app/public'.$path);
if ($file !== false && str_starts_with($file, '/app/public/') && is_file($file)) return false;
if (str_starts_with($path, '/legacy/')) { http_response_code(404); exit; }
// SuiteCRM's generated runtime checks legacy/config.php relative to docroot.
chdir('/app/public');
$_SERVER['SCRIPT_FILENAME'] = '/app/public/index.php';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
require '/app/public/index.php';
`
const relay = String.raw`<?php
$socket = stream_socket_client('tcp://127.0.0.1:8099', $errno, $error, 2);
if (!$socket) exit(1);
while (!feof($socket)) {
    $read = [$socket];
    if (!feof(STDIN)) $read[] = STDIN;
    $write = $except = null;
    if (stream_select($read, $write, $except, 20) <= 0) break;
    foreach ($read as $stream) {
        $part = fread($stream, 8192);
        if ($part === false || ($stream === $socket && $part === '')) break 2;
        if ($part === '' && $stream === STDIN) { stream_socket_shutdown($socket, STREAM_SHUT_WR); continue; }
        $output = $stream === STDIN ? $socket : STDOUT;
        while ($part !== '') {
            $count = fwrite($output, $part);
            if (!$count) break 3;
            $part = substr($part, $count);
        }
        fflush($output);
    }
}
`
writeFixture('seed.php', fixture)
writeFixture('bootstrap.sh', bootstrap)
writeFixture('router.php', router)
writeFixture('relay.php', relay)
if (oauthSmoke) {
  writeFixture('oauth-smoke.php', readFileSync(new URL('./fixtures/suitecrm-8-10-2-oauth-smoke.php', import.meta.url)))
  for (const folder of ['email-audience', 'native-email-scope']) {
    cpSync(new URL(`../services/suitecrm/${folder}`, import.meta.url), join(fixtureRoot, 'source', folder), { recursive: true })
  }
}

let admitted = false, networkId = null, appId = null, bootId = null, ready = false, stopped = false
const connections = new Set()
const server = createServer(socket => {
  if (!ready || connections.size >= 16) return socket.destroy()
  const pipe = spawn('docker', ['exec', '-i', app, 'php', '/fixture/relay.php'], { stdio: ['pipe', 'pipe', 'ignore'] })
  connections.add(socket)
  socket.setTimeout(25_000, () => socket.destroy())
  socket.on('error', () => {})
  pipe.stdin.on('error', () => {})
  pipe.on('error', () => socket.destroy())
  socket.on('close', () => { connections.delete(socket); pipe.kill() })
  socket.pipe(pipe.stdin)
  pipe.stdout.pipe(socket)
})
function cleanup() {
  if (stopped) return
  stopped = true
  ready = false
  for (const socket of connections) socket.destroy()
  if (server.listening) server.close()
  const failures = []
  const attempt = action => { try { action() } catch (error) { failures.push(error) } }
  for (const containerId of [bootId, appId].filter(Boolean)) attempt(() => {
    let metadata
    try { metadata = inspect('container', containerId) } catch (error) {
      if (/No such (?:object|container)/i.test(String(error.stderr))) return
      throw error
    }
    assert.equal(metadata.Config.Labels[ownerLabel], token)
    docker('rm', '--force', '--volumes', metadata.Id)
  })
  if (admitted) attempt(() => assert.equal(lease.cleanup(), true))
  if (networkId) attempt(() => {
    const metadata = inspect('network', networkId)
    assert.equal(metadata.Labels[ownerLabel], token)
    assert.deepEqual(Object.keys(metadata.Containers || {}), [])
    docker('network', 'rm', networkId)
  })
  attempt(() => {
    assert.equal(readFileSync(join(root, 'owner'), 'utf8'), token)
    assert.match(root, /\/clawpilot-suitecrm-upgrade-rehearsal\.[A-Za-z0-9]+$/)
    if (coldBoot && process.platform === 'linux' && existsSync(coldVolume)) {
      assert.equal(realpathSync(coldVolume), coldVolume)
      // On native Linux the exact startup sets UID 33 on the bind mount.
      // Restore ownership only on the isolated fixture after all writers exit.
      docker('run', '--rm', '--pull=never', '--network', 'none', '--memory', '128m', '--memory-swap', '128m',
        '--pids-limit', '32', '--cpus', '0.5', '--mount', `type=bind,source=${coldVolume},target=/cold-fixture`,
        '--entrypoint', '/bin/chown', candidateImage.Id, '-R', `${process.getuid()}:${process.getgid()}`, '/cold-fixture')
    }
    rmSync(root, { recursive: true })
  })
  if (failures.length) throw new AggregateError(failures, 'Disposable rehearsal cleanup incomplete')
  console.log('PASS owned fixture containers, network, lease, and temporary files cleaned up')
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  try { cleanup() } finally { process.exit(signal === 'SIGINT' ? 130 : 143) }
})
const limits = (memory, cpus) => ['--read-only', '--memory', memory, '--memory-swap', memory, '--cpus', cpus,
  '--pids-limit', '128', '--log-driver', 'json-file', '--log-opt', 'max-size=2m', '--log-opt', 'max-file=1',
  '--label', `${ownerLabel}=${token}`, '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL']
const expectPrivate = metadata => {
  assert.deepEqual(Object.keys(metadata.HostConfig.PortBindings || {}), [])
  assert.deepEqual(Object.keys(metadata.NetworkSettings.Networks), [network])
  assert.ok(metadata.Mounts.every(mount => mount.Type !== 'volume'))
}
async function testPackagedBoot() {
  checkHostDisk(root)
  const volume = coldVolume, installedApp = join(volume, 'app')
  mkdirSync(installedApp, { recursive: true })
  // Docker's copy API does not reliably traverse the synthetic tmpfs. Stream
  // the archive from inside the running container, without buffering it.
  const archiveSignal = AbortSignal.timeout(120_000)
  const pack = spawn('docker', ['exec', appId, 'tar', '-C', '/app', '-cf', '-', '.'],
    { signal: archiveSignal, stdio: ['ignore', 'pipe', 'inherit'] })
  const unpack = spawn('tar', ['--no-same-owner', '-xf', '-', '-C', installedApp],
    { signal: archiveSignal, stdio: ['pipe', 'ignore', 'inherit'] })
  const exits = await Promise.all([once(pack, 'exit'), once(unpack, 'exit'), pipeline(pack.stdout, unpack.stdin)])
  assert.deepEqual(exits[0], [0, null], 'Synthetic volume archive must finish')
  assert.deepEqual(exits[1], [0, null], 'Synthetic volume restore must finish')
  assert.equal(readFileSync(join(installedApp, 'VERSION'), 'utf8'), '8.10.2\n')
  docker('stop', '--time', '2', appId)
  checkHostDisk(root)
  writeFileSync(join(volume, '.installed-8.10.2'), '', { flag: 'wx' })
  const syntheticEnv = {
    SUITECRM_DB_HOST: 'db', SUITECRM_DB_PORT: '3306', SUITECRM_DB_NAME: 'suitecrm_upgrade_fixture',
    SUITECRM_DB_USER: 'fixture', SUITECRM_DB_PASSWORD: 'Synthetic-native-db-password-only',
    SUITECRM_PUBLIC_URL: 'https://suitecrm-upgrade.invalid', SUITECRM_ADMIN_USER: 'fixture-admin',
    SUITECRM_ADMIN_PASSWORD: 'Synthetic-native-admin-password-only',
    SUITECRM_CLIENT_ID: 'd4358189-2122-4843-8117-7bf63278b64f', SUITECRM_CLIENT_SECRET: 'Synthetic-cold-boot-oauth-secret-only',
    CLAWPILOT_SHARED_BPO_EMAIL_ENABLED: '1', CLAWPILOT_SHARED_BPO_EMAIL_TEMPLATES: '0',
    CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED: '1', PORT: '8080',
  }
  const startBoot = mode => {
    bootId = docker('create', '--pull=never', '--name', stem + '-' + mode, '--network', network,
      ...limits('2g', '1.75').filter(arg => arg !== '--read-only'),
      ...['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'KILL', 'SYS_CHROOT'].flatMap(cap => ['--cap-add', cap]),
      '--mount', `type=bind,source=${volume},target=/var/lib/suitecrm`,
      ...Object.entries(syntheticEnv).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      '--env', `CLAWPILOT_NATIVE_INITIAL_MAINTENANCE=${mode === 'maintenance' ? '1' : '0'}`,
      '--entrypoint', '/bin/bash', candidateImage.Id, '-ec',
      'chown -R www-data:www-data /var/lib/suitecrm/app; exec /usr/local/bin/entrypoint.sh').trim()
    expectPrivate(inspect('container', bootId))
    docker('start', bootId)
  }
  const http = (port, path, ...args) => docker('exec', bootId, 'curl', '--noproxy', '*', '--max-time', '5', '-sS',
    '-H', 'Host: suitecrm.railway.internal', ...args, `http://127.0.0.1:${port}${path}`)
  const status = (port, path, ...args) => http(port, path, '-o', '/dev/null', '-w', '%{http_code}', ...args)
  const waitMode = async (port, mode) => {
    const limit = Date.now() + 220_000
    for (;;) {
      checkHostDisk(root)
      if (!inspect('container', bootId).State.Running || Date.now() > limit) {
        throw new Error(`Candidate ${mode} did not become ready:\n${docker('logs', '--tail', '45', bootId)}`)
      }
      try { if (JSON.parse(http(port, '/_clawpilot/liveness')).mode === mode) return } catch { /* still starting */ }
      await delay(3000)
    }
  }
  const verifyApache = port => {
    assert.equal(status(port, '/'), '200', 'Packaged Apache must serve the installed SuiteCRM login')
    docker('exec', bootId, 'sh', '-ec', 'test "$(cat /var/lib/suitecrm/app/VERSION)" = 8.10.2; grep -q "ClawPilot shared Email worker route" /var/lib/suitecrm/app/public/legacy/custom/application/Ext/Api/V8/Config/routes.php')
    assert.equal(status(port, '/Api/V8/custom/clawpilot-email-shared', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', '{}'),
      '401', 'Installed Email route must reject anonymous writes')
  }
  if (mode === '--cold-boot') {
    startBoot('maintenance')
    await waitMode(8080, 'maintenance')
    const canary = spawn('docker', ['exec', bootId, '/usr/local/bin/entrypoint.sh', '--upgrade-canary'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let canaryOutput = '', canaryExit = false
    canary.on('exit', () => { canaryExit = true })
    for (const stream of [canary.stdout, canary.stderr]) stream.on('data', chunk => { canaryOutput = (canaryOutput + chunk.toString()).slice(-6000) })
    const canaryDeadline = Date.now() + 220_000
    for (;;) {
      checkHostDisk(root)
      if (canaryExit || Date.now() > canaryDeadline) throw new Error(`Packaged loopback canary did not become ready:\n${canaryOutput}`)
      try { if (JSON.parse(http(18080, '/_clawpilot/liveness')).mode === 'normal') break } catch { /* still starting */ }
      await delay(3000)
    }
    assert.equal(status(8080, '/'), '503', 'The main service port must stay fenced during the canary')
    const ip = inspect('container', bootId).NetworkSettings.Networks[network].IPAddress
    assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/)
    assert.throws(() => docker('exec', bootId, 'curl', '--noproxy', '*', '--max-time', '2', '-fsS', `http://${ip}:18080/_clawpilot/liveness`),
      error => error.status === 7 || error.status === 28, 'Canary listener must not accept private-network ingress')
    verifyApache(18080)
    console.log('PASS packaged canary served login on loopback only; public port stayed fenced; anonymous Email write rejected')
    assert.equal(inspect('container', bootId).Config.Labels[ownerLabel], token)
    docker('rm', '--force', '--volumes', bootId)
    bootId = null
  }
  startBoot('normal')
  await waitMode(8080, 'normal')
  verifyApache(8080)
  console.log('PASS packaged amd64 cold boot reopened the upgraded volume with managed Apache routes')
}
try {
  let origin = 'http://suitecrm-upgrade.invalid'
  if (uiOption) {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    origin = `http://127.0.0.1:${server.address().port}`
  }
  const leaseToken = lease.admit(db)
  admitted = true
  execute('unzip', ['-q', oldArchive, '-d', join(root, 'suitecrm')], { timeout: 90_000 })
  networkId = docker('network', 'create', '--internal', '--label', `${ownerLabel}=${token}`, network).trim()
  assert.equal(inspect('network', networkId).Internal, true)
  docker('run', '--rm', '--detach', '--pull=never', '--name', db, '--network', network, '--network-alias', 'db',
    ...limits('640m', '0.75'), '--label', `${DISPOSABLE_POSTGRES_LABEL}=true`, '--label', `${DISPOSABLE_POSTGRES_OWNER_LABEL}=${leaseToken}`,
    '--tmpfs', '/var/lib/mysql:rw,nosuid,size=320m', '--tmpfs', '/run/mysqld:rw,nosuid,size=8m', '--tmpfs', '/tmp:rw,nosuid,size=32m',
    '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--cap-add', 'SETGID', '--cap-add', 'SETUID',
    '--env', 'MARIADB_ROOT_PASSWORD=Synthetic-native-root-password-only', '--env', 'MARIADB_DATABASE=suitecrm_upgrade_fixture',
    '--env', 'MARIADB_USER=fixture', '--env', 'MARIADB_PASSWORD=Synthetic-native-db-password-only', dbImage.Id,
    '--skip-log-bin', '--innodb-buffer-pool-size=64M', '--max-connections=20', '--performance-schema=OFF')
  expectPrivate(inspect('container', db))
  const deadline = Date.now() + 45_000
  for (;;) {
    try {
      const version = docker('exec', '--env', 'MYSQL_PWD=Synthetic-native-db-password-only', db, 'mariadb',
        '--host=127.0.0.1', '--user=fixture', '--database=suitecrm_upgrade_fixture', '--batch', '--skip-column-names', '--execute=SELECT VERSION()')
      assert.match(version, /^11\.4\.13-MariaDB/)
      break
    } catch (error) { if (Date.now() > deadline) throw error; await delay(400) }
  }
  appId = docker('create', '--pull=never', '--name', app, '--network', network, ...limits('2g', '1.75'),
    '--user', '33:33', '--tmpfs', '/app:rw,nosuid,size=1400m,uid=33,gid=33,mode=0700',
    '--tmpfs', '/tmp:rw,nosuid,size=48m,uid=33,gid=33,mode=0700',
    '--mount', `type=bind,source=${join(root, 'suitecrm')},target=/source/suitecrm,readonly`,
    '--mount', `type=bind,source=${fixtureRoot},target=/fixture,readonly`,
    '--mount', `type=bind,source=${newArchive},target=/upgrade/SuiteCRM-8.10.2.zip,readonly`,
    '--env', `FIXTURE_ORIGIN=${origin}`, '--env', `FIXTURE_LOOPBACK_UI=${uiOption ? '1' : '0'}`,
    '--env', `CLAWPILOT_UPGRADE_OAUTH_FIXTURE=${oauthSmoke ? '1' : '0'}`,
    '--env', `FIXTURE_COLD_BOOT=${coldBoot ? '1' : '0'}`,
    '--entrypoint', '/bin/sh', appImage.Id, '/fixture/bootstrap.sh').trim()
  docker('start', appId)
  expectPrivate(inspect('container', appId))
  console.log('PASS both containers admitted on private network; bounded tmpfs; MariaDB 11.4.13')
  const appDeadline = Date.now() + 420_000
  for (;;) {
    checkHostDisk(root)
    const metadata = inspect('container', appId)
    const logs = await promisify(execFile)('docker', ['logs', appId], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
    const output = logs.stdout + logs.stderr
    if (/^PASS rehearsal_complete=1$/m.test(output)) {
      console.log(output.split('\n').filter(line => /^(PASS |ACCOUNT_| *Successfully| *SuiteCRM version saved)/.test(line)).join('\n'))
      break
    }
    if (!metadata.State.Running || Date.now() > appDeadline) throw new Error(`Rehearsal did not finish (status=${metadata.State.Status}, code=${metadata.State.ExitCode}):\n${output.slice(-10_000)}`)
    await delay(3_000)
  }
  if (coldBoot) await testPackagedBoot()
  if (uiOption) {
    await delay(1_500)
    ready = true
    let location = new URL(origin), status
    for (let redirect = 0; redirect <= 3; redirect++) {
      const response = await fetch(location, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      status = response.status
      await response.body?.cancel()
      if (status === 200) break
      const target = response.headers.get('location')
      assert.ok([301, 302, 303, 307, 308].includes(status) && target, 'Synthetic login must respond or redirect')
      location = new URL(target, location)
      assert.equal(location.origin, origin, 'Synthetic login redirect must stay on loopback')
      assert.notEqual(location.pathname, '/install.php', 'Installed fixture must not reopen the installer')
    }
    assert.equal(status, 200, 'Synthetic loopback browser fixture must serve its login shell')
    console.log(`UI_READY=${origin} PID=${process.pid} (synthetic only, available for up to 420 seconds)`)
    const browserDeadline = Date.now() + 420_000
    while (Date.now() < browserDeadline) {
      checkHostDisk(root)
      await delay(3_000)
    }
  }
} finally { cleanup() }
