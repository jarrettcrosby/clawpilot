import net from 'node:net'

export async function probeRawPrinter(host, port, timeoutMs = 3_000) {
  const startedAt = Date.now()
  await new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolvePromise()
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish())
    socket.once('timeout', () => finish(new Error('The printer connection timed out')))
    socket.once('error', () => finish(new Error('The printer could not be reached on that IP and port')))
  })
  return { reachable: true, elapsedMs: Date.now() - startedAt, bytesSent: 0 }
}
