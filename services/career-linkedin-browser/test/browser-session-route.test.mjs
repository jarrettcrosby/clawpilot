import assert from "node:assert/strict";
import test from "node:test";
import { handleBrowserRoute } from "../src/browser-session.mjs";

function browserRoute({
  url = "https://www.linkedin.com/login",
  navigation = true,
  frame = undefined,
  frameError = null,
  subframe = false,
  abortError = null,
  continueError = null,
} = {}) {
  const calls = [];
  const page = {};
  const mainFrame = {};
  const childFrame = {};
  mainFrame.page = () => page;
  childFrame.page = () => page;
  page.mainFrame = () => mainFrame;
  const resolvedFrame = frame === undefined ? (subframe ? childFrame : mainFrame) : frame;
  let frameCalls = 0;
  return {
    calls,
    get frameCalls() {
      return frameCalls;
    },
    request() {
      return {
        url: () => url,
        isNavigationRequest: () => navigation,
        frame() {
          frameCalls += 1;
          if (frameError) throw frameError;
          return resolvedFrame;
        },
      };
    },
    async abort(reason) {
      calls.push(["abort", reason]);
      if (abortError) throw abortError;
    },
    async continue() {
      calls.push(["continue"]);
      if (continueError) throw continueError;
    },
  };
}

test("allowed frame-less LinkedIn and blank navigation continue without frame access", async () => {
  const linkedInRoute = browserRoute({ frameError: new Error("frame_not_available") });
  const blankRoute = browserRoute({
    url: "about:blank",
    frameError: new Error("frame_not_available"),
  });

  await assert.doesNotReject(() => handleBrowserRoute(linkedInRoute));
  await assert.doesNotReject(() => handleBrowserRoute(blankRoute));

  assert.deepEqual(linkedInRoute.calls, [["continue"]]);
  assert.deepEqual(blankRoute.calls, [["continue"]]);
  assert.equal(linkedInRoute.frameCalls, 0);
  assert.equal(blankRoute.frameCalls, 0);
});

test("disallowed navigation without an attached frame is blocked fail-closed", async () => {
  const route = browserRoute({ url: "https://example.com/", frame: null });

  await handleBrowserRoute(route);

  assert.deepEqual(route.calls, [["abort", "blockedbyclient"]]);
});

test("disallowed main-frame navigation is blocked while a confirmed subframe continues", async () => {
  const mainFrameRoute = browserRoute({ url: "https://example.com/" });
  const subframeRoute = browserRoute({ url: "https://example.com/", subframe: true });

  await handleBrowserRoute(mainFrameRoute);
  await handleBrowserRoute(subframeRoute);

  assert.deepEqual(mainFrameRoute.calls, [["abort", "blockedbyclient"]]);
  assert.deepEqual(subframeRoute.calls, [["continue"]]);
});

test("malformed and insecure requests remain blocked", async () => {
  const malformedNavigation = browserRoute({ url: "not a URL" });
  const insecureSubresource = browserRoute({
    url: "http://www.linkedin.com/image.png",
    navigation: false,
  });

  await handleBrowserRoute(malformedNavigation);
  await handleBrowserRoute(insecureSubresource);

  assert.deepEqual(malformedNavigation.calls, [["abort", "blockedbyclient"]]);
  assert.deepEqual(insecureSubresource.calls, [["abort", "blockedbyclient"]]);
});

test("route operation failures never escape the route handler", async () => {
  const route = browserRoute({
    continueError: new Error("route_closed"),
    abortError: new Error("route_already_handled"),
  });

  await assert.doesNotReject(() => handleBrowserRoute(route));

  assert.deepEqual(route.calls, [["continue"], ["abort", "blockedbyclient"]]);
});
