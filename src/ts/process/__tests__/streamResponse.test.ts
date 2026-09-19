import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const { processScriptFullSpy } = vi.hoisted(() => ({
  processScriptFullSpy: vi.fn(),
}))

vi.mock('../scripts', () => ({
  cacheBestMatchForTesting: vi.fn(),
  exportRegex: vi.fn(),
  getBestMatchCacheSizeForTesting: vi.fn(() => 0),
  getBestMatchForTesting: vi.fn(),
  getCompiledRegex: (source: string, flags: string) => new RegExp(source, flags),
  hasProcessScriptCacheEntryForTesting: vi.fn(() => false),
  importRegex: vi.fn(),
  importRegexRows: vi.fn(),
  processScript: vi.fn(async (_char: unknown, data: string) => data),
  processScriptFull: processScriptFullSpy,
  resetScriptCache: vi.fn(),
  risuChatParser: vi.fn((text: string) => text),
}))

vi.mock('../modules', async (importActual) => {
  const actual = await importActual<typeof import('../modules')>()
  return { ...actual, moduleUpdate: () => {} }
})

import {
  setDatabase,
  type Database,
  type Message,
  type MessageGenerationInfo,
  type MessagePresetInfo,
  type character,
} from '../../storage/database.svelte'
import { selectedCharID } from '../../stores.svelte'
import { replaceResourceDatabase } from '../../server/resourceState.svelte'
import type { StreamResponseChunk, requestDataResponse } from '../request/request'
import { consumeStreamResponse } from '../postGeneration/streamResponse'
import { markChatMessageMutationIntent } from '../../server/chatMessageMutationIntent'
import { markChatBodyProjectionApplied } from '../../server/resourceState.svelte'
import { applyServerChatMessagesResource, getChatMessageOwnerState } from '../../server/chatMessageHydration.svelte'
import { halfStreamingProgress, resetHalfStreamingProgressForTests } from '../halfStreamingProgress'
import {
  generationDisplayProjections,
  resetGenerationDisplayProjectionsForTests,
} from '../generationDisplayProjection.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

const testDatabaseState = {
  get db() {
    return getResourceDatabase()
  },
  set db(value: ReturnType<typeof getResourceDatabase>) {
    replaceResourceDatabase(value)
  },
}

const REFORMAT = (s: string) => s.trim()

function makeChar(): character {
  return {
    name: 'Test',
    chaId: 'cha-1',
    chats: [
      {
        id: 'chat-1',
        message: [{ role: 'user', data: 'hi' }],
        note: '',
        name: 'main',
        localLore: [],
      },
    ],
    chatPage: 0,
    reloadKeys: 0,
    image: '',
    emotionImages: [],
    bias: [],
    viewScreen: 'none',
    globalLore: [],
    chaVer: 0,
    firstMessage: '',
    desc: '',
    notes: '',
  } as unknown as character
}

function seed(): character {
  setDatabase({ characters: [makeChar()] } as Database)
  applyServerChatMessagesResource('chat-1', [{ role: 'user', data: 'hi' }], undefined, [])
  selectedCharID.set(0)
  return testDatabaseState.db.characters[0]
}

function ownerMessages(): Message[] {
  return getChatMessageOwnerState('chat-1')?.messages ?? []
}

interface StreamHandle {
  stream: ReadableStream<StreamResponseChunk>
  push: (chunk: StreamResponseChunk) => void
  close: () => void
  error: (e: unknown) => void
}

function makeControlledStream(): StreamHandle {
  let controller!: ReadableStreamDefaultController<StreamResponseChunk>
  const stream = new ReadableStream<StreamResponseChunk>({
    start(c) {
      controller = c
    },
  })
  return {
    stream,
    push: (chunk) => {
      try {
        controller.enqueue(chunk)
      } catch {
        /* already closed via reader.cancel() */
      }
    },
    close: () => {
      try {
        controller.close()
      } catch {
        /* already closed via reader.cancel() */
      }
    },
    error: (e) => {
      try {
        controller.error(e)
      } catch {
        /* already closed */
      }
    },
  }
}

function streamingReq(
  stream: ReadableStream<StreamResponseChunk>,
  options: {
    halfStreaming?: boolean
    halfStreamingProgressManaged?: boolean
    replayGapTruncated?: boolean
    continueBase?: string
    generationDisplayProjection?: Extract<requestDataResponse, { type: 'streaming' }>['generationDisplayProjection']
  } = {},
): requestDataResponse & { type: 'streaming' } {
  return { type: 'streaming', result: stream, ...options } as requestDataResponse & { type: 'streaming' }
}

function callArgs(
  req: requestDataResponse & { type: 'streaming' },
  currentChar: character,
  signal: AbortSignal,
  overrides: Partial<Parameters<typeof consumeStreamResponse>[0]> = {},
) {
  return {
    req,
    arg: {},
    nowChatroom: currentChar,
    currentChar,
    selectedChar: 0,
    selectedChat: 0,
    generationId: 'gen-1',
    generationInfo: {} as MessageGenerationInfo,
    promptInfo: {} as MessagePresetInfo,
    abortSignal: signal,
    reformatContent: REFORMAT,
    ...overrides,
  }
}

describe('consumeStreamResponse', { tags: 'core' }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(1000))
    processScriptFullSpy.mockReset()
    processScriptFullSpy.mockImplementation(async (_c: unknown, data: string) => ({
      data,
      emoChanged: false,
    }))
    resetHalfStreamingProgressForTests()
    resetGenerationDisplayProjectionsForTests()
  })

  it('streams negotiated regenerate text into a transient target projection', async () => {
    const currentChar = seed()
    applyServerChatMessagesResource(
      'chat-1',
      [
        { role: 'user', data: 'try again', chatId: 'user-1' },
        { role: 'char', data: 'old reply', chatId: 'assistant-old' },
      ],
      undefined,
      [],
    )
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const displayProjection = {
      operationId: 'operation-1',
      attemptNo: 1,
      characterId: 'cha-1',
      chatId: 'chat-1',
      mode: 'regenerate' as const,
      targetMessageId: 'assistant-old',
      generationId: 'gen-1',
      projectionEpoch: 3,
    }
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream, { generationDisplayProjection: displayProjection }), currentChar, ctrl.signal, {
        skipEditOutput: true,
      }),
    )

    push({ 'gen-1': 'new partial reply' })
    close()
    const result = await promise

    expect(ownerMessages()).toEqual([
      { role: 'user', data: 'try again', chatId: 'user-1' },
      { role: 'char', data: 'old reply', chatId: 'assistant-old' },
    ])
    expect(get(generationDisplayProjections)).toEqual([
      expect.objectContaining({
        operationId: 'operation-1',
        targetMessageId: 'assistant-old',
        generationId: 'gen-1',
        status: 'streaming',
        text: 'new partial reply',
      }),
    ])
    expect(result.projection).toMatchObject({
      messageId: 'assistant-old',
      generationId: 'gen-1',
      appended: false,
      displayProjection,
    })
  })

  it('half-streaming keeps partial text hidden, reports throughput, and applies the final response once', async () => {
    const currentChar = seed()
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream, { halfStreaming: true }), currentChar, ctrl.signal),
    )

    push({ msgKey: 'a' })
    await Promise.resolve()
    await Promise.resolve()
    expect(ownerMessages()[1]?.data).toBe('')
    expect(get(halfStreamingProgress)).toContainEqual(
      expect.objectContaining({ generatedTokens: 1, tokensPerSecond: 0 }),
    )
    expect(processScriptFullSpy).not.toHaveBeenCalled()

    vi.setSystemTime(new Date(1100))
    push({ msgKey: 'ab' })
    await Promise.resolve()
    await Promise.resolve()
    expect(ownerMessages()[1]?.data).toBe('')
    expect(get(halfStreamingProgress)).toContainEqual(
      expect.objectContaining({ generatedTokens: 2, tokensPerSecond: 10 }),
    )

    close()
    const out = await promise
    expect(out.result).toBe('ab')
    expect(ownerMessages()[1]?.data).toBe('ab')
    expect(processScriptFullSpy).toHaveBeenCalledOnce()
    expect(processScriptFullSpy).toHaveBeenCalledWith(currentChar, 'ab', 'editoutput', 1)
    expect(get(halfStreamingProgress)).toEqual([])
  })

  it('half-streaming continue mode preserves the existing response until the continuation completes', async () => {
    const currentChar = seed()
    getChatMessageOwnerState('chat-1')!.messages.push({ role: 'char', data: 'existing' })
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream, { halfStreaming: true }), currentChar, ctrl.signal, {
        arg: { continue: true },
      }),
    )

    push({ msgKey: ' continuation' })
    await Promise.resolve()
    await Promise.resolve()
    expect(ownerMessages()[1]?.data).toBe('existing')
    expect(processScriptFullSpy).not.toHaveBeenCalled()

    close()
    await promise
    expect(ownerMessages()[1]?.data).toBe('existing continuation')
    expect(processScriptFullSpy).toHaveBeenCalledOnce()
  })

  it('half-streaming keeps a local-provider partial when Stop aborts before closure', async () => {
    const currentChar = seed()
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream, { halfStreaming: true }), currentChar, ctrl.signal),
    )

    push({ msgKey: 'buffered local partial' })
    await vi.waitFor(() => expect(get(halfStreamingProgress)[0]?.generatedTokens).toBe(1))
    expect(ownerMessages()[1]?.data).toBe('')

    ctrl.abort()
    close()

    const out = await promise
    expect(out.streamAborted).toBe(true)
    expect(ownerMessages()[1]).toMatchObject({
      role: 'char',
      data: 'buffered local partial',
      chatId: 'gen-1',
    })
    expect(processScriptFullSpy).toHaveBeenCalledWith(currentChar, 'buffered local partial', 'editoutput', 1)
  })

  it('single chunk: pushes initial message, writes processed data, returns lastResponseChunk', async () => {
    const currentChar = seed()
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const onGenerationText = vi.fn()
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream), currentChar, ctrl.signal, { onGenerationText }),
    )
    push({ msgKey: 'hello' })
    close()
    const out = await promise
    expect(out.result).toBe('hello')
    expect(out.lastResponseChunk).toEqual({ msgKey: 'hello' })
    expect(out.streamAborted).toBe(false)
    expect(out.msgIndex).toBe(1)
    const messages = getChatMessageOwnerState('chat-1')?.messages ?? []
    expect(messages).toHaveLength(2)
    expect(messages[1].data).toBe('hello')
    expect(messages[1].role).toBe('char')
    expect(messages[1].chatId).toBe('gen-1')
    expect(onGenerationText).toHaveBeenCalledOnce()
  })

  it('marks the completed stream projection when its replay window was gap-truncated', async () => {
    const currentChar = seed()
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream, { replayGapTruncated: true }), currentChar, ctrl.signal),
    )
    push({ msgKey: 'canonical terminal text' })
    close()

    const out = await promise
    expect(out.projection.gapTruncated).toBe(true)
    expect(out.result).toBe('canonical terminal text')
  })

  it('multiple chunks: last chunk wins for message slot and result', async () => {
    const currentChar = seed()
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    push({ msgKey: 'a' })
    push({ msgKey: 'ab' })
    push({ msgKey: 'abc' })
    close()
    const out = await promise
    expect(out.result).toBe('abc')
    expect(ownerMessages()[1]?.data).toBe('abc')
    // Render coalescing: the microtask-paced chunks share one full-fidelity
    // apply at settle time instead of one editoutput parse per chunk.
    expect(processScriptFullSpy).toHaveBeenCalledTimes(1)
    expect(processScriptFullSpy).toHaveBeenCalledWith(currentChar, 'abc', 'editoutput', 1)
  })

  it('continue mode: decrements msgIndex, prepends prefix from prior message', async () => {
    const currentChar = seed()
    getChatMessageOwnerState('chat-1')!.messages.push({ role: 'char', data: 'partial' })
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream), currentChar, ctrl.signal, { arg: { continue: true } }),
    )
    push({ msgKey: 'extra' })
    close()
    const out = await promise
    expect(out.msgIndex).toBe(1)
    expect(processScriptFullSpy).toHaveBeenCalledWith(currentChar, 'partialextra', 'editoutput', 1)
    expect(ownerMessages()).toHaveLength(2)
  })

  it('uses the immutable continue base when a retried reattach already displays the partial', async () => {
    const currentChar = seed()
    getChatMessageOwnerState('chat-1')!.messages.push({
      role: 'char',
      data: 'Seed answer. Continued reply.',
      chatId: 'continue-target',
    })
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream, { continueBase: 'Seed answer.' }), currentChar, ctrl.signal, {
        arg: { continue: true },
        skipEditOutput: true,
      }),
    )

    push({ msgKey: ' Continued reply.' })
    close()
    const out = await promise

    expect(ownerMessages()[1]?.data).toBe('Seed answer. Continued reply.')
    expect(out.projection.detached).toBe(false)
  })

  it('append-style continue creates a generation-owned row behind the prior assistant', async () => {
    const currentChar = seed()
    getChatMessageOwnerState('chat-1')!.messages.push({
      role: 'char',
      data: 'previous chapter',
      chatId: 'previous-assistant',
    })
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const req = streamingReq(stream)
    req.continueDisposition = 'append'
    const promise = consumeStreamResponse(
      callArgs(req, currentChar, ctrl.signal, {
        arg: { continue: true },
        skipEditOutput: true,
      }),
    )
    push({ msgKey: '\n### Chapter 2\nnew chapter' })
    close()

    const out = await promise
    const messages = ownerMessages()
    expect(messages).toHaveLength(3)
    expect(messages[1]).toMatchObject({ chatId: 'previous-assistant', data: 'previous chapter' })
    expect(messages[2]).toMatchObject({ chatId: 'gen-1', data: '### Chapter 2\nnew chapter' })
    expect(out.projection).toMatchObject({ messageId: 'gen-1', appended: true, previousData: '' })
  })

  it('empty/falsy chunk value: coerces to empty string instead of throwing', async () => {
    const currentChar = seed()
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    push({ msgKey: '' })
    close()
    const out = await promise
    expect(out.result).toBe('')
    expect(processScriptFullSpy).toHaveBeenCalledWith(currentChar, '', 'editoutput', 1)
  })

  it('removeIncompleteResponse=true: routes the chunk through trimUntilPunctuation (real impl)', async () => {
    const currentChar = seed()
    testDatabaseState.db.removeIncompleteResponse = true
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    // 'noPunct' has no trailing punctuation → real trim strips to ''.
    push({ msgKey: 'noPunct' })
    close()
    const out = await promise
    expect(out.result).toBe('')
    expect(processScriptFullSpy).toHaveBeenCalledWith(currentChar, '', 'editoutput', 1)
  })

  it('pre-aborted signal: skips the read loop entirely, streamAborted=true', async () => {
    const currentChar = seed()
    const { stream, close } = makeControlledStream()
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    expect(out.streamAborted).toBe(true)
    expect(processScriptFullSpy).not.toHaveBeenCalled()
    close()
  })

  it('mid-stream abort: stops the loop, preserves the last-applied chunk', async () => {
    const currentChar = seed()
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    push({ msgKey: 'first' })
    // Let the first chunk get processed before aborting.
    await Promise.resolve()
    await Promise.resolve()
    ctrl.abort()
    close()
    const out = await promise
    expect(out.streamAborted).toBe(true)
    expect(ownerMessages()[1]?.data).toBe('first')
  })

  it('mid-stream abort before tokens removes the empty generated message', async () => {
    const currentChar = seed()
    const { stream, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    const messages = getChatMessageOwnerState('chat-1')?.messages ?? []
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      role: 'char',
      data: '',
      chatId: 'gen-1',
    })

    ctrl.abort()
    close()

    const out = await promise
    expect(out.streamAborted).toBe(true)
    expect(ownerMessages()).toEqual([{ role: 'user', data: 'hi' }])
    expect(testDatabaseState.db.characters[0].chats[0].isStreaming).toBe(false)
  })

  it('terminal stream closure before tokens removes the empty generated message', async () => {
    const currentChar = seed()
    const { stream, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))

    close()

    const out = await promise
    expect(out.streamAborted).toBe(false)
    expect(ownerMessages()).toEqual([{ role: 'user', data: 'hi' }])
  })

  it('retains the active assistant row across an assembly transcript hydration', async () => {
    const currentChar = seed()
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))

    expect(getChatMessageOwnerState('chat-1')?.messages.at(-1)).toMatchObject({
      role: 'char',
      data: '',
      chatId: 'gen-1',
    })
    expect(applyServerChatMessagesResource('chat-1', [{ role: 'user', data: 'hi' }], undefined, [])).toBe(true)
    expect(ownerMessages().at(-1)).toMatchObject({
      role: 'char',
      data: '',
      chatId: 'gen-1',
    })

    push({ msgKey: 'survives hydration' })
    close()

    const out = await promise
    expect(out.projection.detached).toBe(false)
    expect(getChatMessageOwnerState('chat-1')?.messages.at(-1)).toMatchObject({
      role: 'char',
      data: 'survives hydration',
      chatId: 'gen-1',
    })
  })

  it('does not retain the active assistant row over a changed authoritative transcript', async () => {
    const currentChar = seed()
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))

    expect(
      applyServerChatMessagesResource('chat-1', [{ role: 'user', data: 'newer authoritative edit' }], undefined, []),
    ).toBe(true)
    push({ msgKey: 'must not return' })
    close()

    const out = await promise
    expect(out.projection.detached).toBe(true)
    expect(ownerMessages()).toEqual([{ role: 'user', data: 'newer authoritative edit' }])
  })

  it('durable replay reuses an existing partial generation row', async () => {
    const currentChar = seed()
    getChatMessageOwnerState('chat-1')!.messages.push({
      role: 'char',
      data: 'partial',
      chatId: 'gen-1',
      generationInfo: { generationId: 'gen-1' },
    })
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))

    push({ msgKey: 'partial recovered' })
    close()

    await promise
    const messages = getChatMessageOwnerState('chat-1')?.messages ?? []
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      role: 'char',
      data: 'partial recovered',
      chatId: 'gen-1',
    })
  })

  it('mid-stream abort keeps a non-empty generated message for server reconciliation', async () => {
    const currentChar = seed()
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    push({ msgKey: 'partial' })
    await Promise.resolve()
    await Promise.resolve()

    ctrl.abort()
    close()

    const out = await promise
    expect(out.streamAborted).toBe(true)
    const messages = getChatMessageOwnerState('chat-1')?.messages ?? []
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      role: 'char',
      data: 'partial',
      chatId: 'gen-1',
    })
  })

  it('reader error after abort is swallowed (streamAborted ends true)', async () => {
    const currentChar = seed()
    const { stream, error } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    ctrl.abort()
    error(new Error('reader-broke'))
    const out = await promise
    expect(out.streamAborted).toBe(true)
  })

  it('reader error without abort is rethrown', async () => {
    const currentChar = seed()
    const { stream, error } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    error(new Error('unrelated-failure'))
    await expect(promise).rejects.toThrow('unrelated-failure')
  })

  it('finally always runs: isStreaming flipped on then off, reloadKeys bumped each stage', async () => {
    const currentChar = seed()
    testDatabaseState.db.characters[0].reloadKeys = 0
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    push({ msgKey: 'hi' })
    close()
    await promise
    expect(testDatabaseState.db.characters[0].chats[0].isStreaming).toBe(false)
    // setup (+1) + per-chunk (+1) + finally (+1) = 3
    expect(testDatabaseState.db.characters[0].reloadKeys).toBe(3)
  })

  it('keeps streaming bound to stable character and chat ids after collection reorder', async () => {
    const characterA = makeChar()
    characterA.chaId = 'cha-a'
    characterA.chats[0].id = 'chat-a'
    const characterB = makeChar()
    characterB.chaId = 'cha-b'
    characterB.chats[0].id = 'chat-b'
    characterB.chats[0].message = [{ role: 'char', data: 'belongs to B', chatId: 'msg-b' }]
    setDatabase({ characters: [characterA, characterB] } as Database)
    const liveA = testDatabaseState.db.characters[0]
    const liveB = testDatabaseState.db.characters[1]
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream), liveA, ctrl.signal, {
        targetCharacterId: 'cha-a',
        targetChatId: 'chat-a',
      }),
    )

    testDatabaseState.db.characters = [liveB, liveA]
    push({ msgKey: 'A response' })
    close()
    await promise

    expect(getChatMessageOwnerState('chat-b')?.messages).toEqual([
      { role: 'char', data: 'belongs to B', chatId: 'msg-b' },
    ])
    expect(testDatabaseState.db.characters[1].chats[0].message.at(-1)?.data).toBe('A response')
    expect(testDatabaseState.db.characters[1].chats[0].isStreaming).toBe(false)
  })

  it('detaches instead of falling back to another indexed owner when the original disappears', async () => {
    const characterA = makeChar()
    characterA.chaId = 'cha-a'
    characterA.chats[0].id = 'chat-a'
    const characterB = makeChar()
    characterB.chaId = 'cha-b'
    characterB.chats[0].id = 'chat-b'
    characterB.chats[0].message = [{ role: 'char', data: 'belongs to B', chatId: 'msg-b' }]
    setDatabase({ characters: [characterA, characterB] } as Database)
    const liveA = testDatabaseState.db.characters[0]
    const liveB = testDatabaseState.db.characters[1]
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream), liveA, ctrl.signal, {
        targetCharacterId: 'cha-a',
        targetChatId: 'chat-a',
      }),
    )

    testDatabaseState.db.characters = [liveB]
    push({ msgKey: 'must not cross owners' })
    close()
    await promise

    expect(getChatMessageOwnerState('chat-b')?.messages).toEqual([
      { role: 'char', data: 'belongs to B', chatId: 'msg-b' },
    ])
    expect(testDatabaseState.db.characters[0].chats[0].isStreaming).not.toBe(true)
    expect(testDatabaseState.db.characters[0].reloadKeys).toBe(0)
  })

  it('removes the abort listener in finally (later abort has no effect on result)', async () => {
    const currentChar = seed()
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    push({ msgKey: 'done' })
    close()
    const out = await promise
    expect(out.streamAborted).toBe(false)
    ctrl.abort()
    // No throw, no late mutation: the listener was removed in finally.
    expect(ownerMessages()[1]?.data).toBe('done')
  })
})

// Streaming display writes are frame-coalesced instead of parsed per token.
describe('streaming render coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(1000))
    processScriptFullSpy.mockReset()
    processScriptFullSpy.mockImplementation(async (_c: unknown, data: string) => ({
      data,
      emoChanged: false,
    }))
  })

  it('bounds parse work for an N-token stream: applies are O(flushes), not O(N)', async () => {
    const currentChar = seed()
    testDatabaseState.db.characters[0].reloadKeys = 0
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    const tokenCount = 200
    let accumulated = ''
    for (let i = 0; i < tokenCount; i += 1) {
      accumulated += `tok${i} `
      push({ msgKey: accumulated })
    }
    close()
    const out = await promise

    // Final text identical to the per-chunk behavior: newest payload, reformat
    // (trim) + editoutput applied once at full fidelity.
    expect(out.result).toBe(accumulated)
    expect(getChatMessageOwnerState('chat-1')?.messages[1]?.data).toBe(accumulated.trim())
    // Old behavior: 200 editoutput parses + 200 display writes. Coalesced: the
    // microtask-paced chunks drain before any animation frame elapses, so the
    // settle apply is the only one (bound generously to tolerate one frame).
    expect(processScriptFullSpy.mock.calls.length).toBeLessThanOrEqual(2)
    // reloadKeys bumps == display reparses: setup (+1) + applies (<=2) +
    // finally (+1) — bounded, instead of 202.
    expect(testDatabaseState.db.characters[0].reloadKeys).toBeLessThanOrEqual(4)
  })

  it('flushes on the frame scheduler so the display progresses mid-stream', async () => {
    const currentChar = seed()
    const frames: (() => void)[] = []
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream), currentChar, ctrl.signal, {
        renderFlushScheduler: (flush) => {
          frames.push(flush)
        },
      }),
    )

    // First chunk arrives: one frame flush is scheduled; running it shows the
    // partial text before the stream is anywhere near done.
    push({ msgKey: 'Hello' })
    await vi.waitFor(() => expect(frames.length).toBe(1))
    frames.shift()!()
    await vi.waitFor(() => expect(getChatMessageOwnerState('chat-1')?.messages[1]?.data).toBe('Hello'))

    // Later chunks re-arm at most one further frame; without running it, the
    // terminal settle still applies the newest payload at full fidelity.
    push({ msgKey: 'Hello wor' })
    push({ msgKey: 'Hello world' })
    close()
    const out = await promise
    expect(out.result).toBe('Hello world')
    expect(getChatMessageOwnerState('chat-1')?.messages[1]?.data).toBe('Hello world')
    // One frame apply + one settle apply.
    expect(processScriptFullSpy).toHaveBeenCalledTimes(2)
  })

  it('does not overwrite a newer projection when a coalesced write settles', async () => {
    const currentChar = seed()
    const frames: (() => void)[] = []
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream), currentChar, ctrl.signal, {
        renderFlushScheduler: (flush) => {
          frames.push(flush)
        },
      }),
    )

    push({ msgKey: 'server stream' })
    await vi.waitFor(() => expect(frames.length).toBe(1))

    expect(
      applyServerChatMessagesResource(
        'chat-1',
        [
          {
            role: 'char',
            data: 'projection final',
            chatId: 'gen-1',
            generationInfo: { generationId: 'gen-1' },
          },
        ],
        undefined,
        [],
      ),
    ).toBe(true)
    close()

    const out = await promise
    expect(out.msgIndex).toBe(1)
    const messages = getChatMessageOwnerState('chat-1')?.messages ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0].data).toBe('projection final')
    expect(processScriptFullSpy).not.toHaveBeenCalled()
  })

  it('retargets a coalesced write when a moved row is still stream-owned', async () => {
    const currentChar = seed()
    const frames: (() => void)[] = []
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream), currentChar, ctrl.signal, {
        renderFlushScheduler: (flush) => {
          frames.push(flush)
        },
      }),
    )

    push({ msgKey: 'server stream' })
    await vi.waitFor(() => expect(frames.length).toBe(1))
    const ownerBeforeMove = getChatMessageOwnerState('chat-1')
    const messages = ownerBeforeMove?.messages
    expect(messages).toBeDefined()
    messages!.splice(0, messages!.length, {
      role: 'char',
      data: '',
      chatId: 'gen-1',
      generationInfo: { generationId: 'gen-1' },
    })
    expect(getChatMessageOwnerState('chat-1')?.projectionEpoch).toBe(ownerBeforeMove?.projectionEpoch)
    close()

    const out = await promise
    expect(out.msgIndex).toBe(0)
    expect(out.projection.detached).toBe(false)
    expect(messages?.[0]?.data).toBe('server stream')
  })

  it('stops applying frames after a message mutation intent advances', async () => {
    const currentChar = seed()
    const frames: (() => void)[] = []
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(
      callArgs(streamingReq(stream), currentChar, ctrl.signal, {
        arg: { continue: true },
        renderFlushScheduler: (flush) => frames.push(flush),
      }),
    )
    const target = getChatMessageOwnerState('chat-1')!.messages[0]
    target.role = 'char'
    target.chatId = 'continue-target'
    target.data = 'user edit'
    markChatMessageMutationIntent('chat-1')
    push({ msgKey: 'server stream' })
    close()

    await promise
    expect(target.data).toBe('user edit')
  })

  it('stops applying frames after an authoritative body projection advances', async () => {
    const currentChar = seed()
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    const target = getChatMessageOwnerState('chat-1')!.messages[1]
    target.data = 'authoritative final'
    markChatBodyProjectionApplied('chat-1')
    push({ msgKey: 'server stream' })
    close()

    await promise
    expect(target.data).toBe('authoritative final')
  })

  it('a mid-stream apply failure propagates and still runs the finally cleanup', async () => {
    const currentChar = seed()
    processScriptFullSpy.mockRejectedValue(new Error('script-broke'))
    const { stream, push, close } = makeControlledStream()
    const ctrl = new AbortController()
    const promise = consumeStreamResponse(callArgs(streamingReq(stream), currentChar, ctrl.signal))
    push({ msgKey: 'boom' })
    close()
    await expect(promise).rejects.toThrow('script-broke')
    expect(testDatabaseState.db.characters[0].chats[0].isStreaming).toBe(false)
    // The apply never succeeded, so the message slot keeps its initial value.
    expect(getChatMessageOwnerState('chat-1')?.messages[1]?.data).toBe('')
  })
})
