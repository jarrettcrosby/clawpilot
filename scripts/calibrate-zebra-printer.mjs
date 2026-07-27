#!/usr/bin/env node
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const KNOWN_CONFIGURATION_KEYS = [
  'DARKNESS',
  'PRINT SPEED',
  'TEAR OFF',
  'PRINT MODE',
  'MEDIA TYPE',
  'SENSOR TYPE',
  'SENSOR SELECT',
  'PRINT WIDTH',
  'LABEL LENGTH',
  'MAXIMUM LENGTH',
  'MEDIA POWER UP',
  'HEAD CLOSE',
  'LABEL TOP',
  'LEFT POSITION',
  'RESOLUTION',
  'FIRMWARE',
  'SERIAL NUMBER',
]

const AUTO_CALIBRATION_COMMAND = '~JC\r\n'

function integer(value, name, fallback, maximum = 65_535) {
  const number = Number(value ?? fallback)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`)
  }
  return number
}

function parseArguments(argv, env = process.env) {
  const flags = new Set()
  const values = new Map()
  const flagOptions = new Set([
    '--confirm-auto-calibration',
    '--confirm-agent-paused',
    '--help',
    '-h',
  ])
  const valueOptions = new Set([
    '--host',
    '--port',
    '--http-port',
    '--expected-media',
    '--settle-ms',
    '--timeout-ms',
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--') && argument !== '-h') {
      throw new Error(`Unexpected argument: ${argument}`)
    }
    if (!valueOptions.has(argument)) {
      if (!flagOptions.has(argument)) {
        throw new Error(`Unknown option: ${argument}`)
      }
      flags.add(argument)
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`)
    }
    values.set(argument, value)
    index += 1
  }

  const help = flags.has('--help') || flags.has('-h')
  const host = String(
    values.get('--host') || env.CLAWPILOT_PRINTER_HOST || '',
  ).trim()
  if (!host && !help) {
    throw new Error('CLAWPILOT_PRINTER_HOST or --host is required')
  }

  return {
    host,
    port: integer(
      values.get('--port') || env.CLAWPILOT_PRINTER_PORT,
      '--port',
      9_100,
    ),
    httpPort: integer(
      values.get('--http-port') || env.CLAWPILOT_PRINTER_HTTP_PORT,
      '--http-port',
      80,
    ),
    timeoutMs: integer(values.get('--timeout-ms'), '--timeout-ms', 5_000, 60_000),
    settleMs: integer(values.get('--settle-ms'), '--settle-ms', 12_000, 60_000),
    expectedMedia: String(values.get('--expected-media') || '').trim(),
    confirmAutoCalibration: flags.has('--confirm-auto-calibration'),
    confirmAgentPaused: flags.has('--confirm-agent-paused'),
    help,
  }
}

function decodeHtml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

function configurationValue(preformatted, key) {
  const line = preformatted.split(/\r?\n/).find((candidate) => {
    const normalized = candidate.trimEnd()
    return normalized === key || normalized.endsWith(`  ${key}`)
  })
  if (!line) return null
  return line.trimEnd().slice(0, -key.length).trim() || null
}

export function parseZebraConfiguration(html) {
  const preformatted = decodeHtml(
    String(html).match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)?.[1] || '',
  )
  if (!preformatted) {
    throw new Error('The Zebra configuration page did not contain a configuration block')
  }
  const configuration = Object.fromEntries(
    KNOWN_CONFIGURATION_KEYS.map((key) => [
      key,
      configurationValue(preformatted, key),
    ]),
  )
  const heading = String(html).match(
    /<h1>\s*Zebra Technologies\s*<br\s*\/?>\s*([^<]+)<\/h1>/i,
  )
  const title = String(html).match(/<title>\s*([^<]+?)\s*<\/title>/i)
  const status = title?.[1]?.split(' - ').at(-1)?.trim() || null
  return {
    model: decodeHtml(heading?.[1]?.trim() || 'Zebra printer'),
    status: status === 'View Printer Configuration' ? null : status,
    configuration,
  }
}

function parseZebraHomeStatus(html) {
  const title = String(html).match(/<title>\s*([^<]+?)\s*<\/title>/i)
  return title?.[1]?.split(' - ').at(-1)?.trim() || null
}

function numericPrefix(value) {
  const match = String(value || '').match(/^[+-]?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : null
}

function mediaDiagnosis(snapshot, expectedMedia) {
  const resolutionDotsPerMillimeter = numericPrefix(
    snapshot.configuration.RESOLUTION?.match(/\b\d+(?:\.\d+)?\/MM\b/)?.[0],
  )
  const dotsPerInch = resolutionDotsPerMillimeter
    ? resolutionDotsPerMillimeter * 25.4
    : null
  const labelLengthDots = numericPrefix(snapshot.configuration['LABEL LENGTH'])
  const expectedHeightInches = expectedMedia === 'label_4x6' ? 6 : null
  const expectedLengthDots = dotsPerInch && expectedHeightInches
    ? dotsPerInch * expectedHeightInches
    : null
  const deltaDots = labelLengthDots !== null && expectedLengthDots !== null
    ? labelLengthDots - expectedLengthDots
    : null
  const deltaInches = deltaDots !== null && dotsPerInch
    ? deltaDots / dotsPerInch
    : null

  return {
    expectedMedia: expectedMedia || null,
    configuredMediaType: snapshot.configuration['MEDIA TYPE'],
    configuredSensorType: snapshot.configuration['SENSOR TYPE'],
    configuredLabelLengthDots: labelLengthDots,
    resolutionDotsPerMillimeter,
    expectedLengthDots: expectedLengthDots === null
      ? null
      : Math.round(expectedLengthDots),
    lengthDeltaDots: deltaDots === null ? null : Math.round(deltaDots),
    lengthDeltaInches: deltaInches === null
      ? null
      : Number(deltaInches.toFixed(2)),
    expectedStockMatchesCalibration: deltaInches === null
      ? null
      : Math.abs(deltaInches) <= 0.25,
  }
}

export async function inspectZebraPrinter(input) {
  const authority = input.httpPort === 80
    ? input.host
    : `${input.host}:${input.httpPort}`
  const request = (pathname) => fetch(`http://${authority}${pathname}`, {
    method: 'GET',
    headers: { accept: 'text/html' },
    signal: AbortSignal.timeout(input.timeoutMs),
  })
  const [homeResponse, configurationResponse] = await Promise.all([
    request('/'),
    request('/config.html'),
  ])
  if (!homeResponse.ok || !configurationResponse.ok) {
    throw new Error(
      `Zebra inspection failed with HTTP ${homeResponse.status}/${configurationResponse.status}`,
    )
  }
  const [homeHtml, configurationHtml] = await Promise.all([
    homeResponse.text(),
    configurationResponse.text(),
  ])
  const snapshot = parseZebraConfiguration(configurationHtml)
  snapshot.status = parseZebraHomeStatus(homeHtml) || snapshot.status
  return {
    ...snapshot,
    diagnosis: mediaDiagnosis(snapshot, input.expectedMedia),
  }
}

export async function sendZebraAutoCalibration(input) {
  const payload = Buffer.from(AUTO_CALIBRATION_COMMAND, 'ascii')
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host: input.host, port: input.port })
    let settled = false
    const settle = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolvePromise({ acceptedBytes: payload.byteLength })
    }
    socket.setTimeout(input.timeoutMs)
    socket.once('connect', () => {
      socket.write(payload, (error) => {
        if (error) return settle(error)
        socket.end()
      })
    })
    socket.once('finish', () => settle())
    socket.once('timeout', () => settle(new Error('Zebra calibration delivery timed out')))
    socket.once('error', settle)
  })
}

function assertCalibrationPreconditions(options, snapshot) {
  if (!options.confirmAgentPaused) {
    throw new Error(
      '--confirm-agent-paused is required so a print job cannot overlap calibration',
    )
  }
  if (options.expectedMedia !== 'label_4x6') {
    throw new Error(
      '--expected-media label_4x6 is required after loading 4 x 6 gap labels',
    )
  }
  if (snapshot.status !== 'READY') {
    throw new Error(`The Zebra printer is not READY (status: ${snapshot.status || 'unknown'})`)
  }
  if (
    snapshot.configuration['MEDIA TYPE'] !== 'GAP/NOTCH'
    || snapshot.configuration['SENSOR TYPE'] !== 'WEB'
  ) {
    throw new Error(
      'The printer must report GAP/NOTCH media with the WEB sensor before this bounded calibration',
    )
  }
}

function usage() {
  return `Inspect or calibrate one networked Zebra printer.

Read-only inspection (default):
  CLAWPILOT_PRINTER_HOST=192.0.2.10 npm run print-agent:calibrate-zebra

Guarded standard auto media calibration:
  CLAWPILOT_PRINTER_HOST=192.0.2.10 npm run print-agent:calibrate-zebra -- \\
    --expected-media label_4x6 \\
    --confirm-agent-paused \\
    --confirm-auto-calibration

The calibration action sends only Zebra command ~JC. It changes the stored
media length and sensor calibration and intentionally feeds one to four labels.
It does not submit a ClawPilot artifact or carrier label. The enrolled local
print agent must be paused and 4 x 6 gap media must already be loaded.
`
}

export async function runZebraCalibrationCli(argv, env = process.env) {
  const options = parseArguments(argv, env)
  if (options.help) {
    process.stdout.write(usage())
    return
  }

  const before = await inspectZebraPrinter(options)
  if (!options.confirmAutoCalibration) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: 'inspect',
      mutationSent: false,
      printer: before,
    }, null, 2)}\n`)
    return
  }

  assertCalibrationPreconditions(options, before)
  process.stderr.write(
    'Sending Zebra ~JC: stored sensor calibration will change and one to four labels will feed.\n',
  )
  const delivery = await sendZebraAutoCalibration(options)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, options.settleMs))
  const after = await inspectZebraPrinter(options)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    action: 'auto_media_calibration',
    command: '~JC',
    expectedCalibrationFeedCount: '1-4 labels',
    acceptedBytes: delivery.acceptedBytes,
    before,
    after,
  }, null, 2)}\n`)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runZebraCalibrationCli(process.argv.slice(2))
}
