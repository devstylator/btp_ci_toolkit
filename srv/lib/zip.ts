import { inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  path: string
  size: number
  /** Decompressed content (stored or deflate entries). */
  read(): Buffer
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_ENTRY_SIZE = 20 * 1024 * 1024

/** Minimal ZIP reader for CPI artifact exports (no ZIP64, no encryption). Throws on malformed archives. */
export function readZip(data: Buffer): ZipEntry[] {
  let eocd = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (data.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive')
  const count = data.readUInt16LE(eocd + 10)
  let offset = data.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('Corrupt ZIP directory')
    const method = data.readUInt16LE(offset + 10)
    const compressedSize = data.readUInt32LE(offset + 20)
    const size = data.readUInt32LE(offset + 24)
    const nameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const commentLength = data.readUInt16LE(offset + 32)
    const localOffset = data.readUInt32LE(offset + 42)
    const path = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength
    if (path.endsWith('/')) continue
    entries.push({
      path,
      size,
      read() {
        if (size > MAX_ENTRY_SIZE) throw new Error(`ZIP entry too large: ${path}`)
        if (data.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error('Corrupt ZIP entry')
        const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28)
        const raw = data.subarray(start, start + compressedSize)
        if (method === 0) return Buffer.from(raw)
        if (method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_SIZE })
        throw new Error(`Unsupported ZIP compression method ${method} in ${path}`)
      }
    })
  }
  return entries
}
