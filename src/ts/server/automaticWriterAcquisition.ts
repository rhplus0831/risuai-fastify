import { fetchServerSettingsGroup } from './resourceReads'

/** Read server policy before acquisition; an unavailable preference never grants takeover. */
export async function shouldAutoAcquireDisconnectedWriter(signal?: AbortSignal | null): Promise<boolean> {
  const result = await fetchServerSettingsGroup('sidebar', signal)
  return result.status === 'ok' && result.settings.autoAcquireDisconnectedWriter !== false
}
