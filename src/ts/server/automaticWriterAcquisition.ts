import { fetchServerSettingsGroup } from './resourceReads'

export type AutoAcquireDisconnectedWriterPreference =
  | { status: 'ok'; enabled: boolean; attempts: number }
  | { status: 'unavailable'; attempts: number }

/** One request rarely fails alone right after a successful bootstrap read; absorb a short flap here. */
const PREFERENCE_READ_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Read the server policy that decides whether a disconnected writer may be
 * acquired automatically. `unavailable` is not an answer: callers that would
 * otherwise settle a role on it must retry or defer instead.
 */
export async function readAutoAcquireDisconnectedWriterPreference(
  signal?: AbortSignal | null,
): Promise<AutoAcquireDisconnectedWriterPreference> {
  for (let attempts = 1; ; attempts++) {
    const result = await fetchServerSettingsGroup('sidebar', signal)
    if (result.status === 'ok') {
      return { status: 'ok', enabled: result.settings.autoAcquireDisconnectedWriter !== false, attempts }
    }
    const retryDelay = PREFERENCE_READ_RETRY_DELAYS_MS[attempts - 1]
    if (retryDelay === undefined || signal?.aborted) return { status: 'unavailable', attempts }
    await delay(retryDelay, signal)
    if (signal?.aborted) return { status: 'unavailable', attempts }
  }
}

/** Read server policy before acquisition; an unavailable preference never grants takeover. */
export async function shouldAutoAcquireDisconnectedWriter(signal?: AbortSignal | null): Promise<boolean> {
  const preference = await readAutoAcquireDisconnectedWriterPreference(signal)
  return preference.status === 'ok' && preference.enabled
}
