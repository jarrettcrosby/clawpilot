import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { LiveTokenStore } from "../src/live-token-store.mjs";
import { LiveSurface } from "../src/live-surface.mjs";
import {
  KEY_SYMS,
  codePointToKeysym,
  sendControlKeyToRfb,
  sendTextToRfb,
} from "../src/mobile-input.mjs";

const cookieSecret = "cookie-secret-fixture-0123456789abcdef-EXACT";

async function callLive(surface, { method, path, body, cookie }) {
  const request = body === undefined
    ? { method, headers: cookie ? { cookie } : {} }
    : Object.assign(
        Readable.from([Buffer.from(JSON.stringify(body), "utf8")]),
        { method, headers: cookie ? { cookie } : {} },
      );
  const captured = {};
  const handled = await surface.handleHttp(request, {
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(responseBody) {
      captured.body = responseBody;
    },
  }, new URL(`https://worker.example.com${path}`));
  assert.equal(handled, true);
  return captured;
}

test("redeems only a digest-matched preimage and issues a PII-free stateless cookie", () => {
  const now = 1_787_980_800_000;
  const token = "A".repeat(43);
  const authTokenDigest = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(now + 60_000).toISOString();
  const store = new LiveTokenStore({ hmacSecret: cookieSecret, now: () => now });
  store.activate({
    sessionId: "session-1",
    attemptId: "attempt-1",
    authTokenDigest,
    expiresAt,
    returnUrl:
      "https://jarrett.suburbiasandwichco.com/career/linkedin/return?attemptId=attempt-1&destination=settings",
  });
  assert.equal(store.matchToken("B".repeat(43)), null);
  assert.equal(store.matchToken(token).attemptId, "attempt-1");
  const issued = store.issueCookieAfterAcceptedRedemption("attempt-1");
  assert.equal(store.matchToken(token).responseReplay, true);
  assert.equal(store.isRedeemed("attempt-1"), true);
  assert.equal(store.authorizeCookieForVnc(issued.cookie).attemptId, "attempt-1");
  assert.equal(store.authorizeCookieForOutcome(issued.cookie).attemptId, "attempt-1");
  const claims = JSON.parse(Buffer.from(issued.cookie.split(".")[0], "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(claims).sort(), ["attemptId", "aud", "exp", "nonce", "v"]);

  const revoked = [];
  store.onVncRevoked((attemptId) => revoked.push(attemptId));
  store.setOutcome("attempt-1", { status: "succeeded" });
  assert.equal(store.matchToken(token), null);
  assert.equal(store.authorizeCookieForVnc(issued.cookie), null);
  assert.equal(store.authorizeCookieForOutcome(issued.cookie).attemptId, "attempt-1");
  store.disableAllVnc();
  assert.equal(store.authorizeCookieForVnc(issued.cookie), null);
  assert.deepEqual(revoked, ["attempt-1"]);
  assert.deepEqual(store.outcomeForCookie(issued.cookie), {
    status: "succeeded",
    returnUrl:
      "https://jarrett.suburbiasandwichco.com/career/linkedin/return?attemptId=attempt-1&destination=settings",
  });

  const restarted = new LiveTokenStore({ hmacSecret: cookieSecret, now: () => now });
  restarted.activate({
    sessionId: "session-2",
    attemptId: "attempt-1",
    authTokenDigest,
    authTokenRedeemedAt: new Date(now).toISOString(),
    expiresAt,
  });
  assert.equal(restarted.matchToken(token), null);
  assert.equal(restarted.authorizeCookieForVnc(issued.cookie).sessionId, "session-2");
});

test("a lost redemption response narrowly replays the same cookie and then closes", async () => {
  let now = Date.now();
  const token = "R".repeat(43);
  const attemptId = "attempt-response-replay";
  const store = new LiveTokenStore({
    hmacSecret: cookieSecret,
    now: () => now,
    redemptionReplayMs: 2_000,
  });
  store.activate({
    sessionId: "session-response-replay",
    attemptId,
    authTokenDigest: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  let controlRedemptions = 0;
  const surface = new LiveSurface({
    tokenStore: store,
    vncHost: "127.0.0.1",
    vncPort: 5900,
    publicBaseUrl: "https://worker.example.com",
    redeemWithControlPlane: async () => {
      controlRedemptions += 1;
      return { kind: "accepted" };
    },
  });
  const redeem = async () => {
    const request = Readable.from([Buffer.from(JSON.stringify({ token }), "utf8")]);
    request.method = "POST";
    const captured = {};
    const handled = await surface.handleHttp(request, {
      writeHead(status, headers) {
        captured.status = status;
        captured.headers = headers;
      },
      end(body) {
        captured.body = body;
      },
    }, new URL("https://worker.example.com/v1/live/redeem"));
    assert.equal(handled, true);
    return captured;
  };

  const lostResponse = await redeem();
  const replayedResponse = await redeem();
  assert.equal(lostResponse.status, 200);
  assert.equal(replayedResponse.status, 200);
  assert.equal(
    replayedResponse.headers["set-cookie"],
    lostResponse.headers["set-cookie"],
  );
  assert.equal(controlRedemptions, 1);

  store.setOutcome(attemptId, { status: "succeeded" });
  assert.equal((await redeem()).status, 409);

  store.activate({
    sessionId: "session-response-window",
    attemptId: "attempt-response-window",
    authTokenDigest: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  assert.ok(store.issueCookieAfterAcceptedRedemption("attempt-response-window"));
  now += 2_001;
  assert.equal(store.matchToken(token), null);

  store.activate({
    sessionId: "session-response-expiry",
    attemptId: "attempt-response-expiry",
    authTokenDigest: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(now + 1_000).toISOString(),
  });
  assert.ok(store.issueCookieAfterAcceptedRedemption("attempt-response-expiry"));
  now += 1_001;
  assert.equal(store.matchToken(token), null);
  surface.close();
});

test("a recovered redeemed claim requires current-fence adoption before issuing a cookie", async () => {
  const now = Date.now();
  const token = "Q".repeat(43);
  const attemptId = "attempt-adopt-raw-token";
  const store = new LiveTokenStore({ hmacSecret: cookieSecret, now: () => now });
  store.activate({
    sessionId: "session-adopt-raw-token",
    attemptId,
    authTokenDigest: createHash("sha256").update(token).digest("hex"),
    authTokenRedeemedAt: new Date(now - 1_000).toISOString(),
    authTokenAdoptionRequired: true,
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  assert.equal(store.isRedeemed(attemptId), false);
  assert.equal(store.matchToken("Z".repeat(43)), null);

  const controlResults = [{ kind: "retryable" }, { kind: "accepted" }];
  let controlCalls = 0;
  const surface = new LiveSurface({
    tokenStore: store,
    vncHost: "127.0.0.1",
    vncPort: 5900,
    publicBaseUrl: "https://worker.example.com",
    redeemWithControlPlane: async () => controlResults[controlCalls++],
  });
  const temporarilyUnavailable = await callLive(surface, {
    method: "POST",
    path: "/v1/live/redeem",
    body: { token },
  });
  assert.equal(temporarilyUnavailable.status, 503);
  assert.equal(store.isRedeemed(attemptId), false);
  assert.equal(store.matchToken(token).attemptId, attemptId);

  const adopted = await callLive(surface, {
    method: "POST",
    path: "/v1/live/redeem",
    body: { token },
  });
  assert.equal(adopted.status, 200);
  assert.match(adopted.headers["set-cookie"], /^__Host-clp_linkedin_live=/);
  assert.equal(controlCalls, 2);
  assert.equal(store.isRedeemed(attemptId), true);
  surface.close();
});

test("an existing signed cookie proves issuance but still adopts the current fence", async () => {
  const now = Date.now();
  const token = "E".repeat(43);
  const attemptId = "attempt-adopt-existing-cookie";
  const expiresAt = new Date(now + 60_000).toISOString();
  const digest = createHash("sha256").update(token).digest("hex");
  const preCrashStore = new LiveTokenStore({ hmacSecret: cookieSecret, now: () => now });
  preCrashStore.activate({
    sessionId: "session-before-crash",
    attemptId,
    authTokenDigest: digest,
    expiresAt,
  });
  const existingCookie = preCrashStore.issueCookieAfterAcceptedRedemption(attemptId).cookie;

  const recoveredStore = new LiveTokenStore({ hmacSecret: cookieSecret, now: () => now });
  recoveredStore.activate({
    sessionId: "session-after-crash",
    attemptId,
    authTokenDigest: digest,
    authTokenRedeemedAt: new Date(now - 1_000).toISOString(),
    authTokenAdoptionRequired: true,
    expiresAt,
  });
  assert.equal(recoveredStore.isRedeemed(attemptId), false);
  assert.equal(recoveredStore.authorizeCookieForVnc(existingCookie), null);
  assert.equal(recoveredStore.inspectCookie(existingCookie).adoptionRequired, true);

  let controlAdoptions = 0;
  const surface = new LiveSurface({
    tokenStore: recoveredStore,
    vncHost: "127.0.0.1",
    vncPort: 5900,
    publicBaseUrl: "https://worker.example.com",
    redeemWithControlPlane: async () => {
      controlAdoptions += 1;
      return { kind: "accepted" };
    },
  });
  const outcome = await callLive(surface, {
    method: "GET",
    path: "/v1/live/outcome",
    cookie: `__Host-clp_linkedin_live=${existingCookie}`,
  });
  assert.equal(outcome.status, 200);
  assert.equal(JSON.parse(outcome.body).status, "pending");
  assert.equal(controlAdoptions, 1);
  assert.equal(recoveredStore.isRedeemed(attemptId), true);
  assert.equal(
    recoveredStore.authorizeCookieForVnc(existingCookie).sessionId,
    "session-after-crash",
  );
  assert.equal(recoveredStore.matchToken(token), null);
  surface.close();
});

test("terminal auth closes the one global viewer before a later command can reuse the display", async () => {
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1;
      this.closedWith = null;
    }
    close(code, reason) {
      this.closedWith = { code, reason };
      this.readyState = 3;
      this.emit("close");
    }
    send() {}
  }
  class FakeVnc extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.writes = 0;
    }
    write() { this.writes += 1; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("close");
    }
  }

  const now = 1_787_980_800_000;
  const token = "C".repeat(43);
  const store = new LiveTokenStore({ hmacSecret: cookieSecret, now: () => now });
  store.activate({
    sessionId: "session-1",
    attemptId: "attempt-1",
    authTokenDigest: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const issued = store.issueCookieAfterAcceptedRedemption("attempt-1");
  const vncSockets = [];
  const surface = new LiveSurface({
    tokenStore: store,
    vncHost: "127.0.0.1",
    vncPort: 5900,
    publicBaseUrl: "https://worker.example.com",
    redeemWithControlPlane: async () => ({ kind: "accepted" }),
    connectVnc: () => {
      const socket = new FakeVnc();
      vncSockets.push(socket);
      return socket;
    },
  });
  const first = new FakeSocket();
  const second = new FakeSocket();
  surface.bridgeVnc(first, { attemptId: "attempt-1" });
  surface.bridgeVnc(second, { attemptId: "attempt-2" });
  assert.equal(first.closedWith.reason, "replaced");
  assert.equal(vncSockets[0].destroyed, true);

  const terminalViewer = new FakeSocket();
  surface.bridgeVnc(terminalViewer, store.authorizeCookieForVnc(issued.cookie));
  terminalViewer.emit("message", Buffer.from("before-close"));
  assert.equal(vncSockets.at(-1).writes, 1);
  store.setOutcome("attempt-1", { status: "succeeded" });
  assert.equal(terminalViewer.closedWith.reason, "authentication_complete");
  terminalViewer.emit("message", Buffer.from("after-close"));
  assert.equal(vncSockets.at(-1).writes, 1);
  assert.equal(vncSockets.at(-1).destroyed, true);
  assert.equal(store.authorizeCookieForVnc(issued.cookie), null);
  assert.equal(store.outcomeForCookie(issued.cookie).status, "succeeded");
  const rejectedUpgrade = new FakeSocket();
  rejectedUpgrade.written = "";
  rejectedUpgrade.destroyed = false;
  rejectedUpgrade.write = (value) => {
    rejectedUpgrade.written += value;
  };
  rejectedUpgrade.destroy = () => {
    rejectedUpgrade.destroyed = true;
  };
  await surface.handleUpgrade({
    url: "/live/ws",
    headers: {
      origin: "https://worker.example.com",
      cookie: `__Host-clp_linkedin_live=${issued.cookie}`,
    },
  }, rejectedUpgrade, Buffer.alloc(0));
  assert.match(rejectedUpgrade.written, /401 Unauthorized/);
  assert.equal(rejectedUpgrade.destroyed, true);
  store.disableAllVnc();
  assert.equal(store.authorizeCookieForVnc(issued.cookie), null);

  let assetStatus;
  let assetHeaders;
  let assetBody;
  assert.equal(await surface.handleHttp(
    { method: "GET" },
    {
      writeHead(status, headers) {
        assetStatus = status;
        assetHeaders = headers;
      },
      end(body) {
        assetBody = body;
      },
    },
    new URL("https://worker.example.com/live-assets/core/rfb.js"),
  ), true);
  assert.equal(assetStatus, 200);
  assert.match(assetHeaders["content-type"], /javascript/);
  assert.match(assetBody.toString("utf8"), /class RFB/);
  surface.close();
});

test("mobile keyboard translation sends text and control keys through the RFB API", () => {
  const calls = [];
  const rfb = { sendKey: (...args) => calls.push(args) };
  sendTextToRfb(rfb, "A☕");
  sendControlKeyToRfb(rfb, KEY_SYMS.enter);
  assert.equal(codePointToKeysym("A".codePointAt(0)), 65);
  assert.equal(codePointToKeysym("☕".codePointAt(0)), 0x01002615);
  assert.deepEqual(calls, [
    [65, null, true],
    [65, null, false],
    [0x01002615, null, true],
    [0x01002615, null, false],
    [KEY_SYMS.enter, null, true],
    [KEY_SYMS.enter, null, false],
  ]);
});

test("live surface source keeps the token in a fragment, hardens the page, and never exposes raw VNC", async () => {
  const source = await readFile(new URL("../src/live-surface.mjs", import.meta.url), "utf8");
  assert.match(source, /location\.hash/);
  assert.match(source, /history\.replaceState/);
  assert.match(source, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(source, /redeemLiveToken/);
  assert.ok(source.indexOf("history.replaceState") < source.indexOf("await redeemLiveToken"));
  assert.match(source, /requestOrigin !== this\.publicOrigin/);
  assert.match(source, /referrer-policy/);
  assert.match(source, /x-frame-options/);
  assert.match(source, /permissions-policy/);
  assert.match(source, /Keyboard/);
  assert.match(source, /id="reconnect" type="button" disabled/);
  assert.ok(
    source.indexOf("if (!redemption.ok) throw") <
      source.indexOf("reconnectButton.disabled = false"),
  );
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage).*token|token.*(?:localStorage|sessionStorage)/);
  assert.doesNotMatch(source, /\/live\/\$\{token\}/);
  const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(serverSource, /createConnection\(\{ host: config\.vncHost, port: config\.vncPort \}\)/);
  assert.match(serverSource, /ready \? 200 : 503/);
});
