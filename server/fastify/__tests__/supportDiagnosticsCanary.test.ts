import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import {
  isRemoteDiagnosticsResponse,
  isSupportDiagnosticsStateResponse,
  projectRemoteDiagnosticRecordV4,
  SUPPORT_DIAGNOSTICS_ENDPOINT,
  SUPPORT_DIAGNOSTICS_STATE_ENDPOINT,
  type RemoteDiagnosticRecordV4,
} from '@risuai/protocol/remote-diagnostics'
import { buildApp, type BuiltApp } from '../src/app.js'
import { openDatabase } from '../src/db.js'
import { runOpenAIStream, resolveOpenAIRequest } from '../src/generation/openai.js'
import { applyImport } from '../src/repository.js'
import { normalizeRisuSaveSnapshotDatabase } from '../src/risuSave/importSnapshot.js'
import { mintSupportDiagnosticsCredential } from '../src/supportDiagnosticsAuth.js'
import { readRemoteDiagnosticsConfig } from '../../../util/diagnostics-remote.js'
import { setupAuthedClient } from './helpers/auth.js'

/** Every sensitive source the channel must never carry, each with a distinct marker. */
const marks = {
  personaName: 'PRIVATE_CANARY_PERSONA_NAME_a71e',
  persona: 'PRIVATE_CANARY_PERSONA_PROMPT_b2c4',
  characterName: 'PRIVATE_CANARY_CHARACTER_NAME_c3d5',
  character: 'PRIVATE_CANARY_CHARACTER_DESC_d4e6',
  loreKey: 'PRIVATE_CANARY_LORE_KEY_e5f7',
  lore: 'PRIVATE_CANARY_LORE_CONTENT_f6a8',
  presetName: 'PRIVATE_CANARY_PRESET_NAME_a7b9',
  preset: 'PRIVATE_CANARY_PRESET_PROMPT_b8c0',
  model: 'PRIVATE_CANARY_MODEL_ID_c9d1',
  chatName: 'PRIVATE_CANARY_CHAT_NAME_d0e2',
  priorMessage: 'PRIVATE_CANARY_PRIOR_MESSAGE_e1f3',
  userMessage: 'PRIVATE_CANARY_USER_MESSAGE_f2a4',
  luaError: 'PRIVATE_CANARY_LUA_ERROR_a3b5',
  urlPath: 'PRIVATE_CANARY_URL_PATH_b4c6',
  key: 'PRIVATE_CANARY_API_KEY_c5d7',
  header: 'PRIVATE_CANARY_HEADER_d6e8',
  echo: 'PRIVATE_CANARY_PROVIDER_ECHO_e7f9',
  jobId: 'private-canary-job-f8a0',
  characterA: 'private-canary-character-a',
  characterB: 'private-canary-character-b',
  chatA: 'private-canary-chat-a',
  chatB: 'private-canary-chat-b',
}
const head = 'e'.repeat(40)
const FACT_ID =
  /^(?:rejection\.code(?:\.\d+)?|error(?:\.\d+)?\.name|error(?:\.\d+)?\.location\.\d+|runtime\.location\.\d+|validation\.(?:domain|owner|rule|value-kind|field)|provider\.(?:adapter|status))$/

function fixtureDatabase() {
  const promptSettings = {
    assistantPrefill: '',
    postEndInnerFormat: '',
    sendChatAsSystem: false,
    sendName: false,
    utilOverride: false,
  }
  const generationSettings = {
    configured: true,
    personaId: 'canary-persona',
    modelPresetId: 'canary-model-preset',
    promptPresetId: 'canary-prompt-preset',
    jailbreakToggle: false,
    sidebarToggles: {},
  }
  const character = (chaId: string, chatId: string, extra: Record<string, unknown>) => ({
    type: 'character',
    chaId,
    name: marks.characterName,
    utilityBot: false,
    chatPage: 0,
    desc: marks.character,
    firstMessage: '',
    globalLore: [
      {
        key: marks.loreKey,
        secondkey: '',
        insertorder: 100,
        comment: marks.loreKey,
        content: marks.lore,
        mode: 'normal',
        alwaysActive: true,
        selective: false,
      },
    ],
    chats: [
      {
        id: chatId,
        name: marks.chatName,
        note: '',
        message: [{ role: 'user', data: marks.priorMessage, chatId: `${chatId}-message` }],
        localLore: [],
        generationSettings,
      },
    ],
    ...extra,
  })
  return {
    currentChar: 0,
    characters: [
      character(marks.characterA, marks.chatA, {}),
      character(marks.characterB, marks.chatB, {
        triggerscript: [
          {
            comment: 'canary',
            type: 'input',
            conditions: [],
            effect: [{ type: 'triggerlua', code: `error('${marks.luaError}')` }],
          },
        ],
      }),
    ],
    selectedPersona: 0,
    personas: [{ id: 'canary-persona', name: marks.personaName, personaPrompt: marks.persona, icon: '', note: '' }],
    modelPresetsId: 0,
    promptPresetsId: 0,
    botPresets: [],
    modelPresets: [{ id: 'canary-model-preset', name: marks.presetName, maxContext: 100_000, maxResponse: 50 }],
    promptPresets: [
      {
        id: 'canary-prompt-preset',
        name: marks.presetName,
        mainPrompt: marks.preset,
        formatingOrder: ['main', 'personaPrompt', 'description', 'lorebook', 'chats', 'lastChat'],
        promptSettings,
        customPromptTemplateToggle: '',
      },
    ],
    modules: [],
    enabledModules: [],
    formatingOrder: ['main', 'personaPrompt', 'description', 'lorebook', 'chats', 'lastChat'],
    promptSettings,
    mainPrompt: marks.preset,
    maxContext: 100_000,
    maxResponse: 50,
  }
}

function encodings(secret: string): string[] {
  const digest = createHash('sha256').update(secret).digest('hex')
  return [
    secret,
    secret.toLowerCase(),
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'),
    Buffer.from(secret).toString('base64url'),
    Buffer.from(secret).toString('hex'),
    digest,
    digest.slice(0, 32),
    digest.slice(0, 16),
  ]
}

function assertContentFree(surface: string, value: string, secrets: readonly string[]): void {
  const lower = value.toLowerCase()
  for (const secret of secrets) {
    for (const encoded of new Set(encodings(secret))) {
      expect(lower.includes(encoded.toLowerCase()), `${surface} carries ${secret} as ${encoded}`).toBe(false)
    }
  }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})

it('keeps every sensitive source out of every support surface while still recording the failures', async () => {
  vi.stubEnv('LOG_LEVEL', 'silent')
  vi.stubEnv('RISU_PROTOCOL_METRICS', '0')
  const root = mkdtempSync(path.join(tmpdir(), 'risu-support-canary-'))
  const dataDir = path.join(root, 'data')
  const privateDir = path.join(root, 'private')
  mkdirSync(privateDir, { mode: 0o700 })
  const verifierFile = path.join(privateDir, 'verifier.json')
  const credentialFile = path.join(privateDir, 'remote.json')
  await mintSupportDiagnosticsCredential({ verifierFile, credentialFile, origin: 'https://synthetic.invalid' })
  const token = readRemoteDiagnosticsConfig(credentialFile).token
  const providerBodies: string[] = []
  const provider = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    providerBodies.push(body)
    // A provider that echoes the whole request back inside its error body.
    response.writeHead(400, { 'Content-Type': 'application/json', 'X-Upstream-Private': marks.header })
    response.end(JSON.stringify({ error: { message: `${marks.echo} ${body}`, type: 'invalid_request_error' } }))
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    provider.closeAllConnections()
    await new Promise<void>((resolve) => provider.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })
  const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`
  const db = openDatabase(dataDir)
  await applyImport(db, dataDir, normalizeRisuSaveSnapshotDatabase(fixtureDatabase()))
  db.close()

  let current: BuiltApp | undefined
  const start = async () => {
    const built = await buildApp({
      buildIdentity: { build: head, source: 'git', locationsTrusted: true, dirty: false },
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir,
        bodyLimit: 1024 * 1024,
        importMaxBytes: Infinity,
        trustProxy: false,
        hubUrl: 'https://synthetic.invalid',
        staticRoot: null,
        clientDiagnostics: true,
        supportDiagnostics: { enabled: true, verifierFile },
      },
      generationChat: {
        dispatchProvider(context) {
          const request = resolveOpenAIRequest({
            model: marks.model,
            messages: context.result.formated ?? context.result.prompt.formated,
            apiKey: marks.key,
            baseUrl: `${providerOrigin}/${marks.urlPath}`,
            extraHeaders: { 'X-Private': marks.header },
            signal: context.signal,
            trace: context.trace,
          })
          if (!request) throw new Error('synthetic provider fixture is invalid')
          return runOpenAIStream(request)
        },
      },
      memoryWorker: false,
      bardWikiWorker: false,
      assetGc: false,
    })
    await built.app.ready()
    await built.diagnostics.ready
    current = built
    return built
  }
  cleanup.push(async () => {
    await current?.app.close()
  })
  let built = await start()
  const { assertion } = await setupAuthedClient(built.app)
  const secrets = [...Object.values(marks), token, assertion, dataDir]
  const support = { authorization: `Bearer ${token}` }
  const settled = () =>
    vi.waitFor(() => expect(current!.diagnostics.journal?.read().pending).toBe(0), { timeout: 5000, interval: 20 })

  // 1. A provider HTTP error whose body echoes the assembled prompt.
  const echoed = await built.app.inject({
    method: 'POST',
    url: '/api/v1/generate/chat',
    headers: { 'risu-auth': assertion },
    payload: {
      chatId: marks.chatA,
      characterId: marks.characterA,
      mode: 'send',
      userMessage: marks.userMessage,
      durable: true,
    },
  })
  expect(echoed.statusCode).toBe(200)
  await built.generationJobs.settleRunners()
  // Provider HTTP errors are retried; every attempt carried the full prompt.
  expect(providerBodies.length).toBeGreaterThanOrEqual(1)
  const dispatched = providerBodies.length
  for (const secret of [
    marks.persona,
    marks.character,
    marks.lore,
    marks.preset,
    marks.priorMessage,
    marks.userMessage,
  ])
    expect(providerBodies[0]).toContain(secret)

  // 2. A user-authored Lua trigger that raises with content in its message.
  const scripted = await built.app.inject({
    method: 'POST',
    url: '/api/v1/generate/chat',
    headers: { 'risu-auth': assertion },
    payload: {
      chatId: marks.chatB,
      characterId: marks.characterB,
      mode: 'send',
      userMessage: marks.userMessage,
      durable: true,
    },
  })
  expect(scripted.statusCode).toBeGreaterThanOrEqual(200)
  await built.generationJobs.settleRunners()
  expect(providerBodies).toHaveLength(dispatched)

  // 3. A closed-code rejection whose request path carries content.
  const rejected = await built.app.inject({
    url: `/api/v1/generate/chat/${marks.jobId}/stream`,
    headers: { 'risu-auth': assertion },
  })
  expect(rejected.statusCode).toBe(404)
  expect(rejected.json()).toMatchObject({ error: 'generation_job_not_found' })
  await settled()

  const readAllV4 = async (app: BuiltApp['app']): Promise<RemoteDiagnosticRecordV4[]> => {
    const entries: RemoteDiagnosticRecordV4[] = []
    let query = 'version=4&limit=5'
    for (let page = 0; page < 200; page++) {
      const response = await app.inject({ url: `${SUPPORT_DIAGNOSTICS_ENDPOINT}?${query}`, headers: support })
      expect(response.statusCode).toBe(200)
      assertContentFree(`support v4 page ${page}`, response.body, secrets)
      const value: unknown = response.json()
      if (!isRemoteDiagnosticsResponse(value) || value.version !== 4) throw new Error('expected validated v4 evidence')
      expect(value.identity).toEqual({ build: head, instanceId: value.identity.instanceId })
      entries.push(...value.entries)
      if (!value.pagination.nextCursor) return entries
      query = `version=4&cursor=${value.pagination.nextCursor}`
    }
    throw new Error('unbounded pagination')
  }
  const records = await readAllV4(built.app)
  for (const version of ['1', '2', '3']) {
    const response = await built.app.inject({
      url: `${SUPPORT_DIAGNOSTICS_ENDPOINT}?version=${version}&limit=200`,
      headers: support,
    })
    expect(response.statusCode).toBe(200)
    expect(isRemoteDiagnosticsResponse(response.json())).toBe(true)
    assertContentFree(`support v${version}`, response.body, secrets)
  }
  const state = await built.app.inject({ url: SUPPORT_DIAGNOSTICS_STATE_ENDPOINT, headers: support })
  expect(state.statusCode).toBe(200)
  assertContentFree('state', state.body, secrets)
  const snapshot: unknown = state.json()
  if (!isSupportDiagnosticsStateResponse(snapshot)) throw new Error('expected a validated state snapshot')
  expect(snapshot.rejections.byCode.generation_job_not_found).toBeGreaterThanOrEqual(1)
  for (const url of ['/api/v1/diagnostics', '/api/v1/diagnostics?version=2']) {
    const manual = await built.app.inject({ url, headers: { 'risu-auth': assertion } })
    expect(manual.statusCode).toBe(200)
    assertContentFree(url, manual.body, secrets)
  }

  // Positive controls: the failures were recorded, with closed facts only.
  const facts = (record: RemoteDiagnosticRecordV4) => Object.fromEntries((record.facts ?? []).map((f) => [f.id, f]))
  for (const record of records) for (const fact of record.facts ?? []) expect(fact.id).toMatch(FACT_ID)
  const providerFailure = records.find(
    ({ entry }) => entry.category === 'provider' && entry.stage === 'terminal' && entry.outcome === 'http-error',
  )
  expect(providerFailure?.entry).toMatchObject({ adapter: 'openai', statusCode: 400, providerMayHaveRun: true })
  expect(facts(providerFailure!)).toMatchObject({
    'provider.adapter': { type: 'provider-adapter', value: 'openai' },
    'provider.status': { type: 'http-status', value: 400 },
  })
  const scriptFailure = records.find(({ entry }) => entry.category === 'script' && entry.failures > 0)
  expect(scriptFailure?.entry).toMatchObject({ runtime: 'lua' })
  expect(facts(scriptFailure!)['error.name']).toMatchObject({ type: 'error-name' })
  const rejection = records.find(
    (record) =>
      record.entry.category === 'generation' &&
      record.entry.outcome === 'rejected' &&
      facts(record)['rejection.code']?.value === 'generation_job_not_found',
  )
  expect(rejection?.entry).toMatchObject({ requestUid: rejected.headers['x-request-uid'] })

  // The journal on disk and its restored form after a restart are surfaces too.
  const journalPath = path.join(dataDir, 'diagnostics/journal.sqlite')
  await built.app.close()
  current = undefined
  assertContentFree('journal file', readFileSync(journalPath, 'latin1'), secrets)
  const journal = new DatabaseSync(journalPath, { readOnly: true })
  try {
    const rows = journal.prepare('SELECT record FROM journal_records ORDER BY sequence').all() as { record: string }[]
    expect(rows.length).toBeGreaterThanOrEqual(records.length)
    for (const row of rows) {
      expect(projectRemoteDiagnosticRecordV4(JSON.parse(row.record))).not.toBeNull()
      assertContentFree('journal row', row.record, secrets)
    }
  } finally {
    journal.close()
  }
  built = await start()
  const restored = await readAllV4(built.app)
  expect(restored.length).toBeGreaterThanOrEqual(records.length)
  expect(restored.some((record) => facts(record)['rejection.code']?.value === 'generation_job_not_found')).toBe(true)
  expect(restored.some((record) => facts(record)['provider.status']?.value === 400)).toBe(true)
}, 30_000)
