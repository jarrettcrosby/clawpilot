import { chromium } from "playwright-core";

function timeoutAfter(milliseconds) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("chromium_probe_timeout")), milliseconds);
    timer.unref?.();
  });
}

export async function probeChromiumReadiness({
  executablePath,
  display,
  timeoutMs,
  launch = (options) => chromium.launch(options),
}) {
  const probe = (async () => {
    let browser;
    try {
      browser = await launch({
        executablePath,
        headless: false,
        timeout: timeoutMs,
        env: { ...process.env, DISPLAY: display },
        args: ["--disable-dev-shm-usage", "--no-sandbox", "--window-size=320,240"],
      });
      const context = await browser.newContext({
        viewport: { width: 320, height: 240 },
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      await page.setContent("<!doctype html><title>runtime-ready</title>", {
        waitUntil: "load",
        timeout: timeoutMs,
      });
      return (await page.title()) === "runtime-ready";
    } catch {
      return false;
    } finally {
      await browser?.close().catch(() => undefined);
    }
  })();

  return Promise.race([probe, timeoutAfter(timeoutMs)]).catch(() => false);
}
