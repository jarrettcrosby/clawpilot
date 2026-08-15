import { Buffer } from 'node:buffer'

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let result = value
  for (let bit = 0; bit < 8; bit += 1) {
    result = (result & 1) === 1
      ? (result >>> 1) ^ 0xedb88320
      : result >>> 1
  }
  return result >>> 0
})

function crc32(bytes) {
  let checksum = 0xffffffff
  for (const byte of bytes) {
    checksum = CRC32_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8)
  }
  return (checksum ^ 0xffffffff) >>> 0
}

function normalizedArchivePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '')
  if (
    !normalized
    || normalized.includes('\0')
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('A ZIP entry path is invalid')
  }
  return normalized
}

function entryMode(input) {
  const mode = Number(input)
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error('A ZIP entry mode is invalid')
  }
  return 0o100000 | mode
}

export function createDeterministicZip(entries) {
  if (!Array.isArray(entries) || entries.length < 1) {
    throw new Error('At least one ZIP entry is required')
  }
  const prepared = entries.map((entry) => {
    const name = normalizedArchivePath(entry.path)
    const nameBytes = Buffer.from(name, 'utf8')
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(String(entry.content ?? ''), 'utf8')
    if (nameBytes.byteLength > 0xffff || content.byteLength > 0xffffffff) {
      throw new Error('A ZIP entry exceeds the supported archive limits')
    }
    return {
      name,
      nameBytes,
      content,
      checksum: crc32(content),
      mode: entryMode(entry.mode ?? 0o644),
    }
  }).sort((left, right) => left.name.localeCompare(right.name, 'en'))

  const names = new Set()
  for (const entry of prepared) {
    if (names.has(entry.name)) throw new Error(`Duplicate ZIP entry: ${entry.name}`)
    names.add(entry.name)
  }

  const localRecords = []
  const centralRecords = []
  let localOffset = 0
  for (const entry of prepared) {
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0x0021, 12)
    localHeader.writeUInt32LE(entry.checksum, 14)
    localHeader.writeUInt32LE(entry.content.byteLength, 18)
    localHeader.writeUInt32LE(entry.content.byteLength, 22)
    localHeader.writeUInt16LE(entry.nameBytes.byteLength, 26)
    localHeader.writeUInt16LE(0, 28)
    localRecords.push(localHeader, entry.nameBytes, entry.content)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE((3 << 8) | 20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0x0021, 14)
    centralHeader.writeUInt32LE(entry.checksum, 16)
    centralHeader.writeUInt32LE(entry.content.byteLength, 20)
    centralHeader.writeUInt32LE(entry.content.byteLength, 24)
    centralHeader.writeUInt16LE(entry.nameBytes.byteLength, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE((entry.mode << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(localOffset, 42)
    centralRecords.push(centralHeader, entry.nameBytes)

    localOffset += localHeader.byteLength + entry.nameBytes.byteLength + entry.content.byteLength
  }

  const centralDirectory = Buffer.concat(centralRecords)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(prepared.length, 8)
  end.writeUInt16LE(prepared.length, 10)
  end.writeUInt32LE(centralDirectory.byteLength, 12)
  end.writeUInt32LE(localOffset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localRecords, centralDirectory, end])
}
