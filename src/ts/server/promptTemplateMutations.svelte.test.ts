import { demoteClientSession, resetClientSessionForTests } from '../clientSession'
import { enterClientWriter, repromoteClientWriter } from '../__tests__/clientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

const commandState = vi.hoisted(() => ({
  revision: 1 as number | null,
  commands: [] as Array<{
    built: Record<string, unknown>
    rollback?: () => void
    keepalive?: boolean
  }>,
  beforeBuild: null as (() => void) | null,
  runResults: [] as Array<Promise<{ status: string; error?: string }>>,
  transports: [] as Array<{ mutationId?: string; databaseLineage?: string }>,
}))

const durableState = vi.hoisted(() => ({
  nextId: 0,
  stages: [] as Array<{ key: string; intent: Record<string, unknown>; handle: Record<string, any> }>,
  dispatches: [] as Array<{ handle: Record<string, any>; intent: Record<string, unknown> }>,
  acknowledgements: [] as Array<Record<string, any>>,
  retainFailures: false,
  settlementListeners: new Map<string, Set<(settlement: 'accepted' | 'discarded') => void>>(),
}))

const commandMocks = vi.hoisted(() => ({
  canUseServerCommands: () => true,
  patchPromptSettingsCommand: vi.fn(
    async (args: Record<string, unknown>): Promise<Record<string, unknown>> => ({
      kind: 'patchPromptSettings',
      ...args,
    }),
  ),
  peekCachedServerCommandRevision: () => commandState.revision,
  runServerCommand: vi.fn(
    async (args: {
      command: (baseRevision: number) => Promise<Record<string, unknown>>
      rollback?: () => void
      keepalive?: boolean
      mutationId?: string
      databaseLineage?: string
      failureRollbackDisposition?: (result: { status: string; error?: string }) => 'retain' | 'rollback'
    }) => {
      const beforeBuild = commandState.beforeBuild
      commandState.beforeBuild = null
      beforeBuild?.()
      const built = await args.command(1)
      if (built.status && built.status !== 'ok') {
        args.rollback?.()
        return built
      }
      commandState.commands.push({
        built,
        rollback: args.rollback,
        ...(args.keepalive ? { keepalive: args.keepalive } : {}),
      })
      commandState.transports.push({
        mutationId: args.mutationId,
        databaseLineage: args.databaseLineage,
      })
      const queuedResult = commandState.runResults.shift()
      const result = queuedResult ? await queuedResult : { status: 'ok', revision: 1 }
      if (result.status !== 'ok' && args.failureRollbackDisposition?.(result) !== 'retain') args.rollback?.()
      return result
    },
  ),
  updatePromptItemCommand: vi.fn(async (args: Record<string, unknown>) => {
    const { optimisticAcknowledgement: _optimisticAcknowledgement, ...request } = args
    return {
      kind: 'updatePromptItem',
      ...request,
    }
  }),
  createPromptItemCommand: vi.fn(async (args: Record<string, unknown>) => ({
    kind: 'createPromptItem',
    ...args,
  })),
  deletePromptItemCommand: vi.fn(async (args: Record<string, unknown>) => ({
    kind: 'deletePromptItem',
    ...args,
  })),
  reorderPromptItemsCommand: vi.fn(async (args: Record<string, unknown>) => ({
    kind: 'reorderPromptItems',
    ...args,
  })),
  updatePromptPresetCommand: vi.fn(async (args: Record<string, unknown>) => ({
    kind: 'updatePromptPreset',
    ...args,
  })),
  updateModelPresetCommand: vi.fn(async (args: Record<string, unknown>) => ({
    kind: 'updateModelPreset',
    ...args,
  })),
  patchServerBackedSettings: vi.fn(
    async (args: {
      patch: Record<string, unknown>
      acknowledgeOptimistic?: boolean
      optimisticProjectionEpochs?: Record<string, number>
      rollback?: () => void
      keepalive?: boolean
      mutationId?: string
      databaseLineage?: string
      failureRollbackDisposition?: (result: { status: string; error?: string }) => 'retain' | 'rollback'
    }) => {
      const built = {
        kind: 'patchServerBackedSettings',
        patch: args.patch,
        acknowledgeOptimistic: args.acknowledgeOptimistic,
        optimisticProjectionEpochs: args.optimisticProjectionEpochs,
      }
      commandState.commands.push({
        built,
        rollback: args.rollback,
        ...(args.keepalive ? { keepalive: args.keepalive } : {}),
      })
      commandState.transports.push({
        mutationId: args.mutationId,
        databaseLineage: args.databaseLineage,
      })
      const queuedResult = commandState.runResults.shift()
      const result = queuedResult ? await queuedResult : { status: 'ok', revision: 1 }
      if (result.status !== 'ok' && args.failureRollbackDisposition?.(result) !== 'retain') args.rollback?.()
      return result
    },
  ),
  patchSettingsObjectFieldsCommand: vi.fn(async () => ({ status: 'unavailable' })),
  completeOnboardingCommand: vi.fn(async () => ({ status: 'unavailable' })),
  settingsGroupForKey: () => 'prompt',
  enablePromptItemsCommand: vi.fn(async (args: Record<string, unknown>) => ({
    kind: 'enablePromptItems',
    ...args,
  })),
}))

const hydrationState = vi.hoisted(() => {
  let hydrated = true
  let ownerId: string | null = null
  let hydratedOwnerId: string | null | undefined = undefined
  let version = 0
  const subscribers = new Set<(value: { hydratedOwnerIds: ReadonlySet<string | null>; version: number }) => void>()
  const ownerEpochs = new Map<string | null, number>()
  const taintedOwners = new Set<string | null>()
  const selectedFallbacks = new Map<string, unknown[]>()
  const hydrationSnapshot = () => ({
    hydratedOwnerIds: new Set<string | null>(hydrated ? [hydratedOwnerId ?? ownerId] : []),
    version,
  })
  return {
    ensure: vi.fn(
      async (options?: { force?: boolean; promptPresetId?: string | null }) =>
        hydrated &&
        (hydratedOwnerId === undefined ||
          hydratedOwnerId === (options?.promptPresetId === undefined ? ownerId : options.promptPresetId)),
    ),
    isHydrated: (promptPresetId: string | null = ownerId) =>
      hydrated && (hydratedOwnerId === undefined || hydratedOwnerId === promptPresetId),
    currentOwner: () => ownerId,
    captureOwnerEpoch: (owner: string | null = ownerId) => ownerEpochs.get(owner) ?? 0,
    hasOwnerEpochChanged: (owner: string | null, epoch: number) => (ownerEpochs.get(owner) ?? 0) !== epoch,
    advanceOwnerEpoch: (owner: string | null) => ownerEpochs.set(owner, (ownerEpochs.get(owner) ?? 0) + 1),
    resetOwnerEpochs: () => ownerEpochs.clear(),
    isTainted: (owner: string | null) => taintedOwners.has(owner),
    markTainted: (owner: string | null) => taintedOwners.add(owner),
    resetTaints: () => taintedOwners.clear(),
    usesSelectedFallback: (owner: string | null = ownerId) => owner !== null && selectedFallbacks.has(owner),
    cloneSelectedFallback: (owner: string | null = ownerId) => {
      const fallback = owner === null ? undefined : selectedFallbacks.get(owner)
      return fallback === undefined ? undefined : JSON.parse(JSON.stringify(fallback))
    },
    setSelectedFallback: (owner: string, fallback: unknown[]) => {
      selectedFallbacks.set(owner, JSON.parse(JSON.stringify(fallback)))
    },
    resetSelectedFallbacks: () => selectedFallbacks.clear(),
    setOwner: (value: string | null) => {
      ownerId = value
    },
    setHydrated: (value: boolean, owner?: string | null) => {
      hydrated = value
      hydratedOwnerId = owner
      version += 1
      const snapshot = hydrationSnapshot()
      for (const subscriber of subscribers) subscriber(snapshot)
    },
    store: {
      subscribe: (run: (value: { hydratedOwnerIds: ReadonlySet<string | null>; version: number }) => void) => {
        run(hydrationSnapshot())
        subscribers.add(run)
        return () => subscribers.delete(run)
      },
    },
  }
})

vi.mock('./commands', () => commandMocks)
vi.mock('src/ts/server/commands', () => commandMocks)

const pendingMutationOutboxMock = vi.hoisted(() => ({
  stagePendingMutation: (key: string, intent: Record<string, unknown>, previous?: Record<string, any> | null) => {
    const reuse = previous?.phase === 'staged' && previous.key === key
    if (reuse) previous.phase = 'superseded'
    const handle = {
      key,
      mutationId: reuse ? previous!.mutationId : `prompt-mutation-${++durableState.nextId}`,
      phase: 'staged',
    }
    durableState.stages.push({ key, intent: JSON.parse(JSON.stringify(intent)), handle })
    return handle
  },
  acknowledgePendingMutation: async (handle: Record<string, any>) => {
    durableState.acknowledgements.push(handle)
    return 'deleted'
  },
}))

const durableMutationDispatchMock = vi.hoisted(() => ({
  registerDurableMutationSettlementListener: (
    mutationId: string,
    listener: (settlement: 'accepted' | 'discarded') => void,
  ) => {
    const listeners = durableState.settlementListeners.get(mutationId) ?? new Set()
    listeners.add(listener)
    durableState.settlementListeners.set(mutationId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) durableState.settlementListeners.delete(mutationId)
    }
  },
  dispatchDurableMutation: async (
    handle: Record<string, any>,
    intent: Record<string, unknown>,
    dispatch: (transport: {
      mutationId: string
      databaseLineage: string
      failureRollbackDisposition: () => 'retain' | 'rollback'
    }) => Promise<unknown>,
  ) => {
    handle.phase = 'dispatching'
    durableState.dispatches.push({ handle, intent: JSON.parse(JSON.stringify(intent)) })
    return dispatch({
      mutationId: handle.mutationId,
      databaseLineage: 'test-lineage',
      failureRollbackDisposition: () => (durableState.retainFailures ? 'retain' : 'rollback'),
    })
  },
}))

vi.mock('./pendingMutationOutbox', () => pendingMutationOutboxMock)
vi.mock('src/ts/server/pendingMutationOutbox', () => pendingMutationOutboxMock)
vi.mock('./durableMutationDispatch', () => durableMutationDispatchMock)
vi.mock('src/ts/server/durableMutationDispatch', () => durableMutationDispatchMock)

vi.mock('./promptTemplateHydration', () => ({
  capturePromptTemplateOwnerProjectionEpoch: hydrationState.captureOwnerEpoch,
  clonePromptTemplateSelectedFallback: hydrationState.cloneSelectedFallback,
  currentPromptTemplateOwnerId: hydrationState.currentOwner,
  hasPromptTemplateOwnerProjectionEpochChanged: hydrationState.hasOwnerEpochChanged,
  ensurePromptTemplateHydrated: hydrationState.ensure,
  isPromptTemplateHydrated: hydrationState.isHydrated,
  isPromptTemplateHydratedInState: (_state: unknown, owner?: string | null) => hydrationState.isHydrated(owner),
  markPromptTemplateOwnerAcknowledgementTainted: hydrationState.markTainted,
  promptTemplateOwnerUsesSelectedFallback: hydrationState.usesSelectedFallback,
  peekPromptTemplateOwnerRevision: () => null,
  promptTemplateHydrationStateStore: hydrationState.store,
}))
vi.mock('src/ts/server/promptTemplateHydration', () => ({
  capturePromptTemplateOwnerProjectionEpoch: hydrationState.captureOwnerEpoch,
  clonePromptTemplateSelectedFallback: hydrationState.cloneSelectedFallback,
  currentPromptTemplateOwnerId: hydrationState.currentOwner,
  hasPromptTemplateOwnerProjectionEpochChanged: hydrationState.hasOwnerEpochChanged,
  ensurePromptTemplateHydrated: hydrationState.ensure,
  isPromptTemplateHydrated: hydrationState.isHydrated,
  isPromptTemplateHydratedInState: (_state: unknown, owner?: string | null) => hydrationState.isHydrated(owner),
  markPromptTemplateOwnerAcknowledgementTainted: hydrationState.markTainted,
  promptTemplateOwnerUsesSelectedFallback: hydrationState.usesSelectedFallback,
  peekPromptTemplateOwnerRevision: () => null,
  promptTemplateHydrationStateStore: hydrationState.store,
}))

import type { PromptItem, PromptSettings as PromptSettingsFixture } from '../process/prompt'
import type { Database } from '../storage/database.svelte'
import { withCloneInstrumentation } from '../__tests__/cloneCostHarness'
import {
  applyCollectionsResource,
  applySettingsGroupResource,
  captureSettingsGroupProjectionEpoch,
  isServerCollectionName,
  isSettingsGroupAcknowledgementTainted,
  replaceResourceDatabase,
} from './resourceState.svelte'
import { SERVER_SETTINGS_GROUP_BY_KEY } from './settingsGroups'
import PromptSettings from 'src/lib/Setting/Pages/PromptSettings.svelte'
import { language } from 'src/lang'
import { notifyServerCommandLocalEffectApplied } from './commandLocalEffectEvents'
import {
  createPromptItemCommand,
  deletePromptItemCommand,
  enablePromptItemsCommand,
  reorderPromptItemsCommand,
  type PromptItemOptimisticAcknowledgement,
  type PromptItemSnapshot,
} from './commands'
import { queuePromptItemProjectionUpdate as queuePromptItemProjectionUpdateForPromptSettings } from 'src/ts/server/promptTemplateMutations.svelte'
import {
  applyPromptItemProjectionWrite,
  capturePromptTemplateOwnerMutationFence,
  cloneJsonValue,
  commitPendingPromptTemplateMutations,
  queuePromptItemProjectionUpdate,
  queuePromptSettingsProjectionPatch,
  reconcilePromptTemplateDraft,
  reapplyPendingPromptTemplateStructuralProjections,
  resetPendingPromptTemplateStructuralMutationsForTests,
  resetPromptTemplateSelectionDirtyState,
  promptTemplateOwnerCommandId,
  restorePromptItemProjectionWrite,
  rollbackFailedPromptTemplateItemCreate,
  rollbackFailedPromptTemplateItemDelete,
  rollbackFailedPromptTemplateItemReorder,
  runPromptTemplateOwnerCommand,
  runPromptTemplateOwnerRollback,
  snapshotJson,
  stagePromptItemDeleteMutation,
  type PromptTemplateDraftBinding,
} from './promptTemplateMutations.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

const BIG = 'x'.repeat(5000)
type MountedComponent = Parameters<typeof unmount>[0]

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function publishPromptTemplateStructuralSettlement(mutationId: string, settlement: 'accepted' | 'discarded'): void {
  for (const listener of durableState.settlementListeners.get(mutationId) ?? []) listener(settlement)
}

const resourceDatabase = {
  set current(value: unknown) {
    replaceResourceDatabase(value as Database)
  },
}

const minimalPromptSettings: PromptSettingsFixture = {
  assistantPrefill: '',
  postEndInnerFormat: '',
  sendChatAsSystem: false,
  sendName: false,
  utilOverride: false,
}

function item(id: string, text: string): PromptItem {
  return { id, type: 'plain', type2: 'normal', role: 'system', text } as PromptItem
}

function promptItemSnapshot(id: string, text: string): PromptItemSnapshot {
  return { id, type: 'plain', type2: 'normal', role: 'system', text }
}

function promptItemFixture(value: Record<string, unknown>): PromptItem {
  return value as unknown as PromptItem
}

// `text` lives on the plain/jailbreak/cot/chatML PromptItem variants; the seed
// uses plain items, so read it through a narrow cast in assertions.
function textOf(value: PromptItem | undefined): string | undefined {
  return (value as { text?: string } | undefined)?.text
}

// One tiny edited item plus several large items, so a single-item clone is
// distinguishable from a whole-`promptTemplate` clone by serialized size.
function seedTemplate(): void {
  const template = [item('p-0', 'small'), item('p-1', BIG), item('p-2', BIG), item('p-3', BIG)]
  resourceDatabase.current = {
    promptTemplate: template,
    promptPresetsId: 0,
    promptPresets: [{ id: 'prompt-a', promptTemplate: cloneJsonValue(template) }],
  }
}

function durableStageByRequestPath(path: string) {
  return durableState.stages.find(({ intent }) => {
    const requests = intent.requests as Array<{ path?: string }> | undefined
    return requests?.some((request) => request.path === path)
  })
}

function draftCopy(): PromptItem[] {
  return cloneJsonValue((getResourceDatabase().promptTemplate ?? []) as PromptItem[])
}

function draftBindingFor(
  getDraftItems: () => PromptItem[],
  setDraftItems: (items: PromptItem[]) => void,
): PromptTemplateDraftBinding {
  return {
    getItems: getDraftItems,
    setItems: setDraftItems,
  }
}

async function flushPromptItemDirtyTestState(draftItems: PromptItem[]): Promise<void> {
  getResourceDatabase().promptTemplate = cloneJsonValue(draftItems)
  commitPendingPromptTemplateMutations()
  await Promise.resolve()
  await Promise.resolve()
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function seedPromptSettings(overrides: Record<string, unknown> = {}): void {
  resourceDatabase.current = {
    promptTemplate: [],
    promptSettings: { ...minimalPromptSettings },
    customPromptTemplateToggle: 'server old',
    templateDefaultVariables: '',
    OAIPrediction: '',
    autoSuggestPrompt: '',
    systemContentReplacement: '',
    systemRoleReplacement: 'user',
    jsonSchemaEnabled: false,
    outputImageModal: false,
    strictJsonSchema: false,
    fallbackModels: {
      model: [],
      memory: [],
      translate: [],
      emotion: [],
      otherAx: [],
      scriptMain: [],
      scriptAux: [],
    },
    fallbackWhenBlankResponse: false,
    doNotChangeFallbackModels: false,
    ...overrides,
  }
}

async function mountPromptSettingsComponent(target: HTMLElement): Promise<MountedComponent> {
  const component = mount(PromptSettings, {
    target,
    props: { mode: 'inline', subMenu: 1 },
  })
  await tick()
  await flushMicrotasks()
  await tick()
  return component
}

interface PromptDragTransfer {
  types: string[]
  getData: (type: string) => string
  setData: (type: string, value: string) => void
  setDragImage: ReturnType<typeof vi.fn>
}

function createPromptDragTransfer(): PromptDragTransfer {
  const data = new Map<string, string>()
  const types: string[] = []
  return {
    types,
    getData: (type) => data.get(type) ?? '',
    setData: (type, value) => {
      data.set(type, value)
      if (!types.includes(type)) types.push(type)
    },
    setDragImage: vi.fn(),
  }
}

function promptRowToggle(target: HTMLElement, name: string): HTMLButtonElement {
  const toggle = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === name,
  )
  expect(toggle).toBeTruthy()
  return toggle!
}

function promptRowDragHandle(target: HTMLElement, name: string): HTMLElement {
  const handle = promptRowToggle(target, name).closest<HTMLElement>('[draggable="true"]')
  expect(handle).toBeTruthy()
  return handle!
}

function promptRowDropTarget(target: HTMLElement, name: string): HTMLElement {
  const dropTarget = promptRowDragHandle(target, name).parentElement
  expect(dropTarget).toBeTruthy()
  return dropTarget!
}

function dispatchPromptDragEvent(
  target: HTMLElement,
  type: 'dragstart' | 'dragover' | 'drop',
  dataTransfer: PromptDragTransfer,
  clientY = 0,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    clientY: { value: clientY },
    dataTransfer: { value: dataTransfer },
  })
  target.dispatchEvent(event)
}

function hoverPromptRowAfter(target: HTMLElement, name: string, dataTransfer: PromptDragTransfer): void {
  const row = promptRowDropTarget(target, name)
  row.getBoundingClientRect = () => ({ top: 0, height: 100 }) as DOMRect
  dispatchPromptDragEvent(row, 'dragover', dataTransfer, 75)
}

function promptSettingsTextarea(target: HTMLElement, index = 0): HTMLTextAreaElement {
  const textarea = target.querySelectorAll<HTMLTextAreaElement>('textarea').item(index)
  expect(textarea).toBeTruthy()
  return textarea!
}

function promptSettingsTextInput(target: HTMLElement, index = 0): HTMLInputElement {
  const input = target.querySelectorAll<HTMLInputElement>('input[type="text"]').item(index)
  expect(input).toBeTruthy()
  return input!
}

async function editPromptSettingsTextarea(target: HTMLElement, value: string, index = 0): Promise<void> {
  const textarea = promptSettingsTextarea(target, index)
  textarea.value = value
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  await flushMicrotasks()
  await tick()
}

async function editPromptSettingsTextInput(target: HTMLElement, value: string, index = 0): Promise<void> {
  const input = promptSettingsTextInput(target, index)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  await flushMicrotasks()
  await tick()
}

async function applyPromptSettingsProjection(apply: () => void): Promise<void> {
  const before = getResourceDatabase({ snapshot: true }) as unknown as Record<string, unknown>
  apply()
  const after = getResourceDatabase({ snapshot: true }) as unknown as Record<string, unknown>
  const changedKeys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  )
  const revision = ++promptSettingsProjectionRevision
  let promptSettingsChanged = false

  for (const key of changedKeys) {
    if (isServerCollectionName(key)) {
      applyCollectionsResource(
        {
          revision,
          collections: Object.prototype.hasOwnProperty.call(after, key) ? ({ [key]: after[key] } as never) : {},
        },
        key,
      )
    } else if (SERVER_SETTINGS_GROUP_BY_KEY[key] === 'prompt') {
      promptSettingsChanged = true
    }
  }
  if (promptSettingsChanged) {
    applySettingsGroupResource(
      {
        revision,
        group: 'prompt',
        settings: {},
      },
      [],
    )
  }
  await tick()
  await flushMicrotasks()
  await tick()
}

let promptSettingsProjectionRevision = 10_000

beforeEach(() => {
  resetClientSessionForTests()
  vi.useFakeTimers()
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  )
  commandState.revision = 1
  commandState.commands.length = 0
  commandState.beforeBuild = null
  commandState.runResults.length = 0
  commandState.transports.length = 0
  durableState.nextId = 0
  durableState.stages.length = 0
  durableState.dispatches.length = 0
  durableState.acknowledgements.length = 0
  durableState.retainFailures = false
  durableState.settlementListeners.clear()
  resetPendingPromptTemplateStructuralMutationsForTests()
  commandMocks.patchPromptSettingsCommand.mockClear()
  commandMocks.updatePromptItemCommand.mockClear()
  commandMocks.createPromptItemCommand.mockClear()
  commandMocks.deletePromptItemCommand.mockClear()
  commandMocks.reorderPromptItemsCommand.mockClear()
  commandMocks.enablePromptItemsCommand.mockClear()
  commandMocks.updatePromptPresetCommand.mockClear()
  commandMocks.updateModelPresetCommand.mockClear()
  commandMocks.patchServerBackedSettings.mockClear()
  commandMocks.runServerCommand.mockClear()
  hydrationState.setHydrated(true)
  hydrationState.setOwner(null)
  hydrationState.resetOwnerEpochs()
  hydrationState.resetTaints()
  hydrationState.resetSelectedFallbacks()
  hydrationState.ensure.mockClear()
  hydrationState.ensure.mockImplementation(async (options?: { force?: boolean; promptPresetId?: string | null }) =>
    hydrationState.isHydrated(
      options?.promptPresetId === undefined ? hydrationState.currentOwner() : options.promptPresetId,
    ),
  )
})

afterEach(() => {
  resetClientSessionForTests()
  resetPendingPromptTemplateStructuralMutationsForTests()
  durableState.settlementListeners.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resourceDatabase.current = {}
})

describe('applyPromptItemProjectionWrite', () => {
  it('mirrors only the edited item into the projection without a whole-array clone', () => {
    seedTemplate()
    const draft = draftCopy()
    draft[0] = item('p-0', 'edited')

    const instrumented = withCloneInstrumentation(() => applyPromptItemProjectionWrite(draft, 'p-0'))

    // The clone is one tiny item, never the multi-item array of large bodies.
    expect(instrumented.maxClonedSize).toBeLessThan(BIG.length)
    expect(instrumented.result).toEqual(item('p-0', 'edited'))
    expect((getResourceDatabase().promptTemplate as PromptItem[])[0]).toEqual(item('p-0', 'edited'))
    // Unrelated large items are untouched.
    expect(textOf((getResourceDatabase().promptTemplate as PromptItem[])[1])).toBe(BIG)
  })

  it('returns null and writes nothing when the item is gone from the draft', () => {
    seedTemplate()
    const result = applyPromptItemProjectionWrite(draftCopy(), 'missing')
    expect(result).toBeNull()
    expect((getResourceDatabase().promptTemplate as PromptItem[])[0]).toEqual(item('p-0', 'small'))
  })

  it('falls back to a full sync when the projection has no matching row yet', () => {
    seedTemplate()
    // The draft has a brand-new item absent from the projection.
    const draft = draftCopy()
    draft.push(item('p-new', 'fresh'))
    const result = applyPromptItemProjectionWrite(draft, 'p-new')
    expect(result).toEqual(item('p-new', 'fresh'))
    expect((getResourceDatabase().promptTemplate as PromptItem[]).map((p) => p.id)).toEqual([
      'p-0',
      'p-1',
      'p-2',
      'p-3',
      'p-new',
    ])
  })

  it('returns null without creating promptTemplate while the template is unloaded', () => {
    hydrationState.setHydrated(false)
    resourceDatabase.current = {}

    const result = applyPromptItemProjectionWrite([item('p-0', 'draft')], 'p-0')

    expect(result).toBeNull()
    expect(getResourceDatabase()).not.toHaveProperty('promptTemplate')
  })

  it('writes only the selected preset owner when the aggregate projection is stale', () => {
    hydrationState.setOwner('preset-a')
    const aggregate = [item('p-0', 'stale aggregate')]
    const ownerTemplate = [item('p-0', 'owner text')]
    resourceDatabase.current = {
      promptTemplate: aggregate,
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', promptTemplate: ownerTemplate }],
    }

    const result = applyPromptItemProjectionWrite([item('p-0', 'edited owner')], 'p-0', 'preset-a')

    expect(result).toEqual(item('p-0', 'edited owner'))
    expect(getResourceDatabase().promptPresets[0].promptTemplate).toEqual([item('p-0', 'edited owner')])
    expect(getResourceDatabase().promptTemplate).toEqual(aggregate)
  })

  it.each([
    ['missing', []],
    [
      'duplicated',
      [
        { id: 'preset-a', promptTemplate: [item('p-0', 'owner one')] },
        { id: 'preset-a', promptTemplate: [item('p-0', 'owner two')] },
      ],
    ],
    ['mismatched', [{ id: 'preset-b', promptTemplate: [item('p-0', 'mismatch')] }]],
  ])('fails closed without an aggregate write when the selected owner is %s', (_label, presets) => {
    hydrationState.setOwner('preset-a')
    const aggregate = [item('p-0', 'stale aggregate')]
    resourceDatabase.current = {
      promptTemplate: aggregate,
      promptPresetsId: 0,
      promptPresets: presets,
    }

    const result = applyPromptItemProjectionWrite([item('p-0', 'edited owner')], 'p-0', 'preset-a')

    expect(result).toBeNull()
    expect(getResourceDatabase().promptTemplate).toEqual(aggregate)
  })
})

describe('restorePromptItemProjectionWrite', () => {
  it('restores only the edited item, leaving concurrent edits to other items intact', () => {
    seedTemplate()
    const projection = getResourceDatabase().promptTemplate as PromptItem[]
    // The failing command had optimistically changed p-0; meanwhile p-1 changed too.
    ;(projection[0] as { text: string }).text = 'optimistic'
    ;(projection[1] as { text: string }).text = 'concurrent'

    restorePromptItemProjectionWrite('p-0', item('p-0', 'original'))

    expect((getResourceDatabase().promptTemplate as PromptItem[])[0]).toEqual(item('p-0', 'original'))
    // A whole-array rollback would have reverted p-1 to BIG; the scoped rollback does not.
    expect(textOf((getResourceDatabase().promptTemplate as PromptItem[])[1])).toBe('concurrent')
  })
})

describe('prompt template collection rollback guards', () => {
  it.each([
    [
      'create',
      async (ownerId: string | null) =>
        createPromptItemCommand({
          baseRevision: 7,
          promptPresetId: promptTemplateOwnerCommandId(ownerId),
          promptItem: promptItemSnapshot('created', 'new'),
        }),
      commandMocks.createPromptItemCommand,
    ],
    [
      'delete',
      async (ownerId: string | null) =>
        deletePromptItemCommand({
          baseRevision: 7,
          promptPresetId: promptTemplateOwnerCommandId(ownerId),
          itemId: 'deleted',
        }),
      commandMocks.deletePromptItemCommand,
    ],
    [
      'reorder',
      async (ownerId: string | null) =>
        reorderPromptItemsCommand({
          baseRevision: 7,
          promptPresetId: promptTemplateOwnerCommandId(ownerId),
          itemIds: ['p-1', 'p-0'],
        }),
      commandMocks.reorderPromptItemsCommand,
    ],
    [
      'enable',
      async (ownerId: string | null) =>
        enablePromptItemsCommand({
          baseRevision: 7,
          promptPresetId: promptTemplateOwnerCommandId(ownerId),
          enabled: true,
        }),
      commandMocks.enablePromptItemsCommand,
    ],
  ])(
    'drops stale %s command construction after the selected owner changes',
    async (_name, buildCommand, commandMock) => {
      hydrationState.setOwner('preset-a')
      const ownerId = hydrationState.currentOwner()
      hydrationState.setOwner('preset-b')

      const result = await runPromptTemplateOwnerCommand(ownerId, () => buildCommand(ownerId))

      expect(result).toEqual({ status: 'unavailable' })
      expect(commandMock).not.toHaveBeenCalled()
    },
  )

  it.each([
    [
      'create',
      async (ownerId: string | null) =>
        createPromptItemCommand({
          baseRevision: 7,
          promptPresetId: promptTemplateOwnerCommandId(ownerId),
          promptItem: promptItemSnapshot('created', 'new'),
        }),
      commandMocks.createPromptItemCommand,
      {
        kind: 'createPromptItem',
        baseRevision: 7,
        promptPresetId: 'preset-a',
        promptItem: promptItemSnapshot('created', 'new'),
      },
    ],
    [
      'delete',
      async (ownerId: string | null) =>
        deletePromptItemCommand({
          baseRevision: 7,
          promptPresetId: promptTemplateOwnerCommandId(ownerId),
          itemId: 'deleted',
        }),
      commandMocks.deletePromptItemCommand,
      {
        kind: 'deletePromptItem',
        baseRevision: 7,
        promptPresetId: 'preset-a',
        itemId: 'deleted',
      },
    ],
    [
      'reorder',
      async (ownerId: string | null) =>
        reorderPromptItemsCommand({
          baseRevision: 7,
          promptPresetId: promptTemplateOwnerCommandId(ownerId),
          itemIds: ['p-1', 'p-0'],
        }),
      commandMocks.reorderPromptItemsCommand,
      {
        kind: 'reorderPromptItems',
        baseRevision: 7,
        promptPresetId: 'preset-a',
        itemIds: ['p-1', 'p-0'],
      },
    ],
    [
      'enable',
      async (ownerId: string | null) =>
        enablePromptItemsCommand({
          baseRevision: 7,
          promptPresetId: promptTemplateOwnerCommandId(ownerId),
          enabled: true,
        }),
      commandMocks.enablePromptItemsCommand,
      {
        kind: 'enablePromptItems',
        baseRevision: 7,
        promptPresetId: 'preset-a',
        enabled: true,
      },
    ],
  ])('uses the captured owner when constructing %s commands', async (_name, buildCommand, commandMock, expected) => {
    hydrationState.setOwner('preset-a')
    const ownerId = hydrationState.currentOwner()

    const result = await runPromptTemplateOwnerCommand(ownerId, () => buildCommand(ownerId))

    expect(result).toEqual(expected)
    expect(commandMock).toHaveBeenCalledWith(expect.objectContaining({ promptPresetId: 'preset-a' }))
  })

  it('skips collection rollback after the selected owner changes', () => {
    hydrationState.setOwner('preset-a')
    const ownerId = hydrationState.currentOwner()
    let draftItems = [item('p-0', 'first'), item('created', 'new')]
    resourceDatabase.current = { promptTemplate: cloneJsonValue(draftItems) }
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    hydrationState.setOwner('preset-b')
    rollbackFailedPromptTemplateItemCreate({
      ownerId,
      binding,
      itemId: 'created',
      attemptedItem: item('created', 'new'),
    })

    expect(draftItems.map((promptItem) => promptItem.id)).toEqual(['p-0', 'created'])
    expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual([
      'p-0',
      'created',
    ])
  })

  it('skips delete rollback after the selected owner changes', () => {
    hydrationState.setOwner('preset-a')
    const ownerId = hydrationState.currentOwner()
    let draftItems = [item('p-0', 'first'), item('p-1', 'second')]
    resourceDatabase.current = { promptTemplate: cloneJsonValue(draftItems) }
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    hydrationState.setOwner('preset-b')
    rollbackFailedPromptTemplateItemDelete({
      ownerId,
      binding,
      itemId: 'deleted',
      previousIndex: 1,
      previousItem: item('deleted', 'deleted original'),
    })

    expect(draftItems.map((promptItem) => promptItem.id)).toEqual(['p-0', 'p-1'])
    expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual([
      'p-0',
      'p-1',
    ])
  })

  it('skips reorder rollback after the selected owner changes', () => {
    hydrationState.setOwner('preset-a')
    const ownerId = hydrationState.currentOwner()
    let draftItems = [item('p-1', 'second'), item('p-0', 'first')]
    resourceDatabase.current = { promptTemplate: cloneJsonValue(draftItems) }
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    hydrationState.setOwner('preset-b')
    rollbackFailedPromptTemplateItemReorder({
      ownerId,
      binding,
      previousItemIds: ['p-0', 'p-1'],
      attemptedItemIds: ['p-1', 'p-0'],
    })

    expect(draftItems.map((promptItem) => promptItem.id)).toEqual(['p-1', 'p-0'])
    expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual([
      'p-1',
      'p-0',
    ])
  })

  it('skips enable rollback after the selected owner changes', () => {
    hydrationState.setOwner('preset-a')
    const ownerId = hydrationState.currentOwner()
    resourceDatabase.current = { promptTemplate: [] }

    hydrationState.setOwner('preset-b')
    runPromptTemplateOwnerRollback(ownerId, () => {
      getResourceDatabase().promptTemplate = undefined
    })

    expect(getResourceDatabase().promptTemplate).toEqual([])
  })

  it('failed create removes unchanged attempted item and preserves newer sibling and appended rows', () => {
    let draftItems = [item('p-0', 'first'), item('p-1', 'second'), item('created', 'new')]
    resourceDatabase.current = { promptTemplate: cloneJsonValue(draftItems) }
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    draftItems = [item('p-0', 'first edited'), item('p-1', 'second'), item('created', 'new'), item('later', 'later')]
    getResourceDatabase().promptTemplate = cloneJsonValue(draftItems)

    rollbackFailedPromptTemplateItemCreate({
      ownerId: null,
      binding,
      itemId: 'created',
      attemptedItem: item('created', 'new'),
    })

    expect(draftItems.map((promptItem) => promptItem.id)).toEqual(['p-0', 'p-1', 'later'])
    expect(textOf(draftItems[0])).toBe('first edited')
    expect(textOf(draftItems[2])).toBe('later')
    expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual([
      'p-0',
      'p-1',
      'later',
    ])
  })

  it('failed preset create also restores the canonical preset projection', () => {
    hydrationState.setOwner('preset-a')
    let draftItems = [item('p-0', 'first'), item('created', 'new')]
    resourceDatabase.current = {
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', promptTemplate: cloneJsonValue(draftItems) }],
      promptTemplate: cloneJsonValue(draftItems),
    }
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    rollbackFailedPromptTemplateItemCreate({
      ownerId: 'preset-a',
      binding,
      itemId: 'created',
      attemptedItem: item('created', 'new'),
    })

    expect(draftItems.map((promptItem) => promptItem.id)).toEqual(['p-0'])
    expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual([
      'p-0',
      'created',
    ])
    expect(
      (getResourceDatabase().promptPresets[0].promptTemplate as PromptItem[]).map((promptItem) => promptItem.id),
    ).toEqual(['p-0'])
  })

  it('failed create skips rollback when the created row was edited after dispatch', () => {
    let draftItems = [item('p-0', 'first'), item('created', 'edited after dispatch')]
    resourceDatabase.current = { promptTemplate: cloneJsonValue(draftItems) }
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    rollbackFailedPromptTemplateItemCreate({
      ownerId: null,
      binding,
      itemId: 'created',
      attemptedItem: item('created', 'new'),
    })

    expect(draftItems.map((promptItem) => promptItem.id)).toEqual(['p-0', 'created'])
    expect(textOf(draftItems[1])).toBe('edited after dispatch')
    expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual([
      'p-0',
      'created',
    ])
  })

  it('failed delete reinserts only the missing deleted item and preserves sibling edits', () => {
    const deleted = item('deleted', 'deleted original')
    let draftItems = [item('p-0', 'first edited'), item('p-1', 'second'), item('later', 'later')]
    resourceDatabase.current = { promptTemplate: cloneJsonValue(draftItems) }
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    rollbackFailedPromptTemplateItemDelete({
      ownerId: null,
      binding,
      itemId: 'deleted',
      previousIndex: 1,
      previousItem: deleted,
    })

    expect(draftItems.map((promptItem) => promptItem.id)).toEqual(['p-0', 'deleted', 'p-1', 'later'])
    expect(textOf(draftItems[0])).toBe('first edited')
    expect(textOf(draftItems[1])).toBe('deleted original')
    expect(textOf(draftItems[3])).toBe('later')
    expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual([
      'p-0',
      'deleted',
      'p-1',
      'later',
    ])
  })

  it('failed reorder restores previous id order while preserving item content edits', () => {
    let draftItems = [item('p-1', 'second edited'), item('p-0', 'first edited'), item('p-2', 'third')]
    resourceDatabase.current = { promptTemplate: cloneJsonValue(draftItems) }
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    rollbackFailedPromptTemplateItemReorder({
      ownerId: null,
      binding,
      previousItemIds: ['p-0', 'p-1', 'p-2'],
      attemptedItemIds: ['p-1', 'p-0', 'p-2'],
    })

    expect(draftItems.map((promptItem) => promptItem.id)).toEqual(['p-0', 'p-1', 'p-2'])
    expect(textOf(draftItems[0])).toBe('first edited')
    expect(textOf(draftItems[1])).toBe('second edited')
    expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual([
      'p-0',
      'p-1',
      'p-2',
    ])
  })

  it('failed reorder skips when a newer reorder changed the live id sequence', () => {
    let draftItems = [item('p-1', 'second'), item('p-2', 'third'), item('p-0', 'first')]
    resourceDatabase.current = { promptTemplate: cloneJsonValue(draftItems) }
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    rollbackFailedPromptTemplateItemReorder({
      ownerId: null,
      binding,
      previousItemIds: ['p-0', 'p-1', 'p-2'],
      attemptedItemIds: ['p-1', 'p-0', 'p-2'],
    })

    expect(draftItems.map((promptItem) => promptItem.id)).toEqual(['p-1', 'p-2', 'p-0'])
    expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual([
      'p-1',
      'p-2',
      'p-0',
    ])
  })
})

describe('commitPendingPromptTemplateMutations', () => {
  it('does not dispatch prompt item updates while the template is unloaded', async () => {
    hydrationState.setHydrated(false)
    resourceDatabase.current = {}
    let draftItems = [item('p-0', 'unloaded draft')]
    const binding: PromptTemplateDraftBinding = {
      getItems: () => draftItems,
      setItems: (items) => {
        draftItems = items
      },
    }

    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'previous'), 500)
    await vi.advanceTimersByTimeAsync(500)

    expect(commandState.commands).toHaveLength(0)
    expect(getResourceDatabase()).not.toHaveProperty('promptTemplate')
  })

  it('stages the exact coalesced prompt-item payload and forwards its replay-safe transport id', async () => {
    seedTemplate()
    hydrationState.setOwner('prompt-a')
    let draftItems = draftCopy()
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    draftItems[0] = item('p-0', 'first queued text')
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 500, 'prompt-a')
    draftItems[0] = item('p-0', 'final queued text')
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'first queued text'), 500, 'prompt-a')

    expect(durableState.stages).toHaveLength(2)
    expect(durableState.stages.map(({ key }) => key)).toEqual([
      'prompt-template-owner:prompt-a',
      'prompt-template-owner:prompt-a',
    ])
    expect(durableState.stages[0].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/prompt-items/p-0',
          body: {
            promptPresetId: 'prompt-a',
            patch: { text: 'first queued text' },
          },
        },
      ],
    })
    expect(durableState.stages[1].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/prompt-items/p-0',
          body: {
            promptPresetId: 'prompt-a',
            patch: { text: 'final queued text' },
          },
        },
      ],
    })
    expect(durableState.stages[1].handle).not.toBe(durableState.stages[0].handle)
    expect(durableState.stages[1].handle.mutationId).toBe(durableState.stages[0].handle.mutationId)

    commitPendingPromptTemplateMutations()
    await flushMicrotasks()

    expect(durableState.dispatches[0].handle).toBe(durableState.stages[1].handle)
    expect(commandState.transports).toEqual([
      {
        mutationId: durableState.stages[1].handle.mutationId,
        databaseLineage: 'test-lineage',
      },
    ])
  })

  it('orders modern and legacy prompt rows by owner', () => {
    seedTemplate()
    hydrationState.setOwner('prompt-a')
    let draftItems = draftCopy()
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    draftItems[0] = item('p-0', 'modern row zero')
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 500, 'prompt-a')
    draftItems[1] = item('p-1', 'modern row one')
    queuePromptItemProjectionUpdate(binding, 'p-1', item('p-1', BIG), 500, 'prompt-a')

    hydrationState.setOwner(null)
    draftItems[2] = item('p-2', 'legacy row two')
    queuePromptItemProjectionUpdate(binding, 'p-2', item('p-2', BIG), 500, null)
    draftItems[3] = item('p-3', 'legacy row three')
    queuePromptItemProjectionUpdate(binding, 'p-3', item('p-3', BIG), 500, null)

    expect(durableState.stages.map(({ key }) => key)).toEqual([
      'prompt-template-owner:prompt-a',
      'prompt-template-owner:prompt-a',
      'prompt-template-owner:__legacy__',
      'prompt-template-owner:__legacy__',
    ])
    resetPromptTemplateSelectionDirtyState()
  })

  it('detaches a pending row PATCH and appends DELETE without discarding its durable predecessor', async () => {
    seedTemplate()
    hydrationState.setOwner('prompt-a')
    let draftItems = draftCopy()
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    draftItems[0] = item('p-0', 'edited before delete')
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 500, 'prompt-a')
    const stagedDelete = stagePromptItemDeleteMutation('prompt-a', 'p-0')

    expect(durableState.stages.map(({ key }) => key)).toEqual([
      'prompt-template-owner:prompt-a',
      'prompt-template-owner:prompt-a',
    ])
    expect(stagedDelete.intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'DELETE',
          path: '/prompt-items/p-0',
          body: { promptPresetId: 'prompt-a' },
        },
      ],
    })
    expect(durableState.acknowledgements).toEqual([])
    await flushMicrotasks()
    expect(durableState.dispatches).toHaveLength(1)
    expect(commandState.commands[0].built).toMatchObject({
      kind: 'updatePromptItem',
      itemId: 'p-0',
      patch: { text: 'edited before delete' },
    })

    await vi.advanceTimersByTimeAsync(500)
    commitPendingPromptTemplateMutations()
    await flushMicrotasks()

    expect(durableState.dispatches).toHaveLength(1)
    expect(commandMocks.updatePromptItemCommand).toHaveBeenCalledOnce()
    expect(stagePromptItemDeleteMutation(null, 'legacy-item').outbox.key).toBe('prompt-template-owner:__legacy__')
    resetPromptTemplateSelectionDirtyState()
  })

  it('immediately dispatches a corrective total revert when an earlier row generation may already dispatch', async () => {
    seedTemplate()
    hydrationState.setOwner('prompt-a')
    let draftItems = draftCopy()
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    draftItems[0] = item('p-0', 'first generation')
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 500, 'prompt-a')
    durableState.stages[0].handle.phase = 'dispatching'

    draftItems[0] = item('p-0', 'small')
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'first generation'), 500, 'prompt-a')

    expect(durableState.stages).toHaveLength(2)
    expect(durableState.stages[1].handle.mutationId).not.toBe(durableState.stages[0].handle.mutationId)
    expect(durableState.stages[1].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/prompt-items/p-0',
          body: {
            promptPresetId: 'prompt-a',
            patch: { text: 'small' },
          },
        },
      ],
    })
    expect(durableState.acknowledgements).toEqual([])
    expect(durableState.dispatches.map(({ handle }) => handle)).toEqual([durableState.stages[1].handle])
    await flushMicrotasks()
    expect(commandState.commands[0].built).toMatchObject({ patch: { text: 'small' } })
    resetPromptTemplateSelectionDirtyState()
  })

  it('merges net row edits with fields reverted from a possibly immutable generation', () => {
    seedTemplate()
    hydrationState.setOwner('prompt-a')
    let draftItems = draftCopy()
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    draftItems[0] = { ...item('p-0', 'first generation'), role: 'user' } as PromptItem
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 500, 'prompt-a')
    durableState.stages[0].handle.phase = 'dispatching'

    draftItems[0] = { ...item('p-0', 'small'), role: 'assistant' } as PromptItem
    queuePromptItemProjectionUpdate(
      binding,
      'p-0',
      { ...item('p-0', 'first generation'), role: 'user' } as PromptItem,
      500,
      'prompt-a',
    )

    expect(durableState.stages[1].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/prompt-items/p-0',
          body: {
            promptPresetId: 'prompt-a',
            patch: { role: 'assistant', text: 'small' },
          },
        },
      ],
    })
    resetPromptTemplateSelectionDirtyState()
  })

  it('flushes pending prompt item updates with keepalive and clears debounce', async () => {
    seedTemplate()
    hydrationState.setOwner('prompt-a')
    let draftItems = draftCopy()
    draftItems[0] = item('p-0', 'unload item')
    const binding: PromptTemplateDraftBinding = {
      getItems: () => draftItems,
      setItems: (items) => {
        draftItems = items
      },
    }

    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 500)
    commitPendingPromptTemplateMutations({ keepalive: true })
    await Promise.resolve()

    expect(commandState.commands).toHaveLength(1)
    expect(commandState.commands[0].keepalive).toBe(true)
    expect(commandState.commands[0].built).toEqual({
      kind: 'updatePromptItem',
      baseRevision: 1,
      promptPresetId: 'prompt-a',
      itemId: 'p-0',
      patch: { text: 'unload item' },
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(commandState.commands).toHaveLength(1)
  })

  it('keeps whole-owner acknowledgement cloning off the per-keystroke queue path', () => {
    seedTemplate()
    let draftItems = draftCopy()
    draftItems[0] = item('p-0', 'edited')
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    const instrumented = withCloneInstrumentation(() =>
      queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 500),
    )

    expect(instrumented.maxClonedSize).toBeLessThan(BIG.length)
    resetPromptTemplateSelectionDirtyState()
  })

  it('retains a debounced prompt item intent when the selected prompt preset owner changes', async () => {
    seedTemplate()
    hydrationState.setOwner('prompt-a')
    let draftItems = draftCopy()
    draftItems[0] = item('p-0', 'stale owner edit')
    const binding: PromptTemplateDraftBinding = {
      getItems: () => draftItems,
      setItems: (items) => {
        draftItems = items
      },
    }

    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 500, 'prompt-a')
    hydrationState.setOwner('prompt-b')
    await vi.advanceTimersByTimeAsync(500)

    expect(commandState.commands).toHaveLength(0)
    expect(textOf(draftItems[0])).toBe('stale owner edit')
    expect(durableState.acknowledgements).toEqual([])
  })

  it('coalesced prompt item rollback restores the first pre-edit item', async () => {
    seedTemplate()
    let draftItems = draftCopy()
    const binding: PromptTemplateDraftBinding = {
      getItems: () => draftItems,
      setItems: (items) => {
        draftItems = items
      },
    }

    draftItems[0] = item('p-0', 'draft one')
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 500)
    draftItems[0] = item('p-0', 'draft two')
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'draft one'), 500)

    await vi.advanceTimersByTimeAsync(500)
    expect(commandState.commands).toHaveLength(1)
    expect(commandState.commands[0].built).toEqual({
      kind: 'updatePromptItem',
      baseRevision: 1,
      itemId: 'p-0',
      patch: { text: 'draft two' },
    })

    commandState.commands[0].rollback?.()

    expect(textOf(draftItems[0])).toBe('small')
    expect(textOf((getResourceDatabase().promptTemplate as PromptItem[])[0])).toBe('small')
  })

  it('rebases a debounced same-field prompt item edit after two saves fail', async () => {
    const firstResult = createDeferred<{ status: string; error?: string }>()
    const secondResult = createDeferred<{ status: string; error?: string }>()
    commandState.runResults.push(firstResult.promise, secondResult.promise)
    seedTemplate()
    let draftItems = draftCopy()
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    draftItems[0] = item('p-0', 'first attempt')
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 0)
    await vi.advanceTimersByTimeAsync(0)

    draftItems[0] = item('p-0', 'second attempt')
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'first attempt'), 50)
    expect(textOf(draftItems[0])).toBe('second attempt')

    firstResult.resolve({ status: 'network-error', error: 'first failed' })
    await flushMicrotasks()
    expect(textOf(draftItems[0])).toBe('second attempt')

    await vi.advanceTimersByTimeAsync(50)
    expect(commandState.commands.map((entry) => entry.built)).toEqual([
      expect.objectContaining({ patch: { text: 'first attempt' } }),
      expect.objectContaining({ patch: { text: 'second attempt' } }),
    ])

    secondResult.resolve({ status: 'network-error', error: 'second failed' })
    await flushMicrotasks()
    expect(textOf(draftItems[0])).toBe('small')
    expect(textOf((getResourceDatabase().promptTemplate as PromptItem[])[0])).toBe('small')
  })

  it('rolls back only failed update fields while preserving a newer different-field preset edit', async () => {
    hydrationState.setOwner('preset-a')
    const original = item('p-0', 'server text')
    resourceDatabase.current = {
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', promptTemplate: [cloneJsonValue(original)] }],
      promptTemplate: [cloneJsonValue(original)],
    }
    let draftItems = [cloneJsonValue(original)]
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    draftItems[0] = promptItemFixture({ ...draftItems[0], text: 'failed text' })
    queuePromptItemProjectionUpdate(binding, 'p-0', original, 500, 'preset-a')
    await vi.advanceTimersByTimeAsync(500)

    const firstAttempt = cloneJsonValue(draftItems[0])
    draftItems[0] = promptItemFixture({ ...draftItems[0], role: 'user' })
    getResourceDatabase().promptPresets[0].promptTemplate = cloneJsonValue(draftItems) as never
    queuePromptItemProjectionUpdate(binding, 'p-0', firstAttempt, 500, 'preset-a')
    commandState.commands[0].rollback?.()

    expect(draftItems[0]).toMatchObject({ text: 'server text', role: 'user' })
    expect((getResourceDatabase().promptTemplate as PromptItem[])[0]).toMatchObject({
      text: 'server text',
      role: 'system',
    })
    expect((getResourceDatabase().promptPresets[0].promptTemplate as PromptItem[])[0]).toMatchObject({
      text: 'server text',
      role: 'user',
    })
    expect(hydrationState.isTainted('preset-a')).toBe(true)

    await vi.advanceTimersByTimeAsync(500)
    expect(commandState.commands[1].built).toMatchObject({ patch: { role: 'user' } })
    expect(commandState.commands[1].built.patch).toEqual({ role: 'user' })
    const secondInput = commandMocks.updatePromptItemCommand.mock.calls[1][0] as {
      optimisticAcknowledgement: PromptItemOptimisticAcknowledgement
    }
    expect(secondInput.optimisticAcknowledgement.ownerState).toEqual({
      enabled: true,
      items: [expect.objectContaining({ text: 'server text', role: 'user' })],
    })
  })

  it('omits very large unchanged fields from a debounced prompt item update', async () => {
    const previous = promptItemFixture({
      ...item('p-0', 'small'),
      largeMetadata: BIG,
      nestedMetadata: { body: BIG },
    })
    resourceDatabase.current = { promptTemplate: [cloneJsonValue(previous)] }
    let draftItems = [promptItemFixture({ ...previous, text: 'edited' })]
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    queuePromptItemProjectionUpdate(binding, 'p-0', previous, 500)
    await vi.advanceTimersByTimeAsync(500)

    expect(commandState.commands).toHaveLength(1)
    expect(commandState.commands[0].built).toEqual({
      kind: 'updatePromptItem',
      baseRevision: 1,
      itemId: 'p-0',
      patch: { text: 'edited' },
    })
    expect(snapshotJson(commandState.commands[0].built).length).toBeLessThan(BIG.length)
  })

  it('captures the exact post-write prompt owner state as client-only acknowledgement metadata', async () => {
    seedTemplate()
    let draftItems = draftCopy()
    draftItems[0] = item('p-0', 'accepted optimistic edit')
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )
    const projectionFence = capturePromptTemplateOwnerMutationFence(null)

    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 500, null, projectionFence)
    await vi.advanceTimersByTimeAsync(500)

    const commandInput = commandMocks.updatePromptItemCommand.mock.calls[0][0]
    expect(commandInput).toMatchObject({
      optimisticAcknowledgement: {
        collectionProjectionEpoch: projectionFence.collectionProjectionEpoch,
        ownerProjectionEpoch: projectionFence.ownerProjectionEpoch,
        ownerState: { enabled: true },
      },
    })
    const optimisticAcknowledgement = commandInput.optimisticAcknowledgement as PromptItemOptimisticAcknowledgement
    expect(optimisticAcknowledgement.ownerState.enabled).toBe(true)
    if (!optimisticAcknowledgement.ownerState.enabled) throw new Error('expected an enabled owner')
    expect(optimisticAcknowledgement.ownerState.items[0]).toEqual(item('p-0', 'accepted optimistic edit'))
    expect(commandState.commands[0].built).not.toHaveProperty('optimisticAcknowledgement')
  })

  it('skips a failed item-update rollback after an authoritative owner collection projection', async () => {
    seedTemplate()
    let draftItems = draftCopy()
    draftItems[0] = item('p-0', 'optimistic edit')
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )
    const projectionFence = capturePromptTemplateOwnerMutationFence(null)
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 500, null, projectionFence)
    await vi.advanceTimersByTimeAsync(500)
    applyCollectionsResource(
      { revision: 2, collections: { promptTemplate: [item('p-0', 'authoritative')] } },
      'promptTemplate',
    )

    commandState.commands[0].rollback?.()

    expect(textOf(draftItems[0])).toBe('optimistic edit')
    expect(textOf((getResourceDatabase().promptTemplate as PromptItem[])[0])).toBe('authoritative')
    expect(hydrationState.isTainted(null)).toBe(true)
  })

  it('skips a failed collection rollback after the owner hydration epoch changes', () => {
    let draftItems = [item('p-0', 'first'), item('created', 'optimistic')]
    resourceDatabase.current = { promptTemplate: cloneJsonValue(draftItems) }
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )
    const projectionFence = capturePromptTemplateOwnerMutationFence(null)
    hydrationState.advanceOwnerEpoch(null)

    rollbackFailedPromptTemplateItemCreate({
      ownerId: null,
      binding,
      itemId: 'created',
      attemptedItem: item('created', 'optimistic'),
      projectionFence,
    })

    expect(draftItems.map((promptItem) => promptItem.id)).toEqual(['p-0', 'created'])
  })

  it('sends removals through deleteKeys while retaining explicit null values', async () => {
    const previous = promptItemFixture({
      ...item('p-0', 'small'),
      removable: 'drop me',
      innerFormat: 'legacy format',
      unchanged: BIG,
    })
    const attempted = promptItemFixture({ ...previous, innerFormat: null })
    delete (attempted as unknown as Record<string, unknown>).removable
    resourceDatabase.current = { promptTemplate: [cloneJsonValue(previous)] }
    let draftItems = [attempted]
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    queuePromptItemProjectionUpdate(binding, 'p-0', previous, 500)
    await vi.advanceTimersByTimeAsync(500)

    expect(commandState.commands).toHaveLength(1)
    expect(commandState.commands[0].built).toEqual({
      kind: 'updatePromptItem',
      baseRevision: 1,
      itemId: 'p-0',
      patch: { innerFormat: null },
      deleteKeys: ['removable'],
    })
  })

  it('sends an idempotent correction when a debounced update reverts to its retained baseline', async () => {
    seedTemplate()
    let draftItems = draftCopy()
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    draftItems[0] = item('p-0', 'draft edit')
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 500)
    draftItems[0] = item('p-0', 'small')
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'draft edit'), 500)
    await vi.advanceTimersByTimeAsync(500)

    expect(commandState.commands).toHaveLength(1)
    expect(commandState.commands[0].built).toEqual({
      kind: 'updatePromptItem',
      baseRevision: 1,
      itemId: 'p-0',
      patch: { text: 'small' },
    })
    expect(durableState.acknowledgements).toEqual([])
  })

  it('PromptSettings component teardown flushes pending prompt-template patches', async () => {
    seedTemplate()
    let draftItems = draftCopy()
    draftItems[0] = item('p-0', 'component teardown item')
    const binding: PromptTemplateDraftBinding = {
      getItems: () => draftItems,
      setItems: (items) => {
        draftItems = items
      },
    }
    queuePromptItemProjectionUpdateForPromptSettings(binding, 'p-0', item('p-0', 'small'), 500)
    getResourceDatabase().promptTemplate = []
    getResourceDatabase().promptSettings = { ...minimalPromptSettings }

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await unmount(component)
      component = null
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
    await Promise.resolve()

    expect(commandState.commands).toHaveLength(1)
    expect(commandState.commands[0].keepalive).toBeUndefined()
    expect(commandState.commands[0].built).toEqual({
      kind: 'updatePromptItem',
      baseRevision: 1,
      itemId: 'p-0',
      patch: { text: 'component teardown item' },
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(commandState.commands).toHaveLength(1)
  })

  it('keeps a focused prompt row mounted through a value-only sibling reconcile', async () => {
    const focusedRow = promptItemFixture({ ...item('focused-row', 'server old'), name: 'Focused row' })
    const siblingRow = promptItemFixture({ ...item('sibling-row', 'sibling old'), name: 'Sibling old' })
    seedPromptSettings({ promptTemplate: [focusedRow, siblingRow] })

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await flushMicrotasks()
      await tick()

      promptRowToggle(target, 'Focused row').click()
      await tick()
      const focusedInput = target.querySelector<HTMLTextAreaElement>(
        '[data-risu-prompt-item-id="focused-row"] textarea',
      )
      expect(focusedInput).toBeTruthy()
      focusedInput!.value = 'local dirty text'
      focusedInput!.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
      await flushMicrotasks()
      await tick()
      focusedInput!.focus()
      focusedInput!.setSelectionRange(6, 6)
      const stageCount = durableState.stages.length

      commandState.revision = 2
      await applyPromptSettingsProjection(() => {
        getResourceDatabase().promptTemplate = [
          cloneJsonValue(focusedRow),
          promptItemFixture({ ...siblingRow, name: 'Sibling fresh' }),
        ]
      })

      const reconciledInput = target.querySelector<HTMLTextAreaElement>(
        '[data-risu-prompt-item-id="focused-row"] textarea',
      )
      expect(reconciledInput).toBe(focusedInput)
      expect(document.activeElement).toBe(focusedInput)
      expect(reconciledInput?.value).toBe('local dirty text')
      expect(reconciledInput?.selectionStart).toBe(6)
      expect(target.textContent).toContain('Sibling fresh')
      expect(durableState.stages).toHaveLength(stageCount)
    } finally {
      if (component) await unmount(component)
      resetPromptTemplateSelectionDirtyState()
      target.remove()
    }
  })

  it.each(['create', 'reorder'] as const)('flushes an edited row before a durable legacy prompt %s', async (action) => {
    const first = promptItemFixture({ ...item('p-0', 'original first'), name: 'First row' })
    const second = promptItemFixture({ ...item('p-1', 'original second'), name: 'Second row' })
    seedPromptSettings({ promptTemplate: [first, second] })
    let draftItems = draftCopy()
    draftItems[0] = promptItemFixture({ ...draftItems[0], text: 'edited before structure' })
    queuePromptItemProjectionUpdate(
      draftBindingFor(
        () => draftItems,
        (items) => {
          draftItems = items
        },
      ),
      'p-0',
      first,
      500,
      null,
    )

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await flushMicrotasks()
      await tick()

      const actionButton =
        action === 'create'
          ? target.querySelector<HTMLButtonElement>(`button[aria-label="${language.add}: ${language.promptTemplate}"]`)
          : target.querySelector<HTMLButtonElement>(`button[aria-label="${language.moveDown}: First row"]`)
      expect(actionButton).toBeTruthy()
      actionButton!.click()
      await tick()
      await flushMicrotasks()

      const ownerStages = durableState.stages.filter(({ key }) => key === 'prompt-template-owner:__legacy__')
      const ownerRequests = ownerStages.map(({ intent }) => (intent.requests as Array<Record<string, unknown>>)[0])
      expect(ownerRequests.map((request) => request?.path)).toEqual([
        '/prompt-items/p-0',
        action === 'create' ? '/prompt-items' : '/prompt-items/reorder',
      ])
      expect(ownerRequests[0]).toEqual({
        method: 'PATCH',
        path: '/prompt-items/p-0',
        body: { patch: { text: 'edited before structure' } },
      })
      expect(ownerRequests[1]).toMatchObject(
        action === 'create'
          ? {
              method: 'POST',
              path: '/prompt-items',
              body: { promptItem: expect.objectContaining({ id: expect.any(String), text: '' }) },
            }
          : {
              method: 'POST',
              path: '/prompt-items/reorder',
              body: { itemIds: ['p-1', 'p-0'] },
            },
      )
      expect(commandState.commands.map(({ built }) => built.kind)).toEqual([
        'updatePromptItem',
        action === 'create' ? 'createPromptItem' : 'reorderPromptItems',
      ])
    } finally {
      if (component) unmount(component)
      target.remove()
    }
  })

  it('disables structural controls and renders a pending status until create persistence settles', async () => {
    const pending = createDeferred<{ status: string; error?: string }>()
    commandState.runResults.push(pending.promise)
    const existing = promptItemFixture({ ...item('p-a', 'first'), name: 'Existing row' })
    seedPromptSettings({ promptTemplate: [existing] })

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, { target, props: { mode: 'inline', subMenu: 0 } })
      await tick()
      await flushMicrotasks()

      const add = target.querySelector<HTMLButtonElement>(
        `button[aria-label="${language.add}: ${language.promptTemplate}"]`,
      )!
      add.click()
      await tick()

      expect(add.disabled).toBe(true)
      expect(
        target.querySelector<HTMLButtonElement>(`button[aria-label="${language.remove}: Existing row"]`)?.disabled,
      ).toBe(true)
      expect(target.querySelector('[data-testid="prompt-template-structural-mutation-status"]')).toBeNull()
      expect(target.querySelectorAll('[data-risu-prompt-item-id]')).toHaveLength(2)

      pending.resolve({ status: 'ok' })
      await flushMicrotasks()
      await tick()
      expect(add.disabled).toBe(false)
      expect(target.querySelector('[data-testid="prompt-template-structural-mutation-status"]')).toBeNull()
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it.each(['create', 'delete', 'reorder'] as const)(
    'keeps a retained %s projected through refresh and reports final replay discard',
    async (action) => {
      const first = promptItemFixture({ ...item('p-a', 'first'), name: 'First row' })
      const second = promptItemFixture({ ...item('p-b', 'second'), name: 'Second row' })
      const authoritative = [first, second]
      seedPromptSettings({ promptTemplate: authoritative })
      durableState.retainFailures = true
      commandState.runResults.push(Promise.resolve({ status: 'unavailable' }))

      const target = document.createElement('div')
      document.body.appendChild(target)
      let component: MountedComponent | null = null
      try {
        component = mount(PromptSettings, { target, props: { mode: 'inline', subMenu: 0 } })
        await tick()
        await flushMicrotasks()

        const actionButton =
          action === 'create'
            ? target.querySelector<HTMLButtonElement>(
                `button[aria-label="${language.add}: ${language.promptTemplate}"]`,
              )
            : target.querySelector<HTMLButtonElement>(
                `button[aria-label="${action === 'delete' ? language.remove : language.moveDown}: First row"]`,
              )
        expect(actionButton).toBeTruthy()
        actionButton!.click()
        await flushMicrotasks()
        await tick()

        expect(target.querySelector('[data-testid="prompt-template-structural-mutation-status"]')).toBeNull()
        const attemptedIds = (getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)
        if (action === 'create') expect(attemptedIds).toHaveLength(3)
        if (action === 'delete') expect(attemptedIds).toEqual(['p-b'])
        if (action === 'reorder') expect(attemptedIds).toEqual(['p-b', 'p-a'])

        getResourceDatabase().promptTemplate = cloneJsonValue(authoritative)
        hydrationState.advanceOwnerEpoch(null)
        reapplyPendingPromptTemplateStructuralProjections(null)
        expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual(
          attemptedIds,
        )

        const requestPath =
          action === 'create' ? '/prompt-items' : action === 'delete' ? '/prompt-items/p-a' : '/prompt-items/reorder'
        const stage = durableStageByRequestPath(requestPath)
        expect(stage).toBeTruthy()
        publishPromptTemplateStructuralSettlement(stage!.handle.mutationId, 'discarded')
        await flushMicrotasks()
        await tick()

        expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual([
          'p-a',
          'p-b',
        ])
        expect(
          target.querySelector('[data-testid="prompt-template-structural-mutation-status"]')?.textContent,
        ).toContain(language.promptTemplateMutation.replayDiscarded)
      } finally {
        if (component) await unmount(component)
        target.remove()
      }
    },
  )

  it('shows the exact terminal delete failure after restoring the removed row', async () => {
    const first = promptItemFixture({ ...item('p-a', 'first'), name: 'First row' })
    seedPromptSettings({ promptTemplate: [first] })
    commandState.runResults.push(Promise.resolve({ status: 'error', error: 'delete rejected' }))

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, { target, props: { mode: 'inline', subMenu: 0 } })
      await tick()
      await flushMicrotasks()
      target.querySelector<HTMLButtonElement>(`button[aria-label="${language.remove}: First row"]`)!.click()
      await flushMicrotasks()
      await tick()

      expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual(['p-a'])
      expect(target.querySelector('[data-testid="prompt-template-structural-mutation-status"]')?.textContent).toContain(
        'delete rejected',
      )
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('keeps a prompt drag bound to stable item and target IDs across an authoritative reorder', async () => {
    const first = promptItemFixture({ ...item('p-a', 'first'), name: 'Drag source' })
    const second = promptItemFixture({ ...item('p-b', 'second'), name: 'Stable target' })
    const third = promptItemFixture({ ...item('p-c', 'third'), name: 'Server first' })
    seedPromptSettings({ promptTemplate: [first, second, third] })

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await flushMicrotasks()
      await tick()

      promptRowToggle(target, 'Drag source').click()
      await tick()
      const dataTransfer = createPromptDragTransfer()
      dispatchPromptDragEvent(promptRowDragHandle(target, 'Drag source'), 'dragstart', dataTransfer)
      hoverPromptRowAfter(target, 'Stable target', dataTransfer)
      await tick()

      commandState.revision = 2
      await applyPromptSettingsProjection(() => {
        getResourceDatabase().promptTemplate = cloneJsonValue([third, first, second])
      })

      dispatchPromptDragEvent(promptRowDropTarget(target, 'Stable target'), 'drop', dataTransfer)
      await tick()
      await flushMicrotasks()

      expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual([
        'p-c',
        'p-b',
        'p-a',
      ])
      expect(promptRowToggle(target, 'Drag source').getAttribute('aria-expanded')).toBe('true')
      expect(commandMocks.reorderPromptItemsCommand).toHaveBeenCalledWith(
        expect.objectContaining({ itemIds: ['p-c', 'p-b', 'p-a'] }),
      )
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it.each([
    {
      missing: 'source',
      authoritativeTemplate: [
        promptItemFixture({ ...item('p-c', 'third'), name: 'Remaining row' }),
        promptItemFixture({ ...item('p-b', 'second'), name: 'Stable target' }),
      ],
      dropRow: 'Stable target',
    },
    {
      missing: 'target',
      authoritativeTemplate: [
        promptItemFixture({ ...item('p-a', 'first'), name: 'Drag source' }),
        promptItemFixture({ ...item('p-c', 'third'), name: 'Remaining row' }),
      ],
      dropRow: 'Remaining row',
    },
  ])('aborts a prompt drag when its stable $missing disappears', async ({ authoritativeTemplate, dropRow }) => {
    const first = promptItemFixture({ ...item('p-a', 'first'), name: 'Drag source' })
    const second = promptItemFixture({ ...item('p-b', 'second'), name: 'Stable target' })
    const third = promptItemFixture({ ...item('p-c', 'third'), name: 'Remaining row' })
    seedPromptSettings({ promptTemplate: [first, second, third] })

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await flushMicrotasks()
      await tick()

      const dataTransfer = createPromptDragTransfer()
      dispatchPromptDragEvent(promptRowDragHandle(target, 'Drag source'), 'dragstart', dataTransfer)
      hoverPromptRowAfter(target, 'Stable target', dataTransfer)
      await tick()

      commandState.revision = 2
      await applyPromptSettingsProjection(() => {
        getResourceDatabase().promptTemplate = cloneJsonValue(authoritativeTemplate)
      })

      dispatchPromptDragEvent(promptRowDropTarget(target, dropRow), 'drop', dataTransfer)
      await tick()
      await flushMicrotasks()

      expect((getResourceDatabase().promptTemplate as PromptItem[]).map((promptItem) => promptItem.id)).toEqual(
        authoritativeTemplate.map((promptItem) => promptItem.id),
      )
      expect(commandMocks.reorderPromptItemsCommand).not.toHaveBeenCalled()
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('aborts a prompt drag after its owner changes', async () => {
    const first = promptItemFixture({ ...item('p-a', 'first'), name: 'Drag source' })
    const second = promptItemFixture({ ...item('p-b', 'second'), name: 'Stable target' })
    hydrationState.setOwner('preset-a')
    seedPromptSettings({
      promptTemplate: [first, second],
      promptPresetsId: 0,
      promptPresets: [
        { id: 'preset-a', name: 'Preset A', promptTemplate: [first, second] },
        { id: 'preset-b', name: 'Preset B', promptTemplate: [] },
      ],
    })

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await flushMicrotasks()
      await tick()

      const dataTransfer = createPromptDragTransfer()
      dispatchPromptDragEvent(promptRowDragHandle(target, 'Drag source'), 'dragstart', dataTransfer)
      hoverPromptRowAfter(target, 'Stable target', dataTransfer)
      hydrationState.setOwner('preset-b')

      dispatchPromptDragEvent(promptRowDropTarget(target, 'Stable target'), 'drop', dataTransfer)
      await tick()
      await flushMicrotasks()

      expect(
        (getResourceDatabase().promptPresets[0].promptTemplate as PromptItem[]).map((promptItem) => promptItem.id),
      ).toEqual(['p-a', 'p-b'])
      expect(commandMocks.reorderPromptItemsCommand).not.toHaveBeenCalled()
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('PromptSettings does not dispatch or write an empty template while unloaded', async () => {
    hydrationState.setHydrated(false)
    hydrationState.ensure.mockResolvedValueOnce(false)
    resourceDatabase.current = { promptSettings: { ...minimalPromptSettings } }

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await unmount(component)
      component = null
    } finally {
      if (component) await unmount(component)
      target.remove()
    }

    expect(commandState.commands).toHaveLength(0)
    expect(getResourceDatabase()).not.toHaveProperty('promptTemplate')
  })

  it('PromptSettings shows a localized hydration failure and renders content after retry', async () => {
    hydrationState.setOwner('preset-a')
    hydrationState.setHydrated(false, 'preset-a')
    resourceDatabase.current = {
      promptSettings: { ...minimalPromptSettings },
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    hydrationState.ensure.mockImplementation(async (options?: { force?: boolean; promptPresetId?: string | null }) => {
      if (!options?.force) return false
      const hydratedTemplate = [
        promptItemFixture({ ...item('hydrated-row', 'hydrated text'), name: 'Hydrated retry row' }),
      ]
      getResourceDatabase().promptPresets[0].promptTemplate = cloneJsonValue(hydratedTemplate) as never
      getResourceDatabase().promptTemplate = cloneJsonValue(hydratedTemplate)
      hydrationState.setHydrated(true, 'preset-a')
      return true
    })

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await flushMicrotasks()
      await tick()

      expect(target.querySelector('[data-testid="prompt-template-hydration-error"]')).not.toBeNull()
      expect(target.textContent).toContain(language.promptTemplateLoadFailed)
      expect(target.textContent).not.toContain('Hydrated retry row')

      const retry = target.querySelector<HTMLButtonElement>('[data-testid="prompt-template-hydration-retry"]')
      expect(retry?.textContent).toContain(language.retry)
      retry?.click()
      await tick()
      await flushMicrotasks()
      await tick()

      expect(hydrationState.ensure).toHaveBeenNthCalledWith(1, { promptPresetId: 'preset-a' })
      expect(hydrationState.ensure).toHaveBeenNthCalledWith(2, { force: true, promptPresetId: 'preset-a' })
      expect(target.querySelector('[data-testid="prompt-template-hydration-error"]')).toBeNull()
      expect(target.textContent).toContain('Hydrated retry row')
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('PromptSettings ignores a stale owner hydration failure after the current preset renders', async () => {
    const presetAHydration = createDeferred<boolean>()
    hydrationState.setOwner('preset-a')
    hydrationState.setHydrated(false, 'preset-a')
    resourceDatabase.current = {
      promptSettings: { ...minimalPromptSettings },
      promptPresetsId: 0,
      promptPresets: [
        { id: 'preset-a', name: 'Preset A' },
        { id: 'preset-b', name: 'Preset B' },
      ],
    }
    hydrationState.ensure.mockImplementation(async (options?: { force?: boolean; promptPresetId?: string | null }) => {
      const ownerId = options?.promptPresetId ?? hydrationState.currentOwner()
      if (ownerId === 'preset-a') return presetAHydration.promise
      const hydratedTemplate = [
        promptItemFixture({ ...item('preset-b-row', 'preset B text'), name: 'Current preset B row' }),
      ]
      getResourceDatabase().promptPresets[1].promptTemplate = cloneJsonValue(hydratedTemplate) as never
      getResourceDatabase().promptTemplate = cloneJsonValue(hydratedTemplate)
      hydrationState.setHydrated(true, 'preset-b')
      return true
    })

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      expect(hydrationState.ensure).toHaveBeenCalledWith({ promptPresetId: 'preset-a' })

      hydrationState.setOwner('preset-b')
      hydrationState.setHydrated(false, 'preset-b')
      getResourceDatabase().promptPresetsId = 1
      await tick()
      await flushMicrotasks()
      await tick()

      expect(target.textContent).toContain('Current preset B row')
      expect(target.querySelector('[data-testid="prompt-template-hydration-error"]')).toBeNull()

      presetAHydration.resolve(false)
      await flushMicrotasks()
      await tick()

      expect(target.textContent).toContain('Current preset B row')
      expect(target.querySelector('[data-testid="prompt-template-hydration-error"]')).toBeNull()
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('PromptSettings does not repeat an item edit already included in an id sync', async () => {
    hydrationState.setOwner('preset-a')
    resourceDatabase.current = {
      promptSettings: { ...minimalPromptSettings },
      promptPresetsId: 0,
      promptPresets: [
        {
          id: 'preset-a',
          name: 'Preset A',
          promptTemplate: [
            promptItemFixture({
              type: 'plain',
              type2: 'normal',
              role: 'system',
              text: 'server old',
              name: 'Preset row',
            }),
          ],
        },
      ],
      promptTemplate: [
        promptItemFixture({ type: 'plain', type2: 'normal', role: 'system', text: 'server old', name: 'Preset row' }),
      ],
    }

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await flushMicrotasks()
      await tick()
      expect(hydrationState.isTainted('preset-a')).toBe(true)

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, altKey: true }))
      await tick()
      await flushMicrotasks()
      await tick()

      await editPromptSettingsTextarea(target, 'local dirty')
      await flushMicrotasks()

      expect(commandState.commands[0].built).toMatchObject({
        kind: 'updatePromptPreset',
        baseRevision: 1,
        promptPresetId: 'preset-a',
      })
      const presetPatch = commandState.commands[0].built.patch as {
        promptTemplate: Array<{ id?: string; text?: string }>
      }
      expect(presetPatch.promptTemplate[0]).toMatchObject({ id: expect.any(String), text: 'local dirty' })

      await vi.advanceTimersByTimeAsync(250)
      await flushMicrotasks()

      expect(commandState.commands).toHaveLength(1)
      expect(commandMocks.updatePromptItemCommand).not.toHaveBeenCalled()
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('PromptSettings edits only the selected preset owner and preserves a stale aggregate projection', async () => {
    hydrationState.setOwner('preset-a')
    const ownerRow = promptItemFixture({ ...item('owner-row', 'owner text'), name: 'Owner row' })
    const staleAggregate = [promptItemFixture({ ...item('stale-row', 'stale text'), name: 'Stale aggregate row' })]
    resourceDatabase.current = {
      promptSettings: { ...minimalPromptSettings },
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A', promptTemplate: [ownerRow] }],
      promptTemplate: staleAggregate,
    }

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await flushMicrotasks()
      await tick()
      promptRowToggle(target, 'Owner row').click()
      await tick()
      await editPromptSettingsTextarea(target, 'edited owner')

      expect(getResourceDatabase().promptPresets[0].promptTemplate).toEqual([
        expect.objectContaining({ text: 'edited owner' }),
      ])
      expect(getResourceDatabase().promptTemplate).toEqual(staleAggregate)
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('PromptSettings includes sibling id-less rows in an in-flight selected preset id sync', async () => {
    hydrationState.setOwner('preset-a')
    let resolvePresetSync: ((value: { kind: string } & Record<string, unknown>) => void) | null = null
    commandMocks.updatePromptPresetCommand.mockImplementationOnce(
      (args: Record<string, unknown>) =>
        new Promise<{ kind: string } & Record<string, unknown>>((resolve) => {
          resolvePresetSync = () => resolve({ kind: 'updatePromptPreset', ...args })
        }),
    )
    resourceDatabase.current = {
      promptSettings: { ...minimalPromptSettings },
      promptPresetsId: 0,
      promptPresets: [
        {
          id: 'preset-a',
          name: 'Preset A',
          promptTemplate: [
            promptItemFixture({
              type: 'plain',
              type2: 'normal',
              role: 'system',
              text: 'row A old',
              name: 'Preset row A',
            }),
            promptItemFixture({
              type: 'plain',
              type2: 'normal',
              role: 'system',
              text: 'row B old',
              name: 'Preset row B',
            }),
          ],
        },
      ],
      promptTemplate: [
        promptItemFixture({
          type: 'plain',
          type2: 'normal',
          role: 'system',
          text: 'row A old',
          name: 'Preset row A',
        }),
        promptItemFixture({
          type: 'plain',
          type2: 'normal',
          role: 'system',
          text: 'row B old',
          name: 'Preset row B',
        }),
      ],
    }

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await flushMicrotasks()
      await tick()

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, altKey: true }))
      await tick()
      await flushMicrotasks()
      await tick()

      await editPromptSettingsTextarea(target, 'row A dirty', 0)
      await flushMicrotasks()

      expect(commandMocks.updatePromptPresetCommand).toHaveBeenCalledTimes(1)
      const presetSyncArgs = commandMocks.updatePromptPresetCommand.mock.calls[0][0] as {
        patch: { promptTemplate: Array<{ id?: string; text?: string }> }
      }
      expect(presetSyncArgs.patch.promptTemplate).toEqual([
        expect.objectContaining({ id: expect.any(String), text: 'row A dirty' }),
        expect.objectContaining({ id: expect.any(String), text: 'row B old' }),
      ])
      const idSyncStage = durableStageByRequestPath('/prompt-presets/preset-a')
      expect(idSyncStage?.key).toBe('prompt-template-owner:preset-a')
      expect(idSyncStage?.intent).toEqual({
        version: 1,
        requests: [
          {
            method: 'PATCH',
            path: '/prompt-presets/preset-a',
            body: { patch: presetSyncArgs.patch },
          },
        ],
      })
      expect(durableState.dispatches.find(({ handle }) => handle === idSyncStage?.handle)?.intent).toEqual(
        idSyncStage?.intent,
      )
      expect(commandState.commands).toHaveLength(0)

      await editPromptSettingsTextarea(target, 'row B dirty', 1)
      await flushMicrotasks()

      expect(commandMocks.updatePromptPresetCommand).toHaveBeenCalledTimes(1)
      expect(commandMocks.updatePromptItemCommand).not.toHaveBeenCalled()
      const syncedIds = presetSyncArgs.patch.promptTemplate.map((item) => item.id)
      const successorStage = durableStageByRequestPath(`/prompt-items/${syncedIds[1]}`)
      expect(successorStage?.key).toBe('prompt-template-owner:preset-a')
      expect(successorStage?.intent).toEqual({
        version: 1,
        requests: [
          {
            method: 'PATCH',
            path: `/prompt-items/${syncedIds[1]}`,
            body: {
              promptPresetId: 'preset-a',
              patch: { text: 'row B dirty' },
            },
          },
        ],
      })
      expect(durableState.dispatches.map(({ handle }) => handle)).toEqual([idSyncStage?.handle])

      const syncedProjection = cloneJsonValue(presetSyncArgs.patch.promptTemplate)
      getResourceDatabase().promptPresets[0].promptTemplate = cloneJsonValue(syncedProjection) as never
      getResourceDatabase().promptTemplate = cloneJsonValue(syncedProjection) as never
      resolvePresetSync?.({ kind: 'updatePromptPreset', ...presetSyncArgs })
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(250)
      await flushMicrotasks()

      expect(
        commandMocks.updatePromptItemCommand.mock.calls.map(([args]) => (args as { itemId: string }).itemId),
      ).toEqual([syncedIds[1]])
      expect(
        commandMocks.updatePromptItemCommand.mock.calls.map(
          ([args]) => (args as { patch: { text?: string } }).patch.text,
        ),
      ).toEqual(['row B dirty'])
      const updateInput = commandMocks.updatePromptItemCommand.mock.calls[0][0] as {
        optimisticAcknowledgement: PromptItemOptimisticAcknowledgement
      }
      expect(updateInput.optimisticAcknowledgement.ownerState).toEqual({
        enabled: true,
        items: [expect.objectContaining({ text: 'row A dirty' }), expect.objectContaining({ text: 'row B dirty' })],
      })
      expect((getResourceDatabase().promptPresets[0].promptTemplate as PromptItem[])[1]).toMatchObject({
        text: 'row B dirty',
      })
      expect(durableState.dispatches.map(({ handle }) => handle)).toEqual([idSyncStage?.handle, successorStage?.handle])
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('lifecycle flush dispatches a staged id-sync successor once and after its prerequisite', async () => {
    hydrationState.setOwner('preset-a')
    let resolvePresetSync: ((value: { kind: string } & Record<string, unknown>) => void) | null = null
    commandMocks.updatePromptPresetCommand.mockImplementationOnce(
      (args: Record<string, unknown>) =>
        new Promise<{ kind: string } & Record<string, unknown>>((resolve) => {
          resolvePresetSync = () => resolve({ kind: 'updatePromptPreset', ...args })
        }),
    )
    resourceDatabase.current = {
      promptSettings: { ...minimalPromptSettings },
      promptPresetsId: 0,
      promptPresets: [
        {
          id: 'preset-a',
          name: 'Preset A',
          promptTemplate: [
            promptItemFixture({
              type: 'plain',
              type2: 'normal',
              role: 'system',
              text: 'server old',
              name: 'Preset row',
            }),
          ],
        },
      ],
      promptTemplate: [
        promptItemFixture({
          type: 'plain',
          type2: 'normal',
          role: 'system',
          text: 'server old',
          name: 'Preset row',
        }),
      ],
    }

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await flushMicrotasks()
      await tick()

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, altKey: true }))
      await tick()
      await flushMicrotasks()
      await tick()

      await editPromptSettingsTextarea(target, 'first edit')
      await flushMicrotasks()
      const presetSyncArgs = commandMocks.updatePromptPresetCommand.mock.calls[0][0] as {
        patch: { promptTemplate: Array<{ id?: string; text?: string }> }
      }
      const itemId = presetSyncArgs.patch.promptTemplate[0].id!
      const prerequisite = durableStageByRequestPath('/prompt-presets/preset-a')
      expect(prerequisite?.key).toBe('prompt-template-owner:preset-a')

      await editPromptSettingsTextarea(target, 'latest before pagehide')
      await flushMicrotasks()
      const successor = durableStageByRequestPath(`/prompt-items/${itemId}`)
      expect(successor?.key).toBe('prompt-template-owner:preset-a')
      expect(successor?.intent).toEqual({
        version: 1,
        requests: [
          {
            method: 'PATCH',
            path: `/prompt-items/${itemId}`,
            body: {
              promptPresetId: 'preset-a',
              patch: { text: 'latest before pagehide' },
            },
          },
        ],
      })
      expect(durableState.dispatches.map(({ handle }) => handle)).toEqual([prerequisite?.handle])

      commitPendingPromptTemplateMutations({ keepalive: true })
      await flushMicrotasks()

      expect(durableState.dispatches.map(({ handle }) => handle)).toEqual([prerequisite?.handle, successor?.handle])
      expect(commandMocks.updatePromptItemCommand).toHaveBeenCalledTimes(1)
      expect(commandState.commands[0]).toMatchObject({
        built: {
          kind: 'updatePromptItem',
          itemId,
          patch: { text: 'latest before pagehide' },
        },
        keepalive: true,
      })

      const syncedProjection = cloneJsonValue(presetSyncArgs.patch.promptTemplate)
      getResourceDatabase().promptPresets[0].promptTemplate = cloneJsonValue(syncedProjection) as never
      getResourceDatabase().promptTemplate = cloneJsonValue(syncedProjection) as never
      resolvePresetSync?.({ kind: 'updatePromptPreset', ...presetSyncArgs })
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(250)
      await flushMicrotasks()

      expect(commandMocks.updatePromptItemCommand).toHaveBeenCalledTimes(1)
      expect(durableState.dispatches).toHaveLength(2)
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('PromptSettings immediately adopts a newly selected preset template even when the top-level projection is stale', async () => {
    commandState.revision = 5
    hydrationState.setOwner('preset-a')
    resourceDatabase.current = {
      promptSettings: { ...minimalPromptSettings },
      promptTemplate: [promptItemFixture({ ...item('old-row', 'old text'), name: 'Old preset row' })],
      promptPresetsId: 0,
      promptPresets: [
        {
          id: 'preset-a',
          name: 'Preset A',
          promptTemplate: [promptItemFixture({ ...item('old-row', 'old text'), name: 'Old preset row' })],
        },
        {
          id: 'preset-b',
          name: 'Preset B',
          promptTemplate: [promptItemFixture({ ...item('new-row', 'new text'), name: 'New preset row' })],
        },
      ],
    }

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await Promise.resolve()
      await tick()

      expect(target.textContent).toContain('Old preset row')
      const oldRowToggle = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Old preset row',
      )
      oldRowToggle?.click()
      await tick()
      expect(oldRowToggle?.getAttribute('aria-expanded')).toBe('true')

      getResourceDatabase().promptPresetsId = 1
      hydrationState.setOwner('preset-b')
      getResourceDatabase().promptTemplate = [
        promptItemFixture({ ...item('stale-row', 'stale text'), name: 'Stale top-level row' }),
      ]
      await tick()
      await Promise.resolve()
      await tick()

      expect(commandState.revision).toBe(5)
      expect(target.textContent).toContain('New preset row')
      expect(target.textContent).not.toContain('Old preset row')
      expect(target.textContent).not.toContain('Stale top-level row')
      const newRowToggle = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'New preset row',
      )
      expect(newRowToggle?.getAttribute('aria-expanded')).toBe('false')
      expect(getResourceDatabase().promptTemplate).toEqual([
        promptItemFixture({ ...item('stale-row', 'stale text'), name: 'Stale top-level row' }),
      ])

      await vi.advanceTimersByTimeAsync(300)
      expect(commandState.commands).toHaveLength(0)
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('PromptSettings renders a selected fallback without deleting or shadowing it', async () => {
    commandState.revision = 5
    hydrationState.setOwner('preset-a')
    hydrationState.setHydrated(true, 'preset-a')
    const fallback = [promptItemFixture({ ...item('fallback-row', 'fallback text'), name: 'Selected fallback row' })]
    hydrationState.setSelectedFallback('preset-a', fallback)
    resourceDatabase.current = {
      promptSettings: { ...minimalPromptSettings },
      promptTemplate: cloneJsonValue(fallback),
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await flushMicrotasks()
      await tick()

      expect(target.querySelector('[data-testid="prompt-template-selected-fallback-notice"]')?.textContent).toContain(
        language.promptTemplateSelectedFallbackNotice,
      )
      expect(target.textContent).toContain('Selected fallback row')
      expect(getResourceDatabase().promptTemplate).toEqual(fallback)
      expect(getResourceDatabase().promptPresets[0]).not.toHaveProperty('promptTemplate')

      promptRowToggle(target, 'Selected fallback row').click()
      await tick()
      expect(target.querySelector('fieldset')?.hasAttribute('disabled')).toBe(true)
      expect(
        target.querySelector<HTMLButtonElement>(`button[aria-label="${language.add}: ${language.promptTemplate}"]`)
          ?.disabled,
      ).toBe(true)
      expect(commandState.commands).toHaveLength(0)
      expect(getResourceDatabase().promptPresets[0]).not.toHaveProperty('promptTemplate')
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('PromptSettings hydrates the newly selected owner before adopting its preset template', async () => {
    commandState.revision = 5
    hydrationState.setOwner('preset-a')
    hydrationState.setHydrated(true, 'preset-a')
    resourceDatabase.current = {
      promptSettings: { ...minimalPromptSettings },
      promptTemplate: [promptItemFixture({ ...item('old-row', 'old text'), name: 'Old preset row' })],
      promptPresetsId: 0,
      promptPresets: [
        {
          id: 'preset-a',
          name: 'Preset A',
          promptTemplate: [promptItemFixture({ ...item('old-row', 'old text'), name: 'Old preset row' })],
        },
        {
          id: 'preset-b',
          name: 'Preset B',
        },
      ],
    }
    hydrationState.ensure.mockImplementation(async (options?: { promptPresetId?: string | null }) => {
      const requestedOwnerId =
        options?.promptPresetId === undefined ? hydrationState.currentOwner() : options.promptPresetId
      if (requestedOwnerId !== 'preset-b') return hydrationState.isHydrated(requestedOwnerId)
      const preset = getResourceDatabase().promptPresets?.[1] as Record<string, unknown> | undefined
      const hydratedTemplate = [promptItemFixture({ ...item('new-row', 'new text'), name: 'Hydrated preset row' })]
      if (preset) preset.promptTemplate = cloneJsonValue(hydratedTemplate)
      getResourceDatabase().promptTemplate = cloneJsonValue(hydratedTemplate)
      hydrationState.setHydrated(true, 'preset-b')
      return true
    })

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 0 },
      })
      await tick()
      await Promise.resolve()
      await tick()

      expect(target.textContent).toContain('Old preset row')

      hydrationState.setOwner('preset-b')
      hydrationState.setHydrated(false, 'preset-b')
      getResourceDatabase().promptPresetsId = 1
      getResourceDatabase().promptTemplate = [
        promptItemFixture({ ...item('stale-row', 'stale text'), name: 'Stale top-level row' }),
      ]
      await tick()
      await Promise.resolve()
      await tick()

      expect(hydrationState.ensure).toHaveBeenCalledWith({ promptPresetId: 'preset-b' })
      expect(target.textContent).toContain('Hydrated preset row')
      expect(target.textContent).not.toContain('Old preset row')
      expect(target.textContent).not.toContain('Stale top-level row')
      expect(getResourceDatabase().promptTemplate).toEqual([
        promptItemFixture({ ...item('new-row', 'new text'), name: 'Hydrated preset row' }),
      ])

      await vi.advanceTimersByTimeAsync(300)
      expect(commandState.commands).toHaveLength(0)
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('PromptSettings keeps a dirty prompt setting through a stale projection before debounce flush', async () => {
    seedPromptSettings({ customPromptTemplateToggle: 'server old' })

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = await mountPromptSettingsComponent(target)

      await editPromptSettingsTextarea(target, 'local dirty')
      expect(getResourceDatabase().customPromptTemplateToggle).toBe('local dirty')

      await applyPromptSettingsProjection(() => {
        ;(getResourceDatabase() as unknown as Record<string, unknown>).customPromptTemplateToggle = 'stale server'
      })
      const rebasedProjectionEpoch = captureSettingsGroupProjectionEpoch('prompt')

      expect(promptSettingsTextarea(target).value).toBe('local dirty')
      expect(getResourceDatabase().customPromptTemplateToggle).toBe('local dirty')

      await vi.advanceTimersByTimeAsync(250)
      await flushMicrotasks()

      expect(commandState.commands).toHaveLength(1)
      expect(commandState.commands[0].built).toEqual({
        kind: 'patchServerBackedSettings',
        patch: { customPromptTemplateToggle: 'local dirty' },
        acknowledgeOptimistic: true,
        optimisticProjectionEpochs: { prompt: rebasedProjectionEpoch },
      })
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('PromptSettings merges clean object subfields while preserving a dirty prompt setting field', async () => {
    seedPromptSettings({
      promptSettings: {
        ...minimalPromptSettings,
        postEndInnerFormat: 'server old',
        sendName: false,
      },
    })

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = await mountPromptSettingsComponent(target)

      await editPromptSettingsTextInput(target, 'local format')

      await applyPromptSettingsProjection(() => {
        getResourceDatabase().promptSettings = {
          ...minimalPromptSettings,
          postEndInnerFormat: 'stale format',
          sendName: true,
        }
      })

      expect(getResourceDatabase().promptSettings).toMatchObject({
        postEndInnerFormat: 'local format',
        sendName: true,
      })
      expect(durableState.stages.at(-1)?.intent).toMatchObject({
        requests: [
          {
            body: {
              patch: {
                promptSettings: {
                  postEndInnerFormat: 'local format',
                  sendName: true,
                },
              },
            },
          },
        ],
      })

      await vi.advanceTimersByTimeAsync(250)
      await flushMicrotasks()

      expect(commandState.commands).toHaveLength(1)
      expect(commandState.commands[0].built).toMatchObject({
        kind: 'patchServerBackedSettings',
        acknowledgeOptimistic: true,
        optimisticProjectionEpochs: { prompt: expect.any(Number) },
        patch: {
          promptSettings: {
            postEndInnerFormat: 'local format',
            sendName: true,
          },
        },
      })
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('PromptSettings clears dirty prompt setting state when projection catches up', async () => {
    seedPromptSettings({ customPromptTemplateToggle: 'server old' })

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = await mountPromptSettingsComponent(target)

      await editPromptSettingsTextarea(target, 'local accepted')
      expect(getResourceDatabase().customPromptTemplateToggle).toBe('local accepted')

      await applyPromptSettingsProjection(() => {
        ;(getResourceDatabase() as unknown as Record<string, unknown>).customPromptTemplateToggle = 'local accepted'
      })
      notifyServerCommandLocalEffectApplied(
        {} as never,
        {
          kind: 'settingsPatch',
          attemptedPatch: { customPromptTemplateToggle: 'local accepted' },
          settings: { customPromptTemplateToggle: 'local accepted' },
        } as never,
      )
      await flushMicrotasks()
      await applyPromptSettingsProjection(() => {
        ;(getResourceDatabase() as unknown as Record<string, unknown>).customPromptTemplateToggle = 'server later'
      })

      expect(promptSettingsTextarea(target).value).toBe('server later')
      expect(getResourceDatabase().customPromptTemplateToggle).toBe('server later')

      await vi.advanceTimersByTimeAsync(250)
      await flushMicrotasks()
      expect(commandState.commands).toHaveLength(1)
      expect(commandState.commands[0].built).toMatchObject({
        patch: { customPromptTemplateToggle: 'local accepted' },
      })
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('PromptSettings adopts a newly selected prompt preset setting owner without projecting the prior draft', async () => {
    seedPromptSettings({
      customPromptTemplateToggle: 'server A',
      promptPresetsId: 0,
      promptPresets: [
        { id: 'preset-a', name: 'Preset A', customPromptTemplateToggle: 'server A' },
        { id: 'preset-b', name: 'Preset B', customPromptTemplateToggle: 'server B' },
      ],
    })

    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | null = null
    try {
      component = await mountPromptSettingsComponent(target)

      await editPromptSettingsTextarea(target, 'dirty A')
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(250)
      await flushMicrotasks()

      expect(getResourceDatabase().customPromptTemplateToggle).toBe('dirty A')
      expect(getResourceDatabase().promptPresets[0].customPromptTemplateToggle).toBe('dirty A')
      expect(commandMocks.updatePromptPresetCommand).toHaveBeenCalledTimes(1)

      await applyPromptSettingsProjection(() => {
        getResourceDatabase().promptPresetsId = 1
        getResourceDatabase().promptPresets = [
          { id: 'preset-a', name: 'Preset A', customPromptTemplateToggle: 'server A refreshed' },
          { id: 'preset-b', name: 'Preset B', customPromptTemplateToggle: 'server B' },
        ]
        getResourceDatabase().customPromptTemplateToggle = 'server B'
      })

      expect(getResourceDatabase().promptPresets[0].customPromptTemplateToggle).toBe('server A refreshed')
      expect(getResourceDatabase().promptPresets[1].customPromptTemplateToggle).toBe('server B')
      expect(getResourceDatabase().customPromptTemplateToggle).toBe('server B')
      expect(promptSettingsTextarea(target).value).toBe('server B')
      expect(commandMocks.updatePromptPresetCommand).toHaveBeenCalledTimes(1)
    } finally {
      if (component) await unmount(component)
      target.remove()
    }
  })

  it('flushes pending prompt settings patches with keepalive and clears debounce', async () => {
    resourceDatabase.current = { jsonSchemaEnabled: true }
    const projectionEpoch = captureSettingsGroupProjectionEpoch('prompt')

    queuePromptSettingsProjectionPatch({ jsonSchemaEnabled: false }, { jsonSchemaEnabled: true }, 500)
    commitPendingPromptTemplateMutations({ keepalive: true })
    await Promise.resolve()

    expect(commandState.commands).toHaveLength(1)
    expect(commandState.commands[0].keepalive).toBe(true)
    expect(commandState.commands[0].built).toEqual({
      kind: 'patchPromptSettings',
      baseRevision: 1,
      patch: { jsonSchemaEnabled: false },
      acknowledgeOptimistic: true,
      optimisticProjectionEpoch: projectionEpoch,
    })
    expect(durableState.stages[0].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/settings/prompt',
          body: { patch: { jsonSchemaEnabled: false } },
        },
      ],
    })
    expect(commandState.transports).toEqual([
      {
        mutationId: durableState.stages[0].handle.mutationId,
        databaseLineage: 'test-lineage',
      },
    ])

    await vi.advanceTimersByTimeAsync(500)
    expect(commandState.commands).toHaveLength(1)
  })

  it('rebases a debounced same-key prompt setting after two saves fail', async () => {
    const firstResult = createDeferred<{ status: string; error?: string }>()
    const secondResult = createDeferred<{ status: string; error?: string }>()
    commandState.runResults.push(firstResult.promise, secondResult.promise)
    resourceDatabase.current = { customPromptTemplateToggle: 'server baseline' }

    getResourceDatabase().customPromptTemplateToggle = 'first attempt'
    queuePromptSettingsProjectionPatch(
      { customPromptTemplateToggle: 'first attempt' },
      { customPromptTemplateToggle: 'server baseline' },
      0,
    )
    await vi.advanceTimersByTimeAsync(0)

    getResourceDatabase().customPromptTemplateToggle = 'second attempt'
    queuePromptSettingsProjectionPatch(
      { customPromptTemplateToggle: 'second attempt' },
      { customPromptTemplateToggle: 'first attempt' },
      50,
    )

    firstResult.resolve({ status: 'network-error', error: 'first failed' })
    await flushMicrotasks()
    expect(getResourceDatabase().customPromptTemplateToggle).toBe('second attempt')

    await vi.advanceTimersByTimeAsync(50)
    secondResult.resolve({ status: 'network-error', error: 'second failed' })
    await flushMicrotasks()
    expect(getResourceDatabase().customPromptTemplateToggle).toBe('server baseline')
  })

  it('dispatches an immediate prompt settings correction when the value returns to its original snapshot', async () => {
    resourceDatabase.current = { jsonSchemaEnabled: true }

    queuePromptSettingsProjectionPatch({ jsonSchemaEnabled: false }, { jsonSchemaEnabled: true }, 500)
    queuePromptSettingsProjectionPatch({ jsonSchemaEnabled: true }, { jsonSchemaEnabled: false }, 500)
    await vi.advanceTimersByTimeAsync(500)

    expect(commandState.commands).toHaveLength(1)
    expect(commandState.commands[0].built).toMatchObject({ patch: { jsonSchemaEnabled: true } })
    expect(durableState.dispatches.at(-1)?.intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/settings/prompt',
          body: { patch: { jsonSchemaEnabled: true } },
        },
      ],
    })
    expect(durableState.acknowledgements).toEqual([])
  })

  it('captures a fresh prompt settings epoch after a pending batch fully reverts', async () => {
    resourceDatabase.current = { jsonSchemaEnabled: true }

    queuePromptSettingsProjectionPatch({ jsonSchemaEnabled: false }, { jsonSchemaEnabled: true }, 500)
    queuePromptSettingsProjectionPatch({ jsonSchemaEnabled: true }, { jsonSchemaEnabled: false }, 500)
    const abandonedEpoch = captureSettingsGroupProjectionEpoch('prompt')

    resourceDatabase.current = { jsonSchemaEnabled: true }
    const nextEpoch = captureSettingsGroupProjectionEpoch('prompt')
    expect(nextEpoch).not.toBe(abandonedEpoch)

    getResourceDatabase().jsonSchemaEnabled = false
    queuePromptSettingsProjectionPatch({ jsonSchemaEnabled: false }, { jsonSchemaEnabled: true }, 500)
    await vi.advanceTimersByTimeAsync(500)

    expect(commandState.commands).toHaveLength(2)
    expect(commandState.commands[0].built).toMatchObject({
      optimisticProjectionEpoch: abandonedEpoch,
      patch: { jsonSchemaEnabled: true },
    })
    expect(commandState.commands[1].built).toMatchObject({
      acknowledgeOptimistic: true,
      optimisticProjectionEpoch: nextEpoch,
    })
  })

  it('keeps a reverted prompt field in the absolute closure while a sibling remains dirty', async () => {
    resourceDatabase.current = {
      jsonSchemaEnabled: true,
      customPromptTemplateToggle: 'server baseline',
    }

    queuePromptSettingsProjectionPatch({ jsonSchemaEnabled: false }, { jsonSchemaEnabled: true }, 500)
    queuePromptSettingsProjectionPatch(
      { customPromptTemplateToggle: 'local sibling' },
      { customPromptTemplateToggle: 'server baseline' },
      500,
    )
    queuePromptSettingsProjectionPatch({ jsonSchemaEnabled: true }, { jsonSchemaEnabled: false }, 500)

    expect(durableState.stages.at(-1)?.intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/settings/prompt',
          body: {
            patch: {
              customPromptTemplateToggle: 'local sibling',
              jsonSchemaEnabled: true,
            },
          },
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(commandState.commands.at(-1)?.built).toMatchObject({
      patch: {
        customPromptTemplateToggle: 'local sibling',
        jsonSchemaEnabled: true,
      },
    })
  })

  it('taints acknowledgement and preserves a newer settings projection on command failure', async () => {
    resourceDatabase.current = { jsonSchemaEnabled: true }
    const attemptedEpoch = captureSettingsGroupProjectionEpoch('prompt')
    getResourceDatabase().jsonSchemaEnabled = false
    queuePromptSettingsProjectionPatch({ jsonSchemaEnabled: false }, { jsonSchemaEnabled: true }, 0)
    commandMocks.patchPromptSettingsCommand.mockResolvedValueOnce({ status: 'network-error' })
    commandState.beforeBuild = () => {
      resourceDatabase.current = { jsonSchemaEnabled: 'newer server value' }
    }

    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(commandMocks.patchPromptSettingsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        acknowledgeOptimistic: true,
        optimisticProjectionEpoch: attemptedEpoch,
      }),
      undefined,
      undefined,
    )
    expect(getResourceDatabase().jsonSchemaEnabled).toBe('newer server value')
    expect(isSettingsGroupAcknowledgementTainted('prompt')).toBe(true)
  })
})

describe('PromptSettings action accessibility', () => {
  it('names navigation and add actions while exposing the selected independent tab', async () => {
    seedPromptSettings()
    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | undefined

    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'independent', subMenu: 0 },
      })
      await tick()
      await flushMicrotasks()
      await tick()

      const backButton = target.querySelector<HTMLButtonElement>(`button[aria-label="${language.goback}"]`)
      const addButton = target.querySelector<HTMLButtonElement>(
        `button[aria-label="${language.add}: ${language.promptTemplate}"]`,
      )
      const templateButton = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === language.template,
      )
      const settingsButton = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === language.settings,
      )

      expect(backButton?.type).toBe('button')
      expect(addButton?.type).toBe('button')
      expect(templateButton?.getAttribute('aria-pressed')).toBe('true')
      expect(settingsButton?.getAttribute('aria-pressed')).toBe('false')

      settingsButton?.click()
      await tick()

      expect(templateButton?.getAttribute('aria-pressed')).toBe('false')
      expect(settingsButton?.getAttribute('aria-pressed')).toBe('true')
    } finally {
      if (component) unmount(component)
      target.remove()
    }
  })

  it('names fallback add and remove actions for their model role', async () => {
    seedPromptSettings()
    const target = document.createElement('div')
    document.body.appendChild(target)
    let component: MountedComponent | undefined

    try {
      component = mount(PromptSettings, {
        target,
        props: { mode: 'inline', subMenu: 1 },
      })
      await tick()

      const buttonByText = (text: string) =>
        Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent?.trim() === text,
        )

      buttonByText(language.fallbackModel)?.click()
      await tick()
      buttonByText(language.model)?.click()
      await tick()

      const addButton = target.querySelector<HTMLButtonElement>(
        `button[aria-label="${language.add}: ${language.model}"]`,
      )
      const removeButton = target.querySelector<HTMLButtonElement>(
        `button[aria-label="${language.remove}: ${language.model}"]`,
      )
      expect(addButton?.type).toBe('button')
      expect(removeButton?.type).toBe('button')
    } finally {
      if (component) unmount(component)
      target.remove()
    }
  })
})

describe('reconcilePromptTemplateDraft', () => {
  it('does not reconcile or stringify when the cached revision is unchanged', () => {
    seedTemplate()
    commandState.revision = 5
    const draft = [item('p-0', 'local-edit')] // differs from the projection

    const instrumented = withCloneInstrumentation(() => reconcilePromptTemplateDraft(draft, 5))

    expect(instrumented.result.nextDraft).toBeNull()
    expect(instrumented.result.revision).toBe(5)
    // The keystroke path runs zero whole-template stringify passes.
    expect(instrumented.jsonCloneCount).toBe(0)
  })

  it('reconciles from the projection when the revision advances and content differs', () => {
    seedTemplate()
    commandState.revision = 6
    const draft = [item('p-0', 'stale-local')]

    const result = reconcilePromptTemplateDraft(draft, 5)

    expect(result.revision).toBe(6)
    expect(result.nextDraft).not.toBeNull()
    expect(result.nextDraft?.map((p) => p.id)).toEqual(['p-0', 'p-1', 'p-2', 'p-3'])
    expect(textOf(result.nextDraft?.[0])).toBe('small')
  })

  it('marks a value-only reconcile with the same item-ID sequence as non-structural', () => {
    resourceDatabase.current = {
      promptTemplate: [item('p-a', 'server fresh'), item('p-b', 'sibling fresh')],
    }
    commandState.revision = 6
    let draftItems = [item('p-a', 'server old'), item('p-b', 'sibling old')]

    const result = reconcilePromptTemplateDraft(draftItems, 5)
    if (result.nextDraft) draftItems = result.nextDraft

    expect(result.structuralAdoption).toBe(false)
    expect(draftItems.map((promptItem) => promptItem.id)).toEqual(['p-a', 'p-b'])
    expect(draftItems.map(textOf)).toEqual(['server fresh', 'sibling fresh'])
  })

  it('preserves dirty prompt item text while clean sibling rows refresh', async () => {
    resourceDatabase.current = {
      promptTemplate: [item('dirty-text', 'server old'), item('clean-sibling', 'sibling old')],
    }
    let draftItems = draftCopy()
    draftItems[0] = item('dirty-text', 'local dirty')
    const binding: PromptTemplateDraftBinding = {
      getItems: () => draftItems,
      setItems: (items) => {
        draftItems = items
      },
    }

    queuePromptItemProjectionUpdate(binding, 'dirty-text', item('dirty-text', 'server old'), 500)
    getResourceDatabase().promptTemplate = [item('dirty-text', 'server old'), item('clean-sibling', 'sibling fresh')]
    commandState.revision = 6

    const result = reconcilePromptTemplateDraft(draftItems, 5)
    if (result.nextDraft) draftItems = result.nextDraft

    expect(result.revision).toBe(6)
    expect(textOf(result.nextDraft?.[0])).toBe('local dirty')
    expect(textOf(result.nextDraft?.[1])).toBe('sibling fresh')

    await flushPromptItemDirtyTestState(draftItems)
  })

  it('preserves dirty fields for surviving row IDs when structural adoption makes the row merge fail', () => {
    const survivor = item('survivor', 'survivor server old')
    const removed = item('removed', 'removed server old')
    resourceDatabase.current = { promptTemplate: [survivor, removed] }
    let draftItems = [item('survivor', 'survivor local dirty'), item('removed', 'removed local dirty')]
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    try {
      queuePromptItemProjectionUpdate(binding, 'survivor', survivor, 500)
      queuePromptItemProjectionUpdate(binding, 'removed', removed, 500)
      getResourceDatabase().promptTemplate = [item('added', 'added server'), item('survivor', 'survivor server fresh')]
      commandState.revision = 6

      const adopted = reconcilePromptTemplateDraft(draftItems, 5)
      if (adopted.nextDraft) draftItems = adopted.nextDraft

      expect(adopted.structuralAdoption).toBe(true)
      expect(draftItems.map((promptItem) => promptItem.id)).toEqual(['added', 'survivor'])
      expect(textOf(draftItems[1])).toBe('survivor local dirty')

      getResourceDatabase().promptTemplate = [
        item('added', 'added server'),
        item('survivor', 'survivor server later'),
        item('removed', 'removed server restored'),
      ]
      commandState.revision = 7
      const restored = reconcilePromptTemplateDraft(draftItems, 6)
      if (restored.nextDraft) draftItems = restored.nextDraft

      expect(textOf(draftItems[1])).toBe('survivor local dirty')
      expect(textOf(draftItems[2])).toBe('removed server restored')
    } finally {
      resetPromptTemplateSelectionDirtyState()
    }
  })

  it('does not let an older PATCH acknowledge a newer debounced row edit', async () => {
    const firstResult = createDeferred<{ status: string; error?: string }>()
    commandState.runResults.push(firstResult.promise)
    resourceDatabase.current = {
      promptTemplate: [item('dirty-text', 'server old')],
    }
    let draftItems = draftCopy()
    const binding = draftBindingFor(
      () => draftItems,
      (items) => {
        draftItems = items
      },
    )

    draftItems[0] = item('dirty-text', 'first edit')
    queuePromptItemProjectionUpdate(binding, 'dirty-text', item('dirty-text', 'server old'), 0)
    await vi.advanceTimersByTimeAsync(0)

    draftItems[0] = item('dirty-text', 'newer debounced edit')
    queuePromptItemProjectionUpdate(binding, 'dirty-text', item('dirty-text', 'first edit'), 500)

    firstResult.resolve({ status: 'ok' })
    await flushMicrotasks()

    getResourceDatabase().promptTemplate = [item('dirty-text', 'first edit')]
    commandState.revision = 6
    const result = reconcilePromptTemplateDraft(draftItems, 5)
    if (result.nextDraft) draftItems = result.nextDraft

    expect(textOf(draftItems[0])).toBe('newer debounced edit')
    expect(result.revision).toBe(6)

    resetPromptTemplateSelectionDirtyState()
  })

  it('refreshes clean fields on the dirty row', async () => {
    resourceDatabase.current = {
      promptTemplate: [promptItemFixture({ ...item('dirty-row', 'server old'), name: 'old name', role: 'system' })],
    }
    let draftItems = draftCopy()
    draftItems[0] = promptItemFixture({ ...item('dirty-row', 'local dirty'), name: 'old name', role: 'system' })
    const binding: PromptTemplateDraftBinding = {
      getItems: () => draftItems,
      setItems: (items) => {
        draftItems = items
      },
    }

    queuePromptItemProjectionUpdate(
      binding,
      'dirty-row',
      promptItemFixture({ ...item('dirty-row', 'server old'), name: 'old name', role: 'system' }),
      500,
    )
    getResourceDatabase().promptTemplate = [
      promptItemFixture({ ...item('dirty-row', 'server old'), name: 'server name', role: 'user' }),
    ]
    commandState.revision = 6

    const result = reconcilePromptTemplateDraft(draftItems, 5)
    if (result.nextDraft) draftItems = result.nextDraft

    expect(textOf(result.nextDraft?.[0])).toBe('local dirty')
    expect((result.nextDraft?.[0] as { name?: string } | undefined)?.name).toBe('server name')
    expect((result.nextDraft?.[0] as { role?: string } | undefined)?.role).toBe('user')

    await flushPromptItemDirtyTestState(draftItems)
  })

  it('clears dirty state once projection matches local dirty value, so later projection can update that field', async () => {
    resourceDatabase.current = {
      promptTemplate: [item('clears-dirty', 'server old')],
    }
    let draftItems = draftCopy()
    draftItems[0] = item('clears-dirty', 'local dirty')
    const binding: PromptTemplateDraftBinding = {
      getItems: () => draftItems,
      setItems: (items) => {
        draftItems = items
      },
    }

    queuePromptItemProjectionUpdate(binding, 'clears-dirty', item('clears-dirty', 'server old'), 500)
    getResourceDatabase().promptTemplate = [{ ...item('clears-dirty', 'local dirty'), name: 'server acknowledged' }]
    commandState.revision = 6

    const acknowledged = reconcilePromptTemplateDraft(draftItems, 5)
    if (acknowledged.nextDraft) draftItems = acknowledged.nextDraft

    expect(textOf(draftItems[0])).toBe('local dirty')
    expect((draftItems[0] as { name?: string }).name).toBe('server acknowledged')

    getResourceDatabase().promptTemplate = [{ ...item('clears-dirty', 'server later'), name: 'server acknowledged' }]
    commandState.revision = 7

    const later = reconcilePromptTemplateDraft(draftItems, 6)
    if (later.nextDraft) draftItems = later.nextDraft

    expect(textOf(later.nextDraft?.[0])).toBe('server later')

    await flushPromptItemDirtyTestState(draftItems)
  })

  it('selection reset clears dirty row merges while retaining pending item intents for replay', async () => {
    resourceDatabase.current = {
      promptTemplate: [item('shared-row', 'old preset server')],
    }
    let draftItems = [item('shared-row', 'old preset local dirty')]
    const binding: PromptTemplateDraftBinding = {
      getItems: () => draftItems,
      setItems: (items) => {
        draftItems = items
      },
    }

    queuePromptItemProjectionUpdate(binding, 'shared-row', item('shared-row', 'old preset server'), 500)
    resetPromptTemplateSelectionDirtyState()

    expect(durableState.acknowledgements).toEqual([])

    getResourceDatabase().promptTemplate = [item('shared-row', 'new preset projection')]
    commandState.revision = 6

    const result = reconcilePromptTemplateDraft(draftItems, 5)
    if (result.nextDraft) draftItems = result.nextDraft

    expect(textOf(draftItems[0])).toBe('new preset projection')

    await vi.advanceTimersByTimeAsync(500)
    expect(commandState.commands).toHaveLength(0)
  })

  it('selection reset preserves pending prompt settings patches', async () => {
    resourceDatabase.current = { jsonSchemaEnabled: true }
    const projectionEpoch = captureSettingsGroupProjectionEpoch('prompt')

    queuePromptSettingsProjectionPatch({ jsonSchemaEnabled: false }, { jsonSchemaEnabled: true }, 500)
    resetPromptTemplateSelectionDirtyState()
    await vi.advanceTimersByTimeAsync(500)

    expect(commandState.commands).toHaveLength(1)
    expect(commandState.commands[0].built).toEqual({
      kind: 'patchPromptSettings',
      baseRevision: 1,
      patch: { jsonSchemaEnabled: false },
      acknowledgeOptimistic: true,
      optimisticProjectionEpoch: projectionEpoch,
    })
  })

  it('does not reconcile when the revision advances but content already matches', () => {
    seedTemplate()
    commandState.revision = 6
    const result = reconcilePromptTemplateDraft(draftCopy(), 5)

    expect(result.revision).toBe(6)
    expect(result.nextDraft).toBeNull()
  })
})

it.each([false, true])(
  'retains prompt item and settings intent without dispatch after demotion (repromoted: %s)',
  async (repromoted) => {
    seedTemplate()
    enterClientWriter()
    let draftItems = draftCopy()
    draftItems[0] = item('p-0', 'Pending')
    const binding: PromptTemplateDraftBinding = {
      getItems: () => draftItems,
      setItems: (items) => {
        draftItems = items
      },
    }
    queuePromptItemProjectionUpdate(binding, 'p-0', item('p-0', 'small'), 50)
    queuePromptSettingsProjectionPatch({ jsonSchemaEnabled: false }, { jsonSchemaEnabled: true }, 50)
    const staged = [...durableState.stages]
    expect(staged).toHaveLength(2)
    demoteClientSession()
    if (repromoted) repromoteClientWriter()
    await vi.advanceTimersByTimeAsync(100)
    commitPendingPromptTemplateMutations()
    expect(durableState.stages).toEqual(staged)
    expect(durableState.dispatches).toEqual([])
    expect(durableState.acknowledgements).toEqual([])
    expect(commandState.commands).toEqual([])
    expect(textOf(draftItems[0])).toBe('Pending')
  },
)
