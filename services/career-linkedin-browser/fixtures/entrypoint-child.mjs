#!/usr/bin/env node

import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const role = process.argv[2];
const eventLog = process.env.ENTRYPOINT_TEST_LOG;
const terminationDelayMs = Number(process.env.ENTRYPOINT_TERMINATION_DELAY_MS || 0);

function record(event) {
  appendFileSync(eventLog, `${role}:${event}:${process.pid}\n`);
}

function delayedExit(code = 0) {
  record("term");
  setTimeout(() => {
    record("exit");
    process.exit(code);
  }, terminationDelayMs);
}

if (role === "x11vnc") {
  record("start");
  process.once("SIGTERM", () => delayedExit());
  process.once("SIGINT", () => delayedExit());
  setInterval(() => {}, 1_000);
} else if (role === "xvfb") {
  const display = process.argv[3];
  const match = /^:([0-9]+)/.exec(display);
  if (!match) process.exit(64);

  const socketPath = join(process.env.X11_SOCKET_DIR, `X${match[1]}`);
  const lockPath = join(process.env.X11_LOCK_DIR, `.X${match[1]}-lock`);
  const server = createServer((socket) => socket.destroy());

  server.listen(socketPath, () => {
    writeFileSync(lockPath, `${process.pid}\n`);
    record("start");
    const exitAfterMs = Number(process.env.FAKE_XVFB_EXIT_AFTER_MS || 0);
    if (exitAfterMs > 0) {
      setTimeout(() => {
        record("unexpected-exit");
        process.exit(23);
      }, exitAfterMs);
    }
  });

  const stop = () => {
    record("term");
    server.close(() => {
      rmSync(socketPath, { force: true });
      rmSync(lockPath, { force: true });
      setTimeout(() => {
        record("exit");
        process.exit(0);
      }, terminationDelayMs);
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} else {
  process.exit(64);
}
