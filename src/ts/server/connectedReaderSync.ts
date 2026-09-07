import {
  canUseClientReadServices,
  captureClientSessionGeneration,
  clientSessionStore,
  getClientSessionSnapshot,
  isClientSessionGenerationCurrent,
  observeClientWriter,
  setClientConnectionState,
  type ClientSessionOwnership,
} from '../clientSession'
import { peekObserverRouteIntent } from '../observerRouteIntent'
import { fetchServerBootstrapReadOnly } from './bootstrap'
import {
  peekAppliedServerResourceRevision,
  setAppliedServerResourceRevision,
  setCachedServerCommandRevision,
  type CommandEvent,
} from './commands'
import { subscribeServerCommandEvents, type ServerWriterEvent } from './events'
import { subscribeBrowserLifecycleRecovery } from './lifecycleRecovery'
import {
  refreshAllServerResources,
  refreshInvalidatedServerResources,
  type ServerResourceInvalidationHooks,
  type ServerResourceRefreshResult,
} from './resourceInvalidation'
import { applyServerChatMessagesResource, resetChatHydration } from './chatMessageHydration.svelte'
import { clearCharacterShellHydrationState } from './characterShellHydration.svelte'
import {
  applyServerCharacterLorebookResource,
  markCharacterLorebookHydrated,
  resetLorebookHydration,
} from './lorebookOwner.svelte'
import { clearActiveMessageTranslation } from './messageTranslationJobs'
import {
  applyGreetingTranslationProjection,
  fetchGreetingTranslationProjection,
  getGreetingTranslationProjection,
} from './greetingTranslations.svelte'
import { charactersResourceState } from './resourceState.svelte'
import { applyServerMemoryJobEvent, applyServerMemoryJobSnapshot } from './memoryJobProjection.svelte'
import { publishServerBardWikiJobEvent, publishServerBardWikiJobSnapshot } from './bardWikiJobEvents'

export interface ConnectedReaderSyncOptions {
  onAuthLoss(): void | Promise<void>
  onLineageChange(ownership: ClientSessionOwnership): void | Promise<void>
  onWriterEvent?(writer: ServerWriterEvent): void
  /** Restore local stable route IDs and hydrate visible read bodies after replacement. */
  onProjectionRefreshed?(result: Extract<ServerResourceRefreshResult, { status: 'ok' }>): void | Promise<void>
}

export interface ConnectedReaderSync {
  stop(): void
  retry(): void
  /** The first connection attempt has settled; later recovery is automatic. */
  ready: Promise<void>
}

export const CONNECTED_READER_STALE_TIMEOUT_MS = 60_000

export function calculateConnectedReaderReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const normalizedAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0
  const value = random()
  const jitter = Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.5
  return Math.min(
    30_000,
    Math.max(1, Math.round(Math.min(30_000, 1000 * 2 ** normalizedAttempt) * (0.8 + jitter * 0.4))),
  )
}

/** A reader owns only authenticated reads, projection application, and its event stream. */
export function startConnectedReaderSync(options: ConnectedReaderSyncOptions): ConnectedReaderSync {
  const generation = captureClientSessionGeneration()
  const lineage = getClientSessionSnapshot().databaseLineage
  let stopped = false
  let epoch = 0
  let attempt = 0
  let controller: AbortController | null = null
  let unsubscribe: (() => void) | null = null
  let stopLifecycle: (() => void) | null = null
  let stopSession: (() => void) | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null
  let chain = Promise.resolve()
  let memoryStream: string | null = null
  let memoryVersion = -1
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const current = (sourceEpoch = epoch): boolean => {
    const state = getClientSessionSnapshot()
    return (
      !stopped &&
      sourceEpoch === epoch &&
      state.managed &&
      canUseClientReadServices() &&
      isClientSessionGenerationCurrent(generation) &&
      state.databaseLineage === lineage &&
      (state.lifecycle === 'reading' || state.lifecycle === 'promoting')
    )
  }

  function teardownStream(): void {
    controller?.abort()
    controller = null
    unsubscribe?.()
    unsubscribe = null
    if (watchdogTimer) clearTimeout(watchdogTimer)
    watchdogTimer = null
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    epoch += 1
    teardownStream()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    stopLifecycle?.()
    stopLifecycle = null
    stopSession?.()
    stopSession = null
    resolveReady()
  }

  async function notifyAuthLoss(): Promise<void> {
    stop()
    try {
      await options.onAuthLoss()
    } catch (error) {
      console.warn('Reader authentication reset failed', error)
    }
  }

  function interrupt(sourceEpoch: number): void {
    if (!current(sourceEpoch)) return
    teardownStream()
    // Fence callbacks already queued by this stream, including completed reads.
    epoch += 1
    setClientConnectionState('interrupted', generation)
    if (!current() || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, calculateConnectedReaderReconnectDelayMs(attempt++))
  }

  function frame(sourceEpoch: number): void {
    if (!current(sourceEpoch)) return
    if (watchdogTimer) clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(() => interrupt(sourceEpoch), CONNECTED_READER_STALE_TIMEOUT_MS)
  }

  function enqueue(sourceEpoch: number, task: () => Promise<void>): void {
    chain = chain
      .then(async () => {
        if (current(sourceEpoch)) await task()
      })
      .catch((error) => {
        if (!current(sourceEpoch)) return
        console.warn('Reader resource synchronization failed', error)
        interrupt(sourceEpoch)
      })
  }

  async function checkOwnership(sourceEpoch: number, signal: AbortSignal): Promise<boolean> {
    const result = await fetchServerBootstrapReadOnly(signal, { cacheRevision: false })
    if (!current(sourceEpoch)) return false
    if (result.status !== 'ok') {
      if (result.status === 'error' && result.httpStatus === 401) notifyAuthLoss()
      else interrupt(sourceEpoch)
      return false
    }
    const runtime = result.bootstrap
    if (!runtime.initialized || !runtime.databaseLineage || !runtime.writer) {
      interrupt(sourceEpoch)
      return false
    }
    const ownership = { databaseLineage: runtime.databaseLineage, writer: runtime.writer }
    if (ownership.databaseLineage !== lineage) {
      stop()
      await options.onLineageChange(ownership)
      return false
    }
    if (!observeClientWriter(runtime.writer)) {
      interrupt(sourceEpoch)
      return false
    }
    if (!current(sourceEpoch)) return false
    options.onWriterEvent?.(runtime.writer)
    if (!current(sourceEpoch)) return false
    setCachedServerCommandRevision(runtime.revision)
    return current(sourceEpoch)
  }

  function refreshOptions(sourceEpoch: number, signal: AbortSignal) {
    const isCurrent = () => current(sourceEpoch) && !signal.aborted
    const hooks: Partial<ServerResourceInvalidationHooks> = {
      applyChatMessages: applyServerChatMessagesResource,
      applyCharacterLorebook: applyServerCharacterLorebookResource,
      markCharacterLorebookHydrated,
      clearActiveMessageTranslation,
      refreshGreetingTranslations: async (characterId, minimumRevision) => {
        const character = charactersResourceState.characters.find((candidate) => candidate.chaId === characterId)
        if (!character) return true
        const route = peekObserverRouteIntent()?.route
        // A greeting result belongs to a concrete chat; never clear a usable value before its read succeeds.
        for (const chat of character.chats ?? []) {
          if (!chat.id || !isCurrent()) return false
          const visible = route?.kind === 'character' && route.chaId === characterId && route.chatId === chat.id
          if (!visible && !getGreetingTranslationProjection(characterId, chat.id)) continue
          const result = await fetchGreetingTranslationProjection(characterId, chat.id, undefined, signal)
          if (!isCurrent()) return false
          if (result.status !== 'ok') {
            await checkOwnership(sourceEpoch, signal)
            return false
          }
          if (result.revision < minimumRevision) return false
          applyGreetingTranslationProjection(result)
        }
        return true
      },
    }
    return {
      mode: 'reader' as const,
      signal,
      isCurrent,
      hooks,
      onFullProjectionApplied: () => {
        if (!isCurrent()) return
        clearCharacterShellHydrationState()
        resetChatHydration()
        resetLorebookHydration()
      },
    }
  }

  async function finishRefresh(sourceEpoch: number, result: ServerResourceRefreshResult): Promise<boolean> {
    if (!current(sourceEpoch)) return false
    if (result.status !== 'ok') {
      interrupt(sourceEpoch)
      return false
    }
    await options.onProjectionRefreshed?.(result)
    if (!current(sourceEpoch)) return false
    setCachedServerCommandRevision(result.revision)
    setAppliedServerResourceRevision(result.revision)
    return true
  }

  async function refreshFull(sourceEpoch: number, signal: AbortSignal, minimumRevision = 0): Promise<boolean> {
    if (!(await checkOwnership(sourceEpoch, signal))) return false
    const result = await refreshAllServerResources(refreshOptions(sourceEpoch, signal))
    return finishRefresh(
      sourceEpoch,
      result.status === 'ok' && result.revision < minimumRevision
        ? { status: 'error', error: 'Reader snapshot is older than its invalidating event' }
        : result,
    )
  }

  async function command(sourceEpoch: number, signal: AbortSignal, event: CommandEvent): Promise<void> {
    if (event.databaseLineage && event.databaseLineage !== lineage) {
      await checkOwnership(sourceEpoch, signal)
      return
    }
    if (event.type === 'state.restored' || event.type === 'state.imported') {
      await refreshFull(sourceEpoch, signal, event.revision)
      return
    }
    const appliedRevision = peekAppliedServerResourceRevision()
    if (appliedRevision !== null && event.revision <= appliedRevision) return
    if (appliedRevision === null || event.revision > appliedRevision + 1) {
      await refreshFull(sourceEpoch, signal, event.revision)
      return
    }
    await finishRefresh(
      sourceEpoch,
      await refreshInvalidatedServerResources(event, {
        ...refreshOptions(sourceEpoch, signal),
        appliedRevision,
      }),
    )
  }

  function acceptMemoryVersion(sourceEpoch: number, streamId: string, version: number, snapshot = false): boolean {
    if (!current(sourceEpoch)) return false
    if (snapshot) {
      if (memoryStream === streamId && version < memoryVersion) return false
      memoryStream = streamId
      memoryVersion = version
      return true
    }
    if (memoryStream !== streamId || version <= memoryVersion) return false
    memoryVersion = version
    return true
  }

  async function connect(): Promise<void> {
    if (!current()) return
    teardownStream()
    const sourceEpoch = ++epoch
    controller = new AbortController()
    const signal = controller.signal
    setClientConnectionState('connecting', generation)
    try {
      if (!(await checkOwnership(sourceEpoch, signal))) return
      const result = await subscribeServerCommandEvents({
        mode: 'reader',
        signal,
        sinceRevision: peekAppliedServerResourceRevision(),
        onCommandEvent: (event) => {
          if (!current(sourceEpoch)) return
          if (!event.databaseLineage || event.databaseLineage === lineage)
            setCachedServerCommandRevision(event.revision)
          enqueue(sourceEpoch, () => command(sourceEpoch, signal, event))
        },
        onWriterEvent: (writer) => {
          if (!current(sourceEpoch)) return
          if (observeClientWriter(writer) && current(sourceEpoch)) options.onWriterEvent?.(writer)
        },
        onMemorySnapshot: (snapshot) => {
          if (!acceptMemoryVersion(sourceEpoch, snapshot.streamId, snapshot.version, true)) return
          applyServerMemoryJobSnapshot(snapshot)
          if (current(sourceEpoch))
            publishServerBardWikiJobSnapshot({
              streamId: snapshot.streamId,
              version: snapshot.version,
              jobs: snapshot.bardWikiJobs,
            })
        },
        onMemoryEvent: (event) => {
          if (acceptMemoryVersion(sourceEpoch, event.streamId, event.version)) applyServerMemoryJobEvent(event)
        },
        onBardWikiEvent: (event) => {
          if (acceptMemoryVersion(sourceEpoch, event.streamId, event.version)) publishServerBardWikiJobEvent(event)
        },
        onFrame: () => frame(sourceEpoch),
        onClose: () => interrupt(sourceEpoch),
        onError: (error) => {
          if (!current(sourceEpoch)) return
          if (error.includes('Malformed command event frame')) {
            setClientConnectionState('interrupted', generation)
            enqueue(sourceEpoch, async () => {
              await refreshFull(sourceEpoch, signal)
              interrupt(sourceEpoch)
            })
          } else interrupt(sourceEpoch)
        },
      })
      if (!current(sourceEpoch)) {
        if (result.status === 'ok') result.unsubscribe()
        return
      }
      if (result.status === 'ok') {
        unsubscribe = result.unsubscribe
        attempt = 0
        frame(sourceEpoch)
        setClientConnectionState('live', generation)
      } else if (result.status === 'error' && result.httpStatus === 401) {
        notifyAuthLoss()
      } else if (result.status === 'replay-unavailable') {
        setClientConnectionState('interrupted', generation)
        enqueue(sourceEpoch, async () => {
          await refreshFull(sourceEpoch, signal)
          interrupt(sourceEpoch)
        })
      } else interrupt(sourceEpoch)
    } catch (error) {
      if (current(sourceEpoch)) {
        console.warn('Reader event connection failed', error)
        interrupt(sourceEpoch)
      }
    } finally {
      resolveReady()
    }
  }

  function retry(): void {
    if (!current()) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    void connect()
  }

  if (current() && lineage) {
    stopSession = clientSessionStore.subscribe((state) => {
      if (stopped) return
      if (state.lifecycle === 'auth-required') notifyAuthLoss()
      else if (!current()) stop()
    })
    stopLifecycle = subscribeBrowserLifecycleRecovery(retry)
    void connect()
  } else stop()
  return { stop, retry, ready }
}
