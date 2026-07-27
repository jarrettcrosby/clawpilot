#!/usr/bin/env node
import net from 'node:net'

const confirmed = process.argv.includes('--confirm-test-print')
const host = String(process.env.CLAWPILOT_PRINTER_HOST || '').trim()
const port = Number(process.env.CLAWPILOT_PRINTER_PORT || 9_100)

if (!confirmed) {
  throw new Error('Use --confirm-test-print to send the static VOID test label')
}
if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('A valid CLAWPILOT_PRINTER_HOST and port are required')
}

const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
const zpl = `^XA
^PW812
^LL1218
^LH0,0
^FO36,36^GB740,1140,6^FS
^FO70,95^A0N,64,64^FDCLAWPILOT TEST^FS
^FO70,185^A0N,45,45^FDVOID - NO POSTAGE^FS
^FO70,270^GB670,4,4^FS
^FO70,330^A0N,34,34^FDLocal Zebra connectivity proof^FS
^FO70,390^A0N,28,28^FDNo carrier label or shipment was created.^FS
^FO70,470^A0N,28,28^FDPrinter: ${host}:${port}^FS
^FO70,525^A0N,28,28^FDTimestamp: ${timestamp}Z^FS
^FO150,690^BQN,2,8^FDQA,CLAWPILOT-TEST-VOID-${timestamp}^FS
^FO70,1030^A0N,32,32^FDDiscard after verification^FS
^XZ`

await new Promise((resolvePromise, reject) => {
  const socket = net.createConnection({ host, port })
  socket.setTimeout(10_000)
  socket.once('connect', () => socket.end(zpl, 'utf8'))
  socket.once('finish', resolvePromise)
  socket.once('timeout', () => {
    socket.destroy()
    reject(new Error('Printer connection timed out'))
  })
  socket.once('error', reject)
})

process.stdout.write(`Sent static VOID test label to ${host}:${port}\n`)
