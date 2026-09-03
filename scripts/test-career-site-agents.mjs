#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const root = process.cwd();
const requireFromApp = createRequire(
  new URL("../app_src/package.json", import.meta.url),
);
const ts = requireFromApp("typescript");

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function transpile(path) {
  return ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText;
}

function testNextResponse() {
  return class NextResponse {
    static next() {
      return { kind: "next", status: 200 };
    }

    static json(body, init = {}) {
      return { body, kind: "json", status: init.status || 200 };
    }

    static redirect(url) {
      return { kind: "redirect", status: 307, url: String(url) };
    }
  };
}

function loadProxy() {
  const path = "app_src/proxy.ts";
  const module = { exports: {} };
  let sessionCalls = 0;
  vm.runInNewContext(
    transpile(path),
    {
      Headers,
      URL,
      console,
      exports: module.exports,
      module,
      process,
      require(specifier) {
        if (specifier === "next/server")
          return { NextResponse: testNextResponse() };
        if (specifier === "@/lib/authAttribution") {
          return {
            AUTH_CONTEXT_HEADER: "x-clawpilot-auth-context",
            AUTH_CONTEXT_PROOF_HEADER: "x-clawpilot-auth-context-proof",
            createAuthAttributionHeaders: () => ({}),
          };
        }
        if (specifier === "@/lib/authSessions") {
          return {
            createBrowserSession: async () => {
              throw new Error("unexpected session creation");
            },
            resolveRequestSession: async () => {
              sessionCalls += 1;
              return null;
            },
            setBrowserSessionCookie: () => {},
          };
        }
        if (specifier === "@/lib/workerAuth") {
          return { resolveAgentDispatchWorker: async () => null };
        }
        if (specifier === "@/lib/demoMode") {
          return { demoMutationIsRestricted: () => false };
        }
        throw new Error(`Unexpected proxy test import: ${specifier}`);
      },
    },
    { filename: path },
  );
  return { proxy: module.exports.proxy, sessionCalls: () => sessionCalls };
}

function proxyRequest(pathname) {
  return {
    headers: {
      get: (name) =>
        String(name).toLowerCase() === "host" ? "aiapp.eigenracing.com" : null,
    },
    method: "GET",
    nextUrl: { pathname, port: "", search: "" },
    url: `https://aiapp.eigenracing.com${pathname}`,
  };
}

function loadRouteForMissingBearer() {
  const path = "app_src/app/api/career-site/agents/route.ts";
  const module = { exports: {} };
  let actorCalls = 0;
  class ShortLinkRequestError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  class CareerSiteAgentRequestError extends Error {}
  class CareerSiteAgentConfigurationError extends Error {}
  class CareerSiteAgentConnectionError extends Error {}
  vm.runInNewContext(
    transpile(path),
    {
      Buffer,
      console,
      exports: module.exports,
      module,
      process,
      require(specifier) {
        if (specifier === "next/server")
          return { NextResponse: testNextResponse() };
        if (specifier === "@/lib/careerSiteAgentContract") {
          return {
            CareerSiteAgentConfigurationError,
            CareerSiteAgentRequestError,
            parseCareerSiteAgentRequest: (value) => value,
            resolveCareerSiteAgentConfiguration: () => ({
              enabled: true,
              sourceApp: "jarrett-career-agents",
              ownerEmail: "jarrett@suburbiasandwichco.com",
              organizationId: "405bb919-0364-4a88-8a62-b4c9da42cd8f",
            }),
          };
        }
        if (specifier === "@/lib/careerSiteAgents") {
          return {
            CareerSiteAgentConnectionError,
            getCareerSiteAgentStatus: async () => {
              throw new Error("route auth was bypassed");
            },
            runCareerSiteAgent: async () => {
              throw new Error("route auth was bypassed");
            },
          };
        }
        if (specifier === "@/lib/shortlinks") {
          return {
            ShortLinkRequestError,
            validateShortLinkConfiguration: () => {},
            resolveShortLinkActor: async (request) => {
              actorCalls += 1;
              if (
                !/^Bearer\s+\S+$/i.test(
                  String(request.headers.get("authorization") || ""),
                )
              ) {
                throw new ShortLinkRequestError("Unauthorized", 401);
              }
              throw new Error("unexpected authorized route call");
            },
          };
        }
        throw new Error(
          `Unexpected Career Desk agent route import: ${specifier}`,
        );
      },
    },
    { filename: path },
  );
  return { actorCalls: () => actorCalls, route: module.exports };
}

function loadCareerAgents(overrides = {}) {
  const path = "app_src/lib/careerSiteAgents.ts";
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      AbortController,
      clearTimeout,
      console,
      exports: module.exports,
      module,
      process,
      setTimeout,
      require(specifier) {
        if (specifier === "node:crypto") return requireFromApp("node:crypto");
        if (specifier === "@/lib/agents/chatgptAuth") return overrides.auth;
        if (specifier === "@/lib/agents/chatgptResponses")
          return overrides.responses;
        if (specifier === "@/lib/agents/promptSecurity") {
          return {
            AGENT_SECURITY_POLICY: "TEST SECURITY POLICY",
            serializePromptSection: (label, trust, value) =>
              JSON.stringify({ label, trust, value }),
          };
        }
        throw new Error(`Unexpected Career Desk agent import: ${specifier}`);
      },
    },
    { filename: path },
  );
  return module.exports;
}

const route = read("app_src/app/api/career-site/agents/route.ts");
for (const fragment of [
  "resolveCareerSiteAgentConfiguration",
  "validateShortLinkConfiguration({ requireServiceClient: true })",
  "resolveShortLinkActor(req)",
  "!actor.service",
  "parseCareerSiteAgentRequest",
  "getCareerSiteAgentStatus(actor.ownerEmail)",
  "runCareerSiteAgent",
  "'Cache-Control': 'private, no-store, max-age=0'",
]) {
  assert.ok(
    route.includes(fragment),
    `Career Desk agent route missing ${fragment}`,
  );
}

const railwayStart = read("scripts/start-railway.sh");
const runtimeConfig = read("scripts/validate-runtime-config.mjs");
const healthRoute = read("app_src/app/api/health/route.ts");
assert.match(
  railwayStart,
  /\[\[ "\$\{CAREER_SITE_AGENTS_ENABLED:-\}" == "1" \]\]/,
  "Railway startup must require Career Desk agents for this release",
);
for (const fragment of [
  "validateCareerSiteAgentsConfiguration",
  "client.sourceApp === 'jarrett-career-agents'",
  "agentClient.ownerDomain !== 'suburbiasandwichco.com'",
  "agentClient.ownerEmail !== ownerEmail",
  "agentClient.organizationId !== organizationId",
  "client !== agentClient && client.secret === agentClient.secret",
]) {
  assert.ok(
    runtimeConfig.includes(fragment),
    `Career Desk startup validation missing ${fragment}`,
  );
}
for (const fragment of [
  "getCareerSiteAgentConnectionHealth",
  "careerSiteAgents",
  "configured: false",
  "connected: null",
  "credentialStore.status === 'reachable'",
]) {
  assert.ok(
    healthRoute.includes(fragment),
    `Career Desk health missing ${fragment}`,
  );
}
assert.ok(
  !healthRoute.includes("getCareerSiteAgentStatus("),
  "Health must not use the identity-bearing Career Desk status response",
);

const organizationId = "405bb919-0364-4a88-8a62-b4c9da42cd8f";
const siteSecret = "career-site-runtime-test-secret-000000000000000001";
const agentSecret = "career-agent-runtime-test-secret-0000000000000001";
const exactServiceClients = [
  {
    sourceApp: "jarrett-career-site",
    secret: siteSecret,
    ownerDomain: "suburbiasandwichco.com",
    ownerEmail: "jarrett@suburbiasandwichco.com",
    organizationId,
  },
  {
    sourceApp: "jarrett-career-agents",
    secret: agentSecret,
    ownerDomain: "suburbiasandwichco.com",
    ownerEmail: "jarrett@suburbiasandwichco.com",
    organizationId,
  },
];
const validRuntimeEnvironment = {
  PATH: process.env.PATH || "",
  SHORTLINK_PUBLIC_ORIGIN: "https://aiapp.eigenracing.com",
  SHORTLINK_SERVICE_CLIENTS_JSON: JSON.stringify(exactServiceClients),
  CAREER_SITE_SUBMISSIONS_ENABLED: "0",
  CAREER_SITE_AGENTS_ENABLED: "1",
  CAREER_SITE_SUBMISSIONS_OWNER_EMAIL: "jarrett@suburbiasandwichco.com",
  CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID: organizationId,
  DOCUMENT_EMBEDDINGS_PROVIDER: "local",
  CRM_ENABLED: "0",
  CLAWPILOT_REPOSITORY_RUNNER_ENABLED: "0",
  CLAWPILOT_PRINT_AGENT_RELEASE_ENABLED: "0",
  MATON_GMAIL_CONNECTION_ID: "platform-gmail-connection",
  INTEGRATION_EVIDENCE_FINGERPRINT_KEY:
    "career-test-fingerprint-key-000000000000000001",
  INTEGRATION_EVIDENCE_ACTIVE_KEY_ID: "career-test-v1",
  INTEGRATION_EVIDENCE_ENCRYPTION_KEYS: JSON.stringify({
    "career-test-v1": "career-test-encryption-key-000000000000000001",
  }),
};

function validateRuntime(overrides = {}, removedNames = []) {
  const env = { ...validRuntimeEnvironment, ...overrides };
  for (const name of removedNames) delete env[name];
  return spawnSync(process.execPath, ["scripts/validate-runtime-config.mjs"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

const validRuntime = validateRuntime();
assert.equal(validRuntime.status, 0, validRuntime.stderr);
assert.match(validRuntime.stdout, /careerSiteAgents=enabled/);
assert.match(validRuntime.stdout, /authMail=platform/);

const dedicatedAuthMailRuntime = validateRuntime({
  MATON_AUTH_GMAIL_CONNECTION_ID: "dedicated-auth-gmail-connection",
  CLAWPILOT_AUTH_MAIL_FROM: "jarrettcrosby@gmail.com",
});
assert.equal(dedicatedAuthMailRuntime.status, 0, dedicatedAuthMailRuntime.stderr);
assert.match(dedicatedAuthMailRuntime.stdout, /authMail=dedicated/);

const partialAuthMailRuntime = validateRuntime({
  MATON_AUTH_GMAIL_CONNECTION_ID: "dedicated-auth-gmail-connection",
});
assert.notEqual(partialAuthMailRuntime.status, 0);
assert.match(
  partialAuthMailRuntime.stderr,
  /MATON_AUTH_GMAIL_CONNECTION_ID and CLAWPILOT_AUTH_MAIL_FROM must be configured together/,
);

const reusedAuthMailRuntime = validateRuntime({
  MATON_AUTH_GMAIL_CONNECTION_ID: "platform-gmail-connection",
  CLAWPILOT_AUTH_MAIL_FROM: "jarrettcrosby@gmail.com",
});
assert.notEqual(reusedAuthMailRuntime.status, 0);
assert.match(
  reusedAuthMailRuntime.stderr,
  /MATON_AUTH_GMAIL_CONNECTION_ID must differ from MATON_GMAIL_CONNECTION_ID/,
);

const reusedAuthMailSenderRuntime = validateRuntime({
  MATON_GMAIL_CONNECTION_ID: "platform-gmail-connection",
  CLAWPILOT_MAIL_FROM: "Stewards@EigenRacing.com",
  MATON_AUTH_GMAIL_CONNECTION_ID: "dedicated-auth-gmail-connection",
  CLAWPILOT_AUTH_MAIL_FROM: " stewards@eigenracing.com ",
});
assert.notEqual(reusedAuthMailSenderRuntime.status, 0);
assert.match(
  reusedAuthMailSenderRuntime.stderr,
  /CLAWPILOT_AUTH_MAIL_FROM must differ from CLAWPILOT_MAIL_FROM/,
);

const disabledRuntime = validateRuntime({}, ["CAREER_SITE_AGENTS_ENABLED"]);
assert.notEqual(disabledRuntime.status, 0);
assert.match(disabledRuntime.stderr, /CAREER_SITE_AGENTS_ENABLED must be 1/);

const missingAgentClient = validateRuntime({
  SHORTLINK_SERVICE_CLIENTS_JSON: JSON.stringify([exactServiceClients[0]]),
});
assert.notEqual(missingAgentClient.status, 0);
assert.match(missingAgentClient.stderr, /exact jarrett-career-agents source/);

const wrongAgentIdentity = validateRuntime({
  SHORTLINK_SERVICE_CLIENTS_JSON: JSON.stringify([
    exactServiceClients[0],
    { ...exactServiceClients[1], ownerEmail: "other@suburbiasandwichco.com" },
  ]),
});
assert.notEqual(wrongAgentIdentity.status, 0);
assert.match(wrongAgentIdentity.stderr, /exact jarrett-career-agents source/);

const reusedAgentSecret = validateRuntime({
  SHORTLINK_SERVICE_CLIENTS_JSON: JSON.stringify([
    exactServiceClients[0],
    { ...exactServiceClients[1], secret: siteSecret },
  ]),
});
assert.notEqual(reusedAgentSecret.status, 0);
assert.match(
  reusedAgentSecret.stderr,
  /must not be reused by another source/,
);

const previousAuthRequired = process.env.APP_AUTH_REQUIRED;
process.env.APP_AUTH_REQUIRED = "1";
try {
  const proxyRuntime = loadProxy();
  const publicResponse = await proxyRuntime.proxy(
    proxyRequest("/api/career-site/agents"),
  );
  assert.equal(publicResponse.kind, "next");
  assert.equal(
    proxyRuntime.sessionCalls(),
    0,
    "Career agent service route must bypass browser sessions",
  );

  const privateSibling = await proxyRuntime.proxy(
    proxyRequest("/api/career-site/agents/extra"),
  );
  assert.equal(privateSibling.status, 401);
  assert.equal(
    proxyRuntime.sessionCalls(),
    1,
    "Only the exact Career agent service route is public",
  );
} finally {
  if (previousAuthRequired === undefined) delete process.env.APP_AUTH_REQUIRED;
  else process.env.APP_AUTH_REQUIRED = previousAuthRequired;
}

const unauthenticatedRoute = loadRouteForMissingBearer();
const missingBearerResponse = await unauthenticatedRoute.route.GET({
  headers: { get: () => null },
});
assert.equal(missingBearerResponse.status, 401);
assert.equal(missingBearerResponse.body.error, "Unauthorized");
assert.equal(
  unauthenticatedRoute.actorCalls(),
  1,
  "Route must enforce its service bearer identity",
);

const source = read("app_src/lib/careerSiteAgents.ts");
assert.ok(source.includes("getValidChatGPTCredential"));
assert.ok(source.includes("runChatGPTCodexStructuredResponse"));
assert.ok(!source.includes("OPENAI_API_KEY"));
assert.ok(!source.includes("api.openai.com"));

const calls = [];
const runtime = loadCareerAgents({
  auth: {
    async getChatGPTConnection(operatorId) {
      assert.equal(operatorId, "jarrett@suburbiasandwichco.com");
      return {
        connected: true,
        email: "jarrett@example.com",
        planType: "plus",
        expiresAt: "2026-08-29T12:00:00.000Z",
      };
    },
    async getValidChatGPTCredential(operatorId, options) {
      calls.push({ kind: "credential", operatorId, options });
      return { accessToken: "private-test-token", accountId: "account-test" };
    },
  },
  responses: {
    async runChatGPTCodexStructuredResponse(input) {
      calls.push({ kind: "execution", input });
      return {
        text: '{"result":"ok"}',
        citations: [{ url: "https://jobs.example.com/role" }],
      };
    },
  },
});

const status = await runtime.getCareerSiteAgentStatus(
  "jarrett@suburbiasandwichco.com",
);
assert.equal(status.connected, true);
assert.equal(status.provider, "chatgpt-codex");
assert.equal(status.label, "ChatGPT Plus");
const connectionHealth = await runtime.getCareerSiteAgentConnectionHealth(
  "jarrett@suburbiasandwichco.com",
);
assert.equal(JSON.stringify(connectionHealth), '{"connected":true}');

const result = await runtime.runCareerSiteAgent({
  operatorId: "jarrett@suburbiasandwichco.com",
  request: {
    requestId: "e2f7c6dd-18cb-4fb1-a747-42f7f829b20d",
    agentType: "scout",
    schemaName: "career_job_scout",
    instructions: "Find grounded jobs.",
    prompt: '{"query":"operations"}',
    outputSchema: { type: "object" },
    webSearch: true,
  },
});
assert.equal(result.outputText, '{"result":"ok"}');
assert.deepEqual(result.sourceUrls, ["https://jobs.example.com/role"]);
assert.match(result.responseId, /^clawpilot-chatgpt-/);
const execution = calls.find((call) => call.kind === "execution")?.input;
assert.equal(execution.webSearch, true);
assert.equal(execution.outputSchema.name, "career_job_scout");
assert.equal(execution.credential.accessToken, "private-test-token");
assert.match(execution.instructions, /cannot submit an application/);
assert.match(execution.instructions, /TEST SECURITY POLICY/);

const disconnected = loadCareerAgents({
  auth: {
    async getChatGPTConnection() {
      return { connected: false };
    },
    async getValidChatGPTCredential() {
      throw new Error("must not run");
    },
  },
  responses: {
    async runChatGPTCodexStructuredResponse() {
      throw new Error("must not run");
    },
  },
});
await assert.rejects(
  disconnected.runCareerSiteAgent({
    operatorId: "jarrett@suburbiasandwichco.com",
    request: {
      requestId: "e2f7c6dd-18cb-4fb1-a747-42f7f829b20d",
      agentType: "inbox",
      schemaName: "career_inbox_draft",
      instructions: "Draft a reply.",
      prompt: "{}",
      outputSchema: { type: "object" },
      webSearch: false,
    },
  }),
  /Connect ChatGPT/,
);

console.log("PASS test-career-site-agents");
