import { Sha256 } from '@aws-crypto/sha256-js'
import { get, writable } from 'svelte/store'
import type { MessageTranslation } from '../storage/database.svelte'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import { getTranslatorSettingsSignatureKey } from '../translator/translator'
import type { ActiveGreetingTranslation } from './bootstrap'

const CHARACTERS_ENDPOINT = '/api/v1/characters'
const ACTIVE_GREETING_TRANSLATION_REFRESH_MS = 5_000

export interface GreetingTranslationProjectionEntry {
  greetingIndex: number
  translation: MessageTranslation
}

export interface GreetingTranslationProjection {
  revision: number
  characterId: string
  chatId: string
  settingsHash: string | null
  clientSettingsSignature: string
  translations: GreetingTranslationProjectionEntry[]
}

export type GreetingTranslationProjectionReadResult =
  | ({ status: 'ok' } & GreetingTranslationProjection)
  | { status: 'error'; error: string }
  | { status: 'unavailable' }

const projectionByTarget = new Map<string, GreetingTranslationProjection>()
const requestEpochByTarget = new Map<string, number>()
export const greetingTranslationProjectionVersion = writable(0)

export const activeGreetingTranslations = writable<ActiveGreetingTranslation[]>([])
const locallyStartedGreetingJobIds = new Set<string>()
let refreshWired = false
let refreshGeneration = 0
let refreshInFlight = false
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let stopRefreshSubscription: (() => void) | null = null

function bumpProjectionVersion(): void {
  greetingTranslationProjectionVersion.update((value) => value + 1)
}

function cloneTranslation(translation: MessageTranslation): MessageTranslation {
  return { ...translation }
}

function cloneProjection(projection: GreetingTranslationProjection): GreetingTranslationProjection {
  return {
    ...projection,
    translations: projection.translations.map((entry) => ({
      greetingIndex: entry.greetingIndex,
      translation: cloneTranslation(entry.translation),
    })),
  }
}

export function currentGreetingTranslatorSettingsSignature(): string {
  return getTranslatorSettingsSignatureKey()
}

function greetingTranslationTargetKey(characterId: string, chatId: string): string {
  return JSON.stringify([characterId, chatId])
}

export function getGreetingTranslationProjection(
  characterId: string,
  chatId: string,
): GreetingTranslationProjection | null {
  const projection = projectionByTarget.get(greetingTranslationTargetKey(characterId, chatId))
  return projection ? cloneProjection(projection) : null
}

export function clearGreetingTranslationProjection(characterId?: string, chatId?: string): void {
  if (characterId === undefined) {
    const hadProjection = projectionByTarget.size > 0
    projectionByTarget.clear()
    for (const [key, epoch] of requestEpochByTarget) requestEpochByTarget.set(key, epoch + 1)
    if (hadProjection) bumpProjectionVersion()
    return
  }
  let changed = false
  for (const [key, projection] of projectionByTarget) {
    if (projection.characterId !== characterId || (chatId !== undefined && projection.chatId !== chatId)) continue
    requestEpochByTarget.set(key, (requestEpochByTarget.get(key) ?? 0) + 1)
    projectionByTarget.delete(key)
    changed = true
  }
  if (changed) bumpProjectionVersion()
}

export function applyGreetingTranslationProjection(
  projection: GreetingTranslationProjection,
  options: { force?: boolean } = {},
): boolean {
  if (!isGreetingTranslationProjection(projection)) return false
  const key = greetingTranslationTargetKey(projection.characterId, projection.chatId)
  const current = projectionByTarget.get(key)
  if (!options.force && current && projection.revision < current.revision) return false
  projectionByTarget.set(key, cloneProjection(projection))
  bumpProjectionVersion()
  return true
}

export function applyGreetingTranslationCommandReceipt(input: {
  revision: number
  characterId: string
  chatId: string
  greetingIndex: number
  settingsHash: string
  clientSettingsSignature: string
  translation: MessageTranslation
}): boolean {
  if (!isMessageTranslation(input.translation) || input.translation.settingsHash !== input.settingsHash) return false
  const current = projectionByTarget.get(greetingTranslationTargetKey(input.characterId, input.chatId))
  if (
    !current ||
    current.clientSettingsSignature !== input.clientSettingsSignature ||
    current.settingsHash !== input.settingsHash ||
    input.revision < current.revision
  ) {
    return false
  }
  return applyGreetingTranslationProjection({
    ...current,
    revision: input.revision,
    translations: [
      ...current.translations.filter((entry) => entry.greetingIndex !== input.greetingIndex),
      { greetingIndex: input.greetingIndex, translation: cloneTranslation(input.translation) },
    ].sort((left, right) => left.greetingIndex - right.greetingIndex),
  })
}

export function findGreetingTranslation(input: {
  characterId: string
  chatId: string
  greetingIndex: number
  source: string
  clientSettingsSignature: string
}): MessageTranslation | null {
  get(greetingTranslationProjectionVersion)
  const projection = projectionByTarget.get(greetingTranslationTargetKey(input.characterId, input.chatId))
  if (
    !projection ||
    projection.clientSettingsSignature !== input.clientSettingsSignature ||
    projection.settingsHash === null
  ) {
    return null
  }
  const entry = projection.translations.find((candidate) => candidate.greetingIndex === input.greetingIndex)
  if (!entry || entry.translation.settingsHash !== projection.settingsHash) return null
  return entry.translation.sourceHash === sha256HexSync(input.source) ? cloneTranslation(entry.translation) : null
}

export async function refreshGreetingTranslationProjection(
  characterId: string,
  chatId: string,
  options: { clientSettingsSignature?: string; clearBeforeFetch?: boolean; minimumRevision?: number } = {},
): Promise<GreetingTranslationProjectionReadResult> {
  if (typeof characterId !== 'string' || characterId.trim() === '') {
    return { status: 'error', error: 'Character id is required' }
  }
  if (typeof chatId !== 'string' || chatId.trim() === '') {
    return { status: 'error', error: 'Chat id is required' }
  }
  const clientSettingsSignature = options.clientSettingsSignature ?? currentGreetingTranslatorSettingsSignature()
  const key = greetingTranslationTargetKey(characterId, chatId)
  const current = projectionByTarget.get(key)
  if (
    options.clearBeforeFetch ||
    (current !== undefined && current.clientSettingsSignature !== clientSettingsSignature)
  ) {
    clearGreetingTranslationProjection(characterId, chatId)
  }
  const requestEpoch = (requestEpochByTarget.get(key) ?? 0) + 1
  requestEpochByTarget.set(key, requestEpoch)
  const result = await fetchGreetingTranslationProjection(characterId, chatId, clientSettingsSignature)
  if (result.status !== 'ok') return result
  if (requestEpochByTarget.get(key) !== requestEpoch || result.clientSettingsSignature !== clientSettingsSignature) {
    return result
  }
  if (options.minimumRevision !== undefined && result.revision < options.minimumRevision) {
    return { status: 'error', error: 'Greeting translation projection is older than the invalidating event' }
  }
  applyGreetingTranslationProjection(result)
  return result
}

export async function fetchGreetingTranslationProjection(
  characterId: string,
  chatId: string,
  clientSettingsSignature = currentGreetingTranslatorSettingsSignature(),
  signal?: AbortSignal | null,
): Promise<GreetingTranslationProjectionReadResult> {
  let response: Response
  try {
    const auth = await getNodeServerProxyAuth()
    const url = `${CHARACTERS_ENDPOINT}/${encodeURIComponent(characterId)}/greeting-translations?chatId=${encodeURIComponent(chatId)}`
    response = await fetch(url, {
      method: 'GET',
      signal: signal ?? undefined,
      headers: { 'risu-auth': auth },
    })
  } catch (error) {
    return { status: 'error', error: `Network error: ${error instanceof Error ? error.message : String(error)}` }
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {}
  if (!response.ok) {
    return { status: 'error', error: errorMessageFromBody(body, `HTTP ${response.status}`) }
  }
  const projection = parseGreetingTranslationProjection(body, clientSettingsSignature)
  return projection
    ? { status: 'ok', ...projection }
    : { status: 'error', error: 'Invalid greeting translations response' }
}

function greetingJobKey(
  job: Pick<ActiveGreetingTranslation, 'characterId' | 'chatId' | 'greetingIndex' | 'settingsHash'>,
): string {
  return JSON.stringify([job.characterId, job.chatId, job.greetingIndex, job.settingsHash])
}

export function setActiveGreetingTranslations(jobs: readonly ActiveGreetingTranslation[]): void {
  const remote = jobs.map((job) => ({ ...job }))
  const remoteTargets = new Set(remote.map(greetingJobKey))
  for (const job of remote) locallyStartedGreetingJobIds.delete(job.jobId)
  activeGreetingTranslations.update((current) => [
    ...remote,
    ...current.filter(
      (job) =>
        job.status === 'running' &&
        locallyStartedGreetingJobIds.has(job.jobId) &&
        !remoteTargets.has(greetingJobKey(job)),
    ),
  ])
}

export function beginActiveGreetingTranslation(job: ActiveGreetingTranslation & { status: 'running' }): boolean {
  let started = false
  const key = greetingJobKey(job)
  activeGreetingTranslations.update((jobs) => {
    if (jobs.some((candidate) => greetingJobKey(candidate) === key && candidate.status === 'running')) return jobs
    started = true
    locallyStartedGreetingJobIds.add(job.jobId)
    return [...jobs.filter((candidate) => greetingJobKey(candidate) !== key), { ...job }]
  })
  return started
}

export function publishSettledGreetingTranslation(
  job: ActiveGreetingTranslation & { status: 'succeeded' | 'failed' },
): void {
  const key = greetingJobKey(job)
  activeGreetingTranslations.update((jobs) => {
    const current = jobs.find((candidate) => greetingJobKey(candidate) === key)
    if (current?.status === 'running' && current.jobId !== job.jobId) return jobs
    locallyStartedGreetingJobIds.delete(job.jobId)
    return [...jobs.filter((candidate) => greetingJobKey(candidate) !== key), { ...job }]
  })
}

export function isCurrentGreetingTranslationJob(
  characterId: string,
  chatId: string,
  greetingIndex: number,
  settingsHash: string,
  jobId: string,
): boolean {
  return get(activeGreetingTranslations).some(
    (job) =>
      job.characterId === characterId &&
      job.chatId === chatId &&
      job.greetingIndex === greetingIndex &&
      job.settingsHash === settingsHash &&
      job.jobId === jobId &&
      job.status === 'running',
  )
}

export function clearGreetingTranslationJob(jobId: string): void {
  locallyStartedGreetingJobIds.delete(jobId)
  activeGreetingTranslations.update((jobs) => jobs.filter((job) => job.jobId !== jobId))
}

export function clearActiveGreetingTranslation(characterId: string, greetingIndex?: number): void {
  activeGreetingTranslations.update((jobs) => {
    for (const job of jobs) {
      if (job.characterId === characterId && (greetingIndex === undefined || job.greetingIndex === greetingIndex)) {
        locallyStartedGreetingJobIds.delete(job.jobId)
      }
    }
    return jobs.filter(
      (job) => job.characterId !== characterId || (greetingIndex !== undefined && job.greetingIndex !== greetingIndex),
    )
  })
}

export function startActiveGreetingTranslationRefresh(): void {
  if (refreshWired) return
  refreshWired = true
  stopRefreshSubscription = activeGreetingTranslations.subscribe(scheduleActiveGreetingTranslationRefresh)
}

export function stopActiveGreetingTranslationRefresh(): void {
  refreshWired = false
  refreshGeneration += 1
  refreshInFlight = false
  stopRefreshSubscription?.()
  stopRefreshSubscription = null
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = null
}

function scheduleActiveGreetingTranslationRefresh(jobs: readonly ActiveGreetingTranslation[]): void {
  if (!jobs.some((job) => job.status === 'running')) {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = null
    return
  }
  if (!refreshWired || refreshInFlight || refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshActiveGreetingTranslations()
  }, ACTIVE_GREETING_TRANSLATION_REFRESH_MS)
}

async function refreshActiveGreetingTranslations(): Promise<void> {
  if (!refreshWired || refreshInFlight) return
  const generation = refreshGeneration
  const jobsAtStart = get(activeGreetingTranslations)
  if (!jobsAtStart.some((job) => job.status === 'running')) return
  refreshInFlight = true
  try {
    const { fetchServerBootstrapReadOnly } = await import('./bootstrap')
    if (!refreshWired || generation !== refreshGeneration) return
    const bootstrap = await fetchServerBootstrapReadOnly(null, { cacheRevision: false })
    // A command receipt, newer snapshot or UI settlement owns any intervening
    // change. A retired reader also cannot publish into its replacement.
    if (
      refreshWired &&
      generation === refreshGeneration &&
      get(activeGreetingTranslations) === jobsAtStart &&
      bootstrap.status === 'ok'
    ) {
      setActiveGreetingTranslations(bootstrap.bootstrap.activeGreetingTranslations ?? [])
    }
  } catch (error) {
    console.warn('Greeting translation pending refresh failed', error)
  } finally {
    if (generation === refreshGeneration) {
      refreshInFlight = false
      if (refreshWired) scheduleActiveGreetingTranslationRefresh(get(activeGreetingTranslations))
    }
  }
}

function parseGreetingTranslationProjection(
  value: unknown,
  clientSettingsSignature: string,
): GreetingTranslationProjection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 0 ||
    typeof record.characterId !== 'string' ||
    typeof record.chatId !== 'string' ||
    (record.settingsHash !== null && typeof record.settingsHash !== 'string') ||
    !Array.isArray(record.translations)
  ) {
    return null
  }
  const translations: GreetingTranslationProjectionEntry[] = []
  const seen = new Set<number>()
  for (const value of record.translations) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const entry = value as Record<string, unknown>
    if (
      !Number.isInteger(entry.greetingIndex) ||
      (entry.greetingIndex as number) < -1 ||
      seen.has(entry.greetingIndex as number) ||
      !isMessageTranslation(entry.translation)
    ) {
      return null
    }
    if (entry.translation.settingsHash !== record.settingsHash) return null
    seen.add(entry.greetingIndex as number)
    translations.push({
      greetingIndex: entry.greetingIndex as number,
      translation: cloneTranslation(entry.translation),
    })
  }
  return {
    revision: record.revision as number,
    characterId: record.characterId,
    chatId: record.chatId,
    settingsHash: record.settingsHash as string | null,
    clientSettingsSignature,
    translations,
  }
}

function isGreetingTranslationProjection(value: unknown): value is GreetingTranslationProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Number.isSafeInteger(record.revision) &&
    (record.revision as number) >= 0 &&
    typeof record.characterId === 'string' &&
    typeof record.chatId === 'string' &&
    (record.settingsHash === null || typeof record.settingsHash === 'string') &&
    typeof record.clientSettingsSignature === 'string' &&
    Array.isArray(record.translations) &&
    record.translations.every(
      (entry) =>
        !!entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        Number.isInteger((entry as Record<string, unknown>).greetingIndex) &&
        isMessageTranslation((entry as Record<string, unknown>).translation),
    )
  )
}

function isMessageTranslation(value: unknown): value is MessageTranslation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.text === 'string' &&
    record.source === 'raw' &&
    typeof record.sourceHash === 'string' &&
    typeof record.targetLanguage === 'string' &&
    typeof record.inputLanguage === 'string' &&
    (record.translatorType === 'google' ||
      record.translatorType === 'deepl' ||
      record.translatorType === 'deeplX' ||
      record.translatorType === 'llm') &&
    typeof record.settingsHash === 'string' &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt)
  )
}

function sha256HexSync(value: string): string {
  const hash = new Sha256()
  hash.update(new TextEncoder().encode(value))
  return Array.from(hash.digestSync(), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    if (typeof record.error === 'string') return record.error
    if (typeof record.reason === 'string') return record.reason
  }
  return fallback
}
