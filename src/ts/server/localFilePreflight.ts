import { Buffer } from 'buffer'
import { Inflate } from 'fflate'
import { gcm } from '@noble/ciphers/aes.js'
import { decodeRPack } from '../rpack/rpack_js'
import { sha256Bytes, sha256Hex } from '../sha256Fallback'

const MAX_METADATA_BYTES = 50 * 1024 * 1024
const MAX_PNG_TEXT_BYTES = 5 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024

export class ImportPasswordRequired extends Error {}
export class ImportPasswordInvalid extends Error {}

/** Reads metadata with Blob slices; packaged asset bytes never enter memory. */
export async function inspectLocalImport(
  file: Blob,
  fileName: string,
  kind: 'character' | 'module',
  password?: string,
): Promise<{ lowLevelAccess: boolean }> {
  const extension = fileName.split('.').pop()?.toLowerCase()
  let data: any
  if (kind === 'module' && extension === 'risum') {
    const prefix = await read(file, 0, 6)
    if (prefix[0] !== 111 || prefix[1] !== 0) throw new Error('Malformed module header')
    // Standalone module headers use the configured server allowance, not the
    // archive-entry limit. Still validate the declared range before allocating.
    const header = await read(file, 6, view(prefix).getUint32(2, true), file.size)
    data = JSON.parse(new TextDecoder().decode(await decodeRPack(header)))
    data = data.module
  } else if (extension === 'json' || (kind === 'module' && extension === 'lorebook')) {
    // Standalone JSON can exceed an archive entry's limit (for example with
    // inline assets). The server enforces its configured JSON import limit.
    data = JSON.parse(await file.text())
    if (kind === 'module') data = data.module ?? data
  } else if (kind === 'character' && extension === 'png') {
    const signature = await read(file, 0, 8)
    if (!signature.every((byte, i) => byte === [137, 80, 78, 71, 13, 10, 26, 10][i]))
      throw new Error('Malformed PNG character card')
    let offset = 8
    let chara = ''
    let v3 = ''
    let ended = false
    while (offset + 12 <= file.size) {
      const header = await read(file, offset, 8)
      const length = view(header).getUint32(0)
      const type = new TextDecoder().decode(header.subarray(4))
      if (offset + length + 12 > file.size) throw new Error('Malformed PNG character card')
      if (type === 'tEXt') {
        // Read only the keyword of asset chunks, then seek past their payload.
        const keyBytes = await read(file, offset + 8, Math.min(length, 80))
        const separator = keyBytes.indexOf(0)
        const key = separator < 0 ? '' : new TextDecoder().decode(keyBytes.subarray(0, separator))
        if ((key === 'chara' || key === 'ccv3') && length - separator - 1 <= MAX_PNG_TEXT_BYTES) {
          const value = new TextDecoder().decode(await read(file, offset + 9 + separator, length - separator - 1))
          if (key === 'ccv3') v3 = value
          else chara = value
        }
      }
      offset += length + 12
      if (type === 'IEND') {
        ended = true
        break
      }
    }
    const encoded = v3 || chara
    if (!ended || !encoded) throw new Error('PNG character card metadata missing')
    data = encoded.startsWith('rcc||')
      ? await decryptCard(encoded, password)
      : JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } else if (kind === 'character' && ['charx', 'jpg', 'jpeg'].includes(extension ?? '')) {
    data = JSON.parse(new TextDecoder().decode(await readZipMetadata(file, 'card.json')))
  } else throw new Error('Unsupported import file type')
  return {
    lowLevelAccess:
      (kind === 'module' ? data?.lowLevelAccess : data?.data?.extensions?.risuai?.lowLevelAccess) === true,
  }
}

async function decryptCard(encoded: string, password?: string): Promise<unknown> {
  const parts = encoded.split('||')
  if (parts.length !== 5 || parts[1] !== 'rccv1') throw new Error('Malformed encrypted character card')
  const bytes = Uint8Array.from(Buffer.from(parts[2], 'base64'))
  if ((await sha256Hex(bytes)) !== parts[3]) throw new Error('Malformed encrypted character card')
  const metadata = JSON.parse(Buffer.from(parts[4], 'base64').toString('utf8'))
  if (metadata.usePassword === true && password === undefined) throw new ImportPasswordRequired()
  try {
    const keyBytes = await sha256Bytes(metadata.usePassword === true ? (password ?? '') : 'RISU_NONE')
    const subtle = globalThis.crypto?.subtle
    const iv = new Uint8Array(12)
    let clear: ArrayBuffer | Uint8Array
    if (subtle) {
      const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
      clear = await subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes)
    } else {
      clear = gcm(keyBytes, iv).decrypt(bytes)
    }
    return JSON.parse(new TextDecoder().decode(clear))
  } catch {
    if (metadata.usePassword === true) throw new ImportPasswordInvalid()
    throw new Error('Malformed encrypted character card')
  }
}

/** Central-directory lookup works even when card.json follows hundreds of MB
 * of assets. Offsets are adjusted for JPEG-prefixed ZIPs; ZIP64 is supported. */
async function readZipMetadata(file: Blob, name: string): Promise<Uint8Array> {
  const tailStart = Math.max(0, file.size - 65557)
  const tail = await read(file, tailStart, file.size - tailStart)
  let end = tail.length - 22
  while (
    end >= 0 &&
    !(view(tail).getUint32(end, true) === 0x06054b50 && end + 22 + view(tail).getUint16(end + 20, true) === tail.length)
  )
    end--
  if (end < 0) throw new Error('Malformed character archive directory')
  const eocd = tailStart + end
  let count = view(tail).getUint16(end + 10, true)
  let directorySize = view(tail).getUint32(end + 12, true)
  let declaredOffset = view(tail).getUint32(end + 16, true)
  let directoryEnd = eocd
  if (count === 65535 || directorySize === 0xffffffff || declaredOffset === 0xffffffff) {
    const locator = await read(file, eocd - 20, 20)
    if (view(locator).getUint32(0, true) !== 0x07064b50) throw new Error('Malformed ZIP64 locator')
    const zip64Offset = safeNumber(view(locator).getBigUint64(8, true))
    const zip64 = await read(file, zip64Offset, 56)
    if (view(zip64).getUint32(0, true) !== 0x06064b50) throw new Error('Malformed ZIP64 directory')
    count = safeNumber(view(zip64).getBigUint64(32, true))
    directorySize = safeNumber(view(zip64).getBigUint64(40, true))
    declaredOffset = safeNumber(view(zip64).getBigUint64(48, true))
    directoryEnd = zip64Offset
  }
  const directoryStart = directoryEnd - directorySize
  const prefix = directoryStart - declaredOffset
  let offset = directoryStart
  let found: { offset: number; compressed: number; expanded: number; method: number } | undefined
  for (let index = 0; index < count; index++) {
    const header = await read(file, offset, 46)
    const h = view(header)
    if (h.getUint32(0, true) !== 0x02014b50) throw new Error('Malformed character archive directory')
    const nameLength = h.getUint16(28, true)
    const extraLength = h.getUint16(30, true)
    const commentLength = h.getUint16(32, true)
    const entryName = new TextDecoder().decode(await read(file, offset + 46, nameLength))
    if (entryName === name) {
      let compressed = h.getUint32(20, true)
      let expanded = h.getUint32(24, true)
      let localOffset = h.getUint32(42, true)
      if ([compressed, expanded, localOffset].includes(0xffffffff)) {
        const extra = await read(file, offset + 46 + nameLength, extraLength)
        for (let i = 0; i + 4 <= extra.length; ) {
          const size = view(extra).getUint16(i + 2, true)
          if (i + 4 + size > extra.length) throw new Error('Malformed ZIP64 metadata')
          if (view(extra).getUint16(i, true) === 1) {
            let j = i + 4
            const next = () => {
              if (j + 8 > i + 4 + size) throw new Error('Malformed ZIP64 metadata')
              const n = safeNumber(view(extra).getBigUint64(j, true))
              j += 8
              return n
            }
            if (expanded === 0xffffffff) expanded = next()
            if (compressed === 0xffffffff) compressed = next()
            if (localOffset === 0xffffffff) localOffset = next()
          }
          i += 4 + size
        }
      }
      if (h.getUint16(8, true) & 1) throw new Error('Encrypted ZIP archives are unsupported')
      found = { offset: localOffset + prefix, compressed, expanded, method: h.getUint16(10, true) }
    }
    offset += 46 + nameLength + extraLength + commentLength
    if (offset > directoryEnd) throw new Error('Malformed character archive directory')
  }
  if (!found) throw new Error('Character archive must include card.json')
  if (found.expanded > MAX_METADATA_BYTES || found.compressed > MAX_METADATA_BYTES)
    throw new Error('Card metadata exceeds size limit')
  const local = await read(file, found.offset, 30)
  if (view(local).getUint32(0, true) !== 0x04034b50) throw new Error('Malformed character archive entry')
  const start = found.offset + 30 + view(local).getUint16(26, true) + view(local).getUint16(28, true)
  if (found.method === 0) return read(file, start, found.compressed)
  if (found.method !== 8) throw new Error('Unsupported archive compression')
  const chunks: Uint8Array[] = []
  let size = 0
  const inflate = new Inflate((chunk) => {
    size += chunk.length
    if (size > MAX_METADATA_BYTES) throw new Error('Card metadata exceeds size limit')
    chunks.push(chunk)
  })
  for (let position = 0; position < found.compressed; position += CHUNK_BYTES) {
    const length = Math.min(CHUNK_BYTES, found.compressed - position)
    inflate.push(await read(file, start + position, length), position + length === found.compressed)
  }
  if (size !== found.expanded) throw new Error('Malformed character archive metadata')
  const result = new Uint8Array(size)
  let position = 0
  for (const chunk of chunks) {
    result.set(chunk, position)
    position += chunk.length
  }
  return result
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
function safeNumber(value: bigint): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error('Archive offset exceeds supported range')
  return number
}
async function read(file: Blob, offset: number, length: number, limit = MAX_METADATA_BYTES): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    length > limit ||
    offset + length > file.size
  )
    throw new Error('Invalid or oversized import metadata')
  return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
}
