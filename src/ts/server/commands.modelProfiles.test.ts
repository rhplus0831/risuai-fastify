import { makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  createAndBindModelProfileCommand,
  createModelProfileCommand,
  createProviderCredentialCommand,
  convertLegacyModelProfilesCommand,
  deleteModelProfileCommand,
  deleteProviderCredentialCommand,
  duplicateModelProfileCommand,
  reorderModelProfilesCommand,
  updateModelProfileCommand,
  updateProviderCredentialCommand,
  updateModelRoleProfilesCommand,
  updateModelRuntimeDefaultsCommand,
} from './commands'

describe('model profile and credential command adapters', () => {
  it('dispatches model profile commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      const event = { type: 'modelProfile.test', revision: 99, resource: 'modelProfile' }
      if (url.endsWith('/model-profiles/source-profile/duplicate')) {
        return { revision: 99, event, profileId: 'copy-profile', sourceProfileId: 'source-profile' }
      }
      if (url.endsWith('/model-profiles/create-and-bind')) {
        return { revision: 99, event, profileId: 'bound-profile', role: 'memory' }
      }
      if (url.endsWith('/model-profiles/convert-legacy')) {
        return { revision: 99, event, profileIdsByRole: { chatMain: 'main-profile' }, convertedRoles: ['chatMain'] }
      }
      if (url.endsWith('/model-role-profiles')) {
        return { revision: 99, event, roles: ['memory'] }
      }
      if (url.endsWith('/model-runtime-defaults')) {
        return { revision: 99, event }
      }
      if (url.endsWith('/model-profiles/profile-a')) {
        return { revision: 99, event, profileId: 'profile-a', reassignedRoles: ['memory'] }
      }
      return { revision: 99, event, profileId: 'new-profile' }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createModelProfileCommand({
      baseRevision: 1,
      profile: { name: 'Created', modelId: 'gpt-5' },
    })
    await updateModelProfileCommand({
      baseRevision: 2,
      profileId: 'profile-a',
      profile: { id: 'profile-a', name: 'Updated', modelId: 'gpt-4o' },
      expectedProfile: { id: 'profile-a', name: 'Original', modelId: 'gpt-4' },
    })
    await duplicateModelProfileCommand({
      baseRevision: 3,
      profileId: 'source-profile',
      name: 'Copy',
    })
    await reorderModelProfilesCommand({
      baseRevision: 4,
      order: [
        { kind: 'profile', profileId: 'profile-b' },
        { kind: 'divider', id: 'divider-a' },
        { kind: 'profile', profileId: 'profile-a' },
      ],
    })
    await deleteModelProfileCommand({
      baseRevision: 5,
      profileId: 'profile-a',
      reassignments: { memory: { mode: 'inherit' } },
    })
    await updateModelRoleProfilesCommand({
      baseRevision: 6,
      bindings: { memory: { mode: 'profile', profileId: 'profile-a' } },
      modelPresetId: 'model-preset-a',
    })
    await createAndBindModelProfileCommand({
      baseRevision: 7,
      role: 'memory',
      profile: { name: 'Bound', modelId: 'gpt-5' },
    })
    await updateModelRuntimeDefaultsCommand({
      baseRevision: 8,
      runtimeDefaults: { temperature: 55, stripCoT: true },
    })
    await convertLegacyModelProfilesCommand({
      baseRevision: 9,
    })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/model-profiles',
        method: 'POST',
        body: {
          baseRevision: 1,
          profile: { name: 'Created', modelId: 'gpt-5' },
        },
      },
      {
        url: '/api/v1/commands/model-profiles/profile-a',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          profile: { id: 'profile-a', name: 'Updated', modelId: 'gpt-4o' },
          expectedProfile: { id: 'profile-a', name: 'Original', modelId: 'gpt-4' },
        },
      },
      {
        url: '/api/v1/commands/model-profiles/source-profile/duplicate',
        method: 'POST',
        body: {
          baseRevision: 3,
          name: 'Copy',
        },
      },
      {
        url: '/api/v1/commands/model-profiles/reorder',
        method: 'POST',
        body: {
          baseRevision: 4,
          order: [
            { kind: 'profile', profileId: 'profile-b' },
            { kind: 'divider', id: 'divider-a' },
            { kind: 'profile', profileId: 'profile-a' },
          ],
        },
      },
      {
        url: '/api/v1/commands/model-profiles/profile-a',
        method: 'DELETE',
        body: {
          baseRevision: 5,
          reassignments: { memory: { mode: 'inherit' } },
        },
      },
      {
        url: '/api/v1/commands/model-role-profiles',
        method: 'PUT',
        body: {
          baseRevision: 6,
          bindings: { memory: { mode: 'profile', profileId: 'profile-a' } },
          modelPresetId: 'model-preset-a',
        },
      },
      {
        url: '/api/v1/commands/model-profiles/create-and-bind',
        method: 'POST',
        body: {
          baseRevision: 7,
          role: 'memory',
          profile: { name: 'Bound', modelId: 'gpt-5' },
        },
      },
      {
        url: '/api/v1/commands/model-runtime-defaults',
        method: 'PUT',
        body: {
          baseRevision: 8,
          runtimeDefaults: { temperature: 55, stripCoT: true },
        },
      },
      {
        url: '/api/v1/commands/model-profiles/convert-legacy',
        method: 'POST',
        body: {
          baseRevision: 9,
        },
      },
    ])
  })

  it('dispatches provider credential commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch(() => ({
      revision: 99,
      event: { type: 'providerCredential.test', revision: 99, resource: 'providerCredential' },
      credentialId: 'credential-a',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const credential = { id: 'credential-a', name: 'Credential A', type: 'apiKey' as const, apiKey: 'secret' }

    await createProviderCredentialCommand({
      baseRevision: 1,
      credential: { name: credential.name, type: credential.type, apiKey: credential.apiKey },
    })
    await updateProviderCredentialCommand({
      baseRevision: 2,
      credentialId: 'credential/a',
      credential,
      expectedCredential: { ...credential, name: 'Old name' },
    })
    await deleteProviderCredentialCommand({
      baseRevision: 3,
      credentialId: 'credential/a',
    })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/provider-credentials',
        method: 'POST',
        body: {
          baseRevision: 1,
          credential: { name: 'Credential A', type: 'apiKey', apiKey: 'secret' },
        },
      },
      {
        url: '/api/v1/commands/provider-credentials/credential%2Fa',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          credential,
          expectedCredential: { ...credential, name: 'Old name' },
        },
      },
      {
        url: '/api/v1/commands/provider-credentials/credential%2Fa',
        method: 'DELETE',
        body: { baseRevision: 3 },
      },
    ])
  })
})
