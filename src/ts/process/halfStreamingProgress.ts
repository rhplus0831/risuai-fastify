import { writable } from 'svelte/store'

export interface HalfStreamingProgressTarget {
  characterId: string
  chatId: string
  generationId: string
}

export interface ActiveHalfStreamingProgress extends HalfStreamingProgressTarget {
  generatedTokens: number
  tokensPerSecond: number
  firstTokenAt?: number
  updatedAt: number
}

export interface HalfStreamingTokenSample {
  /** Cumulative generated-token count measured by the streaming server. */
  generatedTokens?: number
}

const MAX_ACTIVE_HALF_STREAMING_PROGRESS = 16
const TOKEN_SPEED_WINDOW_MS = 5_000

export const halfStreamingProgress = writable<ActiveHalfStreamingProgress[]>([])

interface HalfStreamingProgressSession extends HalfStreamingProgressTarget {
  latestGeneratedTokens?: number
  arrivalSamples: Array<{ generatedTokens: number; receivedAt: number }>
}

const activeTargets = new Map<string, HalfStreamingProgressSession>()

function targetKey(target: HalfStreamingProgressTarget): string {
  return JSON.stringify([target.characterId, target.chatId, target.generationId])
}

function sameTarget(
  progress: ActiveHalfStreamingProgress,
  target: HalfStreamingProgressTarget,
): progress is ActiveHalfStreamingProgress {
  return (
    progress?.characterId === target.characterId &&
    progress.chatId === target.chatId &&
    progress.generationId === target.generationId
  )
}

function sameChat(
  target: Pick<HalfStreamingProgressTarget, 'characterId' | 'chatId'>,
  characterId: string,
  chatId: string,
): boolean {
  return target.characterId === characterId && target.chatId === chatId
}

function trimActiveTargets(): void {
  while (activeTargets.size > MAX_ACTIVE_HALF_STREAMING_PROGRESS) {
    const oldestKey = activeTargets.keys().next().value
    if (oldestKey === undefined) return
    const oldestTarget = activeTargets.get(oldestKey)
    activeTargets.delete(oldestKey)
    if (oldestTarget) {
      halfStreamingProgress.update((entries) => entries.filter((entry) => !sameTarget(entry, oldestTarget)))
    }
  }
}

export function beginHalfStreamingProgress(target: HalfStreamingProgressTarget): void {
  for (const [key, activeTarget] of activeTargets) {
    if (sameChat(activeTarget, target.characterId, target.chatId)) activeTargets.delete(key)
  }
  const key = targetKey(target)
  activeTargets.set(key, { ...target, arrivalSamples: [] })
  halfStreamingProgress.update((entries) => [
    ...entries.filter((entry) => !sameChat(entry, target.characterId, target.chatId)),
    {
      ...target,
      generatedTokens: 0,
      tokensPerSecond: 0,
      updatedAt: Date.now(),
    },
  ])
  trimActiveTargets()
}

/**
 * Record one provider token frame. Server streams can supply tokenizer-aware
 * cumulative progress so batched gateway deltas retain useful totals. Display
 * throughput uses a trailing client-arrival window; local and older server
 * streams retain the frame-counting fallback within the same window.
 */
export function recordHalfStreamingToken(
  target: HalfStreamingProgressTarget,
  now = Date.now(),
  sample?: HalfStreamingTokenSample,
): void {
  const key = targetKey(target)
  if (!activeTargets.has(key)) return
  const activeTarget = activeTargets.get(key)!
  activeTargets.delete(key)
  activeTargets.set(key, activeTarget)
  halfStreamingProgress.update((current) => {
    const active = current.find((entry) => sameTarget(entry, target))
    if (!active) return current
    const sampledTokens = sample?.generatedTokens
    let generatedTokens: number
    if (typeof sampledTokens === 'number' && Number.isFinite(sampledTokens) && sampledTokens >= 0) {
      generatedTokens = Math.floor(sampledTokens)
      if (activeTarget.latestGeneratedTokens !== undefined && generatedTokens < activeTarget.latestGeneratedTokens) {
        return current
      }
      activeTarget.latestGeneratedTokens = generatedTokens
    } else {
      // Once tokenizer-aware progress is available, incomplete metadata must not
      // turn cumulative token totals back into frame counts.
      if (activeTarget.latestGeneratedTokens !== undefined) return current
      generatedTokens = active.generatedTokens + 1
    }

    const latestArrival = activeTarget.arrivalSamples.at(-1)
    const receivedAt = Math.max(Number.isFinite(now) ? now : Date.now(), latestArrival?.receivedAt ?? -Infinity)
    if (generatedTokens > 0 || latestArrival) {
      const currentSample = { generatedTokens, receivedAt }
      if (latestArrival?.receivedAt === receivedAt) {
        activeTarget.arrivalSamples[activeTarget.arrivalSamples.length - 1] = currentSample
      } else {
        activeTarget.arrivalSamples.push(currentSample)
      }
    }

    const cutoff = receivedAt - TOKEN_SPEED_WINDOW_MS
    while (activeTarget.arrivalSamples.length > 2 && activeTarget.arrivalSamples[1].receivedAt <= cutoff) {
      activeTarget.arrivalSamples.shift()
    }

    const firstArrival = activeTarget.arrivalSamples[0]
    const secondArrival = activeTarget.arrivalSamples[1]
    const lastArrival = activeTarget.arrivalSamples.at(-1)
    let windowStartedAt = firstArrival?.receivedAt ?? receivedAt
    let windowStartTokens = firstArrival?.generatedTokens ?? generatedTokens
    if (firstArrival && secondArrival && firstArrival.receivedAt < cutoff) {
      const sampleSpan = secondArrival.receivedAt - firstArrival.receivedAt
      if (sampleSpan > 0) {
        const cutoffFraction = (cutoff - firstArrival.receivedAt) / sampleSpan
        windowStartedAt = cutoff
        windowStartTokens =
          firstArrival.generatedTokens + (secondArrival.generatedTokens - firstArrival.generatedTokens) * cutoffFraction
      }
    }
    const windowElapsedMs = lastArrival ? lastArrival.receivedAt - windowStartedAt : 0
    const tokensPerSecond =
      lastArrival && windowElapsedMs > 0
        ? Math.max(0, lastArrival.generatedTokens - windowStartTokens) / (windowElapsedMs / 1000)
        : 0
    const next = {
      ...active,
      generatedTokens,
      tokensPerSecond,
      firstTokenAt: active.firstTokenAt ?? (generatedTokens > 0 ? receivedAt : undefined),
      updatedAt: receivedAt,
    }
    return current.map((entry) => (sameTarget(entry, target) ? next : entry))
  })
}

export function clearHalfStreamingProgress(target: HalfStreamingProgressTarget): void {
  const key = targetKey(target)
  if (!activeTargets.has(key)) return
  activeTargets.delete(key)
  halfStreamingProgress.update((entries) => entries.filter((entry) => !sameTarget(entry, target)))
}

export function clearHalfStreamingProgressForChat(characterId: string, chatId: string): void {
  for (const [key, target] of activeTargets) {
    if (sameChat(target, characterId, chatId)) activeTargets.delete(key)
  }
  halfStreamingProgress.update((entries) => entries.filter((entry) => !sameChat(entry, characterId, chatId)))
}

export function resetHalfStreamingProgressForTests(): void {
  activeTargets.clear()
  halfStreamingProgress.set([])
}
