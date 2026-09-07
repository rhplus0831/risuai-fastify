import { flushSync, mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReaderTranscript from './ReaderTranscript.svelte'
import Chat from './ChatScreens/Chat.svelte'
import { language } from '../lang'
import { seedRenderCostMessages } from '../ts/__tests__/renderCostHarness'
import { withTestDatabaseWrite } from '../ts/__tests__/resourceDatabaseState'
import {
  charactersResourceState,
  settingsResourceState,
  collectionsResourceState,
  applyCharactersResource,
  applyCharacterResource,
  applyCollectionsResource,
  applySettingsGroupResource,
} from '../ts/server/resourceState.svelte'
import * as hydration from '../ts/server/chatMessageHydration.svelte'
import * as resourceReads from '../ts/server/resourceReads'
import { resetReaderDisplayResourcesForTests } from '../ts/server/readerDisplayResources'
import * as readerDisplayResources from '../ts/server/readerDisplayResources'
import * as greetingTranslations from '../ts/server/greetingTranslations.svelte'
import * as parser from '../ts/parser/parser.svelte'
import { selectedCharID, SizeStore } from '../ts/stores.svelte'
import {
  beginClientSession,
  authenticateClientSessionReadView,
  authorizeClientWriterRecovery,
  beginClientPromotion,
  beginClientWriterResume,
  getClientSessionSnapshot,
  settleClientReader,
  setClientProjectionReady,
  setClientConnectionState,
  resetClientSessionForTests,
  requireClientAuthentication,
} from '../ts/clientSession'
import { resetStartupReadinessForTests } from '../ts/startupReadiness'
import { clearChatBodyParseMemo } from './ChatScreens/ChatBodyParseMemo'
import { SERVER_CHARACTER_SUMMARY_VERSION } from '@risuai/protocol/character-summary-resource'
import { demoteClientSession } from '../ts/clientSession'
import { setManagedWriterForTest } from '../ts/__tests__/managedClientSession'
import { appendOptimisticGenerationOperationUserMessage } from '../ts/chatCommands'
import type { character, Message } from '../ts/storage/database.svelte'
import { startReaderGenerationObservation } from '../ts/server/readerGenerationObservation'
import type { ReaderGenerationProjection } from '../ts/server/readerGenerationTypes'
import ReaderTranscriptSelectionHarness from './ReaderTranscript.selectionHarness.svelte'
import {
  beginGenerationDisplayProjection,
  generationDisplayProjections,
  resetGenerationDisplayProjectionsForTests,
  updateGenerationDisplayProjection,
} from '../ts/process/generationDisplayProjection.svelte'
import { halfStreamingProgress, resetHalfStreamingProgressForTests } from '../ts/process/halfStreamingProgress'
import {
  automaticTranslationMessageIds,
  replaceAutomaticTranslationMessageIds,
} from '../ts/process/generatedMessageTranslationEligibility'

vi.mock('../ts/server/readerGenerationObservation', () => ({ startReaderGenerationObservation: vi.fn() }))

vi.mock('../ts/process/modules', async (importActual) => ({
  ...(await importActual<typeof import('../ts/process/modules')>()),
  getModuleAssets: () => [],
  getModuleLorebooks: () => [],
  getModuleRegexScripts: () => [],
  getModuleTriggers: () => [],
  getModules: () => [],
  moduleUpdate: () => {},
}))

let target: HTMLElement
let component: ReturnType<typeof mount> | undefined
let observations: {
  input: Parameters<typeof startReaderGenerationObservation>[0]
  stop: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
}[] = []

function liveProjection(overrides: Partial<ReaderGenerationProjection> = {}): ReaderGenerationProjection {
  return {
    databaseLineage: 'reader-tests',
    characterId: 'reader-character',
    chatId: 'reader-chat',
    operationId: 'reader-operation',
    attemptNo: 1,
    jobId: 'reader-job',
    generationId: 'reader-job',
    projectionEpoch: 1,
    mode: 'send',
    text: 'Live reader output',
    status: 'streaming',
    phase: 'generating',
    startedAt: Date.now(),
    ...overrides,
  }
}

function project(projection: ReaderGenerationProjection | null) {
  observations.at(-1)!.input.onChange({ status: projection ? 'watching' : 'idle', projection })
}

async function settle() {
  flushSync()
  for (let index = 0; index < 6; index += 1) {
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function startReader() {
  const operation = beginClientSession('reader')
  settleClientReader(operation, { databaseLineage: 'reader-tests', writer: { sessionId: 'writer', epoch: 1 } })
  setClientProjectionReady(true)
  setClientConnectionState('live')
  publishReaderFixtures()
}

function publishReaderFixtures() {
  const source = JSON.parse(JSON.stringify(charactersResourceState.characters)) as character[]
  applyCharactersResource({
    version: SERVER_CHARACTER_SUMMARY_VERSION,
    revision: 1,
    characters: source,
    characterOrder: [],
    currentChar: 0,
  })
  for (const character of source)
    for (const chat of character.chats) {
      hydration.applyServerChatMessagesResource(chat.id!, chat.message, undefined, [])
    }
}

function seedReaderChat(count = 3) {
  seedRenderCostMessages(count)
  const writer = charactersResourceState.characters[0]
  const reader = JSON.parse(JSON.stringify(writer)) as character
  reader.chaId = 'reader-character'
  reader.name = 'Reader character'
  reader.firstMessage = ''
  reader.alternateGreetings = []
  reader.chats[0].id = 'reader-chat'
  reader.chats[0].name = 'Reader conversation'
  reader.chats[0].message = reader.chats[0].message.map((message, index) => ({
    ...message,
    data: `Reader message ${index}`,
  }))
  withTestDatabaseWrite(() => {
    charactersResourceState.characters.push(reader)
    settingsResourceState.value.useChatCopy = true
    settingsResourceState.value.clickToEdit = true
    settingsResourceState.value.chatLoadInitialPages = 2
    settingsResourceState.value.chatLoadAdditionalPages = 2
    collectionsResourceState.values.promptPresets = []
    collectionsResourceState.statuses.promptPresets = 'ready'
    collectionsResourceState.values.personas = []
    collectionsResourceState.statuses.personas = 'ready'
  })
  return charactersResourceState.characters[1]
}

beforeEach(() => {
  observations = []
  vi.mocked(startReaderGenerationObservation)
    .mockReset()
    .mockImplementation((input) => {
      const observation = { input, stop: vi.fn(), refresh: vi.fn() }
      observations.push(observation)
      return observation
    })
  resetReaderDisplayResourcesForTests()
  resetClientSessionForTests()
  resetStartupReadinessForTests()
  hydration.resetChatHydration()
  resetGenerationDisplayProjectionsForTests()
  resetHalfStreamingProgressForTests()
  replaceAutomaticTranslationMessageIds([])
  clearChatBodyParseMemo()
  target = document.createElement('div')
  document.body.appendChild(target)
  vi.spyOn(parser, 'ParseMarkdown').mockImplementation(async (source) => `<p>${source}</p>`)
  vi.spyOn(hydration, 'hydrateReaderChatMessageWindow').mockResolvedValue(true)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('unexpected network request'))),
  )
  SizeStore.set({ w: 900, h: 700 })
})

afterEach(async () => {
  if (component) await unmount(component)
  component = undefined
  resetReaderDisplayResourcesForTests()
  resetClientSessionForTests()
  hydration.resetChatHydration()
  resetGenerationDisplayProjectionsForTests()
  resetHalfStreamingProgressForTests()
  replaceAutomaticTranslationMessageIds([])
  clearChatBodyParseMemo()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  target.remove()
})

describe('connected reader transcript', () => {
  it.each(['resolving', 'recovering', 'resuming'] as const)(
    'defers body, display, greeting and rendering work for automatic %s startup',
    async (phase) => {
      const reader = seedReaderChat(2)
      withTestDatabaseWrite(() => {
        reader.firstMessage = 'Raw preview greeting'
      })
      let operation = beginClientSession('preview-writer')
      authenticateClientSessionReadView(operation, {
        databaseLineage: 'reader-tests',
        writer: { sessionId: null, epoch: 1 },
      })
      setClientProjectionReady(true)
      setClientConnectionState('live')
      if (phase !== 'resolving') {
        const ownership = { databaseLineage: 'reader-tests', writer: { sessionId: 'preview-writer', epoch: 2 } }
        authorizeClientWriterRecovery(operation, ownership)
        if (phase === 'resuming') {
          setClientConnectionState('interrupted')
          operation = beginClientWriterResume()!
          authorizeClientWriterRecovery(operation, ownership)
          setClientConnectionState('live')
        }
      }
      publishReaderFixtures()
      hydration.resetChatHydration()
      vi.spyOn(readerDisplayResources, 'readerDisplayResourcesReady').mockReturnValue(false)
      const display = vi
        .spyOn(readerDisplayResources, 'ensureReaderDisplayResources')
        .mockResolvedValue({ status: 'ok' })
      const greeting = vi
        .spyOn(greetingTranslations, 'refreshGreetingTranslationProjection')
        .mockResolvedValue({ status: 'error', error: 'test' })
      component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
      await settle()
      expect(hydration.hydrateReaderChatMessageWindow).not.toHaveBeenCalled()
      expect(display).not.toHaveBeenCalled()
      expect(greeting).not.toHaveBeenCalled()
      expect(parser.ParseMarkdown).not.toHaveBeenCalled()
      expect(target.querySelector('.risu-chat')).toBeNull()
      expect(target.textContent).not.toContain('Raw preview greeting')
      const refresh = target.querySelector<HTMLButtonElement>('[data-reader-refresh]')!
      expect(refresh.disabled).toBe(true)
      refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await settle()
      expect(hydration.hydrateReaderChatMessageWindow).not.toHaveBeenCalled()
      expect(display).not.toHaveBeenCalled()
      expect(observations).toHaveLength(0)

      expect(
        settleClientReader(operation, { databaseLineage: 'reader-tests', writer: getClientSessionSnapshot().writer! }),
      ).toBe(true)
      await settle()
      expect(hydration.hydrateReaderChatMessageWindow).toHaveBeenCalledOnce()
      expect(display).toHaveBeenCalledOnce()
      expect(greeting).toHaveBeenCalledOnce()
      expect(target.textContent).toContain('Reader message 1')
      expect(target.textContent).toContain('Raw preview greeting')
      expect(observations).toHaveLength(1)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('keeps established reader content through promotion and interrupted recovery', async () => {
    seedReaderChat(2)
    startReader()
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    const assertReadable = () => expect(target.textContent).toContain('Reader message 1')
    assertReadable()
    const promotion = beginClientPromotion()!
    await settle()
    assertReadable()
    const ownership = { databaseLineage: 'reader-tests', writer: { sessionId: 'reader', epoch: 2 } }
    expect(authorizeClientWriterRecovery(promotion, ownership)).toBe(true)
    await settle()
    assertReadable()
    setClientConnectionState('interrupted')
    await settle()
    assertReadable()
    const resume = beginClientWriterResume()!
    expect(authorizeClientWriterRecovery(resume, ownership)).toBe(true)
    setClientConnectionState('live')
    await settle()
    assertReadable()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows committed content while a previous writer reconnects', async () => {
    seedReaderChat(2)
    setManagedWriterForTest()
    publishReaderFixtures()
    setClientConnectionState('interrupted')
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.textContent).toContain('Reader message 1')
    expect(target.querySelector('[data-risu-message-action="edit"]')).toBeNull()
    const resume = beginClientWriterResume()!
    const state = getClientSessionSnapshot()
    expect(
      authorizeClientWriterRecovery(resume, { databaseLineage: state.databaseLineage!, writer: state.writer! }),
    ).toBe(true)
    setClientConnectionState('live')
    await settle()
    expect(target.textContent).toContain('Reader message 1')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps writer generation controls hidden while its partial response is loading', async () => {
    seedReaderChat(2)
    setManagedWriterForTest()
    const writer = charactersResourceState.characters[0]
    component = mount(Chat, {
      target,
      props: {
        character: writer.chaId,
        displayChatId: writer.chats[0].id,
        idx: 0,
        isLastMemory: false,
        message: 'Writer partial response',
        role: 'char',
        readOnly: false,
        isGenerationLoading: true,
        isGenerationProjection: true,
        generationPresentationMode: 'send',
        isChatGenerating: true,
      },
    })
    await settle()
    expect(target.querySelector('.chat-generation-loading')).not.toBeNull()
    expect(target.querySelector('[data-risu-message-action]')).toBeNull()
  })

  it('renders partial send output without canonical writes and keeps one row through command-before-done handoff', async () => {
    seedReaderChat(2)
    startReader()
    replaceAutomaticTranslationMessageIds(['writer-eligibility'])
    const original = JSON.parse(
      JSON.stringify(hydration.getReaderChatMessageOwnerState('reader-chat')!.messages),
    ) as Message[]
    const writerBefore = JSON.stringify(charactersResourceState.characters)
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    const projection = liveProjection()
    project(projection)
    await settle()
    const row = target.querySelector('.chat-message-container[data-generation-display-projection="send"]')
    expect(row?.textContent).toContain('Live reader output')
    expect(hydration.getReaderChatMessageOwnerState('reader-chat')!.messages).toEqual(original)
    expect(JSON.stringify(charactersResourceState.characters)).toBe(writerBefore)
    expect(get(automaticTranslationMessageIds)).toEqual(['writer-eligibility'])
    expect(
      vi
        .mocked(parser.ParseMarkdown)
        .mock.calls.some(([source, , , , , args]) => source === 'Live reader output' && args?.readOnly === true),
    ).toBe(true)
    expect(row?.querySelector('[data-risu-message-action="copy"]')).not.toBeNull()
    expect(
      row?.querySelector(
        '[data-risu-message-action="edit"], [data-risu-message-action="translate"], [data-risu-message-action="reroll"]',
      ),
    ).toBeNull()
    expect(fetch).not.toHaveBeenCalled()

    project({ ...projection, text: 'More live reader output', projectionEpoch: 2 })
    await settle()
    expect(target.querySelector('.chat-message-container[data-generation-display-projection="send"]')).toBe(row)
    const result: Message = {
      role: 'char',
      chatId: 'canonical-send',
      data: 'Final server output',
      generationInfo: {
        generationId: projection.generationId,
        operationId: projection.operationId,
        attemptNo: projection.attemptNo,
      },
    }
    hydration.applyServerChatMessagesResource('reader-chat', [...original, result], undefined, [])
    await settle()
    expect(target.querySelector('[data-risu-message-id="canonical-send"]')?.closest('.chat-message-container')).toBe(
      row,
    )
    expect(row?.textContent).toContain('Final server output')
    expect(target.textContent).not.toContain('More live reader output')
    expect(target.querySelectorAll('.chat-message-container[data-generation-display-projection="send"]')).toHaveLength(
      1,
    )
    project(null)
    await settle()
    expect(target.querySelector('[data-risu-message-id="canonical-send"]')?.closest('.chat-message-container')).toBe(
      row,
    )
    expect(target.querySelector('.chat-generation-loading')).toBeNull()
    expect(hydration.getReaderChatMessageOwnerState('reader-chat')!.messages).toEqual([...original, result])
    project({ ...projection, attemptNo: 2, jobId: 'retry-job', generationId: 'retry-job', text: 'Retried live output' })
    await settle()
    expect(target.querySelector('.chat-message-container[data-generation-display-projection="send"]')).not.toBe(row)
    expect(target.querySelector('[data-risu-message-id="canonical-send"]')?.closest('.chat-message-container')).toBe(
      row,
    )
    expect(target.textContent).toContain('Retried live output')
  })

  it.each(['append', 'extend'] as const)(
    'presents Continue %s against its immutable base and adopts its exact result',
    async (disposition) => {
      const reader = seedReaderChat(2)
      withTestDatabaseWrite(() => {
        reader.chats[0].message[1].role = 'char'
      })
      startReader()
      const original = JSON.parse(
        JSON.stringify(hydration.getReaderChatMessageOwnerState('reader-chat')!.messages),
      ) as Message[]
      const base = original[1]
      component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
      await settle()
      const baseRow = target
        .querySelector(`[data-risu-message-id="${base.chatId}"]`)
        ?.closest('.chat-message-container')
      const projection = liveProjection({
        mode: 'continue',
        continueDisposition: disposition,
        continueBase: base.data,
        targetMessageId: base.chatId,
        text: disposition === 'extend' ? `${base.data} plus live text` : 'Appended live text',
      })
      project(projection)
      await settle()
      const row = target.querySelector('.chat-message-container[data-generation-display-projection="continue"]')
      expect(row?.textContent).toContain(projection.text)
      expect(hydration.getReaderChatMessageOwnerState('reader-chat')!.messages).toEqual(original)
      if (disposition === 'extend') expect(row).toBe(baseRow)
      else expect(baseRow?.textContent).toContain(base.data)
      // The target existed before this operation and must not dismiss live Continue.
      project({ ...projection, status: 'finalizing', phase: 'finalizing', text: `${projection.text} completed` })
      await settle()
      expect(row?.textContent).toContain(`${projection.text} completed`)
      expect(row?.querySelector('.chat-generation-loading')).not.toBeNull()
      const result: Message = {
        ...base,
        chatId: disposition === 'extend' ? base.chatId : 'continued-append',
        data: 'Authoritative continued output',
        generationInfo: {
          generationId: projection.generationId,
          operationId: projection.operationId,
          attemptNo: projection.attemptNo,
        },
      }
      const finalMessages = disposition === 'extend' ? [original[0], result] : [...original, result]
      hydration.applyServerChatMessagesResource('reader-chat', finalMessages, undefined, [])
      await settle()
      expect(row?.textContent).toContain('Authoritative continued output')
      expect(
        target.querySelector(`[data-risu-message-id="${result.chatId}"]`)?.closest('.chat-message-container'),
      ).toBe(row)
      project(null)
      await settle()
      expect(
        target.querySelector(`[data-risu-message-id="${result.chatId}"]`)?.closest('.chat-message-container'),
      ).toBe(row)
      expect(target.querySelector('.chat-generation-loading')).toBeNull()
      expect(hydration.getReaderChatMessageOwnerState('reader-chat')!.messages).toEqual(finalMessages)
    },
  )

  it('overlays only the regenerate target and keeps its presentation identity through replacement', async () => {
    seedReaderChat(2)
    startReader()
    const original = JSON.parse(
      JSON.stringify(hydration.getReaderChatMessageOwnerState('reader-chat')!.messages),
    ) as Message[]
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    const oldRow = target
      .querySelector(`[data-risu-message-id="${original[0].chatId}"]`)
      ?.closest('.chat-message-container')
    const unrelatedRow = target.querySelector(`[data-risu-message-id="${original[1].chatId}"]`)
    const projection = liveProjection({
      mode: 'regenerate',
      targetMessageId: original[0].chatId,
      text: 'Regenerated live text',
    })
    project(projection)
    await settle()
    expect(target.querySelector('.chat-message-container[data-generation-display-projection="regenerate"]')).toBe(
      oldRow,
    )
    expect(oldRow?.textContent).toContain('Regenerated live text')
    expect(unrelatedRow?.textContent).toContain(original[1].data)
    expect(hydration.getReaderChatMessageOwnerState('reader-chat')!.messages).toEqual(original)
    const result: Message = {
      role: 'char',
      chatId: 'regenerated-result',
      data: 'Final regenerated text',
      generationInfo: {
        generationId: projection.generationId,
        operationId: projection.operationId,
        attemptNo: projection.attemptNo,
      },
    }
    hydration.applyServerChatMessagesResource('reader-chat', [result, original[1]], undefined, [])
    await settle()
    expect(oldRow?.textContent).toContain('Final regenerated text')
    project(null)
    await settle()
    expect(
      target.querySelector('[data-risu-message-id="regenerated-result"]')?.closest('.chat-message-container'),
    ).toBe(oldRow)
    expect(target.querySelector(`[data-risu-message-id="${original[1].chatId}"]`)).toBe(unrelatedRow)
    expect(target.querySelectorAll('.risu-chat')).toHaveLength(2)
  })

  it('isolates the explicit reader path from writer regenerate and half-streaming stores even with a null projection', async () => {
    seedReaderChat(2)
    startReader()
    const base = hydration.getReaderChatMessageOwnerState('reader-chat')!.messages[1]
    const writer = beginGenerationDisplayProjection({
      characterId: 'reader-character',
      chatId: 'reader-chat',
      operationId: 'stale-writer-operation',
      attemptNo: 1,
      mode: 'regenerate',
      projectionEpoch: 1,
      targetMessageId: base.chatId,
      generationId: base.chatId,
    })
    updateGenerationDisplayProjection(writer, { text: 'Stale writer overlay', status: 'finalizing' })
    halfStreamingProgress.set([
      {
        characterId: 'reader-character',
        chatId: 'reader-chat',
        generationId: base.chatId!,
        generatedTokens: 98765,
        tokensPerSecond: 54321,
        updatedAt: Date.now(),
      },
    ])
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.textContent).toContain(base.data)
    expect(target.textContent).not.toContain('Stale writer overlay')
    expect(target.querySelector('[data-generation-display-projection]')).toBeNull()
    project(liveProjection())
    await settle()
    expect(target.textContent).toContain('Live reader output')
    expect(target.textContent).not.toContain('98765')
    expect(target.textContent).not.toContain('54321')
    project(null)
    await settle()
    expect(target.textContent).toContain(base.data)
    expect(target.textContent).not.toContain('Stale writer overlay')
    expect(target.querySelector('.chat-generation-loading')).toBeNull()
    expect(get(generationDisplayProjections)).toMatchObject([{ operationId: writer.operationId, status: 'finalizing' }])
    expect(get(halfStreamingProgress)).toHaveLength(1)
  })

  it('pins a hydrated older generation target without expanding the reader paging owner', async () => {
    seedReaderChat(6)
    startReader()
    const original = JSON.parse(
      JSON.stringify(hydration.getReaderChatMessageOwnerState('reader-chat')!.messages),
    ) as Message[]
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.querySelector(`[data-risu-message-id="${original[0].chatId}"]`)).toBeNull()
    project(
      liveProjection({ mode: 'regenerate', targetMessageId: original[0].chatId, text: 'Live older regeneration' }),
    )
    await settle()
    expect(target.querySelector(`[data-risu-message-id="${original[0].chatId}"]`)?.textContent).toContain(
      'Live older regeneration',
    )
    expect(observations[0].input.loadPages()).toBe(2)
    expect(target.querySelectorAll('.risu-chat').length).toBeLessThanOrEqual(76)
    expect(hydration.getReaderChatMessageOwnerState('reader-chat')!.messages).toEqual(original)
    project(null)
    await settle()
    expect(target.querySelector(`[data-risu-message-id="${original[0].chatId}"]`)).toBeNull()
  })

  it('stops each selected-chat observer, rejects detached callbacks and refreshes the current read-only viewer', async () => {
    seedReaderChat(4)
    startReader()
    const other = charactersResourceState.characters[0]
    const mounted = mount(ReaderTranscriptSelectionHarness, {
      target,
      props: { characterId: 'reader-character', chatId: 'reader-chat' },
    })
    component = mounted
    await settle()
    const first = observations[0]
    expect(first.input).toMatchObject({ characterId: 'reader-character', chatId: 'reader-chat' })
    expect(first.input.loadPages()).toBe(2)
    target.querySelector<HTMLButtonElement>('[data-reader-load-more]')!.click()
    await settle()
    expect(first.input.loadPages()).toBe(4)
    expect(observations).toHaveLength(1)
    setClientConnectionState('interrupted')
    await settle()
    setClientConnectionState('live')
    await settle()
    expect(observations).toHaveLength(1)
    mounted.select(other.chaId, other.chats[0].id!)
    await settle()
    expect(first.stop).toHaveBeenCalledOnce()
    first.input.onChange({ status: 'watching', projection: liveProjection({ text: 'Detached old output' }) })
    await settle()
    expect(target.textContent).not.toContain('Detached old output')
    const second = observations[1]
    mounted.select('reader-character', 'reader-chat')
    await settle()
    expect(second.stop).toHaveBeenCalledOnce()
    expect(observations).toHaveLength(3)
    first.input.onChange({ status: 'watching', projection: liveProjection({ text: 'Detached old output' }) })
    await settle()
    expect(target.textContent).not.toContain('Detached old output')
    target.querySelector<HTMLButtonElement>('[data-reader-refresh]')!.click()
    await settle()
    expect(observations[2].refresh).toHaveBeenCalledOnce()
    expect(first.refresh).not.toHaveBeenCalled()
    await unmount(mounted)
    component = undefined
    expect(observations[2].stop).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows an interrupted viewer without a transient row and preserves partial text without a busy indicator', async () => {
    seedReaderChat(2)
    startReader()
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    observations[0].input.onChange({ status: 'interrupted', projection: null })
    await settle()
    expect(target.querySelector('[data-reader-generation-interrupted]')?.textContent).toContain(
      language.connectedReaders.generationInterrupted,
    )
    expect(target.textContent).toContain('Reader message 1')
    expect(target.querySelector('[data-generation-display-projection]')).toBeNull()
    observations[0].input.onChange({ status: 'interrupted', projection: liveProjection({ status: 'interrupted' }) })
    await settle()
    expect(target.textContent).toContain('Live reader output')
    expect(target.querySelector('.chat-generation-loading')).toBeNull()
    requireClientAuthentication()
    await settle()
    expect(observations[0].stop).toHaveBeenCalledOnce()
    observations[0].input.onChange({ status: 'watching', projection: liveProjection() })
    await settle()
    expect(target.textContent).not.toContain('Live reader output')
  })

  it('shows reader half-streaming progress without borrowing writer token counts or parsing hidden output', async () => {
    seedReaderChat(2)
    startReader()
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    const parserCalls = vi.mocked(parser.ParseMarkdown).mock.calls.length
    project(liveProjection({ halfStreaming: true, text: null, generatedTokens: 42, elapsedMs: 2000 }))
    await settle()
    const row = target.querySelector('.chat-message-container[data-generation-display-projection="send"]')
    expect(row?.textContent).toContain(language.halfStreamingGeneratedTokens(42))
    expect(row?.querySelector('.chat-generation-loading')).not.toBeNull()
    expect(row?.querySelector('.chat-message-body')).toBeNull()
    expect(vi.mocked(parser.ParseMarkdown).mock.calls).toHaveLength(parserCalls)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('renders its explicit chat with copy and a disabled composer without changing writer selection', async () => {
    seedReaderChat()
    startReader()
    const clipboard = { writeText: vi.fn(async () => undefined) }
    const descriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: clipboard })
    try {
      component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
      await settle()
      expect(target.textContent).toContain('Reader message 2')
      expect(target.textContent).not.toContain('Phase 0 render-cost message')
      expect(target.querySelector<HTMLTextAreaElement>('[data-reader-composer] textarea')?.disabled).toBe(true)
      expect(
        target.querySelector(
          '[data-risu-message-action="edit"], [data-risu-message-action="remove"], [data-risu-message-action="translate"], [data-risu-message-action="reroll"]',
        ),
      ).toBeNull()
      const copy = target.querySelector<HTMLButtonElement>('[data-risu-message-action="copy"]')
      expect(copy).not.toBeNull()
      copy!.click()
      await settle()
      expect(clipboard.writeText).toHaveBeenCalledWith('Reader message 2')
      expect(hydration.hydrateReaderChatMessageWindow).not.toHaveBeenCalled()
      expect(get(selectedCharID)).toBe(0)
      expect(charactersResourceState.currentChar).toBe(0)
      expect(charactersResourceState.characters[0].chatPage).toBe(0)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      if (descriptor) Object.defineProperty(window.navigator, 'clipboard', descriptor)
      else Reflect.deleteProperty(window.navigator, 'clipboard')
    }
  })

  it('loads shell-only display inputs before exposing mobile copy and adopts the configured initial window', async () => {
    seedReaderChat(5)
    withTestDatabaseWrite(() => {
      settingsResourceState.value = { username: 'Shell user', language: 'en' }
      settingsResourceState.groupStatuses = {}
      settingsResourceState.groupRevisions = {}
      settingsResourceState.fullRevision = null
      settingsResourceState.standaloneStatuses = {}
      settingsResourceState.standaloneRevisions = {}
      collectionsResourceState.values = {}
      collectionsResourceState.statuses = {}
      collectionsResourceState.revisions = {}
      collectionsResourceState.fullRevision = null
    })
    let finishDisplay!: (value: Awaited<ReturnType<typeof resourceReads.fetchServerSettingsGroup>>) => void
    const pendingDisplay = new Promise<Awaited<ReturnType<typeof resourceReads.fetchServerSettingsGroup>>>(
      (resolve) => {
        finishDisplay = resolve
      },
    )
    vi.spyOn(resourceReads, 'fetchServerSettingsGroup').mockImplementation(async (group) =>
      group === 'display' ? pendingDisplay : { status: 'ok', revision: 7, group, settings: {} },
    )
    vi.spyOn(resourceReads, 'fetchServerCollection').mockImplementation(async (name) => ({
      status: 'ok',
      revision: 7,
      collections: { [name]: [] },
    }))
    vi.spyOn(resourceReads, 'fetchServerStandaloneSetting').mockImplementation(async (setting) => ({
      status: 'ok',
      revision: 7,
      setting,
      state: { present: false },
    }))
    SizeStore.set({ w: 320, h: 700 })
    startReader()
    const clipboard = { writeText: vi.fn(async () => undefined) }
    const descriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: clipboard })
    try {
      component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
      await settle()
      expect(target.textContent).toContain('Reader message 4')
      expect(target.querySelector('[data-risu-message-action="copy"]')).toBeNull()
      expect(resourceReads.fetchServerSettingsGroup).toHaveBeenCalledWith('display', expect.any(AbortSignal))
      finishDisplay({
        status: 'ok',
        revision: 7,
        group: 'display',
        settings: { useChatCopy: true, chatLoadInitialPages: 1, chatLoadAdditionalPages: 2 },
      })
      await settle()
      expect(target.querySelectorAll('.risu-chat')).toHaveLength(1)
      expect(target.querySelector('[data-reader-load-more]')).not.toBeNull()
      const copy = target.querySelector<HTMLButtonElement>('[data-risu-message-action="copy"]')
      expect(copy).not.toBeNull()
      copy!.click()
      await settle()
      expect(clipboard.writeText).toHaveBeenCalledWith('Reader message 4')
      expect(target.querySelector<HTMLTextAreaElement>('[data-reader-composer] textarea')?.disabled).toBe(true)
      expect(get(selectedCharID)).toBe(0)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      if (descriptor) Object.defineProperty(window.navigator, 'clipboard', descriptor)
      else Reflect.deleteProperty(window.navigator, 'clipboard')
    }
  })

  it('keeps readable text on display dependency failure and retries dependencies with Refresh', async () => {
    seedReaderChat()
    withTestDatabaseWrite(() => {
      delete settingsResourceState.value.useChatCopy
      settingsResourceState.groupStatuses.display = 'idle'
      delete settingsResourceState.groupRevisions.display
      settingsResourceState.fullRevision = null
    })
    const displayRead = vi
      .spyOn(resourceReads, 'fetchServerSettingsGroup')
      .mockResolvedValueOnce({ status: 'error', error: 'Display read unavailable' })
      .mockResolvedValue({
        status: 'ok',
        revision: 7,
        group: 'display',
        settings: { useChatCopy: true, chatLoadInitialPages: 2 },
      })
    startReader()
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.textContent).toContain('Reader message 2')
    expect(target.querySelector('[data-reader-read-failed]')?.textContent).toBe(language.connectedReaders.readFailed)
    target.querySelector<HTMLButtonElement>('[data-reader-refresh]')!.click()
    await settle()
    expect(displayRead).toHaveBeenCalledTimes(2)
    expect(settingsResourceState.groupStatuses.display, settingsResourceState.groupErrors.display).toBe('ready')
    expect(settingsResourceState.value.useChatCopy).toBe(true)
    expect(target.querySelector('[data-risu-message-action="copy"]'), target.innerHTML).not.toBeNull()
    expect(target.querySelector('[data-reader-read-failed]')).toBeNull()
  })

  it('loads older history through the explicit chat window while reusing existing transcript rows', async () => {
    seedReaderChat(5)
    startReader()
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.querySelectorAll('.risu-chat')).toHaveLength(2)
    const newest = target.querySelector('[data-risu-message-id="render-cost-message-4"]')
    target.querySelector<HTMLButtonElement>('[data-reader-load-more]')!.click()
    await settle()
    expect(hydration.hydrateReaderChatMessageWindow).toHaveBeenLastCalledWith('reader-chat', 4, { force: false })
    expect(target.querySelectorAll('.risu-chat')).toHaveLength(4)
    expect(target.querySelector('[data-risu-message-id="render-cost-message-4"]')).toBe(newest)
    expect(get(selectedCharID)).toBe(0)
  })

  it('shows committed updates and keeps the same content when refresh fails', async () => {
    const reader = seedReaderChat()
    startReader()
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    const committed = JSON.parse(JSON.stringify(reader.chats[0].message)) as Message[]
    committed[2].data = 'Committed reader update'
    hydration.applyServerChatMessagesResource('reader-chat', committed, undefined, [])
    await settle()
    expect(target.textContent).toContain('Committed reader update')
    vi.mocked(hydration.hydrateReaderChatMessageWindow).mockResolvedValueOnce(false)
    target.querySelector<HTMLButtonElement>('[data-reader-refresh]')!.click()
    await settle()
    expect(target.querySelector('[data-reader-read-failed]')?.textContent).toBe(language.connectedReaders.readFailed)
    expect(target.textContent).toContain('Committed reader update')
    setClientConnectionState('interrupted')
    await settle()
    expect(target.textContent).toContain('Committed reader update')
  })

  it('retains the last usable same-route view while a full refresh re-stubs its body', async () => {
    seedReaderChat()
    startReader()
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.textContent).toContain('Reader message 2')
    vi.mocked(hydration.hydrateReaderChatMessageWindow).mockResolvedValue(false)
    withTestDatabaseWrite(() => {
      charactersResourceState.characters[1].chats[0].message = []
    })
    hydration.resetChatHydration()
    await settle()
    expect(target.textContent).toContain('Reader message 2')
    expect(hydration.hydrateReaderChatMessageWindow).toHaveBeenCalledTimes(1)
    expect(target.querySelector('[data-reader-read-failed]')).not.toBeNull()
  })
  it('clears live and retained transcript content when authentication is lost', async () => {
    seedReaderChat()
    startReader()
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.textContent).toContain('Reader message 2')
    requireClientAuthentication()
    await settle()
    expect(target.textContent).not.toContain('Reader message 2')
    expect(target.querySelector('.risu-chat')).toBeNull()
  })
  it('keeps staged writer rows and metadata out of a demoted reader during held and failed refresh', async () => {
    setManagedWriterForTest()
    seedReaderChat(2)
    publishReaderFixtures()
    const previous = JSON.parse(JSON.stringify(charactersResourceState.characters[0])) as character
    const chatId = previous.chats[0].id!
    const committed = previous.chats[0].message[1].data
    const appended = appendOptimisticGenerationOperationUserMessage(
      {
        selectedCharID: 0,
        chatPage: 0,
        characterId: previous.chaId,
        chatId,
      },
      { role: 'user', data: 'Pending writer send', chatId: 'pending-send' },
    )
    expect(appended.status).toBe('ok')
    withTestDatabaseWrite(() => {
      charactersResourceState.characters[0].displayName = 'Pending character name'
      charactersResourceState.characters[0].chats[0].name = 'Pending chat name'
      charactersResourceState.characters[0].firstMessage = 'Pending greeting'
    })
    let finish!: (value: boolean) => void
    vi.mocked(hydration.hydrateReaderChatMessageWindow).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    demoteClientSession()
    component = mount(ReaderTranscript, { target, props: { characterId: previous.chaId, chatId } })
    await settle()
    expect(hydration.hydrateReaderChatMessageWindow).toHaveBeenCalledOnce()
    expect(target.textContent).toContain(committed)
    expect(target.textContent).not.toContain('Pending writer send')
    expect(target.textContent).not.toContain('Pending character name')
    expect(target.textContent).not.toContain('Pending chat name')
    expect(target.textContent).not.toContain('Pending greeting')
    finish(false)
    await settle()
    expect(target.textContent).toContain(committed)
    expect(target.querySelector('[data-reader-read-failed]')).not.toBeNull()
    // A late obsolete rollback cannot change the newer certified reader body.
    const accepted = [
      ...previous.chats[0].message,
      { role: 'user', data: 'Server accepted send', chatId: 'pending-send' },
    ] as Message[]
    hydration.applyServerChatMessagesResource(chatId, accepted, undefined, [])
    if (appended.status === 'ok') appended.rollback()
    await settle()
    expect(charactersResourceState.characters[0].chats[0].message.at(-1)?.data).toBe('Server accepted send')
    expect(target.textContent).toContain('Server accepted send')
    expect(target.textContent).not.toContain('Pending writer send')
  })

  it('keeps committed body and details when a newer sparse shell cannot hydrate, including leave and return', async () => {
    setManagedWriterForTest()
    seedReaderChat(2)
    publishReaderFixtures()
    const previous = JSON.parse(JSON.stringify(charactersResourceState.characters[0])) as character
    const chatId = previous.chats[0].id!
    const committed = previous.chats[0].message[1].data
    demoteClientSession()
    const summary = {
      chaId: previous.chaId,
      name: 'New committed summary name',
      type: 'character',
      __serverCharacterShell: true,
      chatIds: [chatId],
      chatCount: 1,
    } as unknown as character
    applyCharactersResource({
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      revision: 2,
      characters: [summary],
      characterOrder: [],
      currentChar: 0,
    })
    vi.mocked(hydration.hydrateReaderChatMessageWindow).mockResolvedValue(false)
    for (let visit = 0; visit < 2; visit += 1) {
      component = mount(ReaderTranscript, { target, props: { characterId: previous.chaId, chatId } })
      await settle()
      expect(target.textContent).toContain(committed)
      expect(target.querySelector('[data-reader-read-failed]')).not.toBeNull()
      expect(target.textContent).toContain('New committed summary name')
      await unmount(component)
      component = undefined
    }
    applyCharactersResource({
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      revision: 3,
      characters: [{ ...summary, chatIds: [] } as unknown as character],
      characterOrder: [],
      currentChar: 0,
    })
    applyCharactersResource({
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      revision: 4,
      characters: [summary],
      characterOrder: [],
      currentChar: 0,
    })
    expect(hydration.getReaderChatMessageOwnerState(chatId)?.messages).toEqual([])
    component = mount(ReaderTranscript, { target, props: { characterId: previous.chaId, chatId } })
    await settle()
    expect(target.textContent).not.toContain(committed)
  })

  it.each([false, true])('never revives a mounted snapshot after delete/re-add (batched: %s)', async (batched) => {
    const reader = seedReaderChat(2)
    startReader()
    const source = JSON.parse(JSON.stringify(reader)) as character
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.textContent).toContain('Reader message 1')
    const previousObservation = observations.at(-1)!
    vi.mocked(hydration.hydrateReaderChatMessageWindow).mockResolvedValue(false)
    applyCharacterResource({ revision: 2, character: { ...source, chats: [] } })
    if (!batched) {
      await settle()
      expect(target.textContent).not.toContain('Reader message 1')
    }
    applyCharacterResource({
      revision: 3,
      character: { ...source, chats: source.chats.map((chat) => ({ ...chat, message: [] })) },
    })
    await settle()
    expect(previousObservation.stop).toHaveBeenCalledOnce()
    expect(observations.at(-1)!.input.incarnation).not.toBe(previousObservation.input.incarnation)
    previousObservation.input.onChange({
      status: 'watching',
      projection: liveProjection({ text: 'Old incarnation live output' }),
    })
    await settle()
    expect(target.textContent).not.toContain('Old incarnation live output')
    expect(hydration.getReaderChatMessageOwnerState('reader-chat')?.messages).toEqual([])
    expect(target.textContent).not.toContain('Reader message 1')
    hydration.applyServerChatMessagesResource(
      'reader-chat',
      [{ role: 'char', data: 'New incarnation content', chatId: 'new-message' }],
      undefined,
      [],
    )
    await settle()
    expect(target.textContent).toContain('New incarnation content')
  })

  it('uses certified persona bindings and names while newer local edits remain pending', async () => {
    seedReaderChat(1)
    startReader()
    const source = JSON.parse(JSON.stringify(charactersResourceState.characters[1])) as character
    source.chats[0].generationSettings = { personaId: 'persona-a' }
    source.chats[0].message[0].role = 'user'
    hydration.applyServerChatMessagesResource('reader-chat', source.chats[0].message, undefined, [])
    applyCharacterResource({ revision: 2, character: source })
    applyCollectionsResource({
      revision: 2,
      collections: {
        personas: [
          { id: 'persona-a', name: 'Committed persona', icon: '', largePortrait: false, personaPrompt: '' },
          { id: 'persona-b', name: 'Other persona', icon: '', largePortrait: false, personaPrompt: '' },
        ],
      },
    })
    applySettingsGroupResource({ revision: 2, group: 'display', settings: { username: 'Committed user' } }, [
      'username',
    ])
    withTestDatabaseWrite(() => {
      charactersResourceState.characters[1].chats[0].generationSettings = { personaId: 'persona-b' }
      collectionsResourceState.values.personas![0].name = 'Pending persona name'
    })
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.textContent).toContain('Committed persona')
    expect(target.textContent).not.toContain('Other persona')
    expect(target.textContent).not.toContain('Pending persona name')
  })
})
