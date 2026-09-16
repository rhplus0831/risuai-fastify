import type { DatabaseSync } from 'node:sqlite'
import type { ResolvedModelProfile } from '@risuai/shared-core/model-profile-resolver'
import type { WorkingGenerationSettings } from './prompt/serverTypes.js'
import { readProviderCredentials } from '@risuai/shared-core/provider-credential-records'

/** Refresh only authentication for the accepted ID. The accepted profile owns
 * provider, endpoint, model and options even when its live editor row changes. */
export function refreshAcceptedProfileCredential(
  sqlite: DatabaseSync | undefined,
  settings: Pick<WorkingGenerationSettings, 'acceptedCredentialPolicy' | 'modelProfiles' | 'providerCredentials'>,
  profile: ResolvedModelProfile,
): ResolvedModelProfile {
  if (settings.acceptedCredentialPolicy !== 'live-id-v1') return profile
  const bound = settings.modelProfiles?.find((row) => row.id === profile.profileId)?.providerOptions?.credentialId
  if (!bound) return profile // Legacy flat credentials retain accepted semantics.
  if (!sqlite) throw new Error('generation_credential_authority_missing')
  const row = sqlite.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
  const live = row ? (JSON.parse(row.data_json) as Record<string, unknown>) : {}
  const matches = Array.isArray(live.providerCredentials)
    ? live.providerCredentials.filter((row) => row && typeof row === 'object' && row.id === bound)
    : []
  if (matches.length !== 1) throw new Error('generation_credential_unavailable')
  const credential = readProviderCredentials(matches)[0]
  const accepted = settings.providerCredentials?.find((row) => row.id === bound)
  if (!credential || !accepted || credential.type !== accepted.type) {
    throw new Error('generation_credential_unavailable')
  }
  const options = { ...profile.providerOptions }
  if (credential.type === 'apiKey') {
    if (!credential.apiKey?.trim()) throw new Error('generation_credential_unavailable')
    options.apiKey = credential.apiKey
    if (options.ollama) options.ollama = { ...options.ollama, apiKey: credential.apiKey }
    if (options.customModel) options.customModel = { ...options.customModel, key: credential.apiKey }
  } else {
    if (!credential.vertex?.privateKey?.trim() || !credential.vertex.clientEmail?.trim()) {
      throw new Error('generation_credential_unavailable')
    }
    // The service-account identity is part of the binding; only its key rotates.
    if (credential.vertex.clientEmail !== accepted.vertex?.clientEmail) {
      throw new Error('generation_credential_identity_changed')
    }
    options.vertex = {
      ...options.vertex,
      privateKey: credential.vertex.privateKey,
      clientEmail: credential.vertex.clientEmail,
    }
  }
  return { ...profile, providerOptions: options }
}
