import { createHash, randomUUID, webcrypto } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { StreamBytes, StreamedPngImage } from './localImportStreamBytes.js'
import type { DatabaseSync } from 'node:sqlite'
import * as fflate from 'fflate'
import { normalizeScriptDefinitionCollection } from './commands/scriptDefinitions.js'
import { repairLorebookEntries } from './commands/lorebooks.js'
import { isImportableMCPIdentifier } from '@risuai/shared-core/mcp-identifier'
import {
  LowLevelAccessImportError,
  convertRealmCharacterCard,
  type RealmAssetSource,
} from './realmImport/characterCard.js'
import { CONTENT_TYPE_EXTENSIONS, ValidationError, addAsset, type AddAssetResult } from './repository.js'

import type { LocalCharacterImportProgress } from '@risuai/protocol/local-file-import'
import { setImmediate as yieldToIo } from 'node:timers/promises'

type JsonRecord = Record<string, unknown>

const CHARACTER_CARD_MAX_ENTRY_BYTES = 50 * 1024 * 1024
const CHARACTER_CARD_STREAM_CHUNK_BYTES = 64 * 1024
const CHARACTER_CARD_TEXT_BYTES = 5 * 1024 * 1024
const RISU_MODULE_MAGIC_BYTE = 111
const RISU_MODULE_VERSION = 0
const RPACK_DECODE_MAP = Buffer.from(
  'LPeEi8ll+7afrrMDLQFpdB/ko+zuXDQhk0oPauJiAp4inP08/HHHxq1ZZwVwbYpEEvokhl+v0XpHzv5QY91RBm8Y4FKoCZ1Wc0y4U2zDoA4Zzz4NfgcyaEbqSPmZLqukSSBeVTU4DLzTsVgWeSgKGuHyzcQ526K6YHJ2fZXvf8jA3jeUv7UUgZIlRazn9WanKzZawRPjSzrojYMbfCewmkLrh6rcVI54JtJXKdS3+C+PiXXwQXfCHv/YFRHlBJcX8zHQmwDXyrRPKjvZsmvaXaE/MGG9kT1O5t++TYKMHSMQmGT0hTN7kEO7qYjx1qUc9sxuuVsLlu3V6cXLCKaAQA==',
  'base64',
)
const EXTENSION_CONTENT_TYPES = Object.fromEntries(
  Object.entries(CONTENT_TYPE_EXTENSIONS).map(([contentType, extension]) => [extension, contentType]),
) as Record<string, string>
EXTENSION_CONTENT_TYPES.jpeg = 'image/jpeg'

export class CharacterPasswordRequiredError extends ValidationError {
  constructor() {
    super('Character card password required')
    this.name = 'CharacterPasswordRequiredError'
  }
}

export class CharacterPasswordInvalidError extends ValidationError {
  constructor() {
    super('Character card password is invalid')
    this.name = 'CharacterPasswordInvalidError'
  }
}

export interface LocalFileImportReport {
  droppedArchiveEntries: string[]
  droppedInlineAssets: Array<{ index: number; name: string }>
}

export interface LocalCharacterFileImportResult {
  character: JsonRecord
  report: LocalFileImportReport
}

export interface LocalModuleFileImportResult {
  module: JsonRecord
}

interface ParsedPngCard {
  card: unknown
  embeddedAssets: Array<{ key: string; bytes: Buffer }>
  imageBytes: Buffer
}

interface ParsedCharxMetadata {
  card: JsonRecord
  moduleBytes: Buffer | null
  droppedEntries: string[]
}

/** Live multipart ingestion. Asset payloads are released entry-by-entry; the
 * archive's total size is not a memory limit. The final create remains revisioned.
 * Like ordinary uploads, assets left by a failed create are reclaimed by GC. */
export async function importLocalFileStream(args: {
  kind: 'character' | 'module'
  source: AsyncIterable<Uint8Array>
  /** Configured standalone metadata limit; archive entries have separate bounds. */
  maxExpandedBytes?: number
  db: DatabaseSync
  dataDir: string
  fileName: string
  allowLowLevelAccess?: boolean
  password?: string
  signal?: AbortSignal
  reportProgress?: (progress: LocalCharacterImportProgress) => void
}): Promise<LocalCharacterFileImportResult | LocalModuleFileImportResult> {
  const extension = fileExtension(args.fileName)
  const report: LocalFileImportReport = { droppedArchiveEntries: [], droppedInlineAssets: [] }
  const assetDict: Record<string, string> = Object.create(null)
  let completedAssets = 0
  const save = (bytes: Uint8Array, name: string) => {
    args.signal?.throwIfAborted()
    const id = persistAsset(args.db, args.dataDir, bytes, name).entry.id
    args.reportProgress?.({ phase: 'assets', completedAssets: ++completedAssets })
    return id
  }
  args.reportProgress?.({ phase: 'read' })
  const reader = new StreamBytes(args.source, args.signal)
  if (args.kind === 'module') {
    let module: JsonRecord
    if (extension === 'risum') {
      module = await readRisumStream(reader, args.allowLowLevelAccess, save, args.maxExpandedBytes ?? Infinity)
    } else if (extension === 'json' || extension === 'lorebook') {
      module = convertJsonModule(parseJsonBytes(await reader.rest(args.maxExpandedBytes ?? Infinity), 'module'))
      assertModuleLowLevelAccessAllowed(module, args.allowLowLevelAccess)
    } else throw new ValidationError('Unsupported module file type')
    delete module.scriptModelOverrides
    module.id = randomUUID()
    normalizeScriptDefinitionCollection({ modules: [module] })
    return { module }
  }

  let card: unknown
  let mainImageId: string | undefined
  let moduleLorebook: unknown[] | undefined
  if (extension === 'charx' || extension === 'jpg' || extension === 'jpeg') {
    let moduleBytes: Buffer | undefined
    let openEntries = 0
    // Synchronous entry callbacks keep only one bounded entry alive. Input reads
    // await each push, so neither the network nor asset writes build a queue.
    await streamZip(
      completeZipSource(args.source),
      (file, fail) => {
        if (file.name.endsWith('/') || (file.name.endsWith('.json') && file.name !== 'card.json')) {
          file.ondata = (error) => {
            if (error) fail(error)
          }
          file.start()
          return
        }
        const drop = () => {
          if (!report.droppedArchiveEntries.includes(file.name)) report.droppedArchiveEntries.push(file.name)
          // Start or keep draining the decoder. terminate() alone leaves
          // unstarted compressed payloads retained by fflate.
          file.ondata = (error) => {
            if (error) fail(error)
          }
        }
        if ((file.originalSize ?? 0) > CHARACTER_CARD_MAX_ENTRY_BYTES) {
          drop()
          file.start()
          return
        }
        openEntries++
        let chunks: Buffer[] = []
        let size = 0
        file.ondata = (error, data, final) => {
          if (error) return fail(error)
          size += data.length
          if (size > CHARACTER_CARD_MAX_ENTRY_BYTES) {
            chunks = []
            openEntries--
            drop()
            return
          }
          if (data.length) chunks.push(Buffer.from(data))
          if (!final) return
          openEntries--
          try {
            const bytes = Buffer.concat(chunks, size)
            chunks = []
            if (file.name === 'card.json') {
              card = parseJsonBytes(bytes, 'card.json')
            } else if (file.name === 'module.risum') moduleBytes = bytes
            else {
              if (!size) throw new ValidationError('Character archive asset is empty')
              assetDict[file.name] = save(bytes, file.name)
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        }
        file.start()
      },
      (completedBytes) => {
        args.signal?.throwIfAborted()
        args.reportProgress?.({ phase: 'assets', completedBytes, completedAssets })
      },
    )
    if (openEntries !== 0) throw new ValidationError('Character archive ended unexpectedly')
    const record = readRecord(card, 'card.json')
    if (record.spec !== 'chara_card_v3') throw new ValidationError('Character archive card must be chara_card_v3')
    if (moduleBytes) {
      const parsed = parseRisum(moduleBytes, { db: args.db, dataDir: args.dataDir, persistAssets: false }).module
      const risuai = ensureRecordField(ensureRecordField(readRecord(record.data, 'card.data'), 'extensions'), 'risuai')
      if (Array.isArray(parsed.regex)) risuai.customScripts = cloneJson(parsed.regex)
      if (Array.isArray(parsed.trigger)) risuai.triggerscript = cloneJson(parsed.trigger)
      if (Array.isArray(parsed.lorebook)) moduleLorebook = cloneJson(parsed.lorebook)
      assertLowLevelAccessAllowed(card, args.allowLowLevelAccess)
      parseRisum(moduleBytes, { db: args.db, dataDir: args.dataDir, persistAssets: true })
    }
    removeDroppedCardAssets(card, report.droppedArchiveEntries)
  } else if (extension === 'png') {
    const signature = await reader.read(8)
    if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new ValidationError('Malformed PNG character card')
    const image = new StreamedPngImage()
    try {
      image.write(signature)
      let cardText = ''
      let v3Text = ''
      while (true) {
        const header = await reader.read(8)
        const length = header.readUInt32BE(0)
        const type = header.toString('ascii', 4)
        if (type === 'tEXt') {
          // PNG keywords are at most 79 bytes plus the separator. Identify the
          // payload before applying card-text or embedded-asset limits.
          const prefix = await reader.read(Math.min(length, 80))
          const separator = prefix.indexOf(0)
          const key = separator < 0 ? '' : prefix.toString('utf8', 0, separator)
          const valueLength = length - separator - 1
          const isCard = key === 'chara' || key === 'ccv3'
          const isAsset = key.startsWith('chara-ext-asset_')
          if ((isCard && valueLength <= CHARACTER_CARD_TEXT_BYTES) || isAsset) {
            const limit = Math.ceil((CHARACTER_CARD_MAX_ENTRY_BYTES * 4) / 3) + 1024
            if (isAsset && valueLength > limit) throw new ValidationError('PNG embedded asset exceeds size limit')
            const value = Buffer.concat([
              prefix.subarray(separator + 1),
              await reader.read(length - prefix.length, limit),
            ]).toString('utf8')
            if (key === 'chara') cardText = value
            else if (key === 'ccv3') v3Text = value
            else {
              const bytes = Buffer.from(value, 'base64')
              if (bytes.length > CHARACTER_CARD_MAX_ENTRY_BYTES)
                throw new ValidationError('PNG embedded asset exceeds size limit')
              assetDict[key.replace('chara-ext-asset_:', '').replace('chara-ext-asset_', '')] = save(bytes, 'asset.png')
            }
          } else {
            // Retain the old parser's handling of irrelevant or oversized card
            // text: ignore it and continue looking for usable card metadata.
            await reader.skip(length - prefix.length)
          }
          await reader.skip(4) // CRC (as in the retained parser, not validated here).
        } else {
          image.write(header)
          let remaining = length + 4
          while (remaining > 0) {
            const count = Math.min(remaining, CHARACTER_CARD_STREAM_CHUNK_BYTES)
            image.write(await reader.read(count))
            remaining -= count
          }
        }
        if (type === 'IEND') break
      }
      await reader.finish()
      const encoded = v3Text || cardText
      if (!encoded) throw new ValidationError('PNG character card metadata missing')
      card = encoded.startsWith('rcc||')
        ? await decodeEncryptedCard(encoded, args.password)
        : decodeBase64Json(encoded, 'PNG card metadata')
      assertLowLevelAccessAllowed(card, args.allowLowLevelAccess)
      args.signal?.throwIfAborted()
      mainImageId = image.register(args.db, args.dataDir)
      args.reportProgress?.({ phase: 'assets', completedAssets: ++completedAssets })
    } finally {
      image.dispose()
    }
  } else if (extension === 'json') {
    card = parseJsonBytes(await reader.rest(args.maxExpandedBytes ?? Infinity), 'character card')
  } else throw new ValidationError('Unsupported character card file type')
  assertLowLevelAccessAllowed(card, args.allowLowLevelAccess)
  dropOversizedInlineAssets(card, report)
  const character = await convertLocalCard(card, args, assetDict, mainImageId, extension === 'png')
  if (moduleLorebook)
    character.globalLore = repairLorebookEntries(moduleLorebook, `character ${String(character.chaId)}.globalLore`)
  return { character, report }
}

async function* completeZipSource(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  let tail = Buffer.alloc(0)
  for await (const chunk of source) {
    // EOCD plus the maximum ZIP comment; never retain the archive itself.
    tail =
      chunk.length >= 65557
        ? Buffer.from(chunk.subarray(chunk.length - 65557))
        : Buffer.concat([tail, chunk]).subarray(-65557)
    yield chunk
  }
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) return
  }
  throw new ValidationError('Character archive ended without a complete directory')
}

async function readRisumStream(
  reader: StreamBytes,
  allowLowLevelAccess: boolean | undefined,
  save: (bytes: Uint8Array, name: string) => string,
  maxMetadataBytes: number,
): Promise<JsonRecord> {
  const prefix = await reader.read(6)
  if (prefix[0] !== RISU_MODULE_MAGIC_BYTE || prefix[1] !== RISU_MODULE_VERSION)
    throw new ValidationError('Malformed module: invalid magic or version')
  const module = normalizeModuleMetadata(
    parseJsonBytes(decodeRpack(await reader.read(prefix.readUInt32LE(2), maxMetadataBytes)), 'module header'),
  )
  assertModuleLowLevelAccessAllowed(module, allowLowLevelAccess)
  const assets = normalizeModuleAssets(module.assets)
  let index = 0
  while (true) {
    const marker = (await reader.read(1))[0]
    if (marker === 0) break
    if (marker !== 1 || index >= assets.length) throw new ValidationError('Malformed module asset payload')
    const length = (await reader.read(4)).readUInt32LE(0)
    const decoded = decodeRpack(await reader.read(length, CHARACTER_CARD_MAX_ENTRY_BYTES))
    assets[index][1] = save(decoded, uploadFileNameForModuleAsset(assets[index][2], decoded))
    index++
  }
  if (index !== assets.length) throw new ValidationError('Module asset payload count does not match metadata')
  await reader.finish()
  module.assets = assets
  return module
}

export async function importLocalCharacterFile(args: {
  db: DatabaseSync
  dataDir: string
  filePath: string
  fileName: string
  allowLowLevelAccess?: boolean
  password?: string
  maxExpandedBytes?: number
  reportProgress?: (progress: LocalCharacterImportProgress) => void
  signal?: AbortSignal
}): Promise<LocalCharacterFileImportResult> {
  const reportStage = async (phase: LocalCharacterImportProgress['phase']) => {
    args.signal?.throwIfAborted()
    args.reportProgress?.({ phase })
    if (args.reportProgress) await yieldToIo()
    args.signal?.throwIfAborted()
  }
  await reportStage('read')
  const extension = fileExtension(args.fileName)
  const report: LocalFileImportReport = { droppedArchiveEntries: [], droppedInlineAssets: [] }

  if (extension === 'json') {
    const card = parseJsonFile(args.filePath, args.maxExpandedBytes, 'character card')
    dropOversizedInlineAssets(card, report)
    return {
      character: await convertLocalCard(card, args, {}, undefined, false),
      report,
    }
  }

  if (extension === 'charx' || extension === 'jpg' || extension === 'jpeg') {
    const totalBytes = fs.statSync(args.filePath).size
    const metadata = await readCharxMetadata(args.filePath, args.maxExpandedBytes, (completedBytes) => {
      args.signal?.throwIfAborted()
      args.reportProgress?.({ phase: 'read', completedBytes, totalBytes })
    })
    report.droppedArchiveEntries.push(...metadata.droppedEntries)
    const card = metadata.card
    removeDroppedCardAssets(card, metadata.droppedEntries)
    dropOversizedInlineAssets(card, report)
    let moduleLorebook: unknown[] | undefined
    if (metadata.moduleBytes) {
      const parsedModule = parseRisum(metadata.moduleBytes, {
        db: args.db,
        dataDir: args.dataDir,
        persistAssets: false,
      })
      const cardData = readRecord(card.data, 'card.data')
      const extensions = ensureRecordField(cardData, 'extensions')
      const risuai = ensureRecordField(extensions, 'risuai')
      if (Array.isArray(parsedModule.module.regex)) risuai.customScripts = cloneJson(parsedModule.module.regex)
      if (Array.isArray(parsedModule.module.trigger)) risuai.triggerscript = cloneJson(parsedModule.module.trigger)
      if (Array.isArray(parsedModule.module.lorebook)) moduleLorebook = cloneJson(parsedModule.module.lorebook)
    }

    // Check the confirmation boundary before writing any packaged assets.
    assertLowLevelAccessAllowed(card, args.allowLowLevelAccess)
    await reportStage('assets')
    const assetDict = await persistCharxAssets(args.filePath, {
      db: args.db,
      dataDir: args.dataDir,
      maxExpandedBytes: args.maxExpandedBytes,
      droppedEntries: report.droppedArchiveEntries,
      reportProgress: args.reportProgress,
      signal: args.signal,
      totalBytes,
    })
    if (metadata.moduleBytes) {
      parseRisum(metadata.moduleBytes, {
        db: args.db,
        dataDir: args.dataDir,
        persistAssets: true,
      })
    }
    const character = await convertLocalCard(card, args, assetDict)
    if (moduleLorebook) {
      character.globalLore = repairLorebookEntries(moduleLorebook, `character ${String(character.chaId)}.globalLore`)
    }
    return { character, report }
  }

  if (extension === 'png') {
    const bytes = readBoundedFile(args.filePath, args.maxExpandedBytes, 'character card')
    const parsed = await parsePngCharacterCard(bytes, args.password)
    dropOversizedInlineAssets(parsed.card, report)
    assertLowLevelAccessAllowed(parsed.card, args.allowLowLevelAccess)
    await reportStage('assets')
    const assetDict: Record<string, string> = {}
    let completedAssets = 0
    for (const asset of parsed.embeddedAssets) {
      args.signal?.throwIfAborted()
      assetDict[asset.key] = persistAsset(args.db, args.dataDir, asset.bytes, 'asset.png').entry.id
      args.reportProgress?.({ phase: 'assets', completedAssets: ++completedAssets })
      if (args.reportProgress) await yieldToIo()
    }
    args.signal?.throwIfAborted()
    const mainImageId = persistAsset(args.db, args.dataDir, parsed.imageBytes, 'character.png').entry.id
    args.reportProgress?.({ phase: 'assets', completedAssets: ++completedAssets })
    return {
      character: await convertLocalCard(parsed.card, args, assetDict, mainImageId, true),
      report,
    }
  }

  throw new ValidationError('Unsupported character card file type')
}

export async function importLocalModuleFile(args: {
  db: DatabaseSync
  dataDir: string
  filePath: string
  fileName: string
  allowLowLevelAccess?: boolean
  maxExpandedBytes?: number
}): Promise<LocalModuleFileImportResult> {
  const extension = fileExtension(args.fileName)
  let module: JsonRecord
  if (extension === 'risum') {
    const bytes = readBoundedFile(args.filePath, args.maxExpandedBytes, 'module')
    const inspected = parseRisum(bytes, { db: args.db, dataDir: args.dataDir, persistAssets: false })
    assertModuleLowLevelAccessAllowed(inspected.module, args.allowLowLevelAccess)
    module = parseRisum(bytes, { db: args.db, dataDir: args.dataDir, persistAssets: true }).module
    assertModuleLowLevelAccessAllowed(module, args.allowLowLevelAccess)
  } else if (extension === 'json' || extension === 'lorebook') {
    const raw = parseJsonFile(args.filePath, args.maxExpandedBytes, 'module')
    module = convertJsonModule(raw)
    assertModuleLowLevelAccessAllowed(module, args.allowLowLevelAccess)
  } else {
    throw new ValidationError('Unsupported module file type')
  }

  delete module.scriptModelOverrides
  module.id = randomUUID()
  normalizeScriptDefinitionCollection({ modules: [module] })
  return { module }
}

function convertJsonModule(value: unknown): JsonRecord {
  const input = readRecord(value, 'module import')
  if (input.type === 'risuModule') {
    return normalizeModuleMetadata(readOptionalRecord(input.module) ? input : { type: 'risuModule', module: input })
  }
  if (input.type === 'risu' && Array.isArray(input.data)) {
    return {
      name: readNonEmptyStringOr(input.name, 'Imported Lorebook'),
      description: readStringOr(input.description, 'Converted from risu lorebook'),
      lorebook: cloneJson(input.data),
      id: randomUUID(),
    }
  }
  if (input.entries && typeof input.entries === 'object' && !Array.isArray(input.entries)) {
    return {
      name: readNonEmptyStringOr(input.name, 'Imported Lorebook'),
      description: readStringOr(input.description, 'Converted from external lorebook'),
      lorebook: convertExternalLorebook(input.entries as JsonRecord),
      id: randomUUID(),
    }
  }
  if (input.type === 'regex' && Array.isArray(input.data)) {
    return {
      name: readNonEmptyStringOr(input.name, 'Imported Regex'),
      description: readStringOr(input.description, 'Converted from risu regex'),
      regex: cloneJson(input.data),
      id: randomUUID(),
    }
  }
  throw new ValidationError('Unsupported module import data')
}

function convertExternalLorebook(entries: JsonRecord): JsonRecord[] {
  const lorebook: JsonRecord[] = []
  for (const value of Object.values(entries)) {
    const entry = readOptionalRecord(value)
    if (!entry) continue
    const keys = readStringArray(entry.key ?? entry.keys ?? entry.keywords)
    const secondaryKeys = readStringArray(entry.secondary_keys)
    const contextConfig = readOptionalRecord(entry.contextConfig)
    lorebook.push({
      key: keys.join(', '),
      insertorder:
        readNumber(entry.order) ?? readNumber(entry.priority) ?? readNumber(contextConfig?.budgetPriority) ?? 0,
      comment: readString(entry.comment) || readString(entry.name) || readString(entry.displayName),
      content: readString(entry.content) || readString(entry.entry) || readString(entry.text),
      mode: 'normal',
      alwaysActive: entry.constant === true || entry.forceActivation === true,
      secondkey: secondaryKeys.join(', '),
      selective: entry.selective === true,
    })
  }
  return lorebook
}

async function convertLocalCard(
  rawCard: unknown,
  args: {
    db: DatabaseSync
    dataDir: string
    allowLowLevelAccess?: boolean
    reportProgress?: (progress: LocalCharacterImportProgress) => void
    signal?: AbortSignal
  },
  assetDict: Record<string, string>,
  mainImageId?: string,
  allowLooseOffSpec = false,
): Promise<JsonRecord> {
  args.signal?.throwIfAborted()
  args.reportProgress?.({ phase: 'convert' })
  if (args.reportProgress) await yieldToIo()
  const card = readRecord(rawCard, 'card')
  if (card.spec !== 'chara_card_v2' && card.spec !== 'chara_card_v3') {
    if (!allowLooseOffSpec && !isImportableOffSpecCard(card)) {
      throw new ValidationError('Unsupported character card data')
    }
    return convertOffSpecCard(card, mainImageId)
  }

  return convertRealmCharacterCard(card, {
    mainImageId,
    allowLowLevelAccess: args.allowLowLevelAccess,
    assetDict,
    storeAsset: async (source) => {
      args.signal?.throwIfAborted()
      const id = await storeLocalCardAsset(args.db, args.dataDir, source)
      if (args.reportProgress) await yieldToIo()
      return id
    },
  })
}

function isImportableOffSpecCard(card: JsonRecord): boolean {
  const data = card.spec_version === '2.0' ? readOptionalRecord(card.data) : card
  if (!data) return false
  return Boolean(
    (readString(data.char_name) || readString(data.name)) &&
    (readString(data.char_persona) || readString(data.description)) &&
    (readString(data.char_greeting) || readString(data.first_mes)),
  )
}

async function storeLocalCardAsset(db: DatabaseSync, dataDir: string, source: RealmAssetSource): Promise<string> {
  const bytes =
    source.kind === 'bytes'
      ? source.bytes
      : typeof source.id === 'string'
        ? Buffer.from(source.id, 'base64')
        : undefined
  if (!bytes || bytes.byteLength === 0) {
    throw new ValidationError('Character card asset is empty')
  }
  if (bytes.byteLength > CHARACTER_CARD_MAX_ENTRY_BYTES) {
    throw new ValidationError('Character card asset exceeds size limit')
  }
  return persistAsset(db, dataDir, bytes, source.fileName, source.contentType).entry.id
}

function assertLowLevelAccessAllowed(card: unknown, allowLowLevelAccess: boolean | undefined): void {
  const root = readOptionalRecord(card)
  const data = readOptionalRecord(root?.data)
  const extensions = readOptionalRecord(data?.extensions)
  const risuai = readOptionalRecord(extensions?.risuai)
  if (risuai?.lowLevelAccess === true && allowLowLevelAccess !== true) {
    throw new LowLevelAccessImportError()
  }
}

function assertModuleLowLevelAccessAllowed(module: JsonRecord, allowLowLevelAccess: boolean | undefined): void {
  if (Object.prototype.hasOwnProperty.call(module, 'mcp')) {
    const mcp = readOptionalRecord(module.mcp)
    const url = typeof mcp?.url === 'string' ? mcp.url.trim() : ''
    if (!isImportableMCPIdentifier(url)) throw new ValidationError('Module MCP URL is invalid')
    module.mcp = { url }
  }
  if (module.lowLevelAccess === true && allowLowLevelAccess !== true) {
    throw new LowLevelAccessImportError()
  }
}

function parseRisum(
  bytes: Uint8Array,
  options: { db: DatabaseSync; dataDir: string; persistAssets: boolean },
): { module: JsonRecord } {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  let position = 0
  const readByte = (): number => {
    if (position + 1 > buffer.length) throw new ValidationError('Malformed module: unexpected end of file')
    return buffer[position++]
  }
  const readLength = (): number => {
    if (position + 4 > buffer.length) throw new ValidationError('Malformed module: unexpected end of file')
    const value = buffer.readUInt32LE(position)
    position += 4
    return value
  }
  const readData = (length: number): Buffer => {
    if (!Number.isSafeInteger(length) || length < 0 || position + length > buffer.length) {
      throw new ValidationError('Malformed module: unexpected end of file')
    }
    const value = buffer.subarray(position, position + length)
    position += length
    return value
  }

  if (readByte() !== RISU_MODULE_MAGIC_BYTE) throw new ValidationError('Malformed module: invalid magic number')
  if (readByte() !== RISU_MODULE_VERSION) throw new ValidationError('Malformed module: invalid version')
  const header = parseJsonBytes(decodeRpack(readData(readLength())), 'module header')
  const module = normalizeModuleMetadata(header)
  const assets = normalizeModuleAssets(module.assets)
  let assetIndex = 0
  while (true) {
    const marker = readByte()
    if (marker === 0) break
    if (marker !== 1) throw new ValidationError('Malformed module: invalid asset marker')
    const encoded = readData(readLength())
    if (encoded.byteLength > CHARACTER_CARD_MAX_ENTRY_BYTES) {
      throw new ValidationError(`Module asset ${assetIndex + 1} exceeds size limit`)
    }
    if (assetIndex >= assets.length) throw new ValidationError('Module asset payload count does not match metadata')
    if (options.persistAssets) {
      const decoded = decodeRpack(encoded)
      const fileName = uploadFileNameForModuleAsset(assets[assetIndex][2], decoded)
      assets[assetIndex][1] = persistAsset(options.db, options.dataDir, decoded, fileName).entry.id
    }
    assetIndex += 1
  }
  if (position !== buffer.length) throw new ValidationError('Malformed module: trailing bytes')
  if (assetIndex !== assets.length) throw new ValidationError('Module asset payload count does not match metadata')
  module.assets = assets
  return { module }
}

function normalizeModuleMetadata(header: unknown): JsonRecord {
  const root = readRecord(header, 'module header')
  if (root.type !== 'risuModule') throw new ValidationError('Malformed module: invalid module type')
  const module = cloneJson(readRecord(root.module, 'module header.module'))
  if (typeof module.name !== 'string' || module.name.trim() === '') {
    throw new ValidationError('Malformed module: invalid module name')
  }
  if (typeof module.id !== 'string' || module.id.trim() === '') {
    throw new ValidationError('Malformed module: invalid module id')
  }
  const assets = normalizeModuleAssets(module.assets)
  if (assets.length > 0) module.assets = assets
  else delete module.assets
  delete module.scriptModelOverrides
  delete module.folderId
  return module
}

function normalizeModuleAssets(value: unknown): [string, string, string][] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ValidationError('Malformed module: invalid asset metadata')
  return value.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length < 2 || typeof raw[0] !== 'string' || typeof raw[1] !== 'string') {
      throw new ValidationError(`Malformed module: invalid asset metadata at index ${index}`)
    }
    if (raw[2] !== undefined && raw[2] !== null && typeof raw[2] !== 'string') {
      throw new ValidationError(`Malformed module: invalid asset filename at index ${index}`)
    }
    return [raw[0], raw[1], typeof raw[2] === 'string' ? raw[2] : '']
  })
}

async function readCharxMetadata(
  filePath: string,
  maxExpandedBytes: number | undefined,
  onBytes?: (bytes: number) => void,
): Promise<ParsedCharxMetadata> {
  let cardBytes: Buffer | null = null
  let moduleBytes: Buffer | null = null
  const droppedEntries: string[] = []
  let totalExpandedBytes = 0

  await streamZip(
    filePath,
    (file, fail) => {
      const collectCard = file.name === 'card.json'
      const collectModule = file.name === 'module.risum'
      if (!collectCard && !collectModule) {
        file.terminate()
        return
      }
      if ((file.originalSize ?? 0) > CHARACTER_CARD_MAX_ENTRY_BYTES) {
        droppedEntries.push(file.name)
        return
      }
      const chunks: Buffer[] = []
      let entryBytes = 0
      file.ondata = (error, data, final) => {
        if (error) return fail(error)
        entryBytes += data.byteLength
        totalExpandedBytes += data.byteLength
        if (entryBytes > CHARACTER_CARD_MAX_ENTRY_BYTES || exceedsFiniteLimit(totalExpandedBytes, maxExpandedBytes)) {
          if (!droppedEntries.includes(file.name)) droppedEntries.push(file.name)
          file.terminate()
          return
        }
        if (data.byteLength > 0) chunks.push(Buffer.from(data))
        if (final) {
          const bytes = Buffer.concat(chunks, entryBytes)
          if (collectCard) cardBytes = bytes
          else moduleBytes = bytes
        }
      }
      file.start()
    },
    onBytes,
  )

  if (!cardBytes) throw new ValidationError('Character archive must include card.json')
  const card = readRecord(parseJsonBytes(cardBytes, 'card.json'), 'card.json')
  if (card.spec !== 'chara_card_v3') throw new ValidationError('Character archive card must be chara_card_v3')
  return { card, moduleBytes, droppedEntries }
}

async function persistCharxAssets(
  filePath: string,
  options: {
    db: DatabaseSync
    dataDir: string
    maxExpandedBytes?: number
    droppedEntries: string[]
    reportProgress?: (progress: LocalCharacterImportProgress) => void
    signal?: AbortSignal
    totalBytes: number
  },
): Promise<Record<string, string>> {
  const assetDict: Record<string, string> = {}
  let totalExpandedBytes = 0
  let completedAssets = 0
  await streamZip(
    filePath,
    (file, fail) => {
      const shouldPersist = file.name !== 'card.json' && file.name !== 'module.risum' && !file.name.endsWith('.json')
      if (!shouldPersist) {
        file.terminate()
        return
      }
      if ((file.originalSize ?? 0) > CHARACTER_CARD_MAX_ENTRY_BYTES) {
        if (!options.droppedEntries.includes(file.name)) options.droppedEntries.push(file.name)
        return
      }
      const chunks: Buffer[] = []
      let entryBytes = 0
      let dropped = false
      file.ondata = (error, data, final) => {
        if (error) return fail(error)
        entryBytes += data.byteLength
        totalExpandedBytes += data.byteLength
        if (
          entryBytes > CHARACTER_CARD_MAX_ENTRY_BYTES ||
          exceedsFiniteLimit(totalExpandedBytes, options.maxExpandedBytes)
        ) {
          dropped = true
          if (!options.droppedEntries.includes(file.name)) options.droppedEntries.push(file.name)
          file.terminate()
          return
        }
        if (data.byteLength > 0) chunks.push(Buffer.from(data))
        if (final && !dropped) {
          const bytes = Buffer.concat(chunks, entryBytes)
          if (bytes.length === 0) return fail(new ValidationError(`Character archive asset is empty: ${file.name}`))
          options.signal?.throwIfAborted()
          assetDict[file.name] = persistAsset(options.db, options.dataDir, bytes, file.name).entry.id
          completedAssets += 1
        }
      }
      file.start()
    },
    (completedBytes) => {
      options.signal?.throwIfAborted()
      options.reportProgress?.({ phase: 'assets', completedBytes, totalBytes: options.totalBytes, completedAssets })
    },
  )
  return assetDict
}

async function streamZip(
  filePath: string | AsyncIterable<Uint8Array>,
  onFile: (file: fflate.UnzipFile, fail: (error: Error) => void) => void,
  onBytes?: (bytes: number) => void,
): Promise<void> {
  let parseError: Error | null = null
  const fail = (error: Error) => {
    parseError ??= error
  }
  try {
    const unzip = new fflate.Unzip()
    unzip.register(fflate.UnzipInflate)
    unzip.onfile = (file) => {
      if (parseError) return
      try {
        onFile(file, fail)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
    let completedBytes = 0
    for await (const chunk of typeof filePath === 'string'
      ? fs.createReadStream(filePath, { highWaterMark: CHARACTER_CARD_STREAM_CHUNK_BYTES })
      : filePath) {
      if (parseError) break
      unzip.push(chunk, false)
      completedBytes += chunk.byteLength
      onBytes?.(completedBytes)
      if (onBytes) await yieldToIo()
    }
    if (!parseError) unzip.push(new Uint8Array(), true)
    if (parseError) throw parseError
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError(
      error instanceof Error ? `Malformed character archive: ${error.message}` : 'Malformed character archive',
    )
  }
}

async function parsePngCharacterCard(bytes: Buffer, password: string | undefined): Promise<ParsedPngCard> {
  if (bytes.byteLength < 20 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new ValidationError('Malformed PNG character card')
  }
  const keptChunks: Buffer[] = [bytes.subarray(0, 8)]
  const embeddedAssets: Array<{ key: string; bytes: Buffer }> = []
  let cardText = ''
  let ccv3Text = ''
  let position = 8
  let sawEnd = false
  while (position + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(position)
    const end = position + 12 + length
    if (end > bytes.length) throw new ValidationError('Malformed PNG character card')
    const type = bytes.toString('ascii', position + 4, position + 8)
    if (type === 'tEXt') {
      const payload = bytes.subarray(position + 8, position + 8 + length)
      const separator = payload.indexOf(0)
      if (separator !== -1) {
        const key = payload.toString('utf8', 0, separator)
        const value = payload.toString('utf8', separator + 1)
        if (key === 'chara' && Buffer.byteLength(value) <= CHARACTER_CARD_TEXT_BYTES) cardText = value
        else if (key === 'ccv3' && Buffer.byteLength(value) <= CHARACTER_CARD_TEXT_BYTES) ccv3Text = value
        else if (key.startsWith('chara-ext-asset_')) {
          const assetKey = key.replace('chara-ext-asset_:', '').replace('chara-ext-asset_', '')
          const assetBytes = Buffer.from(value, 'base64')
          if (assetBytes.byteLength > CHARACTER_CARD_MAX_ENTRY_BYTES) {
            throw new ValidationError(`PNG embedded asset exceeds size limit: ${assetKey}`)
          }
          embeddedAssets.push({ key: assetKey, bytes: assetBytes })
        }
      }
    } else {
      keptChunks.push(bytes.subarray(position, end))
    }
    position = end
    if (type === 'IEND') {
      sawEnd = true
      break
    }
  }
  if (!sawEnd || (!cardText && !ccv3Text)) throw new ValidationError('PNG character card metadata missing')
  const encoded = ccv3Text || cardText
  const card = encoded.startsWith('rcc||')
    ? await decodeEncryptedCard(encoded, password)
    : decodeBase64Json(encoded, 'PNG card metadata')
  return { card, embeddedAssets, imageBytes: Buffer.concat(keptChunks) }
}

async function decodeEncryptedCard(encoded: string, password: string | undefined): Promise<unknown> {
  const parts = encoded.split('||')
  if (parts.length !== 5 || parts[1] !== 'rccv1') throw new ValidationError('Malformed encrypted character card')
  const encrypted = Buffer.from(parts[2], 'base64')
  if (createHash('sha256').update(encrypted).digest('hex') !== parts[3]) {
    throw new ValidationError('Malformed encrypted character card')
  }
  const metadata = readRecord(decodeBase64Json(parts[4], 'encrypted card metadata'), 'encrypted card metadata')
  if (metadata.usePassword === true && password === undefined) throw new CharacterPasswordRequiredError()
  const keyText = metadata.usePassword === true ? (password ?? '') : 'RISU_NONE'
  try {
    const keyHash = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(keyText))
    const key = await webcrypto.subtle.importKey('raw', keyHash, 'AES-GCM', false, ['decrypt'])
    const decrypted = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, encrypted)
    return JSON.parse(Buffer.from(decrypted).toString('utf8'))
  } catch {
    if (metadata.usePassword === true) throw new CharacterPasswordInvalidError()
    throw new ValidationError('Malformed encrypted character card')
  }
}

function convertOffSpecCard(card: JsonRecord, imageId?: string): JsonRecord {
  const legacyData = card.spec_version === '2.0' ? readOptionalRecord(card.data) : card
  const data = legacyData ?? card
  return {
    name: readString(data.name) || 'unknown name',
    firstMessage: readString(data.first_mes) || 'unknown first message',
    desc: readString(data.description),
    notes: '',
    chats: [{ id: randomUUID(), message: [], note: '', name: 'Chat 1', localLore: [], fmIndex: -1 }],
    chatPage: 0,
    image: imageId,
    notificationImage: '',
    emotionImages: [],
    bias: [],
    globalLore: [],
    viewScreen: 'none',
    chaId: randomUUID(),
    sdData: defaultSdData(),
    utilityBot: false,
    customscript: [],
    exampleMessage: readString(data.mes_example),
    creatorNotes: '',
    systemPrompt: readString(data.system_prompt),
    postHistoryInstructions: readString(data.post_history_instructions),
    alternateGreetings: [],
    tags: [],
    creator: '',
    characterVersion: '',
    personality: readString(data.personality),
    scenario: readString(data.scenario),
    firstMsgIndex: -1,
    replaceGlobalNote: '',
    triggerscript: [],
    customNotificationMessage: '',
    additionalText: '',
    chatFolders: [],
  }
}

function dropOversizedInlineAssets(card: unknown, report: LocalFileImportReport): void {
  const root = readOptionalRecord(card)
  const data = readOptionalRecord(root?.data)
  if (!Array.isArray(data?.assets)) return
  data.assets = data.assets.filter((asset, index) => {
    const record = readOptionalRecord(asset)
    const uri = typeof record?.uri === 'string' ? record.uri : ''
    if (!uri.startsWith('data:')) return true
    const base64 = uri.split(',', 2)[1] ?? ''
    if (base64.length < CHARACTER_CARD_MAX_ENTRY_BYTES) return true
    report.droppedInlineAssets.push({ index, name: readString(record?.name) })
    return false
  })
}

function removeDroppedCardAssets(card: unknown, droppedEntries: readonly string[]): void {
  if (droppedEntries.length === 0) return
  const dropped = new Set(droppedEntries)
  const root = readOptionalRecord(card)
  const data = readOptionalRecord(root?.data)
  if (!Array.isArray(data?.assets)) return
  data.assets = data.assets.filter((asset) => {
    const record = readOptionalRecord(asset)
    const uri = typeof record?.uri === 'string' ? record.uri : ''
    const key = uri.startsWith('__asset:')
      ? uri.slice('__asset:'.length)
      : uri.startsWith('embeded://')
        ? uri.slice('embeded://'.length)
        : ''
    return !key || !dropped.has(key)
  })
}

function defaultSdData(): [string, string][] {
  return [
    ['always', 'solo, 1girl'],
    ['negative', ''],
    ["|character's appearance", ''],
    ['current situation', ''],
    ["$character's pose", ''],
    ["$character's emotion", ''],
    ['current location', ''],
  ]
}

function persistAsset(
  db: DatabaseSync,
  dataDir: string,
  bytes: Uint8Array,
  fileName?: string,
  declaredContentType?: string,
): AddAssetResult {
  const contentType = resolveContentType(bytes, fileName, declaredContentType)
  return addAsset(db, dataDir, { bytes: Buffer.from(bytes), contentType })
}

function resolveContentType(bytes: Uint8Array, fileName?: string, declaredContentType?: string): string {
  const normalizedDeclared = declaredContentType?.split(';')[0].trim().toLowerCase()
  if (normalizedDeclared && CONTENT_TYPE_EXTENSIONS[normalizedDeclared]) return normalizedDeclared
  const extension = fileExtension(fileName ?? '')
  if (extension && EXTENSION_CONTENT_TYPES[extension]) return EXTENSION_CONTENT_TYPES[extension]
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'image/gif'
  return 'image/png'
}

function uploadFileNameForModuleAsset(fileName: string, data: Uint8Array): string {
  const extension = fileExtension(fileName)
  if (!extension || EXTENSION_CONTENT_TYPES[extension]) return fileName
  const inferred = CONTENT_TYPE_EXTENSIONS[resolveContentType(data)] ?? 'png'
  return `asset.${inferred}`
}

function decodeRpack(data: Uint8Array): Buffer {
  const result = Buffer.alloc(data.byteLength)
  for (let index = 0; index < data.byteLength; index += 1) result[index] = RPACK_DECODE_MAP[data[index]]
  return result
}

function parseJsonFile(filePath: string, maxBytes: number | undefined, label: string): unknown {
  return parseJsonBytes(readBoundedFile(filePath, maxBytes, label), label)
}

function readBoundedFile(filePath: string, maxBytes: number | undefined, label: string): Buffer {
  const size = fs.statSync(filePath).size
  if (exceedsFiniteLimit(size, maxBytes)) throw new ValidationError(`${label} exceeds size limit`)
  return fs.readFileSync(filePath)
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new ValidationError(`${label} must contain valid JSON`)
  }
}

function decodeBase64Json(value: string, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
  } catch {
    throw new ValidationError(`${label} must contain valid JSON`)
  }
}

function fileExtension(fileName: string): string {
  const extension = path.extname(fileName).slice(1).trim().toLowerCase()
  return extension
}

function ascii(data: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...data.subarray(start, end))
}

function exceedsFiniteLimit(bytes: number, limit: number | undefined): boolean {
  return limit !== undefined && Number.isFinite(limit) && bytes > limit
}

function readRecord(value: unknown, label: string): JsonRecord {
  const record = readOptionalRecord(value)
  if (!record) throw new ValidationError(`${label} must be an object`)
  return record
}

function readOptionalRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as JsonRecord
}

function ensureRecordField(record: JsonRecord, key: string): JsonRecord {
  const existing = readOptionalRecord(record[key])
  if (existing) return existing
  const created: JsonRecord = {}
  record[key] = created
  return created
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readNonEmptyStringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function readStringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
