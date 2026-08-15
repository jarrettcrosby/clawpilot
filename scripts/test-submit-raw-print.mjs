#!/usr/bin/env node
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  rawPrintFailureDisposition,
  submitRaw,
} from './lib/submit-raw-print.mjs'

class FakeSocket extends EventEmitter {
  constructor(writeBehavior = () => {}) {
    super()
    this.writeBehavior = writeBehavior
    this.writeCalls = 0
    this.destroyCalls = 0
    this.timeoutMs = null
  }

  setTimeout(timeoutMs) {
    this.timeoutMs = timeoutMs
  }

  write(payload, callback) {
    this.writeCalls += 1
    return this.writeBehavior({ callback, payload, socket: this })
  }

  end() {
    queueMicrotask(() => this.emit('finish'))
  }

  destroy() {
    this.destroyCalls += 1
  }
}

function injectedConnection(socket, afterCreate) {
  return (options) => {
    socket.options = options
    queueMicrotask(() => afterCreate(socket))
    return socket
  }
}

async function rejectedDelivery(socket, afterCreate) {
  let thrown = null
  try {
    await submitRaw(
      Buffer.from('^XA^XZ'),
      'warehouse-zebra.local',
      9_100,
      123,
      { createConnection: injectedConnection(socket, afterCreate) },
    )
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, 'Expected raw printer delivery to reject')
  return {
    error: thrown,
    disposition: rawPrintFailureDisposition(thrown),
  }
}

const preWriteSocket = new FakeSocket()
const preWrite = await rejectedDelivery(
  preWriteSocket,
  (socket) => socket.emit('error', new Error('connect refused')),
)
assert.equal(preWriteSocket.writeCalls, 0)
assert.equal(preWrite.error.deliveryStarted, false)
assert.equal(preWrite.disposition.acceptedBytes, 0)
assert.equal(preWrite.disposition.deliveryStarted, false)
assert.equal(preWrite.disposition.retryable, true)
assert.equal(preWrite.disposition.code, 'PRINTER_UNAVAILABLE')

const timeoutSocket = new FakeSocket(({ socket }) => {
  queueMicrotask(() => socket.emit('timeout'))
})
const postWriteTimeout = await rejectedDelivery(
  timeoutSocket,
  (socket) => socket.emit('connect'),
)
assert.equal(timeoutSocket.writeCalls, 1)
assert.equal(postWriteTimeout.error.acceptedBytes, 0)
assert.equal(postWriteTimeout.error.deliveryStarted, true)
assert.equal(postWriteTimeout.disposition.deliveryStarted, true)
assert.equal(postWriteTimeout.disposition.retryable, false)
assert.equal(postWriteTimeout.disposition.code, 'PRINT_OUTCOME_UNCERTAIN')

const callbackErrorSocket = new FakeSocket(({ callback }) => {
  queueMicrotask(() => callback(new Error('write callback failed')))
})
const postWriteCallbackError = await rejectedDelivery(
  callbackErrorSocket,
  (socket) => socket.emit('connect'),
)
assert.equal(callbackErrorSocket.writeCalls, 1)
assert.equal(postWriteCallbackError.error.acceptedBytes, 0)
assert.equal(postWriteCallbackError.error.deliveryStarted, true)
assert.equal(postWriteCallbackError.disposition.deliveryStarted, true)
assert.equal(postWriteCallbackError.disposition.retryable, false)
assert.equal(postWriteCallbackError.disposition.code, 'PRINT_OUTCOME_UNCERTAIN')

const payload = Buffer.from('^XA^FO20,20^FDSUCCESS^FS^XZ')
const successSocket = new FakeSocket(({ callback }) => {
  queueMicrotask(() => callback())
})
const success = await submitRaw(
  payload,
  'warehouse-zebra.local',
  9_100,
  123,
  {
    createConnection: injectedConnection(
      successSocket,
      (socket) => socket.emit('connect'),
    ),
  },
)
assert.equal(successSocket.writeCalls, 1)
assert.equal(success.acceptedBytes, payload.byteLength)
assert.equal(success.deliveryStarted, true)

for (const socket of [
  preWriteSocket,
  timeoutSocket,
  callbackErrorSocket,
  successSocket,
]) {
  assert.equal(socket.options.host, 'warehouse-zebra.local')
  assert.equal(socket.options.port, 9_100)
  assert.equal(socket.timeoutMs, 123)
  assert.equal(socket.destroyCalls, 1)
}

process.stdout.write('Raw print delivery-start boundary contracts passed\n')
