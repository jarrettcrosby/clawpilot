import { appendFileSync } from "node:fs";

const eventLog = process.env.ENTRYPOINT_TEST_LOG;
const terminationDelayMs = Number(process.env.ENTRYPOINT_TERMINATION_DELAY_MS || 0);

function record(event) {
  appendFileSync(eventLog, `server:${event}:${process.pid}\n`);
}

function stop() {
  record("term");
  setTimeout(() => {
    record("exit");
    process.exit(0);
  }, terminationDelayMs);
}

record("start");
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
setInterval(() => {}, 1_000);
