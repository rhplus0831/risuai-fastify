import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../platform', async (importActual) => {
  const actual = await importActual<typeof import('../platform')>()
  return {
    ...actual,
    isFastifyServer: true,
  }
})

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'probe-auth-token',
}))

vi.mock('../process/tts', () => import('../process/__fixtures__/mocks/tts'))
vi.mock('../process/inlayScreen', () => import('../process/__fixtures__/mocks/inlayScreen'))
vi.mock('../process/stableDiff', () => import('../process/__fixtures__/mocks/stableDiff'))
vi.mock('../process/prereroll', () => import('../process/__fixtures__/mocks/prereroll'))
vi.mock('../process/files/inlays', () => import('../process/__fixtures__/mocks/inlays'))

vi.mock('../process/memory/hypav3', async (importActual) => {
  const actual = await importActual<typeof import('../process/memory/hypav3')>()
  const fake = await import('../process/__fixtures__/mocks/hypav3')
  return { ...actual, hypaMemoryV3: fake.hypaMemoryV3 }
})

vi.mock('../process/scriptings', () => import('../process/__fixtures__/mocks/scriptings'))

vi.mock('../process/modules', async (importActual) => {
  const actual = await importActual<typeof import('../process/modules')>()
  return {
    ...actual,
    moduleUpdate: () => {},
    getModuleToggles: () => '',
    getModuleTriggers: () => [],
  }
})

const uuidState = vi.hoisted(() => ({ counter: 0 }))
vi.mock('uuid', () => ({
  v4: () => `probe-uuid-${uuidState.counter++}`,
}))

vi.mock('@mlc-ai/web-tokenizers', () => ({
  Tokenizer: {
    fromJSON: async () => ({
      encode: (text: string) => (text.length === 0 ? [] : text.split(/\s+/)),
    }),
    fromSentencePiece: async () => ({
      encode: (text: string) => (text.length === 0 ? [] : text.split(/\s+/)),
    }),
  },
}))

import { clearCachedServerCommandRevision } from '../server/commands'

import { safeStructuredClone } from '../polyfill'
import { resetServerChatState } from '../process/__fixtures__/mocks/serverChatFetch'
import { abortChat, chatProcessStage, doingChat } from '../process/index.svelte'
import { runSendCloneCountProbe } from './sendCloneCountProbe'
function resetProbeState(): void {
  uuidState.counter = 0
  ;(globalThis as Record<string, unknown>).safeStructuredClone = safeStructuredClone
  clearCachedServerCommandRevision()
  resetServerChatState()
  doingChat.set(false)
  abortChat.set(false)
  chatProcessStage.set(0)
}

beforeEach(() => {
  resetProbeState()
})

afterEach(() => {
  resetProbeState()
  vi.unstubAllGlobals()
})

describe('send clone-count probe', () => {
  it('records the plain-send append fast-path clone-count shape and field-scoped rollback clone-count shape', async () => {
    const result = await runSendCloneCountProbe()

    expect(result).toEqual({
      ok: true,
      jsonCloneCount: 1,
      structuredCloneCount: 0,
      totalCloneCount: 1,
      maxClonedSize: 98,
      fixture: {
        characterCount: 3,
        messageCountBeforeSend: 40,
        messageCountAfterSubmit: 41,
        finalMessageCount: 42,
        messageBodySize: 200,
        transcriptJsonSizeBeforeSend: 9941,
        activeChatJsonSizeBeforeSend: 10268,
        activeCharacterJsonSizeBeforeSend: 10546,
        charactersJsonSizeBeforeSend: 12256,
      },
      commands: {
        totalCommandCount: 2,
        messageReplaceCommandCount: 0,
        messageAppendCommandCount: 1,
        characterPatchCommandCount: 1,
        generationResultCommandCount: 0,
        persistedMessageCount: 1,
        persistedWholeTranscript: false,
      },
      serverChat: {
        callCount: 1,
        mode: 'send',
        userMessageLength: 'probe plain send'.length,
      },
    })
    expect(result.jsonCloneCount).toBeLessThan(result.fixture.messageCountBeforeSend)
    expect(result.maxClonedSize).toBeLessThan(result.fixture.transcriptJsonSizeBeforeSend)
    expect(result.maxClonedSize).toBeLessThan(result.fixture.activeCharacterJsonSizeBeforeSend)
  })
})
