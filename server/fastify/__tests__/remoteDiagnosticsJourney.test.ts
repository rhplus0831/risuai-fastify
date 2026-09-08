import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import {
  isDiagnosticEventV2,
  isRemoteDiagnosticsResponse,
  projectDiagnosticJournalRecord,
  SUPPORT_DIAGNOSTICS_ENDPOINT,
  type RemoteDiagnosticsResponseV2,
} from '@risuai/protocol/remote-diagnostics'
import { buildApp, type BuiltApp } from '../src/app.js'
import { getSchemaState, openDatabase } from '../src/db.js'
import { runOpenAIStream, resolveOpenAIRequest } from '../src/generation/openai.js'
import { applyImport } from '../src/repository.js'
import { normalizeRisuSaveSnapshotDatabase } from '../src/risuSave/importSnapshot.js'
import { mintSupportDiagnosticsCredential } from '../src/supportDiagnosticsAuth.js'
import { readRemoteDiagnosticsConfig } from '../../../util/diagnostics-remote.js'
import { setupAuthedClient } from './helpers/auth.js'

const canaries = {
  chat: 'PRIVATE_JOURNEY_CHAT_TEXT_f1a9',
  preset: 'PRIVATE_JOURNEY_PROMPT_PRESET_78bb',
  persona: 'PRIVATE_JOURNEY_PERSONA_91ca',
  model: 'PRIVATE_JOURNEY_MODEL_NAME_a192',
  key: 'PRIVATE_JOURNEY_PROVIDER_CREDENTIAL_c0a7',
  response: 'PRIVATE_JOURNEY_PARTIAL_RESPONSE_669a',
  reasoning: 'PRIVATE_JOURNEY_REASONING_751a',
  header: 'PRIVATE_JOURNEY_PROVIDER_HEADER_d6b2',
  error: 'PRIVATE_JOURNEY_ERROR_AND_STACK_c58a',
  lua: 'PRIVATE_JOURNEY_LUA_LOG_2a7f',
  rejected: 'PRIVATE_JOURNEY_QUERY_HEADER_PATH_&?=18ea',
  characterId: 'private-journey-character',
  chatId: 'private-journey-chat',
}
const luaCode = `listenEdit('editInput', function(id, data) log('${canaries.lua}'); return data end)`
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const helperPath = path.join(repositoryRoot, 'util/diagnostics-remote.ts')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

/** Same minimal configured-chat shape as diagnosticsGeneration; this journey adds real transports. */
function fixtureDatabase() {
  const promptSettings = {
    assistantPrefill: '',
    postEndInnerFormat: '',
    sendChatAsSystem: false,
    sendName: false,
    utilOverride: false,
  }
  return {
    currentChar: 0,
    characters: [
      {
        type: 'character',
        chaId: canaries.characterId,
        name: canaries.chat,
        utilityBot: false,
        chatPage: 0,
        desc: canaries.chat,
        firstMessage: '',
        triggerscript: [
          { comment: canaries.lua, type: 'input', conditions: [], effect: [{ type: 'triggerlua', code: luaCode }] },
        ],
        chats: [
          {
            id: canaries.chatId,
            name: canaries.chat,
            note: '',
            message: [],
            localLore: [],
            generationSettings: {
              configured: true,
              personaId: 'journey-persona',
              modelPresetId: 'journey-model-preset',
              promptPresetId: 'journey-prompt-preset',
              jailbreakToggle: false,
              sidebarToggles: {},
            },
          },
        ],
      },
    ],
    selectedPersona: 0,
    personas: [{ id: 'journey-persona', name: canaries.persona, personaPrompt: canaries.persona, icon: '', note: '' }],
    modelPresetsId: 0,
    promptPresetsId: 0,
    botPresets: [],
    modelPresets: [{ id: 'journey-model-preset', name: canaries.model, maxContext: 100_000, maxResponse: 50 }],
    promptPresets: [
      {
        id: 'journey-prompt-preset',
        name: canaries.preset,
        mainPrompt: canaries.preset,
        formatingOrder: ['main', 'description', 'chats'],
        promptSettings,
        customPromptTemplateToggle: '',
      },
    ],
    modules: [],
    enabledModules: [],
    formatingOrder: ['main', 'description', 'chats'],
    promptSettings,
    mainPrompt: canaries.preset,
    maxContext: 100_000,
    maxResponse: 50,
  }
}

function assertNoEncodedCanaries(value: string, secrets: readonly string[]) {
  for (const secret of secrets) {
    for (const encoded of new Set([
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
      Buffer.from(secret).toString('hex'),
      createHash('sha256').update(secret).digest('hex'),
    ]))
      expect(value).not.toContain(encoded)
  }
}

function assertNoForbiddenFields(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const forbidden = new Set([
    'message',
    'messages',
    'content',
    'prompt',
    'preset',
    'body',
    'headers',
    'authorization',
    'token',
    'apiKey',
    'error',
    'stack',
    'model',
    'profileId',
    'chatId',
    'characterId',
    'filename',
    'url',
    'endpoint',
    'locations',
    'reason',
    'apiMetadata',
  ])
  for (const [key, child] of Object.entries(value)) {
    expect(forbidden.has(key) || /hash|sha256|sidecar/i.test(key)).toBe(false)
    assertNoForbiddenFields(child)
  }
}

it('diagnoses a real provider disconnect and failed commit through the HTTPS helper, then correlates restart recovery without private content', async () => {
  vi.stubEnv('LOG_LEVEL', 'silent')
  vi.stubEnv('RISU_PROTOCOL_METRICS', '0')
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const root = mkdtempSync(path.join(tmpdir(), 'risu-remote-diagnostics-journey-'))
  const dataDir = path.join(root, 'data')
  const privateDir = path.join(root, 'private')
  mkdirSync(privateDir, { mode: 0o700 })
  const verifierFile = path.join(privateDir, 'verifier.json')
  const credentialFile = path.join(privateDir, 'remote.json')
  const certificatePath = path.join(privateDir, 'fixture-cert.pem')
  const keyPath = path.join(privateDir, 'fixture-key.pem')
  let current: BuiltApp | undefined
  let db: ReturnType<typeof openDatabase> | undefined
  const providerRequests: Array<{ body: string; authorization: string | undefined }> = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const provider = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    providerRequests.push({
      body: Buffer.concat(chunks).toString('utf8'),
      authorization: request.headers.authorization,
    })
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Upstream-Private': canaries.header })
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: canaries.reasoning, content: canaries.response } }], private_error: { message: canaries.error, stack: canaries.error } })}\n\n`,
    )
    const timer = setTimeout(() => {
      timers.delete(timer)
      response.destroy()
    }, 60)
    timers.add(timer)
  })
  let https: ReturnType<typeof createHttpsServer> | undefined
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certificatePath,
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-days',
        '1',
      ],
      { stdio: 'pipe' },
    )
    const encodings: unknown[] = []
    https = createHttpsServer(
      { key: readFileSync(keyPath), cert: readFileSync(certificatePath) },
      (request, response) => {
        response.once('finish', () => encodings.push(response.getHeader('content-encoding')))
        if (current) current.app.routing(request, response)
        else {
          response.writeHead(503, { 'Content-Type': 'application/json' })
          response.end('{"error":"storage-unavailable"}')
        }
      },
    )
    await Promise.all(
      [provider, https].map(
        (server) => new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen)),
      ),
    )
    const origin = `https://127.0.0.1:${(https.address() as AddressInfo).port}`
    const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`
    await mintSupportDiagnosticsCredential({ verifierFile, credentialFile, origin })
    const supportConfig = readRemoteDiagnosticsConfig(credentialFile)
    db = openDatabase(dataDir)
    await applyImport(db, dataDir, normalizeRisuSaveSnapshotDatabase(fixtureDatabase()))
    const start = async (retry: boolean) => {
      const built = await buildApp({
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
          requestTrace: { mode: 'agent' },
          generationTrace: { fullPrompt: true, maxGzipBytes: 1024 * 1024 },
        },
        generationChat: {
          dispatchProvider(context) {
            const request = resolveOpenAIRequest({
              model: canaries.model,
              messages: context.result.formated ?? context.result.prompt.formated,
              apiKey: canaries.key,
              baseUrl: providerOrigin,
              extraHeaders: { 'X-Private': canaries.header },
              signal: context.signal,
              trace: context.trace,
            })
            if (!request) throw new Error('synthetic provider fixture is invalid')
            return runOpenAIStream(request)
          },
          finalizationRetry: retry ? { intervalMs: 60_000, baseDelayMs: 1, maxDelayMs: 1 } : false,
        },
        memoryWorker: false,
        bardWikiWorker: false,
        assetGc: false,
      })
      await built.app.ready()
      await built.diagnostics.ready
      return built
    }
    current = await start(false)
    const { assertion } = await setupAuthedClient(current.app)
    const secrets = [...Object.values(canaries), luaCode, supportConfig.token, assertion]
    const runHelper = (args: string[], configPath = credentialFile) =>
      new Promise<{ code: number | string; stdout: string; stderr: string }>((resolveResult) => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          RISU_DIAGNOSTICS_REMOTE_CONFIG: configPath,
          NODE_EXTRA_CA_CERTS: certificatePath,
        }
        delete env.NODE_OPTIONS
        delete env.NODE_TLS_REJECT_UNAUTHORIZED
        execFile(
          process.execPath,
          ['--import', 'tsx', helperPath, ...args],
          { cwd: repositoryRoot, env, timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
          (error, stdout, stderr) => resolveResult({ code: error?.code ?? 0, stdout, stderr }),
        )
      })
    const readEvidence = async (operationRef?: string): Promise<RemoteDiagnosticsResponseV2> => {
      await vi.waitFor(() => expect(current!.diagnostics.journal?.read().pending).toBe(0), {
        timeout: 5000,
        interval: 20,
      })
      const result = await runHelper([
        '--version=2',
        '--limit=200',
        ...(operationRef ? [`--operationRef=${operationRef}`] : []),
      ])
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      assertNoEncodedCanaries(result.stdout, secrets)
      const value: unknown = JSON.parse(result.stdout)
      expect(isRemoteDiagnosticsResponse(value)).toBe(true)
      if (!isRemoteDiagnosticsResponse(value) || value.version !== 2) throw new Error('expected validated v2 evidence')
      expect(value.entries.every((record) => isDiagnosticEventV2(record.entry))).toBe(true)
      assertNoForbiddenFields(value)
      return value
    }

    db.exec(
      `CREATE TRIGGER fail_journey_commit BEFORE INSERT ON messages WHEN NEW.role = 'char' BEGIN SELECT RAISE(FAIL, '${canaries.error}'); END`,
    )
    const generation = await current.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        chatId: canaries.chatId,
        characterId: canaries.characterId,
        mode: 'send',
        userMessage: canaries.chat,
        durable: true,
      },
    })
    expect(generation.statusCode).toBe(200)
    await current.generationJobs.settleRunners()
    expect(providerRequests).toHaveLength(1)
    expect(providerRequests[0].body).toContain(canaries.chat)
    expect(providerRequests[0].body).toContain(canaries.preset)
    expect(providerRequests[0].authorization).toBe(`Bearer ${canaries.key}`)
    const revisionBeforeRead = getSchemaState(db).revision
    const failed = await readEvidence()
    expect(getSchemaState(db).revision).toBe(revisionBeforeRead)
    expect(failed.sources).toEqual({ server: 'journal', browser: 'not-supported' })
    expect(failed.collection).toMatchObject({ pending: 0, operationContinuity: 'retained' })
    const providerFailure = failed.entries.find(
      ({ entry }) => entry.category === 'provider' && entry.stage === 'terminal' && entry.outcome === 'disconnected',
    )
    expect(providerFailure?.entry).toMatchObject({
      adapter: 'openai',
      providerMayHaveRun: true,
      requestUid: generation.headers['x-request-uid'],
      operationRef: expect.stringMatching(/^[a-f0-9]{32}$/),
      attemptRef: expect.stringMatching(/^[a-f0-9]{32}$/),
      timeToHeadersMs: expect.any(Number),
      timeToFirstTokenMs: expect.any(Number),
      chunkCount: expect.any(Number),
    })
    const operationRef = providerFailure!.entry.operationRef!
    const operationEvidence = failed.entries.filter(({ entry }) => entry.operationRef === operationRef)
    expect(operationEvidence.map(({ entry }) => entry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'generation',
          stage: 'complete',
          outcome: 'ambiguous',
          providerMayHaveRun: true,
        }),
        expect.objectContaining({
          category: 'persistence',
          phase: 'authoritative_commit',
          disposition: 'retryable',
          journalConfirmed: true,
          authoritativeCommitted: false,
        }),
        expect.objectContaining({
          category: 'script',
          runtime: 'lua',
          hook: 'editInput',
          runs: 1,
          failures: 0,
          outputChanged: false,
        }),
      ]),
    )
    const failedCommit = operationEvidence.find(
      ({ entry }) => entry.category === 'persistence' && entry.disposition === 'retryable',
    )!
    expect(failedCommit.entry.requestUid).toBe(providerFailure!.entry.requestUid)

    const rejected = [
      ...[
        '/api/v1/diagnostics/%',
        '/api/v1/%64iagnostics/browser%',
        '/api/v1/%73upport/diagnostics%',
        '/api/v1/%73upport%',
      ].map((prefix) => ({
        url: `${prefix}${encodeURIComponent(canaries.rejected)}?private=${encodeURIComponent(canaries.rejected)}`,
        headers: { authorization: `Bearer ${supportConfig.token}`, 'x-private': canaries.rejected },
      })),
      {
        url: `${SUPPORT_DIAGNOSTICS_ENDPOINT}?raw=${encodeURIComponent(canaries.rejected)}`,
        headers: { authorization: `Bearer ${supportConfig.token}`, 'x-private': canaries.rejected },
      },
      { url: SUPPORT_DIAGNOSTICS_ENDPOINT, headers: { authorization: `Bearer ${canaries.rejected}` } },
      {
        method: 'POST' as const,
        url: `/api/v1/support/${encodeURIComponent(canaries.rejected)}`,
        headers: { authorization: `Bearer ${supportConfig.token}` },
        payload: { text: canaries.rejected },
      },
      {
        method: 'POST' as const,
        url: '/api/v1/diagnostics/browser',
        headers: { authorization: `Bearer ${supportConfig.token}`, 'content-type': 'application/json' },
        payload: `{${canaries.rejected}`,
      },
      {
        method: 'GET' as const,
        url: SUPPORT_DIAGNOSTICS_ENDPOINT,
        headers: { authorization: `Bearer ${supportConfig.token}`, 'content-encoding': 'gzip' },
        payload: gzipSync(canaries.rejected.repeat(40_000)),
      },
    ]
    for (const input of rejected) {
      const response = await current.app.inject(input)
      expect(response.statusCode).toBeGreaterThanOrEqual(400)
      expect(response.headers['cache-control']).toBe('no-store')
      assertNoEncodedCanaries(response.body, secrets)
    }
    const unrelatedBadUrl = await current.app.inject('/ordinary/%')
    expect(unrelatedBadUrl.statusCode).toBe(400)
    expect(unrelatedBadUrl.json()).toMatchObject({ error: 'Bad Request', code: 'FST_ERR_BAD_URL', statusCode: 400 })
    const invalidArguments = await runHelper([`--raw=${canaries.rejected}`])
    expect(invalidArguments).toEqual({ code: 1, stdout: '', stderr: 'invalid-query\n' })
    const invalidConfig = path.join(privateDir, 'invalid-remote.json')
    writeFileSync(invalidConfig, JSON.stringify({ ...supportConfig, token: 'e3'.repeat(32) }), { mode: 0o600 })
    expect(await runHelper(['--version=2'], invalidConfig)).toEqual({ code: 1, stdout: '', stderr: 'unauthorized\n' })

    db.exec('DROP TRIGGER fail_journey_commit')
    await current.app.close()
    current = undefined
    current = await start(true)
    const recovered = await readEvidence(operationRef)
    expect(recovered.identity.instanceId).not.toBe(failed.identity.instanceId)
    expect(recovered.collection.operationContinuity).toBe('retained')
    expect(recovered.entries.every(({ entry }) => entry.operationRef === operationRef)).toBe(true)
    const recovery = recovered.entries.find(
      ({ entry }) => entry.category === 'persistence' && entry.disposition === 'recovered',
    )
    expect(recovery?.entry).toMatchObject({ operationRef, authoritativeCommitted: true, cleanupComplete: true })
    expect(recovery?.instanceId).not.toBe(failedCommit.instanceId)
    expect(
      recovered.entries.some(({ entry }) => entry.category === 'provider' && entry.outcome === 'disconnected'),
    ).toBe(true)
    expect(providerRequests).toHaveLength(1)
    expect(getSchemaState(db).revision).toBe(revisionBeforeRead + 1)
    const rows = db.prepare("SELECT json FROM messages WHERE role = 'char'").all() as { json: string }[]
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].json).data).toContain(canaries.response)
    expect(encodings.some((encoding) => encoding === 'br' || encoding === 'gzip')).toBe(true)

    const manual = await current.app.inject({ url: '/api/v1/diagnostics', headers: { 'risu-auth': assertion } })
    expect(manual.statusCode).toBe(200)
    expect(manual.json()).toMatchObject({ version: 1, enabled: true })
    assertNoEncodedCanaries(manual.body, secrets)
    await vi.waitFor(() => expect(current!.diagnostics.journal?.read().pending).toBe(0), { timeout: 5000 })
    const journalPath = path.join(dataDir, 'diagnostics/journal.sqlite')
    const journal = new DatabaseSync(journalPath, { readOnly: true })
    try {
      const journalRows = journal.prepare('SELECT record FROM journal_records ORDER BY sequence').all() as {
        record: string
      }[]
      expect(journalRows.length).toBeGreaterThan(recovered.entries.length)
      for (const row of journalRows) {
        const record: unknown = JSON.parse(row.record)
        expect(projectDiagnosticJournalRecord(record)).not.toBeNull()
        assertNoEncodedCanaries(row.record, secrets)
        assertNoForbiddenFields(record)
      }
    } finally {
      journal.close()
    }
    assertNoEncodedCanaries(readFileSync(journalPath, 'utf8'), secrets)
    await current.app.close()
    current = undefined
    // Raw generation traces stay operator-only; diagnostic traffic cannot add its inputs or support credential.
    const trace = readFileSync(path.join(dataDir, 'trace/agent.jsonl'), 'utf8')
    assertNoEncodedCanaries(trace, [canaries.rejected, supportConfig.token])
    expect(trace).not.toContain('/api/v1/support')
    expect(trace).not.toContain('/api/v1/diagnostics/browser')
  } finally {
    for (const timer of timers) clearTimeout(timer)
    for (const server of [https, provider]) {
      if (!server) continue
      server.closeAllConnections()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
    await current?.app.close()
    db?.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
