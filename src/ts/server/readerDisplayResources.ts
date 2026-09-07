import {
  getClientSessionSnapshot,
  canUseClientReadServices,
  captureClientSessionGeneration,
  clientSessionStore,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import { resolveResourceRequirements, type ResourceRequirement } from './resourceManifest'
import { isReaderPersonaReadRequired } from './readerTranscriptProjection.svelte'
import { SERVER_SETTINGS_KEYS_BY_GROUP } from './settingsGroups'
import { peekAppliedServerResourceRevision } from './commands'
import { refreshServerResourceTargets, type ServerResourceTargetRefreshInput } from './resourceInvalidation'
import {
  beginCollectionsResourceLoad,
  beginSettingsGroupResourceLoad,
  beginStandaloneSettingResourceLoad,
  collectionsResourceState,
  failCollectionsResourceLoad,
  failSettingsGroupResourceLoad,
  failStandaloneSettingResourceLoad,
  settingsResourceState,
} from './resourceState.svelte'

type ReadRequirement = Exclude<ResourceRequirement, { kind: 'projection' }>
export type ReaderDisplayResourcesResult = { status: 'ok' | 'unavailable' } | { status: 'error'; error: string }

const requirements = resolveResourceRequirements(['runtime:chat-display']).filter(
  (requirement): requirement is ReadRequirement => requirement.kind !== 'projection',
)

function readerRequirements(): readonly ReadRequirement[] {
  // Username normally arrives in the shell. A compact persona structure
  // receipt can invalidate that value without changing the ordinary manifest.
  return isReaderPersonaReadRequired('username')
    ? [...requirements, { kind: 'settings-group', group: 'account', keys: ['username'], purposes: ['render'] }]
    : requirements
}

function ready(requirement: ReadRequirement): boolean {
  switch (requirement.kind) {
    case 'settings-group':
      return (
        settingsResourceState.groupStatuses[requirement.group] === 'ready' &&
        !SERVER_SETTINGS_KEYS_BY_GROUP[requirement.group].some(isReaderPersonaReadRequired)
      )
    case 'collection':
      return (
        collectionsResourceState.statuses[requirement.collection] === 'ready' &&
        !isReaderPersonaReadRequired(requirement.collection)
      )
    case 'standalone-setting':
      return (
        settingsResourceState.standaloneStatuses[requirement.setting] === 'ready' &&
        !isReaderPersonaReadRequired(requirement.setting)
      )
  }
}

export function readerDisplayResourcesReady(): boolean {
  return readerRequirements().every(ready)
}

function readerCanLoad(): boolean {
  const session = getClientSessionSnapshot()
  return session.managed && session.lifecycle !== 'writing' && canUseClientReadServices()
}

function markLoading(requirement: ReadRequirement): void {
  switch (requirement.kind) {
    case 'settings-group':
      beginSettingsGroupResourceLoad(requirement.group)
      break
    case 'collection':
      beginCollectionsResourceLoad(requirement.collection)
      break
    case 'standalone-setting':
      beginStandaloneSettingResourceLoad(requirement.setting)
      break
  }
}

function markFailed(requirement: ReadRequirement, error: string): void {
  if (ready(requirement)) return
  switch (requirement.kind) {
    case 'settings-group':
      failSettingsGroupResourceLoad(requirement.group, error)
      break
    case 'collection':
      failCollectionsResourceLoad(error, requirement.collection)
      break
    case 'standalone-setting':
      failStandaloneSettingResourceLoad(requirement.setting, error)
      break
  }
}

interface DisplayResourceLoad {
  generation: number
  controller: AbortController
  consumers: Set<symbol>
  promise: Promise<ReaderDisplayResourcesResult>
}
let inFlight: DisplayResourceLoad | null = null
export const READER_DISPLAY_RESOURCE_MAX_ATTEMPTS = 3

function startLoad(generation: number): DisplayResourceLoad {
  const controller = new AbortController()
  const request: DisplayResourceLoad = { generation, controller, consumers: new Set(), promise: null! }
  const current = () => !controller.signal.aborted && isClientSessionGenerationCurrent(generation) && readerCanLoad()
  const stopSession = clientSessionStore.subscribe(() => {
    if (!current()) controller.abort()
  })
  request.promise = (async (): Promise<ReaderDisplayResourcesResult> => {
    try {
      for (let attempt = 0; attempt < READER_DISPLAY_RESOURCE_MAX_ATTEMPTS; attempt += 1) {
        if (!current()) return { status: 'unavailable' }
        const missing = readerRequirements().filter((requirement) => !ready(requirement))
        if (missing.length === 0) return { status: 'ok' }
        const appliedRevision = peekAppliedServerResourceRevision()
        const targets: ServerResourceTargetRefreshInput = {
          settingsGroups: missing.flatMap((value) => (value.kind === 'settings-group' ? [value.group] : [])),
          collections: missing.flatMap((value) => (value.kind === 'collection' ? [value.collection] : [])),
          standaloneSettings: missing.flatMap((value) => (value.kind === 'standalone-setting' ? [value.setting] : [])),
          ...(appliedRevision === null ? {} : { minimumRevision: appliedRevision }),
        }
        missing.forEach(markLoading)
        const result = await refreshServerResourceTargets(targets, {
          mode: 'reader',
          signal: controller.signal,
          // A commit may land while a newly demanded group is still loading.
          // Reject that older batch before apply, then read at the new cursor.
          isCurrent: () => current() && peekAppliedServerResourceRevision() === appliedRevision,
        })
        if (!current()) return { status: 'unavailable' }
        if (readerDisplayResourcesReady()) return { status: 'ok' }
        const remaining = readerRequirements().filter((requirement) => !ready(requirement))
        if (peekAppliedServerResourceRevision() !== appliedRevision || remaining.length < missing.length) continue
        const error = result.status === 'error' ? result.error : 'Reader display resources could not be loaded'
        remaining.forEach((requirement) => markFailed(requirement, error))
        return { status: 'error', error }
      }
      const error = 'Reader display resources kept changing while loading'
      readerRequirements()
        .filter((requirement) => !ready(requirement))
        .forEach((requirement) => markFailed(requirement, error))
      return { status: 'error', error }
    } catch (error) {
      if (!current()) return { status: 'unavailable' }
      const message = error instanceof Error ? error.message : String(error)
      readerRequirements()
        .filter((requirement) => !ready(requirement))
        .forEach((requirement) => markFailed(requirement, message))
      return { status: 'error', error: message }
    } finally {
      stopSession()
      if (inFlight === request) inFlight = null
    }
  })()
  return request
}

/** Demand-load render inputs only. Event synchronization owns revision cursors. */
export function ensureReaderDisplayResources(
  options: { signal?: AbortSignal | null } = {},
): Promise<ReaderDisplayResourcesResult> {
  if (options.signal?.aborted || !readerCanLoad()) return Promise.resolve({ status: 'unavailable' })
  const generation = captureClientSessionGeneration()
  const missing = readerRequirements().filter((requirement) => !ready(requirement))
  if (missing.length === 0) return Promise.resolve({ status: 'ok' })
  if (inFlight && (inFlight.generation !== generation || inFlight.controller.signal.aborted)) {
    inFlight.controller.abort()
    inFlight = null
  }
  const request = (inFlight ??= startLoad(generation))
  const consumer = Symbol('reader-display-resources')
  request.consumers.add(consumer)
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: ReaderDisplayResourcesResult) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', abort)
      request.controller.signal.removeEventListener('abort', abort)
      request.consumers.delete(consumer)
      if (request.consumers.size === 0 && inFlight === request) request.controller.abort()
      resolve(result)
    }
    const abort = () => finish({ status: 'unavailable' })
    options.signal?.addEventListener('abort', abort, { once: true })
    request.controller.signal.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted || request.controller.signal.aborted) {
      abort()
      return
    }
    request.promise.then(finish, () => finish({ status: 'unavailable' }))
  })
}

export function resetReaderDisplayResourcesForTests(): void {
  inFlight?.controller.abort()
  inFlight = null
}
