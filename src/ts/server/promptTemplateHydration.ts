import { get, writable } from 'svelte/store'
import type { Database, PromptPreset } from '../storage/database.svelte'
import { normalizePromptTemplate } from '../process/promptTemplateNormalization'
import { peekCachedServerCommandRevision } from './commands'
import { fetchServerPromptPresetTemplate } from './hydrationReads'
import { collectionsResourceState, settingsResourceState } from './resourceState.svelte'
import { resolveUniquePromptPreset } from '@risuai/shared-core/effective-prompt-template'
import { captureClientSessionGeneration, isClientSessionGenerationCurrent } from '../clientSession'

export interface PromptTemplateHydrationState {
  hydratedOwnerIds: ReadonlySet<string | null>
  version: number
}

let promptTemplateHydrationState: PromptTemplateHydrationState = {
  hydratedOwnerIds: new Set(),
  version: 0,
}

export const promptTemplateHydrationStateStore = writable(promptTemplateHydrationState)

let promptTemplateHydrationInFlight = new Map<string, Promise<boolean>>()
let promptTemplateHydrationGeneration = 0
let promptTemplateSelectedFallbackOwnerIds = new Set<string>()
let promptTemplateSelectedFallbacks = new Map<string, Database['promptTemplate']>()
let nextPromptTemplateOwnerProjectionEpoch = 0
let promptTemplateOwnerProjectionBaseline = 0
let promptTemplateOwnerProjectionEpochs = new Map<string | null, number>()
let promptTemplateOwnerRevisions = new Map<string | null, number>()
let promptTemplateOwnerAcknowledgementTaints = new Set<string | null>()

export function currentPromptTemplateOwnerId(): string | null {
  const resolution = currentPromptTemplateOwnerResolution()
  if (resolution.status === 'ready') return resolution.ownerId

  // Preserve a resident ambiguous stable ID as the modern owner key so callers
  // cannot reinterpret that row as the legacy aggregate owner. Hydration still
  // resolves the complete owner snapshot again and fails closed.
  const selectedIndex = (settingsResourceState.value as Record<string, unknown>).promptPresetsId
  if (!Number.isInteger(selectedIndex) || (selectedIndex as number) < 0) return null
  const presets = collectionsResourceState.values.promptPresets
  const preset = Array.isArray(presets) ? presets[selectedIndex as number] : undefined
  const selectedPromptPresetId = preset?.id
  if (typeof selectedPromptPresetId !== 'string' || selectedPromptPresetId.trim() === '') return null
  return selectedPromptPresetId
}

export function isPromptTemplateHydrated(promptPresetId?: string | null): boolean {
  return isPromptTemplateHydratedInState(get(promptTemplateHydrationStateStore), promptPresetId)
}

export function isPromptTemplateHydratedInState(
  state: PromptTemplateHydrationState,
  promptPresetId?: string | null,
): boolean {
  const ownerResolution = resolveRequestedPromptTemplateOwner(promptPresetId)
  if (ownerResolution.status !== 'ready') return false
  if (state.hydratedOwnerIds.has(ownerResolution.ownerId)) return true
  return ownerResolution.ownerId === null && localPromptTemplateOwnerIsResolved(null)
}

export function promptTemplateOwnerUsesSelectedFallback(
  promptPresetId: string | null = currentPromptTemplateOwnerId(),
): boolean {
  return promptPresetId !== null && promptTemplateSelectedFallbackOwnerIds.has(promptPresetId)
}

export function clonePromptTemplateSelectedFallback(
  promptPresetId: string | null = currentPromptTemplateOwnerId(),
): Database['promptTemplate'] | undefined {
  if (promptPresetId === null || !promptTemplateSelectedFallbackOwnerIds.has(promptPresetId)) return undefined
  const fallback = promptTemplateSelectedFallbacks.get(promptPresetId)
  return Array.isArray(fallback) ? JSON.parse(JSON.stringify(fallback)) : undefined
}

export function capturePromptTemplateOwnerProjectionEpoch(
  promptPresetId: string | null = currentPromptTemplateOwnerId(),
): number {
  return promptTemplateOwnerProjectionEpochs.get(promptPresetId) ?? promptTemplateOwnerProjectionBaseline
}

export function hasPromptTemplateOwnerProjectionEpochChanged(promptPresetId: string | null, epoch: number): boolean {
  return capturePromptTemplateOwnerProjectionEpoch(promptPresetId) !== epoch
}

export function peekPromptTemplateOwnerRevision(
  promptPresetId: string | null = currentPromptTemplateOwnerId(),
): number | null {
  return promptTemplateOwnerRevisions.get(promptPresetId) ?? null
}

export function isPromptTemplateOwnerAcknowledgementTainted(promptPresetId: string | null): boolean {
  return promptTemplateOwnerAcknowledgementTaints.has(promptPresetId)
}

export function markPromptTemplateOwnerAcknowledgementTainted(promptPresetId: string | null): void {
  promptTemplateOwnerAcknowledgementTaints.add(promptPresetId)
}

export function resetPromptTemplateHydration(): void {
  promptTemplateHydrationGeneration += 1
  promptTemplateHydrationInFlight = new Map()
  promptTemplateSelectedFallbackOwnerIds = new Set()
  promptTemplateSelectedFallbacks = new Map()
  promptTemplateOwnerProjectionBaseline = ++nextPromptTemplateOwnerProjectionEpoch
  promptTemplateOwnerProjectionEpochs = new Map()
  promptTemplateOwnerRevisions = new Map()
  promptTemplateOwnerAcknowledgementTaints = new Set()
  publishPromptTemplateHydratedOwnerIds(new Set())
}

/**
 * Fence an already-resident owner before a forced refresh without making its
 * editor disappear. The retained body remains usable while the authoritative
 * replacement is in flight; callers must fully invalidate it if that refresh
 * fails.
 */
export function markPromptTemplateHydrationStale(promptPresetId: string | null = currentPromptTemplateOwnerId()): void {
  if (promptPresetId !== null) promptTemplateHydrationInFlight.delete(promptPresetId)
  promptTemplateOwnerProjectionEpochs.set(promptPresetId, ++nextPromptTemplateOwnerProjectionEpoch)
}

export function invalidatePromptTemplateHydration(
  promptPresetId: string | null = currentPromptTemplateOwnerId(),
): void {
  if (promptPresetId !== null) {
    promptTemplateSelectedFallbackOwnerIds.delete(promptPresetId)
    promptTemplateSelectedFallbacks.delete(promptPresetId)
  }
  markPromptTemplateHydrationStale(promptPresetId)
  setPromptTemplateOwnerHydrated(promptPresetId, false)
}

export function markPromptTemplateProjectionApplied(
  promptPresetId: string | null = currentPromptTemplateOwnerId(),
  revision?: number,
  options: { advanceProjectionEpoch?: boolean } = {},
): void {
  if (options.advanceProjectionEpoch ?? true) {
    promptTemplateOwnerProjectionEpochs.set(promptPresetId, ++nextPromptTemplateOwnerProjectionEpoch)
    promptTemplateOwnerAcknowledgementTaints.delete(promptPresetId)
  }
  if (Number.isInteger(revision) && (revision as number) >= 0) {
    promptTemplateOwnerRevisions.set(
      promptPresetId,
      Math.max(promptTemplateOwnerRevisions.get(promptPresetId) ?? -1, revision as number),
    )
  }
  setPromptTemplateOwnerHydrated(promptPresetId, true)
}

export function startPromptTemplateHydration(): void {
  void ensurePromptTemplateHydrated()
}

export async function ensurePromptTemplateHydrated(
  options: {
    applyProjection?: boolean
    force?: boolean
    minimumRevision?: number
    promptPresetId?: string | null
  } = {},
): Promise<boolean> {
  const sessionGeneration = captureClientSessionGeneration()
  const ownerResolution = resolveRequestedPromptTemplateOwner(options.promptPresetId)
  if (ownerResolution.status !== 'ready') return false
  const ownerId = ownerResolution.ownerId
  const minimumRevision = normalizedMinimumRevision(options.minimumRevision)
  const ownerRevision = peekPromptTemplateOwnerRevision(ownerId)
  if (
    !options.force &&
    promptTemplateHydrationState.hydratedOwnerIds.has(ownerId) &&
    (minimumRevision === null || (ownerRevision !== null && ownerRevision >= minimumRevision))
  ) {
    if (ownerId !== null && (options.applyProjection ?? true)) {
      return applyHydratedOwnerCompatibilityProjection(ownerId)
    }
    return true
  }
  // The top-level compatibility template belongs to the collection resources
  // and is already part of the initial collection read. Only preset-owned templates
  // need a separate lazy body request.
  if (ownerId === null) {
    const resolved = localPromptTemplateOwnerIsResolved(null)
    if (resolved) markPromptTemplateProjectionApplied(null, minimumRevision ?? undefined)
    return resolved
  }
  const ownerKey = ownerId
  const inFlight = promptTemplateHydrationInFlight.get(ownerKey)
  if (inFlight) {
    const applied = await inFlight
    if (!isClientSessionGenerationCurrent(sessionGeneration)) return false
    const appliedRevision = peekPromptTemplateOwnerRevision(ownerId)
    if (applied && (minimumRevision === null || (appliedRevision !== null && appliedRevision >= minimumRevision))) {
      if ((options.applyProjection ?? true) && !applyHydratedOwnerCompatibilityProjection(ownerId)) {
        return false
      }
      return true
    }
    if (minimumRevision !== null && (appliedRevision === null || appliedRevision < minimumRevision)) {
      return ensurePromptTemplateHydrated({ ...options, force: true })
    }
    return false
  }

  const generation = promptTemplateHydrationGeneration
  const ownerEpoch = capturePromptTemplateOwnerProjectionEpoch(ownerId)
  const baselineRevision = maximumRevision(
    peekCachedServerCommandRevision(),
    ownerRevision,
    promptTemplateCollectionRevision(ownerId),
    minimumRevision,
  )
  if (baselineRevision === null && !options.force) {
    const resolved = localPromptTemplateOwnerIsResolved(ownerId)
    if (resolved) markPromptTemplateProjectionApplied(ownerId)
    return resolved
  }
  const applyProjection = options.applyProjection ?? true
  const ownerSnapshot = promptTemplateOwnerSnapshot(ownerId)
  if (ownerSnapshot === null) return false
  const compatibilitySnapshot = applyProjection ? promptTemplateOwnerSnapshot(null) : null
  const request = (async () => {
    const result = await fetchServerPromptPresetTemplate(ownerId)
    if (!isClientSessionGenerationCurrent(sessionGeneration)) return false
    if (generation !== promptTemplateHydrationGeneration) return false
    if (hasPromptTemplateOwnerProjectionEpochChanged(ownerId, ownerEpoch)) return false
    const currentOwner = currentPromptTemplateOwnerResolution()
    const ownerIsCurrent = currentOwner.status === 'ready' && ownerId === currentOwner.ownerId
    if (applyProjection && !ownerIsCurrent) return false
    if (result.status !== 'ok') {
      promptTemplateHydrationWarning(result.status === 'error' ? result.error : 'server resource read unavailable')
      return false
    }
    if (isOlderThanRevision(result.revision, baselineRevision)) {
      return false
    }
    if (promptTemplateOwnerSnapshot(ownerId) !== ownerSnapshot) {
      return false
    }

    const fields = { promptTemplate: result.promptTemplate } as Partial<Database>
    const selectedFallbackPromptTemplate = result.selectedFallbackPromptTemplate as
      | Database['promptTemplate']
      | undefined
    if (
      applyProjection &&
      ownerIsCurrent &&
      selectedFallbackPromptTemplate !== undefined &&
      (compatibilitySnapshot === null || promptTemplateOwnerSnapshot(null) !== compatibilitySnapshot)
    ) {
      return false
    }
    if (
      !applyPromptTemplateProjectionFields(fields, ownerId, {
        applyCompatibilityProjection: applyProjection && ownerIsCurrent && selectedFallbackPromptTemplate !== undefined,
        ...(selectedFallbackPromptTemplate !== undefined ? { selectedFallbackPromptTemplate } : {}),
      })
    ) {
      return false
    }
    if (selectedFallbackPromptTemplate === undefined) {
      promptTemplateSelectedFallbackOwnerIds.delete(ownerId)
      promptTemplateSelectedFallbacks.delete(ownerId)
    } else {
      promptTemplateSelectedFallbackOwnerIds.add(ownerId)
      promptTemplateSelectedFallbacks.set(ownerId, JSON.parse(JSON.stringify(selectedFallbackPromptTemplate)))
    }
    markPromptTemplateProjectionApplied(ownerId, result.revision)
    return true
  })().finally(() => {
    if (promptTemplateHydrationInFlight.get(ownerKey) === request) {
      promptTemplateHydrationInFlight.delete(ownerKey)
    }
  })

  promptTemplateHydrationInFlight.set(ownerKey, request)
  return request
}

function applyHydratedOwnerCompatibilityProjection(ownerId: string): boolean {
  const currentOwner = currentPromptTemplateOwnerResolution()
  if (
    currentOwner.status !== 'ready' ||
    ownerId !== currentOwner.ownerId ||
    !promptTemplateHydrationState.hydratedOwnerIds.has(ownerId)
  ) {
    return false
  }
  const preset = uniquePromptPresetOwner(ownerId)
  if (!preset) return false
  const hasPromptTemplate = Object.prototype.hasOwnProperty.call(preset, 'promptTemplate')
  if (hasPromptTemplate && !Array.isArray(preset.promptTemplate)) return false
  const usesSelectedFallback = !hasPromptTemplate && promptTemplateSelectedFallbackOwnerIds.has(ownerId)
  const selectedFallbackPromptTemplate = usesSelectedFallback ? promptTemplateSelectedFallbacks.get(ownerId) : undefined
  if (usesSelectedFallback && !Array.isArray(selectedFallbackPromptTemplate)) {
    promptTemplateSelectedFallbackOwnerIds.delete(ownerId)
    promptTemplateSelectedFallbacks.delete(ownerId)
    setPromptTemplateOwnerHydrated(ownerId, false)
    return false
  }
  const fields = {
    promptTemplate: hasPromptTemplate ? JSON.parse(JSON.stringify(preset.promptTemplate)) : null,
  } as Partial<Database>
  const applied = applyPromptTemplateProjectionFields(fields, ownerId, {
    applyCompatibilityProjection: usesSelectedFallback,
    ...(usesSelectedFallback
      ? { selectedFallbackPromptTemplate: JSON.parse(JSON.stringify(selectedFallbackPromptTemplate)) }
      : {}),
  })
  return applied
}

function setPromptTemplateOwnerHydrated(promptPresetId: string | null, hydrated: boolean): void {
  if (promptTemplateHydrationState.hydratedOwnerIds.has(promptPresetId) === hydrated) return
  const hydratedOwnerIds = new Set(promptTemplateHydrationState.hydratedOwnerIds)
  if (hydrated) hydratedOwnerIds.add(promptPresetId)
  else hydratedOwnerIds.delete(promptPresetId)
  publishPromptTemplateHydratedOwnerIds(hydratedOwnerIds)
}

function publishPromptTemplateHydratedOwnerIds(hydratedOwnerIds: ReadonlySet<string | null>): void {
  promptTemplateHydrationState = {
    hydratedOwnerIds: new Set(hydratedOwnerIds),
    version: promptTemplateHydrationState.version + 1,
  }
  promptTemplateHydrationStateStore.set(promptTemplateHydrationState)
}

function isOlderThanRevision(revision: number, comparisonRevision: number | null): boolean {
  return comparisonRevision !== null && revision < comparisonRevision
}

function normalizedMinimumRevision(value: number | undefined): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null
}

function maximumRevision(...values: Array<number | null>): number | null {
  const revisions = values.filter((value): value is number => value !== null)
  return revisions.length > 0 ? Math.max(...revisions) : null
}

function promptTemplateOwnerSnapshot(ownerId: string | null): string | null {
  if (ownerId === null) {
    if (collectionsResourceState.statuses.promptTemplate !== 'ready') return null
    const values = collectionsResourceState.values as Record<string, unknown>
    const present = Object.prototype.hasOwnProperty.call(values, 'promptTemplate')
    if (present && !Array.isArray(values.promptTemplate)) return null
    return snapshotJson({ ownerId, present, promptTemplate: values.promptTemplate })
  }

  const owner = uniquePromptPresetOwner(ownerId)
  return owner ? snapshotJson({ ownerId, owner }) : null
}

function snapshotJson(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? '__undefined__' : snapshot
}

/**
 * Apply a prompt-template resource to its explicit preset owner. Modern owner
 * bodies update only the preset row; the aggregate field is touched only for
 * an explicit legacy owner or selected default-scaffold fallback.
 */
export function applyPromptTemplateProjectionFields(
  fields: Partial<Database>,
  ownerId: string | null = currentPromptTemplateOwnerId(),
  options: {
    applyCompatibilityProjection?: boolean
    selectedFallbackPromptTemplate?: Database['promptTemplate']
  } = {},
): boolean {
  const hasPromptTemplate = Object.prototype.hasOwnProperty.call(fields, 'promptTemplate')
  const promptTemplate = (fields as Record<string, unknown>).promptTemplate
  if (hasPromptTemplate && promptTemplate !== null && !Array.isArray(promptTemplate)) return false
  const normalizedPromptTemplate = hasPromptTemplate ? normalizePromptTemplate(promptTemplate) : null

  if (ownerId === null) {
    if (collectionsResourceState.statuses.promptTemplate !== 'ready') return false
    if (hasPromptTemplate) {
      if (promptTemplate === null) {
        delete collectionsResourceState.values.promptTemplate
      } else {
        collectionsResourceState.values.promptTemplate = normalizedPromptTemplate as Database['promptTemplate']
      }
    }
    return true
  }

  const normalizedSelectedFallback =
    options.selectedFallbackPromptTemplate === undefined
      ? undefined
      : normalizePromptTemplate(options.selectedFallbackPromptTemplate)
  const presets = canonicalPromptPresetCollection()
  const preset = presets ? resolveUniquePromptPreset(presets, ownerId) : undefined
  if (!preset) return false

  const applyCompatibilityProjection = options.applyCompatibilityProjection ?? false
  if (applyCompatibilityProjection) {
    const currentOwner = currentPromptTemplateOwnerResolution()
    if (
      currentOwner.status !== 'ready' ||
      currentOwner.ownerId !== ownerId ||
      collectionsResourceState.statuses.promptTemplate !== 'ready'
    ) {
      return false
    }
  }

  const nextPreset = JSON.parse(JSON.stringify(preset)) as PromptPreset
  if (hasPromptTemplate) {
    if (promptTemplate === null) {
      delete nextPreset.promptTemplate
    } else {
      nextPreset.promptTemplate = normalizedPromptTemplate as PromptPreset['promptTemplate']
    }
  }
  collectionsResourceState.values.promptPresets = presets.map((candidate) =>
    candidate === preset ? nextPreset : candidate,
  ) as Database['promptPresets']

  if (applyCompatibilityProjection && hasPromptTemplate) {
    if (normalizedSelectedFallback !== undefined) {
      collectionsResourceState.values.promptTemplate = normalizedSelectedFallback as Database['promptTemplate']
    } else if (promptTemplate === null) {
      delete collectionsResourceState.values.promptTemplate
    } else {
      collectionsResourceState.values.promptTemplate = normalizedPromptTemplate as Database['promptTemplate']
    }
  }
  return true
}

function localPromptTemplateOwnerIsResolved(promptPresetId: string | null): boolean {
  if (promptPresetId === null) {
    const snapshot = promptTemplateOwnerSnapshot(null)
    return snapshot !== null && Object.prototype.hasOwnProperty.call(collectionsResourceState.values, 'promptTemplate')
  }
  const preset = uniquePromptPresetOwner(promptPresetId)
  return !!preset && Object.prototype.hasOwnProperty.call(preset, 'promptTemplate')
}

function uniquePromptPresetOwner(promptPresetId: string): PromptPreset | undefined {
  const presets = canonicalPromptPresetCollection()
  return resolveUniquePromptPreset(presets, promptPresetId) as PromptPreset | undefined
}

type PromptTemplateOwnerResolution = { status: 'ready'; ownerId: string | null } | { status: 'unavailable' | 'invalid' }

function resolveRequestedPromptTemplateOwner(promptPresetId: string | null | undefined): PromptTemplateOwnerResolution {
  if (promptPresetId === undefined) return currentPromptTemplateOwnerResolution()
  if (promptPresetId === null) {
    return collectionsResourceState.statuses.promptTemplate === 'ready'
      ? { status: 'ready', ownerId: null }
      : { status: 'unavailable' }
  }
  if (typeof promptPresetId !== 'string' || promptPresetId.trim() === '') return { status: 'invalid' }
  return uniquePromptPresetOwner(promptPresetId)
    ? { status: 'ready', ownerId: promptPresetId }
    : collectionsResourceState.statuses.promptPresets === 'ready'
      ? { status: 'invalid' }
      : { status: 'unavailable' }
}

function currentPromptTemplateOwnerResolution(): PromptTemplateOwnerResolution {
  if (settingsResourceState.standaloneStatuses.promptPresetsId !== 'ready') {
    return { status: 'unavailable' }
  }
  const selectedIndex = (settingsResourceState.value as Record<string, unknown>).promptPresetsId
  if (selectedIndex === undefined || selectedIndex === -1) return { status: 'ready', ownerId: null }
  const presets = canonicalPromptPresetCollection()
  if (!presets) return { status: 'invalid' }
  if (
    !Number.isInteger(selectedIndex) ||
    (selectedIndex as number) < 0 ||
    (selectedIndex as number) >= presets.length
  ) {
    return { status: 'invalid' }
  }
  const preset = presets[selectedIndex as number]
  return preset && typeof preset.id === 'string' ? { status: 'ready', ownerId: preset.id } : { status: 'invalid' }
}

function canonicalPromptPresetCollection(): PromptPreset[] | null {
  if (collectionsResourceState.statuses.promptPresets !== 'ready') return null
  const presets = collectionsResourceState.values.promptPresets
  if (!Array.isArray(presets)) return null
  const seen = new Set<string>()
  for (const preset of presets) {
    if (!preset || typeof preset !== 'object' || typeof preset.id !== 'string' || preset.id.trim() === '') return null
    if (seen.has(preset.id)) return null
    seen.add(preset.id)
  }
  return presets as PromptPreset[]
}

function promptTemplateCollectionRevision(ownerId: string | null): number | null {
  const collectionName = ownerId === null ? 'promptTemplate' : 'promptPresets'
  const revision = collectionsResourceState.revisions[collectionName]
  return Number.isInteger(revision) && (revision as number) >= 0 ? (revision as number) : null
}

function promptTemplateHydrationWarning(message: string): void {
  console.warn(`promptTemplate hydration failed: ${message}`)
}
