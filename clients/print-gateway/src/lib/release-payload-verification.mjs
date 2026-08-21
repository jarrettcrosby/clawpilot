import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs'
import path from 'node:path'

const CONCRETE_SECRET = /(?:cppair|cpprint)\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/i
const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
])

export function recursiveRegularFiles(root) {
  const files = []
  const visit = (entryPath) => {
    const stat = statSync(entryPath, { throwIfNoEntry: false })
    if (!stat) return
    if (stat.isFile()) {
      files.push(entryPath)
      return
    }
    if (!stat.isDirectory()) return
    for (const entry of readdirSync(entryPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      visit(path.join(entryPath, entry.name))
    }
  }
  visit(root)
  return files.sort((left, right) => left.localeCompare(right, 'en'))
}

export function assertNoConcreteSecretsInPaths(paths) {
  for (const filePath of paths.flatMap((entry) => recursiveRegularFiles(entry))) {
    const descriptor = openSync(filePath, 'r')
    let carry = ''
    let position = 0
    try {
      const chunk = Buffer.alloc(64 * 1024)
      for (;;) {
        const length = readSync(descriptor, chunk, 0, chunk.length, position)
        if (length === 0) break
        position += length
        const text = `${carry}${chunk.subarray(0, length).toString('latin1')}`
        if (CONCRETE_SECRET.test(text)) {
          throw new Error(`Packaged payload contains a concrete ClawPilot secret: ${path.basename(filePath)}`)
        }
        carry = text.slice(-192)
      }
    } finally {
      closeSync(descriptor)
    }
  }
}

function firstFourBytes(filePath) {
  const descriptor = openSync(filePath, 'r')
  try {
    const header = Buffer.alloc(4)
    return readSync(descriptor, header, 0, header.length, 0) === header.length
      ? header
      : null
  } finally {
    closeSync(descriptor)
  }
}

export function isMachO(filePath) {
  const header = firstFourBytes(filePath)
  return Boolean(header && MACH_O_MAGICS.has(header.readUInt32BE(0)))
}

export function assertUniversalMachOPayload(root, { architecturesFor }) {
  const machoFiles = recursiveRegularFiles(root).filter(isMachO)
  if (machoFiles.length === 0) throw new Error('The packaged macOS app contains no Mach-O payloads')
  for (const filePath of machoFiles) {
    const architectures = [...architecturesFor(filePath)].sort()
    if (architectures.join(',') !== ['arm64', 'x86_64'].sort().join(',')) {
      throw new Error(
        `Mach-O payload is not exactly universal arm64+x86_64: ${path.relative(root, filePath)} (${architectures.join(', ')})`,
      )
    }
  }
  return machoFiles
}

export function windowsPeMachineOrNull(filePath) {
  const descriptor = openSync(filePath, 'r')
  try {
    const dosHeader = Buffer.alloc(64)
    if (readSync(descriptor, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) return null
    if (dosHeader.toString('ascii', 0, 2) !== 'MZ') return null
    const peOffset = dosHeader.readUInt32LE(0x3c)
    if (!Number.isSafeInteger(peOffset) || peOffset < 64 || peOffset > statSync(filePath).size - 6) {
      return null
    }
    const peHeader = Buffer.alloc(6)
    if (readSync(descriptor, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) return null
    if (peHeader.toString('ascii', 0, 4) !== 'PE\0\0') return null
    return peHeader.readUInt16LE(4)
  } finally {
    closeSync(descriptor)
  }
}

export function windowsPePayloads(root) {
  return recursiveRegularFiles(root).filter((filePath) => windowsPeMachineOrNull(filePath) !== null)
}

export function assertWindowsX64PayloadTree(root, {
  architectureExceptions = [],
} = {}) {
  const exceptions = new Set(architectureExceptions.map((entry) => entry.replaceAll('\\', '/')))
  const peFiles = windowsPePayloads(root)
  if (peFiles.length === 0) throw new Error('The packaged Windows app contains no PE payloads')
  for (const filePath of peFiles) {
    const relative = path.relative(root, filePath).replaceAll('\\', '/')
    if (!exceptions.has(relative) && windowsPeMachineOrNull(filePath) !== 0x8664) {
      throw new Error(`Windows payload is not AMD64: ${relative}`)
    }
  }
  return peFiles
}
