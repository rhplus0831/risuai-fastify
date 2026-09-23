import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getSchemaState, openDatabase } from '../src/db.js'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  startHarness,
  stopHarness,
  loadPersistedFromDir,
  importDatabase,
  readJsonRow,
  writeJsonRow,
} from './helpers/commandHarness.js'

let harness: Harness

const rpackEncodeMap = readFileSync(path.join(process.cwd(), 'src/ts/rpack/rpack_map.bin')).subarray(0, 256)

function risumFile(module: Record<string, unknown>): Buffer {
  const encoded = Buffer.from(JSON.stringify({ type: 'risuModule', module }), 'utf8').map(
    (byte) => rpackEncodeMap[byte],
  )
  const header = Buffer.alloc(6)
  header.writeUInt8(111, 0)
  header.writeUInt8(0, 1)
  header.writeUInt32LE(encoded.length, 2)
  return Buffer.concat([header, Buffer.from(encoded), Buffer.from([0])])
}

function multipartModuleUpload(bytes: Buffer): { payload: Buffer; contentType: string } {
  const boundary = 'risu-module-import-boundary'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="module.risum"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  )
  return {
    payload: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

describe('script and trigger definition commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('replaces character and module script and trigger definition collections', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          customscript: [],
          triggerscript: [],
          chats: [],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Mod', regex: [], trigger: [] }],
    })

    const script = {
      id: 'script-a',
      comment: 'Regex',
      in: 'a',
      out: 'b',
      type: 'editinput',
      flag: 'g',
      ableFlag: true,
    }
    const trigger = {
      id: 'trigger-a',
      comment: 'Start',
      type: 'start',
      conditions: [],
      effect: [],
    }

    const characterScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [script] },
    })
    expect(characterScripts.statusCode).toBe(200)
    expect(characterScripts.json().event).toMatchObject({
      type: 'scriptDefinitions.replaced',
      resource: 'characterRow',
      id: 'char-a',
    })

    const characterTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, triggers: [trigger] },
    })
    expect(characterTriggers.statusCode).toBe(200)
    expect(characterTriggers.json()).toMatchObject({
      revision: 3,
      characterId: 'char-a',
      event: {
        type: 'triggerDefinitions.replaced',
        resource: 'characterRow',
        id: 'char-a',
      },
    })

    const moduleScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, scripts: [{ ...script, id: 'module-script' }] },
    })
    expect(moduleScripts.statusCode).toBe(200)
    expect(moduleScripts.json()).toMatchObject({ revision: 4, moduleId: 'mod-a' })

    const moduleTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, triggers: [{ ...trigger, id: 'module-trigger' }] },
    })
    expect(moduleTriggers.statusCode).toBe(200)
    expect(moduleTriggers.json().event).toMatchObject({
      type: 'triggerDefinitions.replaced',
      // Module scripts/triggers rewrite only the `modules` table, so they emit
      // a module-scoped resource (distinct from character `characterRow`).
      resource: 'moduleTriggerDefinition',
      id: 'mod-a',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      modules: Array<{ regex?: Array<{ id: string }>; trigger?: Array<{ id: string }> }>
    }
    expect(database.characters[0].customscript[0].id).toBe('script-a')
    expect(database.characters[0].triggerscript[0].id).toBe('trigger-a')
    expect(persisted.modules[0].regex?.[0].id).toBe('module-script')
    expect(persisted.modules[0].trigger?.[0].id).toBe('module-trigger')
    expect(
      harness.commandEvents
        .list()
        .slice(-4)
        .map((event) => event.type),
    ).toEqual([
      'scriptDefinitions.replaced',
      'triggerDefinitions.replaced',
      'scriptDefinitions.replaced',
      'triggerDefinitions.replaced',
    ])
  })

  it('rejects malformed script and trigger definitions without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', customscript: [], triggerscript: [] }],
      characterOrder: ['char-a'],
    })

    const badScript = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        scripts: [{ id: 'script-a', comment: 'Bad', in: 1, out: '', type: 'editinput' }],
      },
    })
    expect(badScript.statusCode).toBe(400)
    expect(badScript.json().error).toBe('scripts[0].in must be a string')

    const missingScriptId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        scripts: [{ comment: 'Missing', in: '', out: '', type: 'editinput' }],
      },
    })
    expect(missingScriptId.statusCode).toBe(400)
    expect(missingScriptId.json().error).toBe('scripts[0].id must be a non-empty string')

    const duplicateScriptId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        scripts: [
          { id: 'script-a', comment: 'A', in: '', out: '', type: 'editinput' },
          { id: 'script-a', comment: 'B', in: '', out: '', type: 'editinput' },
        ],
      },
    })
    expect(duplicateScriptId.statusCode).toBe(400)
    expect(duplicateScriptId.json().error).toBe('Duplicate script definition id: script-a')

    const badTrigger = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        triggers: [{ id: 'trigger-a', comment: 'Bad', type: 'start', conditions: {}, effect: [] }],
      },
    })
    expect(badTrigger.statusCode).toBe(400)
    expect(badTrigger.json().error).toBe('triggers[0].conditions must be an array')

    const legacyTupleWrite = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        triggers: [{ id: 'trigger-a', comment: 'Legacy', type: ['start'], conditions: [], effect: [] }],
      },
    })
    expect(legacyTupleWrite.statusCode).toBe(400)
    expect(legacyTupleWrite.json().error).toBe('triggers[0].type must be a string')

    const missingTriggerId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        triggers: [{ comment: 'Missing', type: 'start', conditions: [], effect: [] }],
      },
    })
    expect(missingTriggerId.statusCode).toBe(400)
    expect(missingTriggerId.json().error).toBe('triggers[0].id must be a non-empty string')

    const duplicateTriggerId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        triggers: [
          { id: 'trigger-a', comment: 'A', type: 'start', conditions: [], effect: [] },
          { id: 'trigger-a', comment: 'B', type: 'start', conditions: [], effect: [] },
        ],
      },
    })
    expect(duplicateTriggerId.statusCode).toBe(400)
    expect(duplicateTriggerId.json().error).toBe('Duplicate trigger definition id: trigger-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characters[0].customscript).toEqual([])
    expect(bootstrap.resourceDatabase.characters[0].triggerscript).toEqual([])
  })

  it('replaces only the owned definition field on sparse raw character and module rows', { tags: 'core' }, async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', customscript: [], triggerscript: [] }],
      characterOrder: ['char-a'],
      modules: [
        { id: 'mod-a', name: 'Mod A', regex: [], trigger: [] },
        { id: 'mod-b', name: 'Mod B', regex: [], trigger: [], opaque: { sibling: true } },
      ],
    })

    const invalidScript = { id: 'invalid-script', comment: 'Invalid', in: 17, out: '', type: 'editinput' }
    const invalidTrigger = {
      id: 'invalid-trigger',
      comment: 'Invalid',
      type: 'start',
      conditions: { legacy: true },
      effect: [],
    }
    const sparseCharacter = {
      chaId: 'char-a',
      customscript: [{ id: 'old-script', comment: 'Old', in: 'a', out: 'b', type: 'editinput' }],
      triggerscript: [invalidTrigger],
      opaque: { preserve: ['character', 1] },
    }
    const sparseModule = {
      id: 'mod-a',
      regex: [{ id: 'old-module-script', comment: 'Old', in: 'a', out: 'b', type: 'editinput' }],
      trigger: [invalidTrigger],
      opaque: { preserve: ['module', 1] },
    }
    const siblingModuleBefore = readJsonRow(harness.dataDir, 'modules', 'mod-b')
    writeJsonRow(harness.dataDir, 'characters', 'char-a', sparseCharacter)
    writeJsonRow(harness.dataDir, 'modules', 'mod-a', sparseModule)

    const script = { id: 'new-script', comment: 'New', in: 'x', out: 'y', type: 'editinput' }
    const characterScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [script] },
    })
    expect(characterScripts.statusCode, JSON.stringify(characterScripts.json())).toBe(200)
    revision = characterScripts.json().revision
    expect(readJsonRow(harness.dataDir, 'characters', 'char-a')).toEqual({ ...sparseCharacter, customscript: [script] })

    const moduleScript = { ...script, id: 'new-module-script' }
    const moduleScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [moduleScript] },
    })
    expect(moduleScripts.statusCode, JSON.stringify(moduleScripts.json())).toBe(200)
    revision = moduleScripts.json().revision
    expect(readJsonRow(harness.dataDir, 'modules', 'mod-a')).toEqual({ ...sparseModule, regex: [moduleScript] })
    expect(readJsonRow(harness.dataDir, 'modules', 'mod-b')).toEqual(siblingModuleBefore)

    const characterBeforeTrigger = {
      ...readJsonRow(harness.dataDir, 'characters', 'char-a'),
      customscript: [invalidScript],
    }
    const moduleBeforeTrigger = {
      ...readJsonRow(harness.dataDir, 'modules', 'mod-a'),
      regex: [invalidScript],
    }
    writeJsonRow(harness.dataDir, 'characters', 'char-a', characterBeforeTrigger)
    writeJsonRow(harness.dataDir, 'modules', 'mod-a', moduleBeforeTrigger)
    const trigger = { id: 'new-trigger', comment: 'New', type: 'start', conditions: [], effect: [] }

    const characterTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, triggers: [trigger] },
    })
    expect(characterTriggers.statusCode, JSON.stringify(characterTriggers.json())).toBe(200)
    revision = characterTriggers.json().revision
    expect(readJsonRow(harness.dataDir, 'characters', 'char-a')).toEqual({
      ...characterBeforeTrigger,
      triggerscript: [trigger],
    })

    const moduleTrigger = { ...trigger, id: 'new-module-trigger' }
    const moduleTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, triggers: [moduleTrigger] },
    })
    expect(moduleTriggers.statusCode, JSON.stringify(moduleTriggers.json())).toBe(200)
    expect(readJsonRow(harness.dataDir, 'modules', 'mod-a')).toEqual({
      ...moduleBeforeTrigger,
      trigger: [moduleTrigger],
    })
    expect(readJsonRow(harness.dataDir, 'modules', 'mod-b')).toEqual(siblingModuleBefore)
  })

  it('rejects duplicate raw character ids instead of silently selecting one', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        { chaId: 'char-a', name: 'A', customscript: [], triggerscript: [] },
        { chaId: 'char-b', name: 'B', customscript: [], triggerscript: [] },
      ],
      characterOrder: ['char-a', 'char-b'],
    })
    writeJsonRow(harness.dataDir, 'characters', 'char-a', {
      ...readJsonRow(harness.dataDir, 'characters', 'char-a'),
      chaId: 'duplicate',
    })
    writeJsonRow(harness.dataDir, 'characters', 'char-b', {
      ...readJsonRow(harness.dataDir, 'characters', 'char-b'),
      chaId: 'duplicate',
    })

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/duplicate/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [] },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Duplicate character id: duplicate')
    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })

  it('script and trigger routes skip unrelated definition validation and keep target payload checks strict', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          customscript: [],
          triggerscript: [],
          chats: [],
          chatFolders: [],
          chatPage: 0,
        },
        {
          chaId: 'char-b',
          name: 'B',
          customscript: [],
          triggerscript: [],
          chats: [],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
      modules: [
        { id: 'mod-a', name: 'Mod A', regex: [], trigger: [] },
        { id: 'mod-b', name: 'Mod B', regex: [], trigger: [] },
      ],
    })

    const invalidScript = { id: 'bad-script', comment: 'Bad', in: 1, out: '', type: 'editinput' }
    const invalidTrigger = {
      id: 'bad-trigger',
      comment: 'Bad',
      type: 'start',
      conditions: {},
      effect: [],
    }
    writeJsonRow(harness.dataDir, 'characters', 'char-b', {
      ...readJsonRow(harness.dataDir, 'characters', 'char-b'),
      customscript: [invalidScript],
      triggerscript: [invalidTrigger],
    })
    writeJsonRow(harness.dataDir, 'modules', 'mod-b', {
      ...readJsonRow(harness.dataDir, 'modules', 'mod-b'),
      regex: [invalidScript],
      trigger: [invalidTrigger],
      lorebook: undefined,
    })

    const script = {
      id: 'script-a',
      comment: 'Regex',
      in: 'a',
      out: 'b',
      type: 'editinput',
    }
    const trigger = {
      id: 'trigger-a',
      comment: 'Start',
      type: 'start',
      conditions: [],
      effect: [],
    }

    const characterScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [script] },
    })
    expect(characterScripts.statusCode, JSON.stringify(characterScripts.json())).toBe(200)

    const characterTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, triggers: [trigger] },
    })
    expect(characterTriggers.statusCode, JSON.stringify(characterTriggers.json())).toBe(200)

    const moduleScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, scripts: [{ ...script, id: 'module-script' }] },
    })
    expect(moduleScripts.statusCode, JSON.stringify(moduleScripts.json())).toBe(200)

    const moduleTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, triggers: [{ ...trigger, id: 'module-trigger' }] },
    })
    expect(moduleTriggers.statusCode, JSON.stringify(moduleTriggers.json())).toBe(200)

    const malformedScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 5, scripts: { id: 'not-an-array' } },
    })
    expect(malformedScripts.statusCode).toBe(400)
    expect(malformedScripts.json().error).toBe('scripts must be an array')

    const malformedTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 5, triggers: { id: 'not-an-array' } },
    })
    expect(malformedTriggers.statusCode).toBe(400)
    expect(malformedTriggers.json().error).toBe('triggers must be an array')

    expect(readJsonRow(harness.dataDir, 'characters', 'char-b').customscript).toEqual([invalidScript])
    expect(readJsonRow(harness.dataDir, 'characters', 'char-b').triggerscript).toEqual([invalidTrigger])
    expect(readJsonRow(harness.dataDir, 'modules', 'mod-b').regex).toEqual([invalidScript])
    expect(readJsonRow(harness.dataDir, 'modules', 'mod-b').trigger).toEqual([invalidTrigger])
    expect(readJsonRow(harness.dataDir, 'modules', 'mod-b')).not.toHaveProperty('lorebook')
  })

  it('returns 404 and 409 for missing parents and stale script revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [],
      modules: [{ id: 'mod-a', name: 'Mod', mcp: { url: 'https://example.invalid' } }],
    })

    const missingCharacter = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/missing/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [] },
    })
    expect(missingCharacter.statusCode).toBe(404)
    expect(missingCharacter.json().error).toBe('Character not found: missing')

    const mcpModule = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [] },
    })
    expect(mcpModule.statusCode).toBe(404)
    expect(mcpModule.json().error).toBe('Module not found: mod-a')

    const stale = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/missing/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, scripts: [] },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })

  it('canonicalizes a one-element legacy trigger-mode tuple on .risum import and rejects wider tuples', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [],
      characterOrder: [],
      modules: [],
    })
    const headers = { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' }
    const trigger = (type: unknown) => ({
      id: 'trigger-tuple',
      comment: 'Legacy tuple',
      type,
      conditions: [],
      effect: [{ type: 'triggerlua', code: '' }],
    })

    const tuple = multipartModuleUpload(
      risumFile({ id: 'source-module', name: 'Tuple module', trigger: [trigger(['input'])] }),
    )
    const imported = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/import/module?baseRevision=${revision}`,
      headers: { ...headers, 'content-type': tuple.contentType },
      payload: tuple.payload,
    })
    expect(imported.statusCode, imported.body).toBe(200)
    const moduleId = imported.json().moduleId as string
    const stored = readJsonRow(harness.dataDir, 'modules', moduleId)
    expect(stored.trigger).toEqual([expect.objectContaining({ comment: 'Legacy tuple', type: 'input' })])

    const wider = multipartModuleUpload(
      risumFile({ id: 'source-module', name: 'Wider tuple module', trigger: [trigger(['input', 'output'])] }),
    )
    const rejected = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/import/module?baseRevision=${imported.json().revision}`,
      headers: { ...headers, 'content-type': wider.contentType },
      payload: wider.payload,
    })
    expect(rejected.statusCode, rejected.body).toBe(400)
    expect(rejected.json().error).toMatch(/^module [0-9a-f-]+\.trigger\[0\]\.type must be a string$/)
    const persisted = loadPersistedFromDir(harness.dataDir).database as { modules: Array<{ name: string }> }
    expect(persisted.modules.map((module) => module.name)).toEqual(['Tuple module'])
  })
})

describe('compact script and trigger definition mutations', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('updates, creates, reorders, and deletes rows on all four definition owners', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const script = (id: string) => ({
      id,
      comment: `Script ${id}`,
      in: 'input',
      out: 'output',
      type: 'editinput',
      flag: 'g',
      removeMe: 'delete this',
      extension: { original: true },
    })
    const trigger = (id: string) => ({
      id,
      comment: `Trigger ${id}`,
      type: 'start',
      conditions: [],
      effect: [],
      removeMe: 'delete this',
      extension: { original: true },
    })
    let revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          customscript: [script('character-script')],
          triggerscript: [trigger('character-trigger')],
        },
      ],
      characterOrder: ['char-a'],
      modules: [
        {
          id: 'mod-a',
          name: 'Mod',
          regex: [script('module-script')],
          trigger: [trigger('module-trigger')],
        },
      ],
    })

    const targets = [
      {
        url: '/api/v1/commands/characters/char-a/scripts',
        table: 'characters' as const,
        ownerId: 'char-a',
        ownerKey: 'characterId',
        field: 'customscript',
        initialId: 'character-script',
        createdId: 'character-script-created',
        eventType: 'scriptDefinitions.replaced',
        resource: 'characterRow',
        row: script,
      },
      {
        url: '/api/v1/commands/characters/char-a/triggers',
        table: 'characters' as const,
        ownerId: 'char-a',
        ownerKey: 'characterId',
        field: 'triggerscript',
        initialId: 'character-trigger',
        createdId: 'character-trigger-created',
        eventType: 'triggerDefinitions.replaced',
        resource: 'characterRow',
        row: trigger,
      },
      {
        url: '/api/v1/commands/modules/mod-a/scripts',
        table: 'modules' as const,
        ownerId: 'mod-a',
        ownerKey: 'moduleId',
        field: 'regex',
        initialId: 'module-script',
        createdId: 'module-script-created',
        eventType: 'scriptDefinitions.replaced',
        resource: 'moduleScriptDefinition',
        row: script,
      },
      {
        url: '/api/v1/commands/modules/mod-a/triggers',
        table: 'modules' as const,
        ownerId: 'mod-a',
        ownerKey: 'moduleId',
        field: 'trigger',
        initialId: 'module-trigger',
        createdId: 'module-trigger-created',
        eventType: 'triggerDefinitions.replaced',
        resource: 'moduleTriggerDefinition',
        row: trigger,
      },
    ]

    for (const target of targets) {
      const request = async (mutation: Record<string, unknown>) => {
        const response = await harness.app.inject({
          method: 'PATCH',
          url: target.url,
          headers: { 'risu-auth': assertion },
          payload: { baseRevision: revision, mutation },
        })
        expect(response.statusCode, JSON.stringify(response.json())).toBe(200)
        const body = response.json() as Record<string, unknown>
        expect(Object.keys(body).sort()).toEqual(
          target.ownerKey === 'characterId' ? ['characterId', 'event', 'revision'] : ['event', 'moduleId', 'revision'],
        )
        expect(body[target.ownerKey]).toBe(target.ownerId)
        expect(body).not.toHaveProperty('scripts')
        expect(body).not.toHaveProperty('triggers')
        expect(body).not.toHaveProperty('mutation')
        expect(body.event).toMatchObject({
          type: target.eventType,
          resource: target.resource,
          id: target.ownerId,
        })
        revision = body.revision as number
      }
      const readRows = () =>
        readJsonRow(harness.dataDir, target.table, target.ownerId)[target.field] as Array<Record<string, unknown>>

      await request({
        op: 'update',
        id: target.initialId,
        patch: {
          comment: `Updated ${target.initialId}`,
          extension: { original: true, updated: true },
          addedUnknown: ['preserved'],
        },
        deleteKeys: ['removeMe'],
      })
      expect(readRows()).toHaveLength(1)
      expect(readRows()[0]).toMatchObject({
        id: target.initialId,
        comment: `Updated ${target.initialId}`,
        extension: { original: true, updated: true },
        addedUnknown: ['preserved'],
      })
      expect(readRows()[0]).not.toHaveProperty('removeMe')

      const createdRow = { ...target.row(target.createdId), extension: { created: true } }
      await request({ op: 'create', row: createdRow, index: 0 })
      expect(readRows().map((row) => row.id)).toEqual([target.createdId, target.initialId])
      expect(readRows()[0].extension).toEqual({ created: true })

      await request({ op: 'reorder', ids: [target.initialId, target.createdId] })
      expect(readRows().map((row) => row.id)).toEqual([target.initialId, target.createdId])

      await request({ op: 'delete', id: target.initialId })
      expect(readRows()).toEqual([createdRow])
    }
  })

  it('strictly validates mutation shapes and row-level operations without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          customscript: [
            { id: 'script-a', comment: 'A', in: 'a', out: 'b', type: 'editinput' },
            { id: 'script-b', comment: 'B', in: 'b', out: 'c', type: 'editinput' },
          ],
          triggerscript: [],
        },
      ],
      characterOrder: ['char-a'],
    })
    const url = '/api/v1/commands/characters/char-a/scripts'
    const cases: Array<{
      name: string
      payload: Record<string, unknown>
      status?: number
      error: string
    }> = [
      {
        name: 'legacy scripts field',
        payload: { baseRevision: revision, mutation: { op: 'delete', id: 'script-a' }, scripts: [] },
        error: 'body.scripts is not supported for definition mutation commands',
      },
      {
        name: 'unknown update key',
        payload: {
          baseRevision: revision,
          mutation: { op: 'update', id: 'script-a', patch: { comment: 'x' }, extra: true },
        },
        error: 'mutation.extra is not supported for update',
      },
      {
        name: 'empty update',
        payload: { baseRevision: revision, mutation: { op: 'update', id: 'script-a' } },
        error: 'update mutation must include patch fields or deleteKeys',
      },
      {
        name: 'blank update id',
        payload: { baseRevision: revision, mutation: { op: 'update', id: ' ', patch: { comment: 'x' } } },
        error: 'mutation.id must be a non-empty string',
      },
      {
        name: 'id patch',
        payload: { baseRevision: revision, mutation: { op: 'update', id: 'script-a', patch: { id: 'new' } } },
        error: 'mutation.patch.id is not supported',
      },
      {
        name: 'id deletion',
        payload: { baseRevision: revision, mutation: { op: 'update', id: 'script-a', deleteKeys: ['id'] } },
        error: 'mutation.deleteKeys cannot include id',
      },
      {
        name: 'duplicate delete key',
        payload: {
          baseRevision: revision,
          mutation: { op: 'update', id: 'script-a', deleteKeys: ['comment', 'comment'] },
        },
        error: 'Duplicate mutation.deleteKeys field: comment',
      },
      {
        name: 'patch and delete overlap',
        payload: {
          baseRevision: revision,
          mutation: { op: 'update', id: 'script-a', patch: { comment: 'x' }, deleteKeys: ['comment'] },
        },
        error: 'mutation.deleteKeys cannot also patch comment',
      },
      {
        name: 'invalid resulting row',
        payload: { baseRevision: revision, mutation: { op: 'update', id: 'script-a', patch: { in: 17 } } },
        error: 'scripts[0].in must be a string',
      },
      {
        name: 'missing update target',
        payload: { baseRevision: revision, mutation: { op: 'update', id: 'missing', patch: { comment: 'x' } } },
        status: 404,
        error: 'Script definition not found: missing',
      },
      {
        name: 'unknown create key',
        payload: {
          baseRevision: revision,
          mutation: {
            op: 'create',
            row: { id: 'script-c', comment: 'C', in: '', out: '', type: 'editinput' },
            index: 0,
            extra: true,
          },
        },
        error: 'mutation.extra is not supported for create',
      },
      {
        name: 'negative create index',
        payload: {
          baseRevision: revision,
          mutation: {
            op: 'create',
            row: { id: 'script-c', comment: 'C', in: '', out: '', type: 'editinput' },
            index: -1,
          },
        },
        error: 'mutation.index must be a non-negative integer',
      },
      {
        name: 'large create index',
        payload: {
          baseRevision: revision,
          mutation: {
            op: 'create',
            row: { id: 'script-c', comment: 'C', in: '', out: '', type: 'editinput' },
            index: 3,
          },
        },
        error: 'mutation.index must be at most 2',
      },
      {
        name: 'duplicate create id',
        payload: {
          baseRevision: revision,
          mutation: {
            op: 'create',
            row: { id: 'script-a', comment: 'C', in: '', out: '', type: 'editinput' },
            index: 0,
          },
        },
        error: 'Duplicate script definition id: script-a',
      },
      {
        name: 'missing create id',
        payload: {
          baseRevision: revision,
          mutation: {
            op: 'create',
            row: { comment: 'C', in: '', out: '', type: 'editinput' },
            index: 0,
          },
        },
        error: 'scripts[0].id must be a non-empty string',
      },
      {
        name: 'unknown delete key',
        payload: { baseRevision: revision, mutation: { op: 'delete', id: 'script-a', extra: true } },
        error: 'mutation.extra is not supported for delete',
      },
      {
        name: 'missing delete target',
        payload: { baseRevision: revision, mutation: { op: 'delete', id: 'missing' } },
        status: 404,
        error: 'Script definition not found: missing',
      },
      {
        name: 'unknown reorder key',
        payload: {
          baseRevision: revision,
          mutation: { op: 'reorder', ids: ['script-a', 'script-b'], extra: true },
        },
        error: 'mutation.extra is not supported for reorder',
      },
      {
        name: 'duplicate reorder id',
        payload: { baseRevision: revision, mutation: { op: 'reorder', ids: ['script-a', 'script-a'] } },
        error: 'Duplicate definition id in mutation.ids: script-a',
      },
      {
        name: 'blank reorder id',
        payload: { baseRevision: revision, mutation: { op: 'reorder', ids: ['script-a', ' '] } },
        error: 'mutation.ids[1] must be a non-empty string',
      },
      {
        name: 'unknown reorder id',
        payload: { baseRevision: revision, mutation: { op: 'reorder', ids: ['script-a', 'missing'] } },
        error: 'Unknown script definition id in mutation.ids: missing',
      },
      {
        name: 'incomplete reorder',
        payload: { baseRevision: revision, mutation: { op: 'reorder', ids: ['script-a'] } },
        error: 'mutation.ids must include every script definition',
      },
      {
        name: 'unsupported operation',
        payload: { baseRevision: revision, mutation: { op: 'replace', ids: [] } },
        error: 'Unsupported definition mutation operation: replace',
      },
    ]

    for (const testCase of cases) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url,
        headers: { 'risu-auth': assertion },
        payload: testCase.payload,
      })
      expect(response.statusCode, testCase.name).toBe(testCase.status ?? 400)
      expect(response.json().error, testCase.name).toBe(testCase.error)
    }

    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })

  it('creates into absent arrays, rejects present non-arrays, malformed current ids, and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A' }],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Mod' }],
    })
    writeJsonRow(harness.dataDir, 'characters', 'char-a', { chaId: 'char-a', opaque: { exact: true } })
    writeJsonRow(harness.dataDir, 'modules', 'mod-a', { id: 'mod-a', opaque: { exact: true } })

    const characterCreate = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        mutation: {
          op: 'create',
          row: { id: 'script-a', comment: 'A', in: '', out: '', type: 'editinput', unknown: { keep: true } },
          index: 0,
        },
      },
    })
    expect(characterCreate.statusCode, JSON.stringify(characterCreate.json())).toBe(200)
    revision = characterCreate.json().revision
    expect(readJsonRow(harness.dataDir, 'characters', 'char-a')).toEqual({
      chaId: 'char-a',
      opaque: { exact: true },
      customscript: [{ id: 'script-a', comment: 'A', in: '', out: '', type: 'editinput', unknown: { keep: true } }],
    })

    const moduleCreate = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        mutation: {
          op: 'create',
          row: { id: 'trigger-a', comment: 'A', type: 'start', conditions: [], effect: [] },
          index: 0,
        },
      },
    })
    expect(moduleCreate.statusCode, JSON.stringify(moduleCreate.json())).toBe(200)
    revision = moduleCreate.json().revision
    expect(readJsonRow(harness.dataDir, 'modules', 'mod-a')).toEqual({
      id: 'mod-a',
      opaque: { exact: true },
      trigger: [{ id: 'trigger-a', comment: 'A', type: 'start', conditions: [], effect: [] }],
    })

    writeJsonRow(harness.dataDir, 'characters', 'char-a', {
      ...readJsonRow(harness.dataDir, 'characters', 'char-a'),
      triggerscript: { legacy: true },
    })
    const nonArray = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        mutation: {
          op: 'create',
          row: { id: 'trigger-b', comment: 'B', type: 'start', conditions: [], effect: [] },
          index: 0,
        },
      },
    })
    expect(nonArray.statusCode).toBe(400)
    expect(nonArray.json().error).toBe('triggers must be an array')

    writeJsonRow(harness.dataDir, 'modules', 'mod-a', {
      ...readJsonRow(harness.dataDir, 'modules', 'mod-a'),
      regex: [
        { id: 'duplicate', comment: 'A', in: '', out: '', type: 'editinput' },
        { id: 'duplicate', comment: 'B', in: '', out: '', type: 'editinput' },
      ],
    })
    const duplicateCurrentIds = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        mutation: { op: 'update', id: 'duplicate', patch: { comment: 'Updated' } },
      },
    })
    expect(duplicateCurrentIds.statusCode).toBe(400)
    expect(duplicateCurrentIds.json().error).toBe('Duplicate script definition id: duplicate')

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision - 1, mutation: { op: 'delete', id: 'script-a' } },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: revision })
  })
})
