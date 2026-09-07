import { resetClientSessionForTests } from './clientSession'
import {
  setManagedWriterForTest,
  setManagedReaderForTest,
  demoteAndRepromoteForTest,
} from './__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fflate from 'fflate'

const dbState = vi.hoisted(() => ({
  db: {
    characters: [] as any[],
    characterOrder: [] as any[],
  },
}))

const alertState = vi.hoisted(() => ({
  alertClear: vi.fn(),
  alertProgress: vi.fn(),
  alertConfirm: vi.fn(async () => true),
  alertStoreSet: vi.fn(),
  alertError: vi.fn(),
  alertNormal: vi.fn(),
  alertWait: vi.fn(),
}))

const globalApiState = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  saveAsset: vi.fn(),
  saveAssets: vi.fn(),
  readImage: vi.fn(),
}))

const characterCommandState = vi.hoisted(() => ({
  applyCharacterCreateOptimistically: vi.fn(),
  dispatchCreateCharacter: vi.fn(),
}))

const charxState = vi.hoisted(() => ({
  module: undefined as Record<string, unknown> | undefined,
}))

const filePickerState = vi.hoisted(() => ({
  selectFileByDom: vi.fn(),
}))

const localFileImportState = vi.hoisted(() => ({
  importLocalCharacterFileFromServer: vi.fn(),
}))

const clientIdentityState = vi.hoisted(() => ({ nextId: 0 }))

function ensureUniqueTestIds<T extends { id?: string }>(rows: T[], prefix: string): T[] {
  const seen = new Set<string>()
  for (const row of rows) {
    let id = typeof row.id === 'string' && row.id.trim() ? row.id : ''
    if (!id || seen.has(id)) id = `${prefix}-${++clientIdentityState.nextId}`
    row.id = id
    seen.add(id)
  }
  return rows
}

vi.mock('./alert', () => ({
  alertCardExport: vi.fn(),
  alertClear: alertState.alertClear,
  alertConfirm: alertState.alertConfirm,
  alertError: alertState.alertError,
  alertInput: vi.fn(async () => ''),
  alertMd: vi.fn(),
  alertNormal: alertState.alertNormal,
  alertProgress: alertState.alertProgress,
  alertStore: {
    set: alertState.alertStoreSet,
  },
  alertRealmTerms: vi.fn(),
  alertWait: alertState.alertWait,
}))

vi.mock('./globalApi.svelte', () => {
  class TestAppendableBuffer {
    deapended = 0
    #buffer = new Uint8Array(128)
    #byteLength = 0

    get buffer(): Uint8Array {
      return this.#buffer.slice(0, this.#byteLength)
    }

    append(data: Uint8Array) {
      const requiredLength = this.#byteLength + data.byteLength
      if (this.#buffer.byteLength < requiredLength) {
        let newLength = this.#buffer.byteLength * 2
        while (newLength < requiredLength) {
          newLength *= 2
        }
        const next = new Uint8Array(newLength)
        next.set(this.#buffer)
        this.#buffer = next
      }
      this.#buffer.set(data, this.#byteLength)
      this.#byteLength += data.byteLength
    }

    deappend(length: number) {
      this.#buffer = this.#buffer.slice(length)
      this.#byteLength -= length
      this.deapended += length
    }

    slice(start: number, end: number) {
      return this.buffer.slice(start - this.deapended, end - this.deapended)
    }

    length() {
      return this.#byteLength + this.deapended
    }

    clear() {
      this.#buffer = new Uint8Array(128)
      this.#byteLength = 0
      this.deapended = 0
    }
  }

  class TestWriter {
    chunks: Uint8Array[] = []
    async init() {}
    async write(data: Uint8Array) {
      this.chunks.push(data)
    }
    close() {}
  }

  return {
    AppendableBuffer: TestAppendableBuffer,
    BlankWriter: TestWriter,
    checkCharOrder: vi.fn(),
    downloadFile: globalApiState.downloadFile,
    loadAsset: vi.fn(),
    LocalWriter: TestWriter,
    openURL: vi.fn(),
    readImage: globalApiState.readImage,
    saveAsset: globalApiState.saveAsset,
    saveAssets: globalApiState.saveAssets,
    VirtualWriter: TestWriter,
  }
})

vi.mock('./util', () => ({
  blobToUint8Array: vi.fn(async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())),
  checkNullish: (data: unknown) => data === undefined || data === null,
  decryptBuffer: vi.fn(),
  isKnownUri: vi.fn(() => false),
  selectFileByDom: vi.fn(),
  sleep: vi.fn(),
}))

vi.mock('./filePicker', () => ({ selectFileByDom: filePickerState.selectFileByDom }))

vi.mock('src/lang', () => ({
  language: {
    errors: {
      noData: 'No data',
      wrongPassword: 'Wrong password',
    },
    characterImportProgress: {
      prepare: 'Preparing',
      upload: 'Uploading',
      processing: 'Processing',
      read: 'Reading',
      assets: 'Importing assets',
      convert: 'Converting',
      commit: 'Saving',
      refresh: 'Refreshing',
      assetsSaved: '{{count}} assets saved',
    },
    importedCharacter: 'Imported character',
    characterImportQueued: 'Imported character queued',
    characterImportFailed: 'Imported character failed',
    characterImportDroppedArchiveEntry: (fileName: string) => `Archive file: ${fileName}`,
    characterImportDroppedInlineAsset: (index: number, name: string) =>
      `Inline asset data.assets[${index}]${name ? ` (${name})` : ''}`,
    characterImportIncomplete: (details: string) => `Character imported with dropped content:\n${details}`,
    characterImportFailedAfterDroppedContent: (details: string) => `Character import failed:\n${details}`,
    inputCardPassword: 'Card password',
    lowLevelAccessConfirm: 'Low-level access?',
    successExport: 'Exported',
    successImport: 'Imported',
  },
}))

vi.mock('./storage/database.svelte', () => ({
  appVer: 'test',
  applyServerResourceDatabase: vi.fn(),
  defaultSdDataFunc: vi.fn(() => []),
  getCurrentCharacter: vi.fn(),
  importPreset: vi.fn(),
  setCurrentCharacter: vi.fn(),
}))

vi.mock('./characters', () => ({
  changeChar: vi.fn(),
  characterFormatUpdate: vi.fn(),
}))

vi.mock('./media', () => ({
  compressImage: vi.fn(async (data: Uint8Array) => data),
  getImageType: vi.fn(() => 'PNG'),
}))

vi.mock('./stores.svelte', () => {
  const store = () => ({
    set: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  })
  return {
    selectedCharID: store(),
    SettingsMenuIndex: store(),
    settingsOpen: store(),
  }
})

vi.mock('./parser/parser.svelte', () => ({
  hasher: vi.fn(async () => 'hash'),
}))

vi.mock('./process/files/inlays', () => ({
  reencodeImage: vi.fn(async (data: Uint8Array) => data),
}))

vi.mock('./process/modules', () => ({
  exportModule: vi.fn(async () => new Uint8Array([1])),
  readModule: vi.fn(async () => charxState.module),
}))

vi.mock('./characterCommands', () => ({
  applyCharacterCreateOptimistically: characterCommandState.applyCharacterCreateOptimistically,
  currentCharacterStateSnapshot: vi.fn(() => ({
    characters: [],
    characterOrder: [],
    selectedCharID: -1,
  })),
  dispatchCreateCharacter: characterCommandState.dispatchCreateCharacter,
  dispatchUpdateCharacter: vi.fn(),
}))

vi.mock('./server/resourceState.svelte', () => ({
  charactersResourceState: {
    get characters() {
      return dbState.db.characters
    },
    set characters(characters: any[]) {
      dbState.db.characters = characters
    },
    status: 'ready',
  },
  getCharacterResourceOwner: (characterId: string) => {
    const matches = dbState.db.characters.filter((candidate) => candidate?.chaId === characterId)
    return matches.length === 1 ? matches[0] : undefined
  },
  settingsResourceState: {
    get value() {
      return dbState.db
    },
    groupStatuses: { sidebar: 'ready' },
    status: 'ready',
  },
}))

vi.mock('./moduleCommands', () => ({
  createGlobalModule: vi.fn(),
}))

vi.mock('./server/realmImport', () => ({
  importRealmCharacterFromServer: vi.fn(),
}))

vi.mock('./server/localFileImport', () => ({
  importLocalCharacterFileFromServer: localFileImportState.importLocalCharacterFileFromServer,
}))

vi.mock('./server/resourceRefresh', () => ({
  forceServerResourceRefresh: vi.fn(),
}))

vi.mock('./server/commands', () => ({
  setCachedServerCommandRevision: vi.fn(),
}))

vi.mock('./server/chatMessageHydration.svelte', () => ({
  resetChatHydration: vi.fn(),
}))

vi.mock('./server/lorebookOwner.svelte', () => ({
  ensureClientLorebookEntryIds: (entries: Array<{ id?: string }>) => ensureUniqueTestIds(entries, 'lore'),
  recordHydratedCharacterLorebooks: vi.fn(),
  resetLorebookHydration: vi.fn(),
}))

vi.mock('./server/scriptDefinitionOwner.svelte', () => ({
  ensureClientScriptDefinitionIds: (entries: Array<{ id?: string }>) => ensureUniqueTestIds(entries, 'script'),
  ensureClientTriggerDefinitionIds: (entries: Array<{ id?: string }>) => ensureUniqueTestIds(entries, 'trigger'),
}))

vi.mock('./storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: vi.fn(async () => 'test-token'),
}))

import { createBaseV3, exportCharacterCard, importCharacter, importCharacterProcess } from './characterCards'
import { PngChunk } from './pngChunk'
import { DEFAULT_CHARX_MAX_ENTRY_SIZE_BYTES } from './process/processzip'

const BASE_PNG = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'),
)

let consoleLogSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetClientSessionForTests()
  dbState.db = {
    characters: [],
    characterOrder: [],
  }
  clientIdentityState.nextId = 0
  charxState.module = undefined
  filePickerState.selectFileByDom.mockReset()
  localFileImportState.importLocalCharacterFileFromServer.mockReset()
  localFileImportState.importLocalCharacterFileFromServer.mockResolvedValue({
    status: 'ok',
    revision: 12,
    event: { type: 'character.created', revision: 12, resource: 'character' },
    characterId: 'server-character',
    importReport: { droppedArchiveEntries: [], droppedInlineAssets: [] },
  })
  characterCommandState.applyCharacterCreateOptimistically.mockReset()
  characterCommandState.applyCharacterCreateOptimistically.mockImplementation((character: { chaId: string }) => {
    if (dbState.db.characters.some((candidate) => candidate?.chaId === character.chaId)) return -1
    dbState.db.characters.push(character)
    return dbState.db.characters.length - 1
  })
  characterCommandState.dispatchCreateCharacter.mockReset()
  characterCommandState.dispatchCreateCharacter.mockResolvedValue({
    status: 'accepted',
    result: {
      status: 'ok',
      revision: 11,
      event: { type: 'character.created', revision: 11, resource: 'character' },
    },
  })
  alertState.alertStoreSet.mockClear()
  alertState.alertProgress.mockClear()
  alertState.alertClear.mockClear()
  alertState.alertConfirm.mockClear()
  alertState.alertError.mockClear()
  alertState.alertNormal.mockClear()
  alertState.alertWait.mockClear()
  globalApiState.downloadFile.mockReset()
  globalApiState.saveAsset.mockReset()
  globalApiState.saveAsset.mockImplementation(async () => 'primary-image')
  globalApiState.saveAssets.mockReset()
  globalApiState.saveAssets.mockImplementation(async (assets: readonly { data: Uint8Array }[]) =>
    assets.map((asset, index) => `asset-${index}-${Buffer.from(asset.data).toString('hex')}`),
  )
  globalApiState.readImage.mockReset()
  globalApiState.readImage.mockImplementation(async () => BASE_PNG)
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  consoleLogSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('PNG character card import', () => {
  it('decodes and slices each PNG embedded asset value once during import', async () => {
    const fixture = await createPngCardFixture()
    const counters = installPngReadCounters(fixture.assetChunkTexts, fixture.assetBase64Values)

    try {
      await importCharacterProcess({
        name: 'multi-asset.png',
        data: fixture.png,
      })
    } finally {
      counters.restore()
    }

    for (const value of fixture.assetBase64Values) {
      expect(counters.valueDecodeCounts.get(value)).toBe(1)
    }
    for (const chunkText of fixture.assetChunkTexts) {
      expect(counters.chunkSliceCounts.get(chunkText)).toBe(1)
    }
    expect(globalApiState.saveAssets.mock.calls[0][0].map((asset) => Array.from(asset.data))).toEqual(
      fixture.assetPayloads.map((asset) => Array.from(asset)),
    )
  })

  it('preserves multi-asset PNG import output and progress order', async () => {
    const fixture = await createPngCardFixture()

    const imported = await importCharacterProcess({
      name: 'multi-asset.png',
      data: fixture.png,
    })

    expect(alertState.alertError).not.toHaveBeenCalled()
    expect(globalApiState.saveAsset).toHaveBeenCalledTimes(1)
    expect(globalApiState.saveAssets.mock.calls[0][0].map((asset) => Array.from(asset.data))).toEqual(
      fixture.assetPayloads.map((asset) => Array.from(asset)),
    )
    expect(dbState.db.characters).toHaveLength(1)
    expect(imported).toMatchObject({ status: 'accepted', characterId: dbState.db.characters[0].chaId })
    expect(dbState.db.characters[0]).toMatchObject({
      name: 'PNG Multi Asset',
      image: 'primary-image',
      emotionImages: [['smile', 'asset-0-070809']],
      additionalAssets: [['bonus', 'asset-1-01030507', 'webp']],
    })
    expect(dbState.db.characters[0].chats[0].id).toEqual(expect.any(String))
    expect(dbState.db.characters[0].globalLore.map((entry: { id?: string }) => entry.id)).toEqual([
      expect.any(String),
      expect.any(String),
    ])
    expect(new Set(dbState.db.characters[0].globalLore.map((entry: { id?: string }) => entry.id)).size).toBe(2)

    const progress = alertState.alertStoreSet.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.type === 'progress')
      .map((entry) => [entry.msg, entry.submsg])

    expect(progress).toEqual([
      ['Loading... (Loading Assets)', '0.00'],
      ['Loading... (Loading Assets)', '50.00'],
      ['Loading... (Saving Assets)', '0.00'],
      ['Loading... (Assets)', '50.00'],
      ['Loading... (Assets)', '100.00'],
    ])
    expect(alertState.alertNormal).toHaveBeenCalledWith('Imported character')
  })

  it('returns failed without a phantom character id when durable import creation rolls back', async () => {
    characterCommandState.dispatchCreateCharacter.mockImplementationOnce(async (character: { chaId: string }) => {
      dbState.db.characters = dbState.db.characters.filter((candidate) => candidate.chaId !== character.chaId)
      return {
        status: 'failed',
        result: { status: 'error', error: 'rejected import', reason: 'invalid-request' },
      }
    })

    const outcome = await importCharacterProcess({
      name: 'rejected.json',
      data: Buffer.from(JSON.stringify(characterCardFixture('Rejected'))),
    })

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(outcome).not.toHaveProperty('characterId')
    expect(dbState.db.characters).toEqual([])
    expect(alertState.alertNormal).not.toHaveBeenCalledWith('Imported character')
    expect(alertState.alertError).toHaveBeenCalledWith('Imported character failed\nrejected import')
  })

  it('returns queued without a character id and reports that the import is not yet accepted', async () => {
    characterCommandState.dispatchCreateCharacter.mockResolvedValueOnce({
      status: 'queued',
      result: { status: 'unavailable' },
    })

    const outcome = await importCharacterProcess({
      name: 'queued.json',
      data: Buffer.from(JSON.stringify(characterCardFixture('Queued'))),
    })

    expect(outcome).toEqual({ status: 'queued', result: { status: 'unavailable' } })
    expect(outcome).not.toHaveProperty('characterId')
    expect(dbState.db.characters).toHaveLength(1)
    expect(alertState.alertNormal).toHaveBeenCalledWith('Imported character queued')
    expect(alertState.alertNormal).not.toHaveBeenCalledWith('Imported character')
  })

  it('creates PNG card starter chats without generationSettings', async () => {
    const fixture = await createPngCardFixture({
      risuaiExtension: {
        generationSettings: {
          configured: true,
          personaId: 'source-persona',
          presetId: 'source-preset',
          jailbreakToggle: true,
          sidebarToggles: { mode: 'source' },
        },
      },
    })

    await importCharacterProcess({
      name: 'source-generation-settings.png',
      data: fixture.png,
    })

    const chat = dbState.db.characters[0].chats[0]
    expect(chat).toMatchObject({
      message: [],
      note: '',
      name: 'Chat 1',
      localLore: [],
      fmIndex: -1,
    })
    expect(chat).not.toHaveProperty('generationSettings')
  })

  it('normalizes v2 lore identities and carries the starter chat into character dispatch', async () => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'V2 JSON',
        description: 'desc',
        first_mes: 'hello',
        mes_example: '',
        personality: '',
        scenario: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '1',
        extensions: { risuai: {} },
        character_book: characterBookFixture(),
      },
    }

    await importCharacterProcess({ name: 'v2.json', data: Buffer.from(JSON.stringify(card)) })

    const imported = dbState.db.characters[0]
    expect(imported.globalLore).toHaveLength(2)
    expect(new Set(imported.globalLore.map((entry: { id?: string }) => entry.id)).size).toBe(2)
    expect(imported.chats[0].id).toEqual(expect.any(String))
    expect(characterCommandState.dispatchCreateCharacter).toHaveBeenCalledWith(imported, expect.anything())
  })

  it('preserves imported Agent-only activation fields and leaves native empty fields unchanged', async () => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Agent Input Card',
        description: 'desc',
        first_mes: 'hello',
        mes_example: '',
        personality: '',
        scenario: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '1',
        extensions: { risuai: {} },
        character_book: {
          entries: [
            {
              keys: ['/must-be-preserved/'],
              secondary_keys: ['also-preserved'],
              content: 'Agent reference',
              name: 'Reference Notes',
              insertion_order: 1,
              constant: true,
              selective: true,
              use_regex: true,
              extensions: { risu_agent_only: true },
            },
            {
              keys: [],
              secondary_keys: [],
              content: 'Native agent reference',
              name: 'Native Reference Notes',
              insertion_order: 2,
              constant: false,
              selective: false,
              use_regex: false,
              extensions: { risu_agent_only: true },
            },
          ],
        },
      },
    }

    await importCharacterProcess({ name: 'agent-input.json', data: Buffer.from(JSON.stringify(card)) })

    expect(dbState.db.characters[0].globalLore).toHaveLength(2)
    expect(dbState.db.characters[0].globalLore[0]).toMatchObject({
      comment: 'Reference Notes',
      agentOnly: true,
      key: '/must-be-preserved/',
      secondkey: 'also-preserved',
      alwaysActive: true,
      selective: true,
      useRegex: true,
    })
    expect(dbState.db.characters[0].globalLore[1]).toMatchObject({
      comment: 'Native Reference Notes',
      agentOnly: true,
      key: '',
      secondkey: '',
      alwaysActive: false,
      selective: false,
      useRegex: false,
    })
  })

  it('normalizes a charx module lorebook overlay after metadata replacement', async () => {
    const card = characterCardFixture('CharX Overlay')
    charxState.module = {
      id: 'module-source',
      name: 'Overlay',
      description: '',
      lorebook: [
        { id: 'duplicate', key: 'one', content: 'One' },
        { id: 'duplicate', key: 'two', content: 'Two' },
      ],
      regex: [{ comment: 'regex' }],
      trigger: [{ comment: 'trigger', type: 'manual', conditions: [], effect: [] }],
    }
    const archive = createCharXArchive({
      'card.json': Buffer.from(JSON.stringify(card)),
      'module.risum': new Uint8Array([1]),
    })

    await importCharacterProcess({ name: 'overlay.charx', data: archive })

    const imported = dbState.db.characters[0]
    const loreIds = imported.globalLore.map((entry: { id?: string }) => entry.id)
    expect(loreIds[0]).toBe('duplicate')
    expect(loreIds[1]).not.toBe('duplicate')
    expect(new Set(loreIds).size).toBe(2)
    expect(imported.customscript[0].id).toEqual(expect.any(String))
    expect(imported.triggerscript[0].id).toEqual(expect.any(String))
  })

  it('clears completed asset progress before requesting CharX low-level access confirmation', async () => {
    const card = characterCardFixture('CharX Low Level', { lowLevelAccess: true })
    card.data.assets = [
      { type: 'emotion', uri: 'embeded://assets/one.png', name: 'one', ext: 'png' },
      { type: 'icon', uri: 'embeded://assets/two.png', name: 'main', ext: 'png' },
    ]
    const archive = createCharXArchive({
      'card.json': Buffer.from(JSON.stringify(card)),
      'assets/one.png': new Uint8Array([1]),
      'assets/two.png': new Uint8Array([2]),
    })

    await importCharacterProcess({ name: 'low-level.charx', data: archive })

    const assetProgress = alertState.alertStoreSet.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.msg === 'Loading... (Assets)')
      .map((entry) => entry.submsg)
    expect(assetProgress).toEqual(['50.00', '100.00'])
    expect(alertState.alertClear).toHaveBeenCalledOnce()
    expect(alertState.alertConfirm).toHaveBeenCalledWith('Low-level access?')
    expect(alertState.alertClear.mock.invocationCallOrder[0]).toBeLessThan(
      alertState.alertConfirm.mock.invocationCallOrder[0],
    )
    expect(characterCommandState.dispatchCreateCharacter).toHaveBeenCalledOnce()
  })

  it('salvages a CharX whose oversized module is dropped and reports its exact path', async () => {
    const card = characterCardFixture('Oversized Module')
    const cardBytes = Buffer.from(JSON.stringify(card))
    const maxEntrySizeBytes = cardBytes.byteLength
    const archive = createCharXArchive({
      'card.json': cardBytes,
      'module.risum': new Uint8Array(maxEntrySizeBytes + 1),
    })

    await expect(
      importCharacterProcess(
        { name: 'oversized-module.charx', data: archive },
        { charXMaxEntrySizeBytes: maxEntrySizeBytes },
      ),
    ).resolves.toMatchObject({ status: 'accepted' })

    expect(dbState.db.characters).toHaveLength(1)
    expect(dbState.db.characters[0].name).toBe('Oversized Module')
    expect(characterCommandState.dispatchCreateCharacter).toHaveBeenCalledOnce()
    expect(alertState.alertError).toHaveBeenCalledWith(expect.stringContaining('module.risum'))
    expect(alertState.alertNormal).not.toHaveBeenCalled()
  })

  it('reports every oversized CharX entry while importing the readable card', async () => {
    const card = characterCardFixture('Multiple Oversized Entries')
    const cardBytes = Buffer.from(JSON.stringify(card))
    const maxEntrySizeBytes = cardBytes.byteLength
    const archive = createCharXArchive({
      'card.json': cardBytes,
      'module.risum': new Uint8Array(maxEntrySizeBytes + 1),
      'assets/also-too-large.png': new Uint8Array(maxEntrySizeBytes + 2),
    })

    await importCharacterProcess(
      { name: 'multiple-oversized.charx', data: archive },
      { charXMaxEntrySizeBytes: maxEntrySizeBytes },
    )

    const report = String(alertState.alertError.mock.calls[0]?.[0])
    expect(report).toContain('module.risum')
    expect(report).toContain('assets/also-too-large.png')
    expect(dbState.db.characters).toHaveLength(1)
  })

  it('salvages readable card data when a declared oversized asset is dropped', async () => {
    const card = characterCardFixture('Oversized Asset')
    card.data.assets = [{ type: 'emotion', uri: 'embeded://assets/oversized.png', name: 'oversized', ext: 'png' }]
    const cardBytes = Buffer.from(JSON.stringify(card))
    const maxEntrySizeBytes = cardBytes.byteLength
    const archive = createCharXArchive({
      'card.json': cardBytes,
      'assets/oversized.png': new Uint8Array(maxEntrySizeBytes + 1),
    })

    await expect(
      importCharacterProcess(
        { name: 'oversized-asset.charx', data: archive },
        { charXMaxEntrySizeBytes: maxEntrySizeBytes },
      ),
    ).resolves.toMatchObject({ status: 'accepted' })

    expect(dbState.db.characters).toHaveLength(1)
    expect(dbState.db.characters[0].emotionImages).toEqual([])
    expect(characterCommandState.dispatchCreateCharacter).toHaveBeenCalledOnce()
    expect(alertState.alertError).toHaveBeenCalledWith(expect.stringContaining('assets/oversized.png'))
    expect(alertState.alertNormal).not.toHaveBeenCalled()
  })

  it('drops an oversized inline data-URI asset and reports its exact index and name', async () => {
    const card = characterCardFixture('Oversized Data URI')
    card.data.assets = [
      {
        type: 'emotion',
        uri: 'data:application/octet-stream;base64,AQIDBA==',
        name: 'oversized-inline',
        ext: 'png',
      },
    ]
    const archive = createCharXArchive({ 'card.json': Buffer.from(JSON.stringify(card)) })

    await expect(
      importCharacterProcess({ name: 'oversized-inline.charx', data: archive }, { dataUriMaxBase64Length: 7 }),
    ).resolves.toMatchObject({ status: 'accepted' })

    expect(dbState.db.characters).toHaveLength(1)
    expect(dbState.db.characters[0].emotionImages).toEqual([])
    expect(globalApiState.saveAssets).not.toHaveBeenCalled()
    expect(characterCommandState.dispatchCreateCharacter).toHaveBeenCalledOnce()
    expect(alertState.alertError).toHaveBeenCalledWith(expect.stringContaining('data.assets[0] (oversized-inline)'))
    expect(alertState.alertNormal).not.toHaveBeenCalled()
  })

  it('still imports a complete CharX with a declared asset', async () => {
    const card = characterCardFixture('Complete CharX')
    card.data.assets = [{ type: 'emotion', uri: 'embeded://assets/smile.png', name: 'smile', ext: 'png' }]
    const archive = createCharXArchive({
      'card.json': Buffer.from(JSON.stringify(card)),
      'assets/smile.png': new Uint8Array([1, 2, 3]),
    })

    const imported = await importCharacterProcess({ name: 'complete.charx', data: archive })

    expect(imported).toMatchObject({ status: 'accepted', characterId: dbState.db.characters[0].chaId })
    expect(dbState.db.characters[0].emotionImages).toEqual([['smile', 'asset-0-010203']])
    expect(characterCommandState.dispatchCreateCharacter).toHaveBeenCalledOnce()
    expect(alertState.alertError).not.toHaveBeenCalled()
    expect(alertState.alertNormal).toHaveBeenCalledWith('Imported character')
  })

  it('maps packaged prebuilt exclusions to imported asset ids and drops stale legacy paths', async () => {
    const packagedReference = 'embeded://assets/other/image/bonus.webp'
    const staleLegacyReference = `assets/${'b'.repeat(64)}.webp`
    const card = characterCardFixture('Prebuilt Exclusion CharX', {
      prebuiltAssetExclude: [packagedReference, staleLegacyReference, packagedReference],
    })
    card.data.assets = [
      {
        type: 'x-risu-asset',
        uri: packagedReference,
        name: 'bonus',
        ext: 'webp',
      },
    ]
    const archive = createCharXArchive({
      'card.json': Buffer.from(JSON.stringify(card)),
      'assets/other/image/bonus.webp': new Uint8Array([1, 2, 3]),
    })

    await importCharacterProcess({ name: 'prebuilt-exclusion.charx', data: archive })

    const imported = dbState.db.characters[0]
    expect(imported.additionalAssets).toEqual([['bonus', 'asset-0-010203', 'webp']])
    expect(imported.prebuiltAssetExclude).toEqual(['asset-0-010203'])
    expect(characterCommandState.dispatchCreateCharacter).toHaveBeenCalledWith(imported, expect.any(Object))
  })

  it('shows upload bytes and server stages with the current filename', async () => {
    filePickerState.selectFileByDom.mockResolvedValueOnce([
      Object.assign(new Blob(['card']), { name: 'Progress.charx' }),
    ])
    localFileImportState.importLocalCharacterFileFromServer.mockImplementationOnce(async ({ onProgress }) => {
      onProgress({ phase: 'upload', completedBytes: 1048576, totalBytes: 2097152 })
      expect(alertState.alertProgress).toHaveBeenLastCalledWith('Uploading', 50, 'Progress.charx\n1.00 MiB / 2.00 MiB')
      onProgress({ phase: 'assets', completedAssets: 3 })
      expect(alertState.alertProgress).toHaveBeenLastCalledWith(
        'Importing assets',
        null,
        'Progress.charx\n3 assets saved',
      )
      onProgress({ phase: 'commit' })
      expect(alertState.alertProgress).toHaveBeenLastCalledWith('Saving', null, 'Progress.charx')
      return { status: 'error', error: 'Server rejected card' }
    })
    await expect(importCharacter()).resolves.toMatchObject({ status: 'failed' })
    expect(alertState.alertError).toHaveBeenCalledWith(expect.stringContaining('Server rejected card'))
    expect(alertState.alertNormal).not.toHaveBeenCalled()
  })

  it('clears the progress dialog before confirmation and keeps progress on the JSON retry', async () => {
    filePickerState.selectFileByDom.mockResolvedValueOnce([Object.assign(new Blob(['card']), { name: 'Confirm.json' })])
    localFileImportState.importLocalCharacterFileFromServer.mockResolvedValueOnce({
      status: 'low-level-access',
      pendingImportToken: 'pending',
    })
    await expect(importCharacter()).resolves.toMatchObject({ status: 'accepted' })
    expect(alertState.alertClear.mock.invocationCallOrder[0]).toBeLessThan(
      alertState.alertConfirm.mock.invocationCallOrder[0],
    )
    expect(localFileImportState.importLocalCharacterFileFromServer.mock.calls[1][0]).toEqual({
      pendingImportToken: 'pending',
      password: undefined,
      allowLowLevelAccess: true,
      onProgress: expect.any(Function),
    })
  })

  it('surfaces the server CharX salvage report through the importCharacter alert boundary', async () => {
    const cardBytes = Buffer.from(JSON.stringify(characterCardFixture('Alert Boundary')))
    const archive = concatBytes([
      storedLocalFile('module.risum', new Uint8Array(), DEFAULT_CHARX_MAX_ENTRY_SIZE_BYTES + 1, 0),
      storedLocalFile('card.json', cardBytes),
    ])
    const selectedFile = Object.assign(archive, { name: 'oversized-module.charx' })
    filePickerState.selectFileByDom.mockResolvedValueOnce([selectedFile])
    localFileImportState.importLocalCharacterFileFromServer.mockResolvedValueOnce({
      status: 'ok',
      revision: 12,
      event: { type: 'character.created', revision: 12, resource: 'character' },
      characterId: 'server-character',
      importReport: { droppedArchiveEntries: ['module.risum'], droppedInlineAssets: [] },
    })

    await expect(importCharacter()).resolves.toMatchObject({ status: 'accepted' })

    expect(localFileImportState.importLocalCharacterFileFromServer).toHaveBeenCalledWith({
      file: selectedFile,
      fileName: 'oversized-module.charx',
      onProgress: expect.any(Function),
    })
    expect(alertState.alertError).toHaveBeenCalledOnce()
    const surfacedReport = String(alertState.alertError.mock.calls[0][0])
    expect(surfacedReport).toContain('module.risum')
    expect(globalApiState.saveAssets).not.toHaveBeenCalled()
    expect(characterCommandState.dispatchCreateCharacter).not.toHaveBeenCalled()
    expect(alertState.alertNormal).not.toHaveBeenCalled()
  })
})

describe('character card export assets', () => {
  it('writes cloned emotion and additional assets as PNG chunks without mutating source arrays', async () => {
    const char = createExportCharacter()
    char.scriptModelOverrides = {
      llmProfileId: 'local-main-profile',
      axLlmProfileId: 'local-aux-profile',
    }
    const originalEmotions = structuredClone(char.emotionImages)
    const originalAdditionalAssets = structuredClone(char.additionalAssets)
    const writer = new CaptureWriter()

    globalApiState.readImage.mockImplementation(async (key: string) => readExportFixtureAsset(key))

    await exportCharacterCard(char, 'png', { spec: 'v2', writer: writer as any })

    expect(alertState.alertError).not.toHaveBeenCalled()
    expect(char.emotionImages).toEqual(originalEmotions)
    expect(char.additionalAssets).toEqual(originalAdditionalAssets)

    const png = new Uint8Array(Buffer.concat(writer.chunks.map((chunk) => Buffer.from(chunk))))
    const chunks = PngChunk.read(png, ['chara-ext-asset_:1', 'chara-ext-asset_:2', 'chara'])
    expect(chunks['chara-ext-asset_:1']).toBe(Buffer.from(EXPORT_EMOTION_BYTES).toString('base64'))
    expect(chunks['chara-ext-asset_:2']).toBe(Buffer.from(EXPORT_ADDITIONAL_BYTES).toString('base64'))

    const card = JSON.parse(Buffer.from(chunks.chara, 'base64').toString('utf-8'))
    expect(JSON.stringify(card)).not.toContain('local-main-profile')
    expect(JSON.stringify(card)).not.toContain('local-aux-profile')
    expect(card.data.extensions.risuai.emotions).toEqual([['happy', '__asset:1']])
    expect(card.data.extensions.risuai.additionalAssets).toEqual([['theme', '__asset:2', 'css']])
  })

  it('rewrites v3 CharX prebuilt exclusions to the packaged asset URI', async () => {
    const char = createExportCharacter()
    char.prebuiltAssetExclude = ['theme-asset']
    const writer = new CaptureWriter()
    globalApiState.readImage.mockImplementation(async (key: string) => readExportFixtureAsset(key))

    await exportCharacterCard(char, 'charx', { spec: 'v3', writer: writer as any })

    expect(alertState.alertError).not.toHaveBeenCalled()
    const archive = new Uint8Array(Buffer.concat(writer.chunks.map((chunk) => Buffer.from(chunk))))
    const entries = fflate.unzipSync(archive)
    const card = JSON.parse(Buffer.from(entries['card.json']).toString('utf-8'))
    const additionalAsset = card.data.assets.find((asset: { name?: string }) => asset.name === 'theme')
    expect(additionalAsset.uri).toMatch(/^embeded:\/\/assets\/other\/other\/theme\.css$/)
    expect(card.data.extensions.risuai.prebuiltAssetExclude).toEqual([additionalAsset.uri])
  })

  it('inlines v2 JSON export assets instead of leaving dangling chunk references', async () => {
    const char = createExportCharacter()
    const originalEmotions = structuredClone(char.emotionImages)
    const originalAdditionalAssets = structuredClone(char.additionalAssets)

    globalApiState.readImage.mockImplementation(async (key: string) => readExportFixtureAsset(key))

    await exportCharacterCard(char, 'json', { spec: 'v2' })

    expect(alertState.alertError).not.toHaveBeenCalled()
    expect(char.emotionImages).toEqual(originalEmotions)
    expect(char.additionalAssets).toEqual(originalAdditionalAssets)
    expect(globalApiState.downloadFile).toHaveBeenCalledTimes(1)

    const exportedBytes = globalApiState.downloadFile.mock.calls[0][1] as Uint8Array
    const card = JSON.parse(Buffer.from(exportedBytes).toString('utf-8'))
    expect(JSON.stringify(card)).not.toContain('__asset:')
    expect(card.data.extensions.risuai.emotions).toEqual([
      ['happy', Buffer.from(EXPORT_EMOTION_BYTES).toString('base64')],
    ])
    expect(card.data.extensions.risuai.additionalAssets).toEqual([
      ['theme', Buffer.from(EXPORT_ADDITIONAL_BYTES).toString('base64'), 'css'],
    ])
  })

  it('exports Agent-only lorebook entries as inert without mutating the character', async () => {
    const char = createExportCharacter()
    char.globalLore = [
      {
        id: 'agent-reference',
        key: 'must-be-preserved',
        secondkey: 'also-preserved',
        insertorder: 100,
        comment: 'Reference Notes',
        content: 'Agent reference',
        mode: 'normal',
        alwaysActive: true,
        selective: true,
        useRegex: true,
        agentOnly: true,
      },
      {
        id: 'native-agent-reference',
        key: '',
        secondkey: '',
        insertorder: 100,
        comment: 'Native Reference Notes',
        content: 'Native agent reference',
        mode: 'normal',
        alwaysActive: false,
        selective: false,
        useRegex: false,
        agentOnly: true,
      },
    ]
    globalApiState.readImage.mockImplementation(async (key: string) => readExportFixtureAsset(key))
    const originalLore = structuredClone(char.globalLore)

    await exportCharacterCard(char, 'json', { spec: 'v2' })

    const exportedBytes = globalApiState.downloadFile.mock.calls[0][1] as Uint8Array
    const entries = JSON.parse(Buffer.from(exportedBytes).toString('utf-8')).data.character_book.entries
    expect(entries[0]).toMatchObject({
      keys: [],
      secondary_keys: [],
      constant: false,
      selective: true,
      extensions: { risu_agent_only: true },
    })
    expect(entries[1]).toMatchObject({
      keys: [],
      constant: false,
      selective: false,
      extensions: { risu_agent_only: true },
    })
    expect(entries[1].secondary_keys).toEqual([])
    expect(char.globalLore).toEqual(originalLore)
  })

  it('neutralizes Agent-only activation fields in v3 card output without changing internal state', () => {
    const char = createExportCharacter()
    char.globalLore = [
      {
        id: 'agent-reference',
        key: '/must-be-preserved/',
        secondkey: 'also-preserved',
        insertorder: 100,
        comment: 'Reference Notes',
        content: 'Agent reference',
        mode: 'normal',
        alwaysActive: true,
        selective: true,
        useRegex: true,
        agentOnly: true,
      },
    ]

    const originalLore = structuredClone(char.globalLore)
    expect(createBaseV3(char).data.character_book?.entries[0]).toMatchObject({
      keys: [],
      secondary_keys: [],
      constant: false,
      selective: true,
      use_regex: true,
      extensions: { risu_agent_only: true },
    })
    expect(char.globalLore).toEqual(originalLore)
  })
})

function createCharXArchive(entries: Record<string, Uint8Array>): Uint8Array {
  return fflate.zipSync(entries, { level: 0 })
}

function writeUint16LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
}

function writeUint32LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
  target[offset + 2] = (value >>> 16) & 0xff
  target[offset + 3] = (value >>> 24) & 0xff
}

function storedLocalFile(
  name: string,
  data: Uint8Array,
  originalSize = data.byteLength,
  compressedSize = data.byteLength,
): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const output = new Uint8Array(30 + nameBytes.byteLength + data.byteLength)
  writeUint32LE(output, 0, 0x04034b50)
  writeUint16LE(output, 4, 20)
  writeUint16LE(output, 6, 0)
  writeUint16LE(output, 8, 0)
  writeUint32LE(output, 14, 0)
  writeUint32LE(output, 18, compressedSize)
  writeUint32LE(output, 22, originalSize)
  writeUint16LE(output, 26, nameBytes.byteLength)
  writeUint16LE(output, 28, 0)
  output.set(nameBytes, 30)
  output.set(data, 30 + nameBytes.byteLength)
  return output
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

async function createPngCardFixture(options: { risuaiExtension?: Record<string, unknown> } = {}) {
  const assetPayloads = [new Uint8Array([7, 8, 9]), new Uint8Array([1, 3, 5, 7])]
  const assetBase64Values = assetPayloads.map((asset) => Buffer.from(asset).toString('base64'))
  const card = characterCardFixture('PNG Multi Asset', options.risuaiExtension)
  card.data.assets = [
    {
      type: 'emotion',
      uri: '__asset:1',
      name: 'smile',
      ext: 'png',
    },
    {
      type: 'x-risu-asset',
      uri: '__asset:2',
      name: 'bonus',
      ext: 'webp',
    },
  ]
  const chunks = {
    'chara-ext-asset_:1': assetBase64Values[0],
    'chara-ext-asset_:2': assetBase64Values[1],
    ccv3: Buffer.from(JSON.stringify(card)).toString('base64'),
  }
  const png = await PngChunk.write(BASE_PNG, chunks)
  if (!png) {
    throw new Error('failed to build PNG fixture')
  }

  return {
    assetBase64Values,
    assetChunkTexts: [
      `chara-ext-asset_:1\u0000${assetBase64Values[0]}`,
      `chara-ext-asset_:2\u0000${assetBase64Values[1]}`,
    ],
    assetPayloads,
    png: new Uint8Array(png),
  }
}

function characterCardFixture(name: string, risuaiExtension: Record<string, unknown> = {}) {
  return {
    spec: 'chara_card_v3',
    data: {
      name,
      description: 'desc',
      first_mes: 'hello',
      mes_example: '',
      personality: '',
      scenario: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1',
      extensions: {
        risuai: risuaiExtension,
      },
      character_book: characterBookFixture(),
      assets: [] as Array<Record<string, string>>,
    },
  }
}

function characterBookFixture() {
  return {
    entries: [
      { keys: ['one'], secondary_keys: [], content: 'One', name: 'One', insertion_order: 1, constant: false },
      { keys: ['two'], secondary_keys: [], content: 'Two', name: 'Two', insertion_order: 2, constant: true },
    ],
  }
}

function installPngReadCounters(assetChunkTexts: string[], assetBase64Values: string[]) {
  const RealTextDecoder = globalThis.TextDecoder
  const realDecoder = new RealTextDecoder()
  const valueDecodeCounts = new Map(assetBase64Values.map((value) => [value, 0]))
  const chunkSliceCounts = new Map(assetChunkTexts.map((value) => [value, 0]))

  class CountingTextDecoder extends RealTextDecoder {
    decode(input?: Parameters<TextDecoder['decode']>[0], options?: TextDecodeOptions): string {
      const value = super.decode(input, options)
      if (valueDecodeCounts.has(value)) {
        valueDecodeCounts.set(value, valueDecodeCounts.get(value)! + 1)
      }
      return value
    }
  }

  vi.stubGlobal('TextDecoder', CountingTextDecoder)

  const originalSlice = Uint8Array.prototype.slice
  const sliceSpy = vi.spyOn(Uint8Array.prototype, 'slice').mockImplementation(function (
    this: Uint8Array,
    start?: number,
    end?: number,
  ): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(originalSlice.call(this, start, end))
    const value = realDecoder.decode(result)
    if (chunkSliceCounts.has(value)) {
      chunkSliceCounts.set(value, chunkSliceCounts.get(value)! + 1)
    }
    return result
  })

  return {
    chunkSliceCounts,
    valueDecodeCounts,
    restore() {
      sliceSpy.mockRestore()
      vi.unstubAllGlobals()
    },
  }
}

const EXPORT_EMOTION_BYTES = new Uint8Array([1, 2, 3])
const EXPORT_ADDITIONAL_BYTES = new Uint8Array([4, 5, 6])

class CaptureWriter {
  chunks: Uint8Array[] = []

  async init() {}

  async write(data: Uint8Array) {
    this.chunks.push(data)
  }

  close() {}
}

function readExportFixtureAsset(key: string): Uint8Array {
  if (key === 'portrait') {
    return BASE_PNG
  }
  if (key === 'happy-asset') {
    return EXPORT_EMOTION_BYTES
  }
  if (key === 'theme-asset') {
    return EXPORT_ADDITIONAL_BYTES
  }
  return BASE_PNG
}

function createExportCharacter(): any {
  return {
    name: 'Asset Export',
    image: 'portrait',
    firstMessage: 'hello',
    desc: 'desc',
    notes: '',
    chats: [],
    chatFolders: [],
    chatPage: 0,
    viewScreen: 'none',
    bias: [],
    emotionImages: [['happy', 'happy-asset']],
    globalLore: [],
    chaId: 'character-id',
    sdData: [],
    customscript: [],
    triggerscript: [],
    utilityBot: false,
    exampleMessage: '',
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    tags: [],
    creator: '',
    characterVersion: '',
    personality: '',
    scenario: '',
    firstMsgIndex: -1,
    additionalAssets: [['theme', 'theme-asset', 'css']],
    replaceGlobalNote: '',
  }
}

describe('browser card parser writer lifecycle', () => {
  it('does not parse or create a character as a Reader', async () => {
    setManagedReaderForTest()
    await expect(
      importCharacterProcess({ name: 'card.json', data: Buffer.from(JSON.stringify(characterCardFixture('Reader'))) }),
    ).resolves.toBeNull()
    expect(globalApiState.saveAsset).not.toHaveBeenCalled()
    expect(globalApiState.saveAssets).not.toHaveBeenCalled()
    expect(characterCommandState.applyCharacterCreateOptimistically).not.toHaveBeenCalled()
    expect(characterCommandState.dispatchCreateCharacter).not.toHaveBeenCalled()
  })

  it('does not save PNG assets or create a character when delayed parsing resumes after re-promotion', async () => {
    const fixture = await createPngCardFixture()
    setManagedWriterForTest()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const data = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    })
    const reading = vi.spyOn(PngChunk, 'readGenerator')
    try {
      const pending = importCharacterProcess({ name: 'held.png', data })
      await vi.waitFor(() => expect(reading).toHaveBeenCalled())
      demoteAndRepromoteForTest()
      controller.enqueue(fixture.png)
      controller.close()
      await expect(pending).resolves.toBeNull()
      expect(globalApiState.saveAsset).not.toHaveBeenCalled()
      expect(globalApiState.saveAssets).not.toHaveBeenCalled()
      expect(characterCommandState.applyCharacterCreateOptimistically).not.toHaveBeenCalled()
      expect(characterCommandState.dispatchCreateCharacter).not.toHaveBeenCalled()
      expect(alertState.alertNormal).not.toHaveBeenCalled()
    } finally {
      reading.mockRestore()
    }
  })

  it('preserves a managed writer CharX import with embedded assets', async () => {
    setManagedWriterForTest()
    const card = characterCardFixture('Managed CharX')
    card.data.assets = [{ type: 'icon', uri: 'embeded://assets/main.png', name: 'main', ext: 'png' }]
    const archive = createCharXArchive({
      'card.json': Buffer.from(JSON.stringify(card)),
      'assets/main.png': new Uint8Array([1, 2, 3]),
    })
    await expect(importCharacterProcess({ name: 'writer.charx', data: archive })).resolves.toMatchObject({
      status: 'accepted',
    })
    expect(globalApiState.saveAssets).toHaveBeenCalledOnce()
    expect(characterCommandState.dispatchCreateCharacter).toHaveBeenCalledOnce()
    expect(dbState.db.characters[0].name).toBe('Managed CharX')
  })
})
