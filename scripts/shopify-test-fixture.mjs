#!/usr/bin/env node

const ENDPOINT =
  'https://dev.aiapp.eigenracing.com/api/dev/shopify-test-fixtures'
const COMMAND_FIELDS = Object.freeze({
  'prepare-order': [
    'organization-id', 'actor-email', 'idempotency-key',
  ],
  'prepare-fulfillment': [
    'organization-id', 'actor-email', 'idempotency-key',
    'predecessor-command', 'order',
  ],
  execute: [
    'organization-id', 'actor-email', 'command', 'intent', 'confirmation',
  ],
  reconcile: ['organization-id', 'actor-email', 'command'],
  status: ['organization-id', 'command'],
})

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
  return null
}

function argumentsFor(command) {
  const expected = COMMAND_FIELDS[command]
  if (!expected) return fail(
    'Usage: shopify-test-fixture.mjs <prepare-order|prepare-fulfillment|execute|reconcile|status> with the required --name=value fields',
  )
  const parsed = {}
  for (const entry of process.argv.slice(3)) {
    const match = entry.match(/^--([a-z-]+)=(.+)$/u)
    if (!match || !expected.includes(match[1]) || match[1] in parsed) {
      return fail(`Unexpected or duplicate fixture argument: ${entry}`)
    }
    parsed[match[1]] = match[2].trim()
  }
  const missing = expected.filter((name) => !parsed[name])
  if (missing.length) return fail(
    `Missing required fixture arguments: ${missing.map((name) => `--${name}=...`).join(', ')}`,
  )
  return parsed
}

function payload(command, args) {
  if (command === 'prepare-order') return {
    action: 'prepare_order',
    organizationId: args['organization-id'],
    actorEmail: args['actor-email'],
    idempotencyKey: args['idempotency-key'],
  }
  if (command === 'prepare-fulfillment') return {
    action: 'prepare_fulfillment',
    organizationId: args['organization-id'],
    actorEmail: args['actor-email'],
    idempotencyKey: args['idempotency-key'],
    predecessorCommandGlobalId: args['predecessor-command'],
    orderGlobalId: args.order,
  }
  if (command === 'execute') return {
    action: 'execute',
    organizationId: args['organization-id'],
    actorEmail: args['actor-email'],
    commandGlobalId: args.command,
    intentHash: args.intent,
    confirmationStatement: args.confirmation,
  }
  if (command === 'reconcile') return {
    action: 'reconcile',
    organizationId: args['organization-id'],
    actorEmail: args['actor-email'],
    commandGlobalId: args.command,
  }
  return {
    action: 'status',
    organizationId: args['organization-id'],
    commandGlobalId: args.command,
  }
}

function nonSuccessResult(command, body) {
  if (!['execute', 'reconcile', 'status'].includes(command)) return null
  const state = body.result && typeof body.result === 'object'
    ? String(body.result.state || '')
    : ''
  if (!state) {
    return 'Fixture route did not return a verifiable command state. Check status; do not retry an execute command.'
  }
  if (state === 'succeeded' || state === 'reconciled_applied') return null
  if (command === 'status' && state === 'prepared') return null
  return `Fixture command is in safe state "${state}" without a confirmed successful provider outcome. Do not retry an execute command.`
}

const command = String(process.argv[2] || '').trim()
const args = argumentsFor(command)
if (args) {
  const credential = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  if (credential.length < 32) {
    fail('The deployed worker credential is unavailable in this shell.')
  } else {
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload(command, args)),
        signal: AbortSignal.timeout(300_000),
      })
      const body = await response.json().catch(() => null)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        fail(`Fixture route returned an invalid HTTP ${response.status} response.`)
      } else {
        process.stdout.write(`${JSON.stringify(body, null, 2)}\n`)
        if (!response.ok || body.ok !== true) {
          process.exitCode = 1
        } else {
          const stateFailure = nonSuccessResult(command, body)
          if (stateFailure) fail(stateFailure)
        }
      }
    } catch {
      fail('Fixture route request failed without a verifiable response. Check command status; do not retry an execute command.')
    }
  }
}
