import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import { createCipheriv, createHash } from 'node:crypto'
import { encodeRPack } from '../rpack/rpack_js'
import { ImportPasswordInvalid, ImportPasswordRequired, inspectLocalImport } from './localFilePreflight'

const card = (lowLevelAccess: boolean) => ({
  spec: 'chara_card_v3',
  data: { extensions: { risuai: { lowLevelAccess } } },
})
afterEach(() => vi.unstubAllGlobals())

function encryptedCard(usePassword: boolean, tampered = false) {
  const key = createHash('sha256')
    .update(usePassword ? 'secret' : 'RISU_NONE')
    .digest()
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.alloc(12))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(card(true))), cipher.final(), cipher.getAuthTag()])
  if (tampered) encrypted[encrypted.length - 1] ^= 1
  return png(
    `rcc||rccv1||${encrypted.toString('base64')}||${createHash('sha256').update(encrypted).digest('hex')}||${Buffer.from(JSON.stringify({ usePassword })).toString('base64')}`,
  )
}
function png(text: string) {
  const payload = Buffer.from(`ccv3\0${text}`)
  const textChunk = Buffer.alloc(payload.length + 12)
  textChunk.writeUInt32BE(payload.length)
  textChunk.write('tEXt', 4)
  payload.copy(textChunk, 8)
  const end = Buffer.alloc(12)
  end.write('IEND', 4)
  return new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), textChunk, end])
}

describe('local file metadata preflight', () => {
  it.each([
    ['bot.json', 'character', card(true)],
    ['module.json', 'module', { type: 'risuModule', module: { lowLevelAccess: true } }],
    ['module.lorebook', 'module', { type: 'risuModule', module: { lowLevelAccess: true } }],
  ] as const)('inspects standalone %s larger than the archive-entry limit', async (name, kind, data) => {
    const file = new Blob([JSON.stringify(data), ' '.repeat(51 * 1024 * 1024)])
    await expect(inspectLocalImport(file, name, kind)).resolves.toEqual({ lowLevelAccess: true })
  })

  it('prompts for and validates passwords without SubtleCrypto', async () => {
    vi.stubGlobal('crypto', { subtle: undefined })
    const file = encryptedCard(true)
    await expect(inspectLocalImport(file, 'bot.png', 'character')).rejects.toBeInstanceOf(ImportPasswordRequired)
    await expect(inspectLocalImport(file, 'bot.png', 'character', 'wrong')).rejects.toBeInstanceOf(
      ImportPasswordInvalid,
    )
    await expect(inspectLocalImport(file, 'bot.png', 'character', 'secret')).resolves.toEqual({ lowLevelAccess: true })
  })

  it('decrypts passwordless cards and detects their permissions without SubtleCrypto', async () => {
    vi.stubGlobal('crypto', { subtle: undefined })
    await expect(inspectLocalImport(encryptedCard(false), 'bot.png', 'character')).resolves.toEqual({
      lowLevelAccess: true,
    })
  })

  it.each([false, true])(
    'rejects invalid GCM authentication without SubtleCrypto (password: %s)',
    async (usePassword) => {
      vi.stubGlobal('crypto', { subtle: undefined })
      await expect(
        inspectLocalImport(encryptedCard(usePassword, true), 'bot.png', 'character', 'secret'),
      ).rejects.toThrow(usePassword ? ImportPasswordInvalid : 'Malformed encrypted character card')
    },
  )
  it.each([0, 6] as const)('seeks to trailing card metadata without reading assets (ZIP level %s)', async (level) => {
    const archive = zipSync(
      { 'assets/large.png': new Uint8Array(2 * 1024 * 1024), 'card.json': Buffer.from(JSON.stringify(card(true))) },
      { level },
    )
    const file = new Blob([Uint8Array.from(archive)])
    let readBytes = 0
    const slice = file.slice.bind(file)
    file.slice = (start, end, type) => {
      readBytes += (end ?? file.size) - (start ?? 0)
      return slice(start, end, type)
    }
    file.arrayBuffer = () => {
      throw new Error('Whole file read forbidden')
    }
    await expect(inspectLocalImport(file, 'bot.charx', 'character')).resolves.toEqual({ lowLevelAccess: true })
    expect(readBytes).toBeLessThan(70000)
  })
  it('reads JPEG-prefixed archives', async () => {
    const archive = zipSync({ 'card.json': Buffer.from(JSON.stringify(card(false))) })
    await expect(
      inspectLocalImport(new Blob([new Uint8Array(100), Uint8Array.from(archive)]), 'bot.jpg', 'character'),
    ).resolves.toEqual({ lowLevelAccess: false })
  })
  it('decrypts before inspecting low-level access and rejects a wrong password', async () => {
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update('secret').digest(), Buffer.alloc(12))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(card(true))), cipher.final(), cipher.getAuthTag()])
    const encoded = `rcc||rccv1||${encrypted.toString('base64')}||${createHash('sha256').update(encrypted).digest('hex')}||${Buffer.from(JSON.stringify({ usePassword: true })).toString('base64')}`
    const file = png(encoded)
    await expect(inspectLocalImport(file, 'bot.png', 'character')).rejects.toBeInstanceOf(ImportPasswordRequired)
    await expect(inspectLocalImport(file, 'bot.png', 'character', 'wrong')).rejects.toBeInstanceOf(
      ImportPasswordInvalid,
    )
    await expect(inspectLocalImport(file, 'bot.png', 'character', 'secret')).resolves.toEqual({ lowLevelAccess: true })
  })
  it('inspects a risum header without reading its assets', async () => {
    const metadata = await encodeRPack(
      Buffer.from(JSON.stringify({ type: 'risuModule', module: { lowLevelAccess: true } })),
    )
    const prefix = Buffer.alloc(6)
    prefix[0] = 111
    prefix.writeUInt32LE(metadata.length, 2)
    const file = new Blob([prefix, metadata, new Uint8Array(1024 * 1024)])
    await expect(inspectLocalImport(file, 'module.risum', 'module')).resolves.toEqual({ lowLevelAccess: true })
  })
  it('inspects standalone risum metadata above 50 MiB without reading asset payloads', async () => {
    const metadata = await encodeRPack(
      Buffer.from(
        JSON.stringify({
          type: 'risuModule',
          module: {
            id: 'large',
            name: 'Large module',
            description: 'x'.repeat(51 * 1024 * 1024),
            lowLevelAccess: true,
          },
        }),
      ),
    )
    const prefix = Buffer.from([111, 0, 0, 0, 0, 0])
    prefix.writeUInt32LE(metadata.length, 2)
    const file = new Blob([prefix, metadata, new Uint8Array(1024)])
    const slice = vi.spyOn(file, 'slice')
    await expect(inspectLocalImport(file, 'large.risum', 'module')).resolves.toEqual({ lowLevelAccess: true })
    expect(slice.mock.calls.every(([, end]) => end! <= 6 + metadata.length)).toBe(true)
  })

  it('rejects malformed or oversized metadata before uploading', async () => {
    await expect(inspectLocalImport(new Blob(['bad']), 'bot.charx', 'character')).rejects.toThrow()
    const prefix = Buffer.from([111, 0, 255, 255, 255, 127])
    await expect(inspectLocalImport(new Blob([prefix]), 'module.risum', 'module')).rejects.toThrow()
  })
})
