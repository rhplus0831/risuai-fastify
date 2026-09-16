import { bootPromptVariables } from '../src/prompt/promptVariablesBoot.js'
import { insertAssetMetadataBatch, assetsDir } from '../src/repository.js'
import { expandVariables } from '../src/prompt/variables.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase, getSchemaState, CURRENT_SCHEMA_VERSION } from '../src/db.js'
import {
  storeGenerationConfiguration,
  resolveGenerationConfiguration,
  pruneGenerationConfigurationDependencies,
  overlayGenerationChatRuntime,
} from '../src/generationConfiguration.js'
import {
  generationEffectiveConfigurationFingerprint,
  insertGenerationOperationInTransaction,
} from '../src/generationOperations.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import type { AcceptedEffectiveGenerationConfiguration } from '../src/prompt/assemble.js'
import { getModuleAssets, getActiveModules } from '../src/prompt/modules.js'
import { buildAssetGcRisuSaveAssetReport, runAssetGc } from '../src/assetGc.js'
import { refreshAcceptedProfileCredential } from '../src/generationCredentials.js'
import { resolveModelProfileByProfileId } from '@risuai/shared-core/model-profile-resolver'
import {
  GenerationSettingsOwners,
  FastifyChatOwners,
  FastifyCharacterOwners,
} from '../src/generationConfigurationManifest.js'
import schema from '../src/prompt/generationInputSchema.json'

beforeAll(bootPromptVariables)
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'risu-fixed-config-'))
  dirs.push(dir)
  return { dir, db: openDatabase(dir) }
}
function configuration(): AcceptedEffectiveGenerationConfiguration {
  return {
    version: 1,
    database: {
      aiModel: 'debug-echo',
      currentChar: 0,
      enabledModules: ['module-a'],
      mainPrompt: 'accepted prompt',
      globalChatVariables: { mood: 'default' },
      characters: [
        {
          chaId: 'char-a',
          name: 'Accepted character',
          chatPage: 0,
          chats: [
            {
              id: 'chat-a',
              name: 'Chat',
              note: 'accepted note',
              message: [{ role: 'user', data: 'runtime' }],
              scriptstate: { mood: 'runtime' },
              lastMemory: 'old-memory',
              hypaV3Data: { summaries: [] },
              pinned: true,
              bookmarks: ['message-a'],
            },
          ],
        },
      ],
      modules: [
        {
          id: 'module-a',
          name: 'Module',
          namespace: 'namespace-a',
          assets: [
            ['first', 'a'.repeat(64), 'image/png'],
            ['second', 'b'.repeat(64), 'image/png'],
          ],
        },
      ],
      modelProfiles: [
        {
          id: 'profile-a',
          name: 'Accepted profile',
          providerId: 'custom-api',
          modelId: 'custom-api',
          providerOptions: {
            credentialId: 'credential-a',
            baseUrl: 'https://accepted.example/v1',
            requestModel: 'accepted-model',
          },
        },
      ],
      providerCredentials: [{ id: 'credential-a', name: 'Credential', type: 'apiKey', apiKey: 'secret-at-acceptance' }],
      hypaV3Presets: [{ id: 'memory-a', name: 'Memory', settings: { memoryTokensRatio: 0.4 } }],
    },
    acceptedTranscriptTail: { role: 'user', chatId: 'message-a' },
    translationSettings: { translator: 'ko', translatorType: 'llm', sidebarWidth: 333 },
    promptInfo: {},
    resolvedMainProfile: {},
  } as unknown as AcceptedEffectiveGenerationConfiguration
}
function accept(db: ReturnType<typeof openDatabase>, input = configuration(), id = 'operation-a') {
  db.exec('BEGIN IMMEDIATE')
  try {
    const stored = storeGenerationConfiguration(db, input)
    const fingerprint = generationEffectiveConfigurationFingerprint(stored)
    insertGenerationOperationInTransaction(db, {
      databaseLineage: getDatabaseLineage(db),
      operationId: id,
      protocolVersion: 1,
      requestOrigin: 'accepted_send',
      creatorWriterSessionId: 'writer',
      creatorWriterEpoch: 1,
      bindingServerInstanceId: 'server',
      characterId: 'char-a',
      chatId: 'chat-a',
      mode: 'send',
      acceptedMessageId: 'message-a',
      acceptedRevision: 1,
      state: 'accepted',
      requestFingerprint: 'a'.repeat(64),
      intent: { mode: 'send' },
      effectiveConfiguration: stored,
      effectiveConfigurationFingerprint: fingerprint,
    })
    db.prepare("UPDATE generation_operations SET state = 'completed' WHERE operation_id = ?").run(id)
    db.exec('COMMIT')
    return { stored, fingerprint }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

describe('accepted configuration contract', () => {
  it('requires classification when finite generation reader fields are added', () => {
    const definitions = schema.$defs as Record<string, { properties?: Record<string, unknown> }>
    for (const [name, owners] of Object.entries({
      GenerationSettings: GenerationSettingsOwners,
      FastifyCharacter: FastifyCharacterOwners,
      FastifyChat: FastifyChatOwners,
    })) {
      const entry = (schema as Record<string, unknown>)[name] as { $ref: string } | undefined
      // Character/chat are nested schema nodes, while settings is also a root.
      const properties = entry
        ? definitions[entry.$ref.split('/').at(-1)!]?.properties
        : Object.values(definitions).find((def) => {
            const keys = Object.keys(def.properties ?? {})
            return name === 'FastifyCharacter'
              ? keys.includes('chaId') && keys.includes('chats')
              : keys.includes('message') && keys.includes('localLore') && keys.includes('bookmarks')
          })?.properties
      expect(properties).toBeDefined()
      expect(Object.keys(owners).sort()).toEqual(Object.keys(properties!).sort())
    }
  })

  it('deduplicates production-sized catalogs, preserves lookup/enumeration and survives reopen and edits', () => {
    const { dir, db } = setup()
    const input = configuration()
    input.database.enabledModules = Array.from({ length: 14 }, (_, i) => 'module-' + i)
    input.database.modules = input.database.enabledModules.map((id, module) => ({
      id,
      name: id,
      description: '',
      namespace: 'ns-' + module,
      assets: Array.from(
        { length: 11000 },
        (_, i) => [`asset-${module}-${i}`, 'a'.repeat(64), 'image/png'] as [string, string, string],
      ),
    }))
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(8 * 1024 * 1024)
    const first = accept(db, input)
    const count = db.prepare('SELECT count(*) AS n FROM generation_configuration_dependencies').get()!.n
    const second = accept(db, input, 'operation-b')
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(db.prepare('SELECT count(*) AS n FROM generation_configuration_dependencies').get()!.n).toBe(count)
    expect(Buffer.byteLength(JSON.stringify(first.stored))).toBeLessThan(32 * 1024)
    // Editor changes/new operations cannot mutate old content-addressed rows.
    const edited = structuredClone(input)
    edited.database.modules = [
      { id: 'module-0', name: 'Changed', description: '', assets: [['new', 'c'.repeat(64), 'image/png']] },
    ]
    edited.database.mainPrompt = 'new prompt'
    edited.database.hypaV3Presets = [{ id: 'memory-a', name: 'Memory', settings: { memoryTokensRatio: 0.8 } }]
    const next = accept(db, edited, 'operation-c')
    db.close()
    const reopened = openDatabase(dir)
    try {
      const old = resolveGenerationConfiguration(reopened, first.stored, first.fingerprint)
      expect(old.database.mainPrompt).toBe('accepted prompt')
      expect(JSON.parse(expandVariables('{{moduleassetlist::ns-0}}', { database: old.database }).text)).toEqual(
        Array.from({ length: 11000 }, (_, index) => 'asset-0-' + index),
      )

      expect(old.database.hypaV3Presets?.[0].settings.memoryTokensRatio).toBe(0.4)
      const character = old.database.characters[0]
      const chat = character.chats[0]
      expect(getActiveModules(old.database, character, chat).map((module) => module.id)).toEqual(
        input.database.enabledModules,
      )
      expect([...getModuleAssets(getActiveModules(old.database, character, chat))]).toEqual(
        input.database.modules!.flatMap((module) => module.assets ?? []),
      )
      expect(resolveGenerationConfiguration(reopened, next.stored, next.fingerprint).database.mainPrompt).toBe(
        'new prompt',
      )
      const report = buildAssetGcRisuSaveAssetReport(reopened, [])
      expect(report.referenced.map((asset) => asset.id)).toContain('a'.repeat(64))
      reopened.exec('BEGIN IMMEDIATE')
      expect(pruneGenerationConfigurationDependencies(reopened)).toBe(0)
      reopened.exec('DELETE FROM generation_operations')
      expect(pruneGenerationConfigurationDependencies(reopened)).toBeGreaterThan(0)
      reopened.exec('COMMIT')
    } finally {
      reopened.close()
    }
  }, 20000)

  it('keeps runtime and UI edits out of fingerprints; followups load current variables', () => {
    const { db } = setup()
    try {
      const input = configuration()
      const first = accept(db, input)
      const changed = structuredClone(input)
      Object.assign(changed.database, { sidebarWidth: 999, unknownImportHistory: 'huge' })
      Object.assign(changed.database.characters[0].chats[0], {
        pinned: false,
        scriptstate: { mood: 'new' },
        lastMemory: 'new-memory',
        message: [{ role: 'user', data: 'new runtime' }],
      })
      const second = accept(db, changed, 'operation-b')
      expect(second.fingerprint).toBe(first.fingerprint)
      const restored = resolveGenerationConfiguration(db, first.stored, first.fingerprint)
      const chat = restored.database.characters[0].chats[0]
      expect(chat.scriptstate).toBeUndefined()
      expect(chat.lastMemory).toBeUndefined()
      expect(chat.hypaV3Data).toBeUndefined()
      expect(chat.message).toEqual([])
      expect(restored.translationSettings).not.toHaveProperty('sidebarWidth')
      db.prepare('INSERT INTO characters VALUES (?, ?, ?)').run('char-a', 0, '{}')
      db.prepare('INSERT INTO chats VALUES (?, ?, ?, ?)').run(
        'chat-a',
        'char-a',
        0,
        JSON.stringify({ scriptstate: { mood: 'completed' }, lastMemory: 'new-memory' }),
      )
      overlayGenerationChatRuntime(db, chat)
      expect(chat.scriptstate).toEqual({ mood: 'completed' })
      expect(chat.lastMemory).toBe('new-memory')
    } finally {
      db.close()
    }
  })

  it('fails closed for missing/corrupt dependencies and unknown contracts; preserves legacy snapshots', () => {
    const { db } = setup()
    try {
      const input = configuration()
      const { stored, fingerprint } = accept(db, input)
      const legacyHash = generationEffectiveConfigurationFingerprint(input)
      expect(resolveGenerationConfiguration(db, input, legacyHash)).toEqual(input)
      expect(() => resolveGenerationConfiguration(db, { ...stored, contractVersion: 99 }, fingerprint)).toThrow()
      const unsupported = { ...stored, contractVersion: 99 }
      expect(() =>
        resolveGenerationConfiguration(db, unsupported, generationEffectiveConfigurationFingerprint(unsupported)),
      ).toThrow('version_unsupported')
      db.exec("UPDATE generation_configuration_dependencies SET json = '{}' WHERE kind = 'configuration'")
      expect(() => resolveGenerationConfiguration(db, stored, fingerprint)).toThrow('dependency_corrupt')
      expect(() => accept(db, input, 'operation-corrupt')).toThrow('dependency_corrupt')
      expect(
        db.prepare("SELECT 1 FROM generation_operations WHERE operation_id = 'operation-corrupt'").get(),
      ).toBeUndefined()

      db.exec('DELETE FROM generation_configuration_dependencies')
      expect(() => resolveGenerationConfiguration(db, stored, fingerprint)).toThrow('dependency_missing')
    } finally {
      db.close()
    }
  })

  it('rolls back dependency capture and preserves literal objects resembling storage references', () => {
    const { db } = setup()
    try {
      const input = configuration()
      Object.defineProperty(input.database.globalChatVariables!, '__proto__', {
        value: 'literal variable',
        enumerable: true,
      })
      Object.assign(input.database.globalChatVariables!, {
        nested: { $generationDependency: 'a'.repeat(64), kind: 'secret' },
      })
      db.exec('BEGIN IMMEDIATE')
      storeGenerationConfiguration(db, input)
      db.exec('ROLLBACK')
      expect(db.prepare('SELECT count(*) AS n FROM generation_configuration_dependencies').get()!.n).toBe(0)
      const { stored, fingerprint } = accept(db, input)
      expect(resolveGenerationConfiguration(db, stored, fingerprint).database.globalChatVariables).toEqual(
        input.database.globalChatVariables,
      )
    } finally {
      db.close()
    }
  })

  it('separates credentials and rotates the same ID without changing accepted routing', () => {
    const { db } = setup()
    try {
      const input = configuration()
      input.resolvedMainProfile = resolveModelProfileByProfileId({ database: input.database, profileId: 'profile-a' })!
      input.resolvedMainProfile.providerCapabilityInput.config = {
        ...input.resolvedMainProfile.providerCapabilityInput.config,
        oaiCompApiKeys: { custom: 'secret-at-acceptance' },
        vertexPrivateKey: 'secret-at-acceptance',
      }

      const { stored, fingerprint } = accept(db, input)
      expect(JSON.stringify(stored)).not.toContain('secret-at-acceptance')
      for (const row of db
        .prepare("SELECT json FROM generation_configuration_dependencies WHERE kind = 'configuration'")
        .all()) {
        expect(row.json).not.toContain('secret-at-acceptance')
      }
      const accepted = resolveGenerationConfiguration(db, stored, fingerprint).database
      const profile = resolveModelProfileByProfileId({ database: accepted, profileId: 'profile-a' })!
      db.prepare('INSERT INTO settings (id, data_json) VALUES (1, ?)').run(
        JSON.stringify({
          providerCredentials: [{ ...input.database.providerCredentials![0], apiKey: 'rotated' }],
          modelProfiles: [{ id: 'profile-a', providerOptions: { baseUrl: 'https://edited.example' } }],
        }),
      )
      const refreshed = refreshAcceptedProfileCredential(db, accepted, profile)
      expect(refreshed.providerOptions.apiKey).toBe('rotated')
      expect(refreshed.providerOptions.baseUrl).toBe('https://accepted.example/v1')
      expect(refreshed.requestModel).toBe('accepted-model')
      db.exec("UPDATE settings SET data_json = '{}'")
      expect(() => refreshAcceptedProfileCredential(db, accepted, profile)).toThrow('credential_unavailable')
    } finally {
      db.close()
    }
  })

  it('retains accepted catalog binaries through live deletion, then reclaims them after dependency pruning', async () => {
    const { dir, db } = setup()
    try {
      const ids = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
      mkdirSync(assetsDir(dir), { recursive: true })
      for (const id of ids) writeFileSync(path.join(assetsDir(dir), id + '.png'), Buffer.from([1]))
      insertAssetMetadataBatch(
        db,
        ids.map((id) => ({ id, ext: 'png', size: 1, contentType: 'image/png' })),
      )
      accept(db)
      const first = await runAssetGc(dir, { db, graceMs: 0, now: () => Date.now() + 1000 })
      expect(first.deletedAssetIds).toEqual([ids[2]])
      expect(existsSync(path.join(assetsDir(dir), ids[0] + '.png'))).toBe(true)
      db.exec('BEGIN IMMEDIATE; DELETE FROM generation_operations')
      pruneGenerationConfigurationDependencies(db)
      db.exec('COMMIT')
      const second = await runAssetGc(dir, { db, graceMs: 0, now: () => Date.now() + 1000 })
      expect(second.deletedAssetIds.sort()).toEqual(ids.slice(0, 2))
    } finally {
      db.close()
    }
  })

  it('upgrades v40 while leaving inline operations and fingerprints unchanged', () => {
    const { dir, db } = setup()
    db.exec('DROP TABLE generation_configuration_dependencies; UPDATE schema_version SET version = 40')
    db.close()
    const reopened = openDatabase(dir)
    try {
      expect(getSchemaState(reopened).version).toBe(CURRENT_SCHEMA_VERSION)
      expect(reopened.prepare('SELECT count(*) AS n FROM generation_configuration_dependencies').get()!.n).toBe(0)
    } finally {
      reopened.close()
    }
  })
})
