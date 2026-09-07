import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp } from '../src/app.js'
import { setupBrowserSmokeAuth } from './auth.js'
import { importFastBootstrapDatabase, type FastBootstrapHarness } from './fastBootstrapHarness.js'

export const RESIDENCY_CHARACTER_ID = 'transcript-residency-character'
export const RESIDENCY_CHAT_ID = 'transcript-residency-chat'
export const RESIDENCY_INITIAL_ROWS = 30
export const RESIDENCY_ADDITIONAL_ROWS = 15
export const RESIDENCY_STREAM_CHUNKS = [
  'Residency streamed response.',
  '\n\n**Growing response** with a second paragraph.',
  '\n\n- Final streamed item\n- Completed response',
]
// Local, deterministic PNG: no network, credentials, external media, or user data.
// Eager loading below makes offscreen decoding reproducible; the production
// parser otherwise defaults images to lazy, leaving distant rows undecoded.
const IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

export function transcriptResidencyFixture(messageCount: number): Record<string, unknown> {
  return {
    version: 1,
    didFirstSetup: true,
    formatversion: 5,
    currentChar: 0,
    selectedCharID: 0,
    characterOrder: [RESIDENCY_CHARACTER_ID],
    characters: [
      {
        chaId: RESIDENCY_CHARACTER_ID,
        type: 'character',
        name: 'Transcript Residency Character',
        desc: 'Synthetic transcript residency fixture.',
        chatPage: 0,
        firstMessage: '',
        customscript: [],
        globalLore: [],
        viewScreen: 'none',
        emotionImages: [],
        chats: [
          {
            id: RESIDENCY_CHAT_ID,
            name: 'Transcript Residency Chat',
            note: '',
            localLore: [],
            bookmarks: ['residency-message-5'],
            bookmarkNames: { 'residency-message-5': 'Residency deep jump' },
            message: Array.from({ length: messageCount }, (_, index) => ({
              chatId: `residency-message-${index}`,
              role: index % 2 ? 'char' : 'user',
              data: [
                `Residency row ${index}. **Bold text** and inline \`code\`.`,
                ...Array.from(
                  { length: 1 + (index % 4) },
                  () => 'Variable-height Markdown paragraph with enough words to wrap on a narrow mobile display.',
                ),
                index % 3 === 0 ? '- First list item\n- Second list item\n\n> A quoted paragraph.' : '',
                index % 6 === 0
                  ? `<img alt="Residency image ${index}" src="${IMAGE}" loading="eager" width="240" height="${48 + (index % 5) * 24}">`
                  : '',
              ]
                .filter(Boolean)
                .join('\n\n'),
            })),
          },
        ],
      },
    ],
    botPresets: [],
    modelPresets: [{ id: 'residency-model', name: 'Residency Model' }],
    promptPresets: [{ id: 'residency-prompt', name: 'Residency Prompt', promptTemplate: [] }],
    modelProfiles: [
      {
        id: 'residency-profile',
        name: 'Residency Profile',
        providerId: 'debug-echo',
        modelId: 'debug-echo',
        providerOptions: { baseUrl: 'debug://transcript-residency', requestModel: 'residency-model' },
      },
    ],
    modelProfileOrder: [{ kind: 'profile', profileId: 'residency-profile' }],
    modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'residency-profile' } },
    modelRuntimeDefaults: {},
    providerCredentials: [],
    personas: [{ id: 'residency-persona', name: 'Residency User', icon: '', largePortrait: false, personaPrompt: '' }],
    selectedPersona: 0,
    username: 'Residency User',
    loadouts: [],
    loreBook: [],
    modules: [],
    plugins: [],
    pluginCustomStorage: {},
    language: 'en',
    loreBookToken: 8000,
    mainPrompt: '',
    maxContext: 1_000_000,
    maxResponse: 100,
    fixedChatTextarea: true,
    useStreaming: true,
    removeIncompleteResponse: false,
    requestRetrys: 0,
    chatLoadInitialPages: RESIDENCY_INITIAL_ROWS,
    chatLoadAdditionalPages: RESIDENCY_ADDITIONAL_ROWS,
  }
}

/** Real generation route and persistence with a test-only, manually paced provider. */
export async function startTranscriptResidencyHarness(messageCount: number): Promise<
  FastBootstrapHarness & {
    releaseChunk(index: number): void
    releaseAll(): void
  }
> {
  const releases: Array<() => void> = []
  const gates = RESIDENCY_STREAM_CHUNKS.map(() => new Promise<void>((resolve) => releases.push(resolve)))
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-transcript-residency-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 20 * 1024 * 1024,
      importMaxBytes: Number.POSITIVE_INFINITY,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      staticRoot: path.resolve('dist'),
    },
    assetGc: false,
    memoryWorker: false,
    generationChat: {
      dispatchProvider: async function* ({ signal }) {
        for (const [index, content] of RESIDENCY_STREAM_CHUNKS.entries()) {
          if (signal.aborted) return
          const release = releases[index]
          signal.addEventListener('abort', release, { once: true })
          await gates[index]
          signal.removeEventListener('abort', release)
          if (signal.aborted) return
          yield { kind: 'token', content }
        }
        yield { kind: 'done', finishReason: 'stop' }
      },
    },
  })
  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('Residency harness did not bind a TCP port')
    const assertion = await setupBrowserSmokeAuth(app)
    await importFastBootstrapDatabase(app, assertion, transcriptResidencyFixture(messageCount), { dataDir })
    return {
      app,
      assertion,
      dataDir,
      baseUrl: `http://127.0.0.1:${address.port}`,
      releaseChunk: (index) => releases[index](),
      releaseAll: () => releases.forEach((release) => release()),
    }
  } catch (error) {
    releases.forEach((release) => release())
    await app.close().catch(() => undefined)
    rmSync(dataDir, { recursive: true, force: true })
    throw error
  }
}
