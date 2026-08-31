import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const serviceDirectory = resolve(testDirectory, "..");
const entrypointPath = join(serviceDirectory, "docker-entrypoint.sh");
const childFixturePath = join(serviceDirectory, "fixtures", "entrypoint-child.mjs");
const serverFixturePath = join(serviceDirectory, "fixtures", "entrypoint-server.mjs");

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(message);
}

async function readEvents(path) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function eventPid(events, prefix) {
  const event = events.find((line) => line.startsWith(prefix));
  assert.ok(event, `missing event ${prefix}`);
  return Number(event.split(":").at(-1));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function createHarness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "career-linkedin-entrypoint-"));
  const binDirectory = join(root, "bin");
  const socketDirectory = join(root, "x11");
  const lockDirectory = join(root, "locks");
  const sourceDirectory = join(root, "src");
  const eventLog = join(root, "events.log");
  const socketRegistry = join(root, "unix-registry");
  await Promise.all([
    mkdir(binDirectory),
    mkdir(socketDirectory),
    mkdir(lockDirectory),
    mkdir(sourceDirectory),
  ]);
  await writeFile(socketRegistry, "Num RefCount Protocol Flags Type St Inode Path\n");
  await copyFile(serverFixturePath, join(sourceDirectory, "server.mjs"));

  for (const [command, role] of [["Xvfb", "xvfb"], ["x11vnc", "x11vnc"]]) {
    const commandPath = join(binDirectory, command);
    await writeFile(
      commandPath,
      `#!/bin/sh\nexec "${process.execPath}" "${childFixturePath}" "${role}" "$@"\n`,
    );
    await chmod(commandPath, 0o755);
  }

  const displayIndex = options.displayIndex || "99";
  if (options.beforeSpawn) {
    await options.beforeSpawn({ displayIndex, lockDirectory, socketDirectory, socketRegistry });
  }
  const child = spawn("bash", [entrypointPath], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
      DISPLAY: `:${displayIndex}`,
      X11_SOCKET_DIR: socketDirectory,
      X11_LOCK_DIR: lockDirectory,
      X11_SOCKET_REGISTRY: socketRegistry,
      ENTRYPOINT_TEST_LOG: eventLog,
      ENTRYPOINT_TERMINATION_DELAY_MS: String(options.terminationDelayMs || 0),
      FAKE_XVFB_EXIT_AFTER_MS: String(options.xvfbExitAfterMs || 0),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "close");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

  return {
    child,
    displayIndex,
    eventLog,
    exited,
    lockDirectory,
    root,
    socketDirectory,
    socketRegistry,
    output: () => ({ stdout, stderr }),
  };
}

async function removeHarness(harness) {
  if (harness.child.exitCode === null && harness.child.signalCode === null) {
    harness.child.kill("SIGTERM");
    await harness.exited;
  }
  await rm(harness.root, { recursive: true, force: true });
}

async function leaveStaleSocket(socketPath) {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { createServer } from "node:net";
     const server = createServer();
     server.listen(process.argv[1], () => process.stdout.write("ready\\n"));
     setInterval(() => {}, 1000);`,
    socketPath,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.setEncoding("utf8");
  await once(child.stdout, "data");
  const exited = once(child, "close");
  child.kill("SIGKILL");
  await exited;
  assert.equal((await lstat(socketPath)).isSocket(), true);
}

test("removes proven-stale display artifacts and keeps the replacement Xvfb alive", async (t) => {
  const restarted = await createHarness({
    terminationDelayMs: 50,
    beforeSpawn: async ({ displayIndex, lockDirectory, socketDirectory }) => {
      await leaveStaleSocket(join(socketDirectory, `X${displayIndex}`));
      await writeFile(join(lockDirectory, `.X${displayIndex}-lock`), "99999999\n");
    },
  });
  t.after(() => removeHarness(restarted));
  await waitFor(async () => {
    const events = await readEvents(restarted.eventLog);
    return events.some((line) => line.startsWith("server:start:"));
  }, "replacement stack did not start");

  const events = await readEvents(restarted.eventLog);
  const xvfbPid = eventPid(events, "xvfb:start:");
  assert.equal(processIsAlive(xvfbPid), true);
  assert.equal((await lstat(join(restarted.socketDirectory, `X${restarted.displayIndex}`))).isSocket(), true);
});

test("refuses an active display without deleting its socket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "career-linkedin-active-"));
  const socketDirectory = join(root, "x11");
  const lockDirectory = join(root, "locks");
  const binDirectory = join(root, "bin");
  const sourceDirectory = join(root, "src");
  const registry = join(root, "unix-registry");
  const socketPath = join(socketDirectory, "X99");
  await Promise.all([
    mkdir(socketDirectory), mkdir(lockDirectory), mkdir(binDirectory), mkdir(sourceDirectory),
  ]);
  const activeSocket = createServer();
  await new Promise((resolvePromise, reject) => {
    activeSocket.once("error", reject);
    activeSocket.listen(socketPath, resolvePromise);
  });
  t.after(async () => {
    await new Promise((resolvePromise) => activeSocket.close(resolvePromise));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    registry,
    `Num RefCount Protocol Flags Type St Inode Path\n000: 2 0 00010000 0001 01 1 ${socketPath}\n`,
  );

  const child = spawn("bash", [entrypointPath], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
      DISPLAY: ":99",
      X11_SOCKET_DIR: socketDirectory,
      X11_LOCK_DIR: lockDirectory,
      X11_SOCKET_REGISTRY: registry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 1);
  assert.match(stderr, /Refusing active X11 socket/);
  assert.equal((await lstat(socketPath)).isSocket(), true);
});

test("waits for and reaps every child during shutdown", async (t) => {
  const harness = await createHarness({ terminationDelayMs: 200 });
  t.after(() => removeHarness(harness));
  await waitFor(async () => (await readEvents(harness.eventLog)).filter((line) => line.includes(":start:")).length === 3,
    "worker stack did not start");
  const before = await readEvents(harness.eventLog);
  const childPids = [
    eventPid(before, "xvfb:start:"),
    eventPid(before, "x11vnc:start:"),
    eventPid(before, "server:start:"),
  ];

  const startedAt = Date.now();
  harness.child.kill("SIGTERM");
  const [code, signal] = await harness.exited;
  const elapsedMs = Date.now() - startedAt;
  assert.equal(signal, null);
  assert.equal(code, 143);
  assert.ok(elapsedMs >= 175, `entrypoint exited before children: ${elapsedMs}ms`);

  const after = await readEvents(harness.eventLog);
  for (const role of ["xvfb", "x11vnc", "server"]) {
    assert.ok(after.some((line) => line.startsWith(`${role}:exit:`)), `${role} was not reaped`);
  }
  assert.ok(
    after.findIndex((line) => line.startsWith("server:exit:"))
      < after.findIndex((line) => line.startsWith("xvfb:term:")),
    "Xvfb stopped before the Node server finished closing Chromium",
  );
  for (const pid of childPids) assert.equal(processIsAlive(pid), false);
});

test("fails the container and cleans up when Xvfb exits unexpectedly", async (t) => {
  const harness = await createHarness({ xvfbExitAfterMs: 400, terminationDelayMs: 25 });
  t.after(() => removeHarness(harness));
  await waitFor(async () => (await readEvents(harness.eventLog)).some((line) => line.startsWith("server:start:")),
    "worker stack did not start");
  const [code] = await harness.exited;
  assert.equal(code, 1);
  assert.match(harness.output().stderr, /Xvfb exited unexpectedly/);
  const events = await readEvents(harness.eventLog);
  assert.ok(events.some((line) => line.startsWith("x11vnc:exit:")));
  assert.ok(events.some((line) => line.startsWith("server:exit:")));
});
