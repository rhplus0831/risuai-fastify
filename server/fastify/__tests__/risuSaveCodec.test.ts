import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { risuSaveFixtureCases } from '../__fixtures__/risuSave/fixtures.js'
import { classifyRisuSaveEnvelope, inspectRisuSaveBlockFixtureEnvelope } from '../src/risuSave/fixtureHarness.js'
import {
  decodeRisuSaveBlockEnvelope,
  encodeRisuSaveBlockEnvelope,
  RISUSAVE_BLOCK_DIRECTORY_MAX_ENTRIES,
  RISUSAVE_BLOCK_MAX_COUNT,
  RISUSAVE_BLOCK_NAME_MAX_BYTES,
  RisuSaveBlockType,
} from '../src/risuSave/blockCodec.js'
import {
  decodeLegacyRisuSaveEnvelope,
  encodeLegacyRisuSaveEnvelope,
  RISUSAVE_BLOCK_HEADER,
} from '../src/risuSave/legacyEnvelopeCodec.js'
import {
  RISUSAVE_INCOMPLETE_BLOCKS_ERROR,
  UnsupportedGroupCharactersError,
  decodeRisuSaveImportSnapshot,
  normalizeRisuSaveImportDatabase,
} from '../src/risuSave/importSnapshot.js'
import {
  buildRisuSaveExportBlocks,
  buildRisuSaveExportSnapshotFromPersisted,
  encodeRisuSaveBlockExportSnapshot,
  encodeRisuSaveLegacyExportSnapshot,
  encodeRepositoryRisuSaveBlockExport,
  encodeRepositoryRisuSaveLegacyExport,
} from '../src/risuSave/exportSnapshot.js'
import { RISU_SERVER_DATA_KEY } from '../src/risuSave/portableMetadata.js'
import { applyImport, listBackups, loadPersistedWithMessages, writePersistedWithMessages } from '../src/repository.js'
import { openDatabase } from '../src/db.js'
import {
  getGreetingTranslation,
  sourceHash,
  upsertGreetingTranslation,
} from '../src/translation/greetingTranslationStore.js'
import {
  EXPECTED_CANONICAL_OWNER_PERSISTENCE_SNAPSHOT,
  canonicalOwnerPersistenceDatabase,
  canonicalOwnerPersistenceSnapshot,
} from './helpers/canonicalOwnerPersistence.js'

const dataDirs: string[] = []

describe('legacy stop-string import repair', () => {
  it.each([
    { ext: 0, data: [0] },
    { type: 0, data: { type: 'Buffer', data: [0] } },
  ])('removes wrapped undefined from every settings/preset owner in JSON and binary imports: %j', (marker) => {
    const input = {
      characters: [],
      localStopStrings: marker,
      botPresets: [{ id: 'legacy', localStopStrings: marker }],
      modelPresets: [
        { id: 'model', localStopStrings: marker },
        { id: 'custom', localStopStrings: ['STOP'] },
      ],
      promptPresets: [
        { id: 'prompt', localStopStrings: marker, overrideModelParameters: true },
        { id: 'disabled', localStopStrings: null },
      ],
    }
    for (const source of [input, decodeLegacyRisuSaveEnvelope(encodeLegacyRisuSaveEnvelope(input))]) {
      const normalized = normalizeRisuSaveImportDatabase(source)
      expect(normalized).not.toHaveProperty('localStopStrings')
      for (const key of ['botPresets', 'modelPresets', 'promptPresets']) {
        expect((normalized[key] as Record<string, unknown>[])[0]).not.toHaveProperty('localStopStrings')
      }
      expect((normalized.modelPresets as Record<string, unknown>[])[1].localStopStrings).toEqual(['STOP'])
      expect((normalized.promptPresets as Record<string, unknown>[])[1].localStopStrings).toBeNull()
      expect((normalized.promptPresets as Record<string, unknown>[])[0].overrideModelParameters).toBe(true)
    }
    expect(input.localStopStrings).toBe(marker)
  })
})

describe('translator preset chat binding import normalization', () => {
  it('keeps bindings backed by the imported collection and clears missing ids', () => {
    const normalized = normalizeRisuSaveImportDatabase({
      translatorPresets: [{ id: 'translator-a', name: 'A', prompt: 'Translate', maxResponse: 128 }],
      translatorPresetId: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-valid',
              name: 'Valid',
              note: '',
              message: [],
              localLore: [],
              translatorPresetId: 'translator-a',
            },
            {
              id: 'chat-missing',
              name: 'Missing',
              note: '',
              message: [],
              localLore: [],
              translatorPresetId: 'translator-missing',
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const chats = (normalized.characters as Array<{ chats: Array<Record<string, unknown>> }>)[0].chats

    expect(chats[0].translatorPresetId).toBe('translator-a')
    expect(chats[1]).not.toHaveProperty('translatorPresetId')
  })
})

describe('loadout import normalization', () => {
  it('repairs stable ids deterministically and preserves the explicit last-touch name', () => {
    const decoded = decodeRisuSaveImportSnapshot(
      encodeLegacyRisuSaveEnvelope(
        {
          characters: [],
          loadouts: [
            { name: 'Missing id' },
            { id: 'loadout-1', name: 'Reserved later' },
            { id: 'duplicate', name: 'Duplicate name' },
            { id: 'duplicate', name: 'Duplicate name' },
          ],
          lastLoadedLoadoutName: 'Duplicate name',
        },
        'legacy-raw',
      ),
    )

    expect((decoded.database.loadouts as Array<{ id: string }>).map((loadout) => loadout.id)).toEqual([
      'loadout-1-2',
      'loadout-1',
      'duplicate',
      'loadout-4',
    ])
    expect(decoded.database.lastLoadedLoadoutName).toBe('Duplicate name')
  })
})

function makeDataDir(): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-risu-export-'))
  dataDirs.push(dataDir)
  return dataDir
}

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

const PORTABLE_TOMBSTONES = {
  version: 1 as const,
  memoryLegacySummaryTombstones: [
    {
      summaryId: 'legacy-summary-a',
      chatId: 'legacy-chat-a',
      deletedAt: '2026-07-23T00:00:00.000Z',
    },
  ],
}

function encodePortableFixture(envelope: 'legacy' | 'blocks', database: Record<string, unknown>): Uint8Array {
  return envelope === 'legacy'
    ? encodeLegacyRisuSaveEnvelope(database, 'legacy-raw')
    : encodeRisuSaveBlockEnvelope([
        {
          name: 'root',
          type: RisuSaveBlockType.ROOT,
          data: JSON.stringify({ ...database, __directory: [] }),
        },
      ])
}

describe('server .risu fixture harness', () => {
  it('does not create a safety backup or replace live data when import is already aborted', async () => {
    const dataDir = makeDataDir()
    const db = openDatabase(dataDir)
    try {
      writePersistedWithMessages(db, dataDir, {
        _version: 1,
        database: { version: 1, tag: 'live-before-abort', characters: [] },
        assets: [],
      })
      const before = loadPersistedWithMessages(db, dataDir)
      const controller = new AbortController()
      controller.abort()

      await expect(
        applyImport(db, dataDir, { version: 1, tag: 'must-not-import', characters: [] }, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' })

      expect(loadPersistedWithMessages(db, dataDir)).toEqual(before)
      expect(listBackups(dataDir)).toEqual([])
    } finally {
      db.close()
    }
  })

  it('classifies legacy raw, compressed, stream, block, and malformed envelopes', () => {
    for (const fixture of risuSaveFixtureCases) {
      expect(classifyRisuSaveEnvelope(fixture.bytes), fixture.name).toBe(fixture.expectedEnvelope)
    }
  })

  it('pins expected decoded shapes for legacy envelope fixtures', () => {
    const legacyFixtures = risuSaveFixtureCases.filter((fixture) => fixture.expectedEnvelope.startsWith('legacy-'))
    expect(legacyFixtures).toHaveLength(3)

    for (const fixture of legacyFixtures) {
      expect(decodeLegacyRisuSaveEnvelope(fixture.bytes), fixture.name).toEqual(fixture.expectedDecodedShape)
    }
  })

  it('encodes legacy envelopes that round-trip through the production codec', () => {
    const payload = { version: 1, characters: [{ chaId: 'encoded-char', name: 'Encoded' }] }
    const kinds = ['legacy-raw', 'legacy-compressed', 'legacy-stream'] as const

    for (const kind of kinds) {
      const encoded = encodeLegacyRisuSaveEnvelope(payload, kind)
      expect(classifyRisuSaveEnvelope(encoded), kind).toBe(kind)
      expect(decodeLegacyRisuSaveEnvelope(encoded), kind).toEqual(payload)
    }
  })

  it('rejects non-legacy envelopes in the production legacy codec', () => {
    const unknown = risuSaveFixtureCases.find((fixture) => fixture.name === 'malformed-unknown-envelope')
    expect(unknown).toBeDefined()
    expect(() => decodeLegacyRisuSaveEnvelope(unknown!.bytes)).toThrow(/Unsupported legacy \.risu envelope: unknown/)

    const blockEnvelope = risuSaveFixtureCases.find((fixture) => fixture.name === 'risusave-blocks-basic')
    expect(blockEnvelope).toBeDefined()
    expect(() => decodeLegacyRisuSaveEnvelope(blockEnvelope!.bytes)).toThrow(
      /Unsupported legacy \.risu envelope: risusave-blocks/,
    )
  })

  it('pins expected block families for RISUSAVE block fixtures', () => {
    const blockFixtures = risuSaveFixtureCases.filter(
      (fixture) => fixture.expectedEnvelope === 'risusave-blocks' && !fixture.malformed,
    )
    expect(blockFixtures.length).toBeGreaterThanOrEqual(3)

    for (const fixture of blockFixtures) {
      const blocks = inspectRisuSaveBlockFixtureEnvelope(fixture.bytes)
      expect(
        blocks.map((block) => ({
          name: block.name,
          type: block.type,
          unsupportedReference: block.unsupportedReference,
        })),
        fixture.name,
      ).toEqual(fixture.expectedBlocks)
    }
  })

  it('decodes RISUSAVE block fixtures through the production block codec', () => {
    const fixture = risuSaveFixtureCases.find((item) => item.name === 'risusave-blocks-basic')
    expect(fixture).toBeDefined()

    const decoded = decodeRisuSaveBlockEnvelope(fixture!.bytes)
    expect(decoded.unsupportedReferences).toEqual([])
    expect(decoded.blocks.map((block) => [block.name, block.type])).toEqual([
      ['root', RisuSaveBlockType.ROOT],
      ['preset', RisuSaveBlockType.BOTPRESET],
      ['modules', RisuSaveBlockType.MODULES],
      ['loadouts', RisuSaveBlockType.LOADOUTS],
      ['plugins', RisuSaveBlockType.PLUGINS],
      ['pluginStorage', RisuSaveBlockType.PLUGIN_STORAGE],
      ['fixture-char', RisuSaveBlockType.CHARACTER_WITH_CHAT],
      ['config', RisuSaveBlockType.CONFIG],
    ])
    expect(JSON.parse(decoded.blocks.find((block) => block.name === 'modules')!.content!)).toEqual([
      { id: 'module-a', name: 'Module A' },
    ])
  })

  it('encodes RISUSAVE block envelopes that round-trip through the production codec', () => {
    const blocks = [
      {
        name: 'root',
        type: RisuSaveBlockType.ROOT,
        data: JSON.stringify({ version: 1, __directory: ['preset', 'root-component'] }),
      },
      {
        name: 'preset',
        type: RisuSaveBlockType.BOTPRESET,
        data: JSON.stringify([{ id: 'preset-a', name: 'Preset A' }]),
        compression: true,
      },
      {
        name: 'root-component',
        type: RisuSaveBlockType.ROOT_COMPONENT,
        data: JSON.stringify({ key: 'customRootField', data: { enabled: true } }),
      },
    ]

    const encoded = encodeRisuSaveBlockEnvelope(blocks)
    expect(classifyRisuSaveEnvelope(encoded)).toBe('risusave-blocks')

    const decoded = decodeRisuSaveBlockEnvelope(encoded)
    expect(decoded.unsupportedReferences).toEqual([])
    expect(
      decoded.blocks.map((block) => ({
        name: block.name,
        type: block.type,
        compression: block.compression,
        content: block.content,
      })),
    ).toEqual([
      {
        name: 'root',
        type: RisuSaveBlockType.ROOT,
        compression: false,
        content: blocks[0].data,
      },
      {
        name: 'preset',
        type: RisuSaveBlockType.BOTPRESET,
        compression: true,
        content: blocks[1].data,
      },
      {
        name: 'root-component',
        type: RisuSaveBlockType.ROOT_COMPONENT,
        compression: false,
        content: blocks[2].data,
      },
    ])
  })

  it('rejects invalid block compression markers instead of treating them as uncompressed', () => {
    const encoded = encodeRisuSaveBlockEnvelope([
      {
        name: 'root',
        type: RisuSaveBlockType.ROOT,
        data: JSON.stringify({ version: 1, __directory: [] }),
      },
    ])
    encoded[RISUSAVE_BLOCK_HEADER.length + 1] = 2

    expect(() => decodeRisuSaveBlockEnvelope(encoded)).toThrow(/Invalid RISUSAVE block compression marker/)
  })

  it('deduplicates cache-only directory references', () => {
    const encoded = encodeRisuSaveBlockEnvelope([
      {
        name: 'root',
        type: RisuSaveBlockType.ROOT,
        data: JSON.stringify({ version: 1, __directory: ['missing', 'missing', 'root'] }),
      },
    ])

    expect(decodeRisuSaveBlockEnvelope(encoded).unsupportedReferences).toEqual([
      { name: 'missing', type: RisuSaveBlockType.REMOTE, kind: 'cache-only' },
    ])
  })

  it('rejects duplicate physical block names and excessive physical block cardinality', () => {
    const duplicate = encodeRisuSaveBlockEnvelope([
      { name: 'root', type: RisuSaveBlockType.ROOT, data: JSON.stringify({ version: 1 }) },
      { name: 'root', type: RisuSaveBlockType.CONFIG, data: JSON.stringify({ version: 1 }) },
    ])
    expect(() => decodeRisuSaveBlockEnvelope(duplicate)).toThrow('duplicate block name: root')

    const excessive = encodeRisuSaveBlockEnvelope(
      Array.from({ length: RISUSAVE_BLOCK_MAX_COUNT + 1 }, (_, index) => ({
        name: index.toString(36),
        type: RisuSaveBlockType.CHAT,
        data: '',
      })),
    )
    expect(() => decodeRisuSaveBlockEnvelope(excessive)).toThrow(
      `RISUSAVE envelope exceeds ${RISUSAVE_BLOCK_MAX_COUNT} blocks`,
    )
  })

  it('rejects duplicate singleton resource types and root component keys', () => {
    const duplicateSingleton = encodeRisuSaveBlockEnvelope([
      { name: 'root', type: RisuSaveBlockType.ROOT, data: JSON.stringify({ version: 1 }) },
      { name: 'config-a', type: RisuSaveBlockType.CONFIG, data: JSON.stringify({ version: 1 }) },
      { name: 'config-b', type: RisuSaveBlockType.CONFIG, data: JSON.stringify({ version: 1 }) },
    ])
    expect(() => decodeRisuSaveImportSnapshot(duplicateSingleton)).toThrow('duplicate singleton block type')

    const duplicateComponent = encodeRisuSaveBlockEnvelope([
      { name: 'root', type: RisuSaveBlockType.ROOT, data: JSON.stringify({ version: 1 }) },
      {
        name: 'component-a',
        type: RisuSaveBlockType.ROOT_COMPONENT,
        data: JSON.stringify({ key: 'custom', data: { first: true } }),
      },
      {
        name: 'component-b',
        type: RisuSaveBlockType.ROOT_COMPONENT,
        data: JSON.stringify({ key: 'custom', data: { second: true } }),
      },
    ])
    expect(() => decodeRisuSaveImportSnapshot(duplicateComponent)).toThrow('duplicates another root component')
  })

  it('bounds cache-only directory expansion by entry count and encoded block-name size', () => {
    const oversizedDirectory = encodeRisuSaveBlockEnvelope([
      {
        name: 'root',
        type: RisuSaveBlockType.ROOT,
        data: JSON.stringify({
          version: 1,
          __directory: Array.from({ length: RISUSAVE_BLOCK_DIRECTORY_MAX_ENTRIES + 1 }, () => 'missing'),
        }),
      },
    ])
    expect(() => decodeRisuSaveBlockEnvelope(oversizedDirectory)).toThrow(
      `RISUSAVE block directory exceeds ${RISUSAVE_BLOCK_DIRECTORY_MAX_ENTRIES} entries`,
    )

    const oversizedName = encodeRisuSaveBlockEnvelope([
      {
        name: 'root',
        type: RisuSaveBlockType.ROOT,
        data: JSON.stringify({ version: 1, __directory: ['x'.repeat(RISUSAVE_BLOCK_NAME_MAX_BYTES + 1)] }),
      },
    ])
    expect(() => decodeRisuSaveBlockEnvelope(oversizedName)).toThrow(
      `RISUSAVE directory block name exceeds ${RISUSAVE_BLOCK_NAME_MAX_BYTES} bytes`,
    )
  })

  it('represents remote and cache-only blocks as unsupported server decode inputs', () => {
    const unsupported = risuSaveFixtureCases.filter((fixture) =>
      fixture.expectedBlocks?.some((block) => block.unsupportedReference),
    )
    expect(unsupported.map((fixture) => fixture.name)).toEqual([
      'risusave-remote-reference',
      'risusave-cache-only-reference',
    ])

    for (const fixture of unsupported) {
      const { blocks, unsupportedReferences } = decodeRisuSaveBlockEnvelope(fixture.bytes)
      expect(
        blocks.some((block) => block.unsupportedReference),
        fixture.name,
      ).toBe(true)
      expect(unsupportedReferences, fixture.name).toEqual(
        fixture.expectedBlocks
          ?.filter((block) => block.unsupportedReference)
          .map((block) => ({
            name: block.name,
            type: RisuSaveBlockType.REMOTE,
            kind: block.unsupportedReference,
          })),
      )
    }
  })

  it('rejects the malformed truncated-block fixture', () => {
    const truncated = risuSaveFixtureCases.find((fixture) => fixture.name === 'malformed-truncated-block')
    expect(truncated).toBeDefined()
    expect(() => decodeRisuSaveBlockEnvelope(truncated!.bytes)).toThrow(/Malformed RISUSAVE block/)
  })

  it('normalizes decoded legacy envelopes into current import snapshots', () => {
    const fixture = risuSaveFixtureCases.find((item) => item.name === 'legacy-raw-basic')
    expect(fixture).toBeDefined()

    const decoded = decodeRisuSaveImportSnapshot(fixture!.bytes)

    expect(decoded.envelope).toBe('legacy-raw')
    expect(decoded.unsupportedReferences).toEqual([])
    expect(decoded.database.characters).toHaveLength(1)
    expect(decoded.database.characterOrder).toEqual(['fixture-char'])
    expect(decoded.database.currentChar).toBe(0)
    expect(decoded.database.botPresets).toEqual([
      {
        id: 'preset-a',
        name: 'Preset A',
        localNetworkMode: false,
        localNetworkTimeoutSec: 600,
      },
    ])
    expect(decoded.database.botPresetsId).toBe(0)

    const character = (decoded.database.characters as unknown[])[0] as Record<string, unknown>
    expect(character.chaId).toBe('fixture-char')
    expect(character.chats).toHaveLength(1)
    const chat = (character.chats as Array<Record<string, unknown>>)[0]
    expect(chat.id).toEqual(expect.any(String))
    expect(chat.id).not.toBe('')
    expect(chat.message).toEqual([])
    expect(decoded.database.loreBook).toEqual([
      expect.objectContaining({ id: 'default-global-lorebook', name: 'My First LoreBook', data: [] }),
    ])
  })

  it('assembles and normalizes RISUSAVE block envelopes into import snapshots', () => {
    const fixture = risuSaveFixtureCases.find((item) => item.name === 'risusave-blocks-basic')
    expect(fixture).toBeDefined()

    const decoded = decodeRisuSaveImportSnapshot(fixture!.bytes)

    expect(decoded.envelope).toBe('risusave-blocks')
    expect(decoded.unsupportedReferences).toEqual([])
    expect(decoded.database.version).toBe(1)
    expect(decoded.database.__directory).toBeUndefined()
    expect(decoded.database.botPresets).toEqual([
      {
        id: 'preset-a',
        name: 'Preset A',
        localNetworkMode: false,
        localNetworkTimeoutSec: 600,
      },
    ])
    expect(decoded.database.modules).toEqual([{ id: 'module-a', name: 'Module A', description: '' }])
    expect(decoded.database.loadouts).toEqual([
      {
        id: 'loadout-a',
        name: 'Loadout A',
        lastUsed: expect.any(Number),
        favorite: false,
        characterIds: [],
        modules: [],
        globalVariables: {},
        presetName: '',
        modelPresetId: '',
        modelPresetName: '',
        promptPresetId: '',
        promptPresetName: '',
        personaId: '',
      },
    ])
    expect(decoded.database.plugins).toEqual([{ id: 'plugin-a', name: 'Plugin A', version: '3.0' }])
    expect(decoded.database.pluginCustomStorage).toEqual({ 'plugin-a:key': { enabled: true } })
    expect(decoded.database.characterOrder).toEqual(['fixture-char'])
  })

  it('applies root-component blocks as validated top-level fields', () => {
    const encoded = encodeRisuSaveBlockEnvelope([
      {
        name: 'root',
        type: RisuSaveBlockType.ROOT,
        data: JSON.stringify({ version: 1, __directory: ['root-component'] }),
      },
      {
        name: 'root-component',
        type: RisuSaveBlockType.ROOT_COMPONENT,
        data: JSON.stringify({ key: 'customRootField', data: { enabled: true } }),
      },
    ])

    expect(decodeRisuSaveImportSnapshot(encoded).database).toMatchObject({
      version: 1,
      customRootField: { enabled: true },
    })
  })

  it('reports explicit remote references but rejects missing directory blocks', () => {
    const remote = risuSaveFixtureCases.find((item) => item.name === 'risusave-remote-reference')
    const cacheOnly = risuSaveFixtureCases.find((item) => item.name === 'risusave-cache-only-reference')
    expect(remote).toBeDefined()
    expect(cacheOnly).toBeDefined()

    expect(decodeRisuSaveImportSnapshot(remote!.bytes).unsupportedReferences).toEqual([
      { name: 'remote-char', type: RisuSaveBlockType.REMOTE, kind: 'remote' },
    ])
    expect(() => decodeRisuSaveImportSnapshot(cacheOnly!.bytes)).toThrow(RISUSAVE_INCOMPLETE_BLOCKS_ERROR)
  })

  it('rejects a block save truncated exactly after a complete block', () => {
    const blocks = [
      {
        name: 'root',
        type: RisuSaveBlockType.ROOT,
        data: JSON.stringify({ version: 1, __directory: ['preset', 'modules', 'config'] }),
      },
      {
        name: 'preset',
        type: RisuSaveBlockType.BOTPRESET,
        data: JSON.stringify([]),
      },
      {
        name: 'modules',
        type: RisuSaveBlockType.MODULES,
        data: JSON.stringify([{ id: 'module-a', name: 'Module A' }]),
      },
      {
        name: 'config',
        type: RisuSaveBlockType.CONFIG,
        data: JSON.stringify({ version: 1 }),
      },
    ]
    const complete = encodeRisuSaveBlockEnvelope(blocks)
    const boundary = encodeRisuSaveBlockEnvelope(blocks.slice(0, 2)).byteLength
    const truncated = complete.slice(0, boundary)

    expect(decodeRisuSaveBlockEnvelope(truncated).unsupportedReferences).toEqual([
      { name: 'modules', type: RisuSaveBlockType.REMOTE, kind: 'cache-only' },
      { name: 'config', type: RisuSaveBlockType.REMOTE, kind: 'cache-only' },
    ])
    expect(() => decodeRisuSaveImportSnapshot(truncated)).toThrow(RISUSAVE_INCOMPLETE_BLOCKS_ERROR)
  })

  it('rejects malformed decoded import rows', () => {
    const invalidMessage = encodeLegacyRisuSaveEnvelope({
      characters: [
        {
          chaId: 'bad-char',
          name: 'Bad',
          chats: [
            {
              id: 'bad-chat',
              name: 'Bad Chat',
              note: '',
              localLore: [],
              message: [{ role: 'system', data: 'nope', chatId: 'bad-message' }],
            },
          ],
        },
      ],
    })
    expect(() => decodeRisuSaveImportSnapshot(invalidMessage)).toThrow(/message\[0\]\.role must be user or char/)

    const invalidRootComponent = encodeRisuSaveBlockEnvelope([
      {
        name: 'root',
        type: RisuSaveBlockType.ROOT,
        data: JSON.stringify({ version: 1, __directory: ['bad-component'] }),
      },
      {
        name: 'bad-component',
        type: RisuSaveBlockType.ROOT_COMPONENT,
        data: JSON.stringify({ key: '', data: true }),
      },
    ])
    expect(() => decodeRisuSaveImportSnapshot(invalidRootComponent)).toThrow(
      /bad-component block key must be a non-empty string/,
    )
  })

  it('rejects group characters before import normalization can remove them', () => {
    const encoded = encodeLegacyRisuSaveEnvelope({
      characters: [
        {
          type: 'group',
          chaId: 'legacy-group-a',
          name: 'Legacy Party',
          chats: [{ id: 'group-chat-a', message: [{ role: 'user', data: 'keep me' }] }],
        },
      ],
    })

    try {
      decodeRisuSaveImportSnapshot(encoded)
      throw new Error('Expected group import rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedGroupCharactersError)
      expect(error).toMatchObject({
        count: 1,
        groups: [{ id: 'legacy-group-a', name: 'Legacy Party' }],
      })
      expect((error as Error).message).toContain('active database was not changed')
    }
  })

  it.each(['legacy', 'blocks'] as const)(
    'encodes, decodes, and strips portable server metadata in %s envelopes',
    (envelope) => {
      const snapshot = buildRisuSaveExportSnapshotFromPersisted(
        {
          _version: 1,
          database: { characters: [] },
          assets: [],
        },
        PORTABLE_TOMBSTONES,
      )
      const encoded =
        envelope === 'legacy'
          ? encodeRisuSaveLegacyExportSnapshot(snapshot, 'legacy-raw')
          : encodeRisuSaveBlockExportSnapshot(snapshot)
      const encodedDatabase =
        envelope === 'legacy'
          ? (decodeLegacyRisuSaveEnvelope(encoded) as Record<string, unknown>)
          : (JSON.parse(decodeRisuSaveBlockEnvelope(encoded).blocks[0].content!) as Record<string, unknown>)
      expect(encodedDatabase[RISU_SERVER_DATA_KEY]).toEqual(PORTABLE_TOMBSTONES)

      const decoded = decodeRisuSaveImportSnapshot(encoded)
      expect(decoded.portableMetadata).toEqual(PORTABLE_TOMBSTONES)
      expect(decoded.database[RISU_SERVER_DATA_KEY]).toBeUndefined()
    },
  )

  it.each(['legacy', 'blocks'] as const)(
    'repairs and round-trips stable Hypa V3 preset identity in %s exports',
    (envelope) => {
      const snapshot = buildRisuSaveExportSnapshotFromPersisted({
        _version: 1,
        database: {
          characters: [],
          hypaV3PresetId: 2,
          selectedHypaV3PresetId: 'duplicate-memory',
          hypaV3Presets: [
            { id: 'duplicate-memory', name: 'First', settings: {} },
            { id: 'duplicate-memory', name: 'Second', settings: {} },
            { name: 'Selected', settings: {} },
          ],
        },
        assets: [],
      })

      expect(snapshot.database).toMatchObject({
        hypaV3PresetId: 2,
        selectedHypaV3PresetId: 'hypa-v3-preset-3',
        hypaV3Presets: [
          { id: 'duplicate-memory', name: 'First' },
          { id: 'hypa-v3-preset-2', name: 'Second' },
          { id: 'hypa-v3-preset-3', name: 'Selected' },
        ],
      })

      const encoded =
        envelope === 'legacy'
          ? encodeRisuSaveLegacyExportSnapshot(snapshot, 'legacy-raw')
          : encodeRisuSaveBlockExportSnapshot(snapshot)
      expect(decodeRisuSaveImportSnapshot(encoded).database).toMatchObject({
        hypaV3PresetId: 2,
        selectedHypaV3PresetId: 'hypa-v3-preset-3',
      })
    },
  )

  it.each(['legacy', 'blocks'] as const)('rejects malformed portable metadata in %s envelopes', (envelope) => {
    const malformed = [
      null,
      { version: 2, memoryLegacySummaryTombstones: [] },
      { version: 1, memoryLegacySummaryTombstones: 'not-an-array' },
      {
        version: 1,
        memoryLegacySummaryTombstones: [{ summaryId: '', chatId: 'chat-a', deletedAt: 'now' }],
      },
      {
        version: 1,
        memoryLegacySummaryTombstones: [
          { summaryId: 'duplicate', chatId: 'chat-a', deletedAt: 'now' },
          { summaryId: 'duplicate', chatId: 'chat-b', deletedAt: 'later' },
        ],
      },
    ]

    for (const portableMetadata of malformed) {
      const encoded = encodePortableFixture(envelope, {
        characters: [],
        [RISU_SERVER_DATA_KEY]: portableMetadata,
      })
      expect(() => decodeRisuSaveImportSnapshot(encoded)).toThrow(RISU_SERVER_DATA_KEY)
    }
  })

  it.each(['legacy', 'blocks'] as const)(
    'does not let metadata-only %s payloads bypass the empty-database guard',
    (envelope) => {
      const encoded = encodePortableFixture(envelope, {
        [RISU_SERVER_DATA_KEY]: PORTABLE_TOMBSTONES,
      })
      expect(() => decodeRisuSaveImportSnapshot(encoded)).toThrow('risusave_empty_database')
    },
  )

  it('treats absent portable metadata as an older artifact with an empty tombstone list', () => {
    const decoded = decodeRisuSaveImportSnapshot(encodeLegacyRisuSaveEnvelope({ characters: [] }, 'legacy-raw'))
    expect(decoded.portableMetadata).toEqual({
      version: 1,
      memoryLegacySummaryTombstones: [],
    })
    expect(decoded.greetingTranslations).toEqual([])
  })

  it.each(['legacy', 'blocks'] as const)(
    'round-trips source-valid greeting translation variants through %s saves and strips the portable field',
    (envelope) => {
      const dataDir = makeDataDir()
      const db = openDatabase(dataDir)
      try {
        writePersistedWithMessages(db, dataDir, {
          _version: 1,
          database: {
            characters: [
              {
                chaId: 'greeting-char',
                name: 'Greeting Character',
                firstMessage: 'primary',
                alternateGreetings: ['alternate'],
                chats: [],
              },
            ],
          },
          assets: [],
        })
        for (const [settingsHash, text] of [
          ['settings-a', '기본 A'],
          ['settings-b', '기본 B'],
        ] as const) {
          upsertGreetingTranslation(db, 'greeting-char', -1, {
            text,
            source: 'raw',
            sourceHash: sourceHash('primary'),
            targetLanguage: 'ko',
            inputLanguage: 'en',
            translatorType: 'google',
            settingsHash,
            updatedAt: 123,
          })
        }
        const bytes =
          envelope === 'legacy'
            ? encodeRepositoryRisuSaveLegacyExport(db, dataDir, 'legacy-raw')
            : encodeRepositoryRisuSaveBlockExport(db, dataDir)
        const decoded = decodeRisuSaveImportSnapshot(bytes)
        expect(decoded.greetingTranslations.map((row) => [row.settingsHash, row.translation.text])).toEqual([
          ['settings-a', '기본 A'],
          ['settings-b', '기본 B'],
        ])
        expect((decoded.database.characters as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
          'greetingTranslations',
        )
      } finally {
        db.close()
      }
    },
  )

  it('rejects malformed greeting translation entries and drops well-formed stale sources', () => {
    const baseTranslation = {
      text: 'translated',
      source: 'raw',
      sourceHash: sourceHash('stale source'),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'google',
      settingsHash: 'settings-a',
      updatedAt: 123,
    }
    const stale = decodeRisuSaveImportSnapshot(
      encodeLegacyRisuSaveEnvelope({
        characters: [
          {
            chaId: 'greeting-char',
            firstMessage: 'current source',
            greetingTranslations: [{ greetingIndex: -1, settingsHash: 'settings-a', translation: baseTranslation }],
          },
        ],
      }),
    )
    expect(stale.greetingTranslations).toEqual([])
    expect((stale.database.characters as Array<Record<string, unknown>>)[0]).not.toHaveProperty('greetingTranslations')

    expect(() =>
      decodeRisuSaveImportSnapshot(
        encodeLegacyRisuSaveEnvelope({
          characters: [
            {
              chaId: 'greeting-char',
              firstMessage: 'current source',
              greetingTranslations: [{ greetingIndex: -1, settingsHash: 'row-settings', translation: baseTranslation }],
            },
          ],
        }),
      ),
    ).toThrow(/settingsHash must match/)
  })

  it('remints duplicate character ids before attributing portable greeting rows', async () => {
    const dataDir = makeDataDir()
    const db = openDatabase(dataDir)
    try {
      const portableTranslation = (source: string, text: string) => ({
        text,
        source: 'raw' as const,
        sourceHash: sourceHash(source),
        targetLanguage: 'ko',
        inputLanguage: 'en',
        translatorType: 'google' as const,
        settingsHash: 'shared-settings',
        updatedAt: 123,
      })
      const decoded = decodeRisuSaveImportSnapshot(
        encodeLegacyRisuSaveEnvelope({
          characters: [
            {
              chaId: 'duplicate-character',
              firstMessage: 'first source',
              chats: [],
              greetingTranslations: [
                {
                  greetingIndex: -1,
                  settingsHash: 'shared-settings',
                  translation: portableTranslation('first source', 'first translated'),
                },
              ],
            },
            {
              chaId: 'duplicate-character',
              firstMessage: 'second source',
              chats: [],
              greetingTranslations: [
                {
                  greetingIndex: -1,
                  settingsHash: 'shared-settings',
                  translation: portableTranslation('second source', 'second translated'),
                },
              ],
            },
          ],
        }),
      )
      const characters = decoded.database.characters as Array<Record<string, unknown>>
      const characterIds = characters.map((character) => character.chaId as string)
      expect(characterIds[0]).toBe('duplicate-character')
      expect(characterIds[1]).not.toBe('duplicate-character')
      expect(new Set(characterIds).size).toBe(2)
      expect(decoded.greetingTranslations.map((row) => row.characterId)).toEqual(characterIds)

      await applyImport(db, dataDir, decoded.database, {
        greetingTranslations: decoded.greetingTranslations,
        automaticBackupRetention: 0,
      })
      expect(getGreetingTranslation(db, characterIds[0], -1, 'shared-settings')?.translation.text).toBe(
        'first translated',
      )
      expect(getGreetingTranslation(db, characterIds[1], -1, 'shared-settings')?.translation.text).toBe(
        'second translated',
      )
    } finally {
      db.close()
    }
  })

  it('still rejects duplicate portable greeting rows within one character', () => {
    const translation = {
      text: 'translated',
      source: 'raw' as const,
      sourceHash: sourceHash('primary'),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'google' as const,
      settingsHash: 'settings-a',
      updatedAt: 123,
    }
    const row = { greetingIndex: -1, settingsHash: 'settings-a', translation }
    expect(() =>
      decodeRisuSaveImportSnapshot(
        encodeLegacyRisuSaveEnvelope({
          characters: [
            {
              chaId: 'character-a',
              firstMessage: 'primary',
              greetingTranslations: [row, structuredClone(row)],
            },
          ],
        }),
      ),
    ).toThrow(/duplicates another greeting translation row/)
  })

  it('atomically restores extracted greeting rows without retaining the portable character field', async () => {
    const dataDir = makeDataDir()
    const db = openDatabase(dataDir)
    try {
      const translation = {
        text: 'translated primary',
        source: 'raw' as const,
        sourceHash: sourceHash('primary'),
        targetLanguage: 'ko',
        inputLanguage: 'en',
        translatorType: 'google' as const,
        settingsHash: 'settings-a',
        updatedAt: 123,
      }
      const decoded = decodeRisuSaveImportSnapshot(
        encodeLegacyRisuSaveEnvelope({
          characters: [
            {
              chaId: 'greeting-char',
              firstMessage: 'primary',
              chats: [],
              greetingTranslations: [{ greetingIndex: -1, settingsHash: 'settings-a', translation }],
            },
          ],
        }),
      )
      await applyImport(db, dataDir, decoded.database, {
        greetingTranslations: decoded.greetingTranslations,
        automaticBackupRetention: 0,
      })
      expect(getGreetingTranslation(db, 'greeting-char', -1, 'settings-a')?.translation).toEqual(translation)
      const row = db.prepare("SELECT data_json FROM characters WHERE id = 'greeting-char'").get() as {
        data_json: string
      }
      expect(JSON.parse(row.data_json)).not.toHaveProperty('greetingTranslations')
    } finally {
      db.close()
    }
  })

  it('exports tombstones without leaking retry or push-subscription secrets', () => {
    const dataDir = makeDataDir()
    const db = openDatabase(dataDir)
    try {
      writePersistedWithMessages(db, dataDir, {
        _version: 1,
        database: { characters: [] },
        assets: [],
      })
      db.exec(`
        INSERT INTO memory_legacy_summary_tombstones (summary_id, chat_id, deleted_at)
        VALUES ('portable-summary', 'portable-chat', '2026-07-23T00:00:00.000Z');
        INSERT INTO generation_finalization_retries (
          generation_id, chat_id, mode, message_json, alternate_messages_json,
          chat_var_mutations_json, status
        ) VALUES (
          'queue-secret-generation', 'portable-chat', 'send',
          '{"role":"char","data":"queue-secret-payload"}', '[]', '[]', 'terminal'
        );
        INSERT INTO push_subscriptions (endpoint, subscription_json)
        VALUES (
          'https://push.example/secret-endpoint',
          '{"endpoint":"https://push.example/secret-endpoint","keys":{"auth":"push-secret-auth"}}'
        );
      `)

      const encoded = encodeRepositoryRisuSaveLegacyExport(db, dataDir, 'legacy-raw')
      const portableDatabase = decodeLegacyRisuSaveEnvelope(encoded) as Record<string, unknown>
      expect(portableDatabase[RISU_SERVER_DATA_KEY]).toEqual({
        version: 1,
        memoryLegacySummaryTombstones: [
          {
            summaryId: 'portable-summary',
            chatId: 'portable-chat',
            deletedAt: '2026-07-23T00:00:00.000Z',
          },
        ],
      })
      const serialized = JSON.stringify(portableDatabase)
      expect(serialized).not.toContain('queue-secret-generation')
      expect(serialized).not.toContain('queue-secret-payload')
      expect(serialized).not.toContain('https://push.example/secret-endpoint')
      expect(serialized).not.toContain('push-secret-auth')
    } finally {
      db.close()
    }
  })

  it('round-trips ordered reroll candidates with identity and metadata through every portable .risu codec', async () => {
    const candidates = [
      {
        role: 'char',
        data: 'same visible candidate',
        chatId: 'candidate-newest',
        saying: 'Newest Candidate',
        time: 222,
        generationInfo: {
          model: 'newest-model',
          generationId: 'generation-newest',
          operationId: 'operation-newest',
          acceptedMessageId: 'candidate-newest',
          effectLedgerChatId: 'portable-chat',
          inputTokens: 12,
          outputTokens: 34,
        },
        promptInfo: {
          promptName: 'Newest Prompt',
          promptToggles: [{ key: 'tone', value: 'warm' }],
        },
      },
      {
        role: 'char',
        data: 'same visible candidate',
        chatId: 'candidate-older',
        saying: 'Older Candidate',
        time: 111,
        generationInfo: {
          model: 'older-model',
          generationId: 'generation-older',
          operationId: 'operation-older',
          acceptedMessageId: 'candidate-older',
          effectLedgerChatId: 'portable-chat',
          inputTokens: 56,
          outputTokens: 78,
        },
        promptInfo: {
          promptName: 'Older Prompt',
          promptToggles: [{ key: 'tone', value: 'cold' }],
        },
      },
    ]
    const envelopeCases = [
      {
        expected: 'legacy-raw',
        encode: (db: DatabaseSync, dataDir: string) => encodeRepositoryRisuSaveLegacyExport(db, dataDir, 'legacy-raw'),
      },
      {
        expected: 'legacy-compressed',
        encode: (db: DatabaseSync, dataDir: string) =>
          encodeRepositoryRisuSaveLegacyExport(db, dataDir, 'legacy-compressed'),
      },
      {
        expected: 'legacy-stream',
        encode: (db: DatabaseSync, dataDir: string) =>
          encodeRepositoryRisuSaveLegacyExport(db, dataDir, 'legacy-stream'),
      },
      {
        expected: 'risusave-blocks',
        encode: (db: DatabaseSync, dataDir: string) => encodeRepositoryRisuSaveBlockExport(db, dataDir),
      },
    ] as const

    for (const envelopeCase of envelopeCases) {
      const sourceDataDir = makeDataDir()
      const sourceDb = openDatabase(sourceDataDir)
      let encoded: Uint8Array
      try {
        writePersistedWithMessages(sourceDb, sourceDataDir, {
          _version: 1,
          database: {
            version: 1,
            characters: [
              {
                chaId: 'portable-character',
                name: 'Portable Character',
                chats: [
                  {
                    id: 'portable-chat',
                    name: 'Portable Chat',
                    note: '',
                    localLore: [],
                    bookmarks: ['active-response'],
                    message: [
                      { role: 'user', data: 'active prompt', chatId: 'active-prompt' },
                      { role: 'char', data: 'active response', chatId: 'active-response' },
                    ],
                    alternates: candidates,
                  },
                ],
              },
            ],
            characterOrder: ['portable-character'],
            botPresets: [],
            modules: [],
            loadouts: [],
            plugins: [],
            pluginCustomStorage: {},
          },
          assets: [],
        })
        encoded = envelopeCase.encode(sourceDb, sourceDataDir)
      } finally {
        sourceDb.close()
      }

      const decoded = decodeRisuSaveImportSnapshot(encoded)
      expect(decoded.envelope, envelopeCase.expected).toBe(envelopeCase.expected)
      const decodedChat = (decoded.database.characters as Array<{ chats: Array<Record<string, unknown>> }>)[0].chats[0]
      expect(decodedChat.alternates, envelopeCase.expected).toEqual(candidates)
      expect(decodedChat.message, envelopeCase.expected).toEqual([
        { role: 'user', data: 'active prompt', chatId: 'active-prompt' },
        { role: 'char', data: 'active response', chatId: 'active-response' },
      ])
      expect(decodedChat.bookmarks, envelopeCase.expected).toEqual(['active-response'])

      const targetDataDir = makeDataDir()
      const targetDb = openDatabase(targetDataDir)
      try {
        await applyImport(targetDb, targetDataDir, decoded.database, {
          greetingTranslations: decoded.greetingTranslations,
          automaticBackupRetention: 0,
        })
        const reloaded = loadPersistedWithMessages(targetDb, targetDataDir).database as {
          characters: Array<{ chats: Array<Record<string, unknown>> }>
        }
        const reloadedChat = reloaded.characters[0].chats[0]
        expect(reloadedChat.alternates, envelopeCase.expected).toEqual(candidates)
        expect(reloadedChat.message, envelopeCase.expected).toEqual([
          { role: 'user', data: 'active prompt', chatId: 'active-prompt' },
          { role: 'char', data: 'active response', chatId: 'active-response' },
        ])
        expect(reloadedChat.bookmarks, envelopeCase.expected).toEqual(['active-response'])
      } finally {
        targetDb.close()
      }
    }
  })

  it('round-trips canonical owner identities and translator cache inputs through every portable .risu codec', async () => {
    const envelopeCases = [
      {
        expected: 'legacy-raw',
        encode: (db: DatabaseSync, dataDir: string) => encodeRepositoryRisuSaveLegacyExport(db, dataDir, 'legacy-raw'),
      },
      {
        expected: 'legacy-compressed',
        encode: (db: DatabaseSync, dataDir: string) =>
          encodeRepositoryRisuSaveLegacyExport(db, dataDir, 'legacy-compressed'),
      },
      {
        expected: 'legacy-stream',
        encode: (db: DatabaseSync, dataDir: string) =>
          encodeRepositoryRisuSaveLegacyExport(db, dataDir, 'legacy-stream'),
      },
      {
        expected: 'risusave-blocks',
        encode: (db: DatabaseSync, dataDir: string) => encodeRepositoryRisuSaveBlockExport(db, dataDir),
      },
    ] as const

    for (const envelopeCase of envelopeCases) {
      const sourceDataDir = makeDataDir()
      const sourceDb = openDatabase(sourceDataDir)
      let encoded: Uint8Array
      try {
        writePersistedWithMessages(sourceDb, sourceDataDir, {
          _version: 1,
          database: canonicalOwnerPersistenceDatabase(),
          assets: [],
        })
        encoded = envelopeCase.encode(sourceDb, sourceDataDir)
      } finally {
        sourceDb.close()
      }

      const decoded = decodeRisuSaveImportSnapshot(encoded)
      expect(decoded.envelope, envelopeCase.expected).toBe(envelopeCase.expected)
      const targetDataDir = makeDataDir()
      const targetDb = openDatabase(targetDataDir)
      try {
        await applyImport(targetDb, targetDataDir, decoded.database, {
          greetingTranslations: decoded.greetingTranslations,
          automaticBackupRetention: 0,
        })
      } finally {
        targetDb.close()
      }

      const reopened = openDatabase(targetDataDir)
      try {
        expect(
          canonicalOwnerPersistenceSnapshot(loadPersistedWithMessages(reopened, targetDataDir).database),
          envelopeCase.expected,
        ).toEqual(EXPECTED_CANONICAL_OWNER_PERSISTENCE_SNAPSHOT)
      } finally {
        reopened.close()
      }
    }
  })

  it('exports repository snapshots as legacy .risu envelopes', () => {
    const dataDir = makeDataDir()
    const assetId = 'a'.repeat(64)
    const database = {
      version: 1,
      characters: [
        {
          chaId: 'export-char',
          name: 'Export Character',
          image: assetId,
          chats: [
            {
              id: 'export-chat',
              name: 'Export Chat',
              note: '',
              localLore: [],
              message: [{ role: 'user', data: 'hello', chatId: 'export-message' }],
            },
          ],
        },
      ],
      characterOrder: ['export-char'],
      botPresets: [{ id: 'preset-a', name: 'Preset A' }],
      modules: [{ id: 'module-a', name: 'Module A' }],
      loadouts: [{ id: 'loadout-a', name: 'Loadout A' }],
      plugins: [{ id: 'plugin-a', name: 'Plugin A', version: '3.0' }],
      pluginCustomStorage: { 'plugin-a:key': { assetId } },
    }
    const db = openDatabase(dataDir)
    try {
      writePersistedWithMessages(db, dataDir, {
        _version: 1,
        database,
        assets: [{ id: assetId, ext: 'png', size: 12, contentType: 'image/png' }],
      })

      const encoded = encodeRepositoryRisuSaveLegacyExport(db, dataDir, 'legacy-raw')
      const decoded = decodeRisuSaveImportSnapshot(encoded)

      expect(decoded.envelope).toBe('legacy-raw')
      expect(decoded.unsupportedReferences).toEqual([])
      expect(decoded.database.characters).toHaveLength(1)
      expect((decoded.database.characters as Array<Record<string, unknown>>)[0].image).toBe(assetId)
      expect(decoded.database.pluginCustomStorage).toEqual({ 'plugin-a:key': { assetId } })
    } finally {
      db.close()
    }
  })

  it('exports repository snapshots as RISUSAVE block envelopes', () => {
    const dataDir = makeDataDir()
    const assetId = 'b'.repeat(64)
    const db = openDatabase(dataDir)
    try {
      writePersistedWithMessages(db, dataDir, {
        _version: 1,
        database: {
          version: 1,
          selectedCharID: 0,
          characters: [
            {
              chaId: 'block-export-char',
              name: 'Block Export Character',
              image: assetId,
              chats: [],
            },
          ],
          botPresets: [{ id: 'preset-a', name: 'Preset A' }],
          modules: [{ id: 'module-a', name: 'Module A' }],
          loadouts: [{ id: 'loadout-a', name: 'Loadout A' }],
          plugins: [{ id: 'plugin-a', name: 'Plugin A', version: '3.0' }],
          pluginCustomStorage: { 'plugin-a:key': { assetId } },
        },
        assets: [{ id: assetId, ext: 'webp', size: 44, contentType: 'image/webp' }],
      })

      const encoded = encodeRepositoryRisuSaveBlockExport(db, dataDir, {
        compression: true,
      })
      const blocks = decodeRisuSaveBlockEnvelope(encoded)
      const decoded = decodeRisuSaveImportSnapshot(encoded)

      expect(blocks.unsupportedReferences).toEqual([])
      expect(
        blocks.blocks.map((block) => ({
          name: block.name,
          type: block.type,
          compression: block.compression,
        })),
      ).toEqual([
        { name: 'root', type: RisuSaveBlockType.ROOT, compression: true },
        { name: 'preset', type: RisuSaveBlockType.BOTPRESET, compression: true },
        { name: 'modules', type: RisuSaveBlockType.MODULES, compression: true },
        { name: 'loadouts', type: RisuSaveBlockType.LOADOUTS, compression: true },
        { name: 'plugins', type: RisuSaveBlockType.PLUGINS, compression: true },
        { name: 'pluginStorage', type: RisuSaveBlockType.PLUGIN_STORAGE, compression: true },
        {
          name: 'block-export-char',
          type: RisuSaveBlockType.CHARACTER_WITH_CHAT,
          compression: true,
        },
        { name: 'config', type: RisuSaveBlockType.CONFIG, compression: true },
      ])
      expect(JSON.parse(blocks.blocks[0].content!).__directory).toEqual([
        'preset',
        'modules',
        'loadouts',
        'plugins',
        'pluginStorage',
        'block-export-char',
        'config',
      ])
      expect((decoded.database.characters as Array<Record<string, unknown>>)[0].image).toBe(assetId)
      expect(decoded.database.pluginCustomStorage).toEqual({ 'plugin-a:key': { assetId } })
    } finally {
      db.close()
    }
  })

  it('rejects repository export when no persisted database exists', () => {
    const dataDir = makeDataDir()
    expect(() => encodeRepositoryRisuSaveLegacyExport(openDatabase(dataDir), dataDir)).toThrow(
      /database payload missing/,
    )
  })

  it('validates block export inputs before encoding', () => {
    expect(() =>
      buildRisuSaveExportBlocks({
        characters: [{ name: 'Missing stable id', chats: [] }],
        botPresets: [],
        modules: [],
        loadouts: [],
        plugins: [],
        pluginCustomStorage: {},
      }),
    ).toThrow(/character\.chaId must be a non-empty string/)
  })
})
