import assert from "node:assert/strict";
import test from "node:test";
import { probeChromiumReadiness } from "../src/runtime-health.mjs";

test("runtime readiness requires a bounded Chromium launch and real page", async () => {
  let launchOptions;
  let closed = false;
  const ready = await probeChromiumReadiness({
    executablePath: "/usr/bin/chromium",
    display: ":99",
    timeoutMs: 1_000,
    launch: async (options) => {
      launchOptions = options;
      return {
        async newContext() {
          return {
            async newPage() {
              return {
                async setContent() {},
                async title() { return "runtime-ready"; },
              };
            },
          };
        },
        async close() { closed = true; },
      };
    },
  });
  assert.equal(ready, true);
  assert.equal(launchOptions.headless, false);
  assert.equal(launchOptions.env.DISPLAY, ":99");
  assert.equal(launchOptions.timeout, 1_000);
  assert.equal(closed, true);
});

test("runtime readiness fails closed when Chromium cannot launch", async () => {
  assert.equal(await probeChromiumReadiness({
    executablePath: "/missing/chromium",
    display: ":99",
    timeoutMs: 1_000,
    launch: async () => { throw new Error("missing"); },
  }), false);
});
