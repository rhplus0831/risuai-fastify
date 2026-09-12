import { recordStartupMilestone, settleStartupPluginRuntimeReadiness } from '../../startupReadiness'
import { resetClientSessionForTests } from '../../clientSession'
import { setManagedWriterForTest, demoteAndRepromoteForTest } from '../../__tests__/managedClientSession'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock all seven stage-4 delegates. The fakes record their calls and let
// tests stage return values without re-testing each helper's internals
// (covered by their own test files).
const fakes = vi.hoisted(() => ({
  notification: { calls: [] as unknown[], pending: undefined as Promise<void> | undefined },
  applyEmotion: { next: false, calls: 0 },
  loadEmotion: {
    next: { tempEmotion: [] as unknown[], charemotions: {} as Record<string, unknown> },
    calls: 0,
  },
  embedding: { calls: 0 },
  llm: { calls: 0, lastOptions: undefined as unknown },
  imggen: { calls: [] as unknown[] },
  finalize: { calls: [] as { stage4Duration: number; finalized: boolean }[] },
}))

vi.mock('../../postGeneration/notification', () => ({
  chatCompletionNotificationInput: (
    character: { customNotificationMessage?: string; notificationImage?: string; image?: string },
    body: string,
  ) => ({
    body: character.customNotificationMessage?.trim() || body,
    ...(character.notificationImage || character.image ? { icon: character.notificationImage || character.image } : {}),
  }),
  fireDesktopNotification: async (input: unknown) => {
    fakes.notification.calls.push(input)
    await fakes.notification.pending
  },
}))

vi.mock('../postGeneration/notification', () => ({
  chatCompletionNotificationInput: (
    character: { customNotificationMessage?: string; notificationImage?: string; image?: string },
    body: string,
  ) => ({
    body: character.customNotificationMessage?.trim() || body,
    ...(character.notificationImage || character.image ? { icon: character.notificationImage || character.image } : {}),
  }),
  fireDesktopNotification: async (input: unknown) => {
    fakes.notification.calls.push(input)
    await fakes.notification.pending
  },
}))

vi.mock('../postGeneration/emotionFromResponse', () => ({
  applyEmotionFromResponse: () => {
    fakes.applyEmotion.calls++
    return fakes.applyEmotion.next
  },
}))

vi.mock('../postGeneration/charEmotionStore', () => ({
  loadAndTrimCharEmotion: () => {
    fakes.loadEmotion.calls++
    return fakes.loadEmotion.next
  },
}))

vi.mock('../postGeneration/emotionFallbackEmbedding', () => ({
  runEmotionEmbeddingFallback: async () => {
    fakes.embedding.calls++
  },
}))

vi.mock('../postGeneration/emotionFallbackLlm', () => ({
  runEmotionLlmFallback: async (options: unknown) => {
    fakes.llm.calls++
    fakes.llm.lastOptions = options
  },
}))

vi.mock('../postGeneration/imggenStableDiff', () => ({
  runImggenStableDiff: async (opts: unknown) => {
    fakes.imggen.calls.push(opts)
  },
}))

// finalizeStage4 still runs its real implementation for the stage4Duration
// writeback — the test passes a fresh stageTimings object so we can observe
// the mutation directly.
vi.mock('../postGeneration/stage4Finalize', async (importActual) => {
  const actual = await importActual<typeof import('../postGeneration/stage4Finalize')>()
  return {
    ...actual,
    finalizeStage4: (opts: Parameters<typeof actual.finalizeStage4>[0]) => {
      actual.finalizeStage4(opts)
      fakes.finalize.calls.push({
        stage4Duration: opts.stageTimings.stage4Duration,
        finalized: true,
      })
    },
  }
})

vi.mock('../modules', async (importActual) => {
  const actual = await importActual<typeof import('../modules')>()
  return { ...actual, moduleUpdate: () => {} }
})

import { setDatabase, type Database, type character } from '../../storage/database.svelte'
import { runStage4 } from '../postGeneration/runStage4'
import type { DispatchSuccessReq } from '../dispatch/dispatchRequest'
import { getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

function makeChar(overrides: Partial<character> = {}): character {
  return {
    type: 'character',
    name: 'Tess',
    chaId: 'cha-1',
    desc: '',
    chats: [
      {
        id: 'chat-1',
        name: 'main',
        note: '',
        localLore: [],
        scriptstate: {},
        fmIndex: -1,
        message: [
          {
            role: 'char',
            data: 'reply',
            chatId: 'm0',
            time: 0,
            generationInfo: { model: 'before' },
          },
        ],
      },
    ],
    chatPage: 0,
    customscript: [],
    triggerscript: [],
    exampleMessage: '',
    inlayViewScreen: false,
    viewScreen: 'none',
    emotionImages: [],
    ...overrides,
  } as unknown as character
}

function seedDb(extra: Partial<Database> = {}) {
  setDatabase({
    aiModel: 'gpt-4o',
    subModel: 'gpt-4o',
    characters: [makeChar()],
    notification: false,
    emotionProcesser: 'submodel',
    ...extra,
  } as unknown as Database)
}

function makeStageTimings() {
  return {
    stage1Start: 0,
    stage2Start: 0,
    stage3Start: Date.now() - 100,
    stage4Start: 0,
    stage1Duration: 1,
    stage2Duration: 2,
    stage3Duration: 0,
    stage4Duration: 0,
  }
}

function makeGenerationInfo() {
  return {
    model: 'gpt-4o',
    generationId: 'gen-1',
    inputTokens: 10,
    outputTokens: 20,
    maxContext: 4000,
    stageTiming: { stage1: 0, stage2: 0, stage3: 0, stage4: 0 },
  }
}

function baseArgs(over: Partial<Parameters<typeof runStage4>[0]> = {}) {
  const stages: number[] = []
  return {
    args: {
      database: getDatabase(),
      req: { type: 'success', result: 'done' } as unknown as DispatchSuccessReq,
      currentChar: makeChar(),
      result: 'rendered text',
      resendChat: false,
      emoChanged: false,
      abortSignal: new AbortController().signal,
      target: { characterId: 'cha-1', chatId: 'chat-1', messageId: 'm0' },
      stageTimings: makeStageTimings(),
      generationInfo: makeGenerationInfo(),
      throwError: () => {},
      setProcessStage: (n: number) => stages.push(n),
      ...over,
    },
    stages,
  }
}

beforeEach(() => {
  resetClientSessionForTests()
  fakes.notification.calls = []
  fakes.notification.pending = undefined
  fakes.applyEmotion.next = false
  fakes.applyEmotion.calls = 0
  fakes.loadEmotion.calls = 0
  fakes.embedding.calls = 0
  fakes.llm.calls = 0
  fakes.llm.lastOptions = undefined
  fakes.imggen.calls = []
  fakes.finalize.calls = []
})

describe('runStage4 - stage transition', () => {
  it('writes stage3Duration into stageTimings + generationInfo, then flips to stage 4', async () => {
    seedDb()
    const { args, stages } = baseArgs()

    await runStage4(args)

    expect(args.stageTimings.stage3Duration).toBeGreaterThanOrEqual(0)
    expect(args.generationInfo.stageTiming?.stage3).toBe(args.stageTimings.stage3Duration)
    expect(stages).toEqual([4])
    expect(args.stageTimings.stage4Start).toBeGreaterThan(0)
  })
})

describe('runStage4 - resend handoff', () => {
  it('calls finalizeStage4 and returns resend without notifications or emotion', async () => {
    seedDb({ notification: true })
    const { args } = baseArgs({ resendChat: true })

    const result = await runStage4(args)

    expect(result).toEqual({ status: 'resend' })
    expect(fakes.finalize.calls).toHaveLength(1)
    expect(fakes.notification.calls).toEqual([])
    expect(fakes.applyEmotion.calls).toBe(0)
    expect(fakes.llm.calls).toBe(0)
    expect(fakes.embedding.calls).toBe(0)
    expect(fakes.imggen.calls).toHaveLength(0)
  })
})

describe('runStage4 - notification', () => {
  it('fires fireDesktopNotification with result when db.notification=true', async () => {
    seedDb({ notification: true })
    const { args } = baseArgs({ result: 'hello' })

    await runStage4(args)

    expect(fakes.notification.calls).toEqual([{ body: 'hello' }])
  })

  it('uses the character custom notification message and notification image when set', async () => {
    seedDb({ notification: true })
    const { args } = baseArgs({
      result: 'hello',
      currentChar: makeChar({
        customNotificationMessage: 'Custom completion text',
        image: 'asset-id',
        notificationImage: 'notification-asset-id',
      }),
    })

    await runStage4(args)

    expect(fakes.notification.calls).toEqual([{ body: 'Custom completion text', icon: 'notification-asset-id' }])
  })

  it('uses the character image as the notification fallback', async () => {
    seedDb({ notification: true })
    const { args } = baseArgs({
      result: 'hello',
      currentChar: makeChar({
        image: 'asset-id',
      }),
    })

    await runStage4(args)

    expect(fakes.notification.calls).toEqual([{ body: 'hello', icon: 'asset-id' }])
  })

  it('skips fireDesktopNotification when db.notification=false', async () => {
    seedDb({ notification: false })
    const { args } = baseArgs({ result: 'hello' })

    await runStage4(args)

    expect(fakes.notification.calls).toEqual([])
  })
})

describe('runStage4 - provider emotion short-circuit', () => {
  it('skips emotion fallback when applyEmotionFromResponse returns true', async () => {
    seedDb({ emotionProcesser: 'submodel' })
    fakes.applyEmotion.next = true
    const { args } = baseArgs({
      req: { type: 'success', result: 'done', special: { emotion: 'happy' } } as unknown as DispatchSuccessReq,
      currentChar: makeChar({ viewScreen: 'emotion' }),
    })

    await runStage4(args)

    expect(fakes.applyEmotion.calls).toBe(1)
    expect(fakes.llm.calls).toBe(0)
    expect(fakes.embedding.calls).toBe(0)
    // Default path still finalizes.
    expect(fakes.finalize.calls).toHaveLength(1)
  })
})

describe('runStage4 - emotion fallback routing', () => {
  it('runs embedding fallback when emotionProcesser=embedding and skips finalizeStage4', async () => {
    seedDb({ emotionProcesser: 'embedding' })
    const { args } = baseArgs({
      currentChar: makeChar({ viewScreen: 'emotion' }),
    })

    const result = await runStage4(args)

    expect(result).toEqual({ status: 'done' })
    expect(fakes.embedding.calls).toBe(1)
    expect(fakes.llm.calls).toBe(0)
    // Asymmetry: emotion-fallback paths intentionally skip finalizeStage4.
    expect(fakes.finalize.calls).toHaveLength(0)
  })

  it('runs LLM fallback when emotionProcesser is anything else and skips finalizeStage4', async () => {
    seedDb({ emotionProcesser: 'submodel' })
    const { args } = baseArgs({
      currentChar: makeChar({ viewScreen: 'emotion' }),
    })

    const result = await runStage4(args)

    expect(result).toEqual({ status: 'done' })
    expect(fakes.llm.calls).toBe(1)
    expect((fakes.llm.lastOptions as { database: Database }).database).toBe(args.database)
    expect(fakes.embedding.calls).toBe(0)
    expect(fakes.finalize.calls).toHaveLength(0)
  })

  it('skips emotion fallback when emoChanged is already true', async () => {
    seedDb({ emotionProcesser: 'submodel' })
    const { args } = baseArgs({
      emoChanged: true,
      currentChar: makeChar({ viewScreen: 'emotion' }),
    })

    await runStage4(args)

    expect(fakes.llm.calls).toBe(0)
    expect(fakes.embedding.calls).toBe(0)
    // Default finalize on fall-through.
    expect(fakes.finalize.calls).toHaveLength(1)
  })

  it('skips emotion fallback when abortSignal.aborted=true', async () => {
    seedDb({ emotionProcesser: 'submodel' })
    const ac = new AbortController()
    ac.abort()
    const { args } = baseArgs({
      abortSignal: ac.signal,
      currentChar: makeChar({ viewScreen: 'emotion' }),
    })

    await runStage4(args)

    expect(fakes.llm.calls).toBe(0)
    expect(fakes.embedding.calls).toBe(0)
    expect(fakes.finalize.calls).toHaveLength(1)
  })
})

describe('runStage4 - imggen routing', () => {
  it('calls runImggenStableDiff when viewScreen=imggen and then finalizes', async () => {
    seedDb()
    const { args } = baseArgs({
      currentChar: makeChar({ viewScreen: 'imggen' }),
    })

    const result = await runStage4(args)

    expect(result).toEqual({ status: 'done' })
    expect(fakes.imggen.calls).toHaveLength(1)
    expect(fakes.imggen.calls[0]).toMatchObject({
      abortSignal: args.abortSignal,
      currentChar: args.currentChar,
      target: args.target,
    })
    expect(fakes.finalize.calls).toHaveLength(1)
  })

  it('skips imggen post-generation work when already aborted', async () => {
    seedDb()
    const ac = new AbortController()
    ac.abort()
    const { args } = baseArgs({
      abortSignal: ac.signal,
      currentChar: makeChar({ viewScreen: 'imggen' }),
    })

    const result = await runStage4(args)

    expect(result).toEqual({ status: 'done' })
    expect(fakes.imggen.calls).toHaveLength(0)
    expect(fakes.finalize.calls).toHaveLength(1)
  })
})

describe('runStage4 - inlayViewScreen short-circuit', () => {
  it('skips all emotion/imggen processing when inlayViewScreen=true', async () => {
    seedDb({ emotionProcesser: 'submodel' })
    const { args } = baseArgs({
      currentChar: makeChar({ inlayViewScreen: true, viewScreen: 'emotion' }),
    })

    const result = await runStage4(args)

    expect(result).toEqual({ status: 'done' })
    expect(fakes.llm.calls).toBe(0)
    expect(fakes.embedding.calls).toBe(0)
    expect(fakes.imggen.calls).toHaveLength(0)
    expect(fakes.finalize.calls).toHaveLength(1)
  })
})

describe('runStage4 - default path', () => {
  it('runs finalizeStage4 and returns done when no viewScreen branch matches', async () => {
    seedDb()
    const { args } = baseArgs()

    const result = await runStage4(args)

    expect(result).toEqual({ status: 'done' })
    expect(fakes.finalize.calls).toHaveLength(1)
    expect(args.stageTimings.stage4Duration).toBeGreaterThanOrEqual(0)
  })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function makeOtherChar(): character {
  return makeChar({
    chaId: 'cha-2',
    name: 'Other',
    chats: [
      {
        id: 'chat-2',
        name: 'other',
        note: '',
        localLore: [],
        scriptstate: {},
        fmIndex: -1,
        message: [
          {
            role: 'char',
            data: 'other reply',
            chatId: 'm-other',
            time: 0,
            generationInfo: { model: 'other-before' },
          },
        ],
      },
    ],
  } as Partial<character>)
}

describe('runStage4 - stable finalization target', () => {
  it('finalizes the original message after characters are reordered during an await', async () => {
    seedDb({ notification: true, characters: [makeChar(), makeOtherChar()] })
    const gate = deferred()
    fakes.notification.pending = gate.promise
    const { args } = baseArgs()

    const running = runStage4(args)
    await vi.waitFor(() => expect(fakes.notification.calls).toHaveLength(1))
    getDatabase().characters.reverse()
    gate.resolve()
    await running

    const target = getDatabase().characters.find((char) => char.chaId === 'cha-1')!
    const other = getDatabase().characters.find((char) => char.chaId === 'cha-2')!
    expect(target.chats[0].message.find((message) => message.chatId === 'm0')?.generationInfo?.model).toBe('gpt-4o')
    expect(other.chats[0].message[0].generationInfo?.model).toBe('other-before')
  })

  it('finalizes only the original message after chat and message insertion during an await', async () => {
    seedDb({ notification: true })
    const gate = deferred()
    fakes.notification.pending = gate.promise
    const { args } = baseArgs()

    const running = runStage4(args)
    await vi.waitFor(() => expect(fakes.notification.calls).toHaveLength(1))
    const character = getDatabase().characters[0]
    const originalChat = character.chats[0]
    character.chats.unshift({
      id: 'chat-inserted',
      name: 'inserted',
      note: '',
      localLore: [],
      message: [],
    })
    originalChat.message.push({
      role: 'char',
      data: 'newer row',
      chatId: 'm-inserted',
      generationInfo: { model: 'inserted-before' },
    })
    gate.resolve()
    await running

    expect(originalChat.message.find((message) => message.chatId === 'm0')?.generationInfo?.model).toBe('gpt-4o')
    expect(originalChat.message.find((message) => message.chatId === 'm-inserted')?.generationInfo?.model).toBe(
      'inserted-before',
    )
    expect(character.chats[0].message).toEqual([])
  })

  it('does not write through a reused index after the target is deleted during an await', async () => {
    const other = makeOtherChar()
    seedDb({ notification: true, characters: [makeChar(), other] })
    const gate = deferred()
    fakes.notification.pending = gate.promise
    const { args } = baseArgs()

    const running = runStage4(args)
    await vi.waitFor(() => expect(fakes.notification.calls).toHaveLength(1))
    getDatabase().characters.splice(0, 1)
    gate.resolve()
    await running

    expect(getDatabase().characters[0].chaId).toBe('cha-2')
    expect(getDatabase().characters[0].chats[0].message[0].generationInfo?.model).toBe('other-before')
  })
})

it('does not resume emotion work or finalization after a delayed notification loses writer access', async () => {
  seedDb({ notification: true })
  setManagedWriterForTest()
  for (const milestone of ['entry', 'shell-mounted', 'reader-ready', 'writer-ready', 'plugins-ready'] as const)
    recordStartupMilestone(milestone)
  settleStartupPluginRuntimeReadiness(true)
  let release!: () => void
  fakes.notification.pending = new Promise((resolve) => {
    release = resolve
  })
  const { args } = baseArgs({ currentChar: makeChar({ viewScreen: 'emotion' }) })
  const pending = runStage4(args)
  await vi.waitFor(() => expect(fakes.notification.calls).toHaveLength(1))
  demoteAndRepromoteForTest()
  release()
  await pending
  expect(fakes.embedding.calls).toBe(0)
  expect(fakes.llm.calls).toBe(0)
  expect(fakes.finalize.calls).toEqual([])
})
