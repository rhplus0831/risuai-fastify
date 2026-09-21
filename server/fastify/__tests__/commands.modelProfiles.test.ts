import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MASKED_PROVIDER_SECRET } from '../src/providerSecrets.js'
import { MODEL_ROLES } from '@risuai/shared-core/model-roles'
import type { FastifyDatabase as Database } from '../src/prompt/serverTypes.js'
import { LLMFlags, LLMFormat } from '@risuai/shared-core/model-types'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  startHarness,
  stopHarness,
  loadPersistedFromDir,
  importDatabase,
} from './helpers/commandHarness.js'

let harness: Harness

describe('model profile and credential commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('accepts durable model profile selected-model settings through the provider compatibility group', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      aiModel: 'flat-main-model',
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          providerCredentials: [
            {
              id: ' credential-vertex ',
              name: ' Vertex ',
              type: 'vertexServiceAccount',
              vertex: {
                clientEmail: ' svc@example.iam.gserviceaccount.com ',
                privateKey: ' private-key ',
              },
            },
          ],
          modelProfiles: [
            {
              id: ' profile-a ',
              name: ' Primary ',
              providerId: ' vertex ',
              modelId: ' gpt-5 ',
              providerOptions: {
                credentialId: ' credential-vertex ',
                requestModel: ' wire-model ',
                extraHeaders: { 'X-Test': ' yes ' },
                additionalParams: [[' header::X-Test ', ' true ']],
                vertex: {
                  projectId: ' project-a ',
                  region: ' us-central1 ',
                },
              },
              runtimeOptions: {
                maxContext: 32768,
                maxResponse: 2048,
                temperature: 70,
                topP: 0.9,
                frequencyPenalty: -25,
                useStreaming: false,
                genTime: 3,
                extractJson: ' object ',
                jsonSchemaEnabled: true,
                stripCoT: false,
                modelTools: [' tool-a ', ''],
                customFlags: [LLMFlags.hasImageInput],
                customTokenizer: ' custom-tokenizer ',
              },
              fallbacks: [
                { mode: 'profile', profileId: ' fallback-profile ' },
                { mode: 'model', modelId: ' fallback-model ' },
              ],
            },
          ],
          modelRoleProfiles: {
            memory: { mode: 'profile', profileId: ' profile-a ' },
            scriptMain: { mode: 'inherit' },
          },
          modelRuntimeDefaults: {
            maxContext: 8192,
            temperature: 55,
            stripCoT: true,
            modelTools: [' tool-a ', ''],
          },
        },
      },
    })

    expect(res.statusCode, res.body).toBe(200)
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      aiModel: 'flat-main-model',
      providerCredentials: [
        {
          id: 'credential-vertex',
          name: 'Vertex',
          type: 'vertexServiceAccount',
          vertex: {
            clientEmail: 'svc@example.iam.gserviceaccount.com',
            privateKey: 'private-key',
          },
        },
      ],
      modelProfiles: [
        {
          id: 'profile-a',
          name: 'Primary',
          providerId: 'vertex',
          modelId: 'gpt-5',
          providerOptions: {
            credentialId: 'credential-vertex',
            requestModel: 'wire-model',
            extraHeaders: { 'X-Test': 'yes' },
            additionalParams: [['header::X-Test', 'true']],
            vertex: {
              projectId: 'project-a',
              region: 'us-central1',
            },
          },
          runtimeOptions: {
            maxContext: 32768,
            maxResponse: 2048,
            temperature: 70,
            topP: 0.9,
            frequencyPenalty: -25,
            useStreaming: false,
            genTime: 3,
            extractJson: 'object',
            jsonSchemaEnabled: true,
            stripCoT: false,
            modelTools: ['tool-a'],
            customFlags: [LLMFlags.hasImageInput],
            customTokenizer: 'custom-tokenizer',
          },
          fallbacks: [
            { mode: 'profile', profileId: 'fallback-profile' },
            { mode: 'model', modelId: 'fallback-model' },
          ],
        },
      ],
      modelRoleProfiles: {
        ...Object.fromEntries(MODEL_ROLES.map((role) => [role, { mode: 'legacy' }])),
        memory: { mode: 'profile', profileId: 'profile-a' },
        scriptMain: { mode: 'inherit' },
      },
      modelRuntimeDefaults: {
        maxContext: 8192,
        temperature: 55,
        stripCoT: true,
        modelTools: ['tool-a'],
      },
    })
  })

  it('rejects malformed durable model profile scaffold settings', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      aiModel: 'flat-main-model',
    })

    const cases: Array<{ patch: Record<string, unknown>; error: string }> = [
      {
        patch: {
          modelProfiles: [
            { id: 'profile-a', name: 'Primary' },
            { id: ' profile-a ', name: 'Duplicate' },
          ],
        },
        error: 'Duplicate model profile id: profile-a',
      },
      {
        patch: {
          modelProfiles: [{ id: 'profile-a', name: 'Primary', providerOptions: { apiKey: 42 } }],
        },
        error:
          'modelProfiles[0].providerOptions.apiKey is no longer supported; reference a credential via modelProfiles[0].providerOptions.credentialId',
      },
      {
        patch: {
          modelProfiles: [{ id: 'profile-a', name: 'Primary', fallbacks: [{ mode: 'legacy', profileId: 'x' }] }],
        },
        error: 'modelProfiles[0].fallbacks[0].mode must be profile or model',
      },
      {
        patch: {
          modelProfiles: [
            {
              id: 'profile-a',
              name: 'Primary',
              fallbacks: [
                { mode: 'profile', profileId: 'fallback-a' },
                { mode: 'profile', profileId: ' fallback-a ' },
              ],
            },
          ],
        },
        error: 'modelProfiles[0].fallbacks[1].profileId must not duplicate fallback-a',
      },
      {
        patch: {
          modelProfiles: [{ id: 'profile-a', name: 'Primary', providerOptions: { openAIKey: 'not-allowed' } }],
        },
        error: 'modelProfiles[0].providerOptions.openAIKey is not supported',
      },
      {
        patch: {
          modelProfiles: [{ id: 'profile-a', name: 'Primary', providerOptions: { requestModel: 42 } }],
        },
        error: 'modelProfiles[0].providerOptions.requestModel must be a string when present',
      },
      {
        patch: {
          modelProfiles: [{ id: 'profile-a', name: 'Primary', runtimeOptions: { notSupported: true } }],
        },
        error: 'modelProfiles[0].runtimeOptions.notSupported is not supported',
      },
      {
        patch: {
          modelProfiles: [{ id: 'profile-a', name: 'Primary', runtimeOptions: { customFlags: [999] } }],
        },
        error:
          'modelProfiles[0].runtimeOptions.customFlags must be an array of valid LLMFlags numeric values when present',
      },
      {
        patch: {
          modelRuntimeDefaults: { notSupported: true },
        },
        error: 'modelRuntimeDefaults.notSupported is not supported',
      },
      {
        patch: {
          modelRuntimeDefaults: { customFlags: [999] },
        },
        error: 'modelRuntimeDefaults.customFlags must be an array of valid LLMFlags numeric values when present',
      },
      {
        patch: {
          modelRoleProfiles: { unknownRole: { mode: 'legacy' } },
        },
        error: 'Unknown model role profile binding: unknownRole',
      },
      {
        patch: {
          modelRoleProfiles: { memory: { mode: 'profile' } },
        },
        error: 'modelRoleProfiles.memory.profileId must be a non-empty string',
      },
      {
        patch: {
          modelRoleProfiles: { memory: { mode: 'profile', profileId: '' } },
        },
        error: 'modelRoleProfiles.memory.profileId must be a non-empty string',
      },
      {
        patch: {
          modelRoleProfiles: { memory: { mode: 'profile', profileId: 'profile-a', providerOptions: {} } },
        },
        error: 'modelRoleProfiles.memory.providerOptions is not supported',
      },
      {
        patch: {
          modelRoleProfiles: { chatMain: { mode: 'inherit' } },
        },
        error: 'modelRoleProfiles.chatMain.mode does not support inherit',
      },
      {
        patch: {
          modelRoleProfiles: { memory: { mode: 'inherit', profileId: 'profile-a' } },
        },
        error: 'modelRoleProfiles.memory.profileId is only supported for profile mode',
      },
    ]

    for (const candidate of cases) {
      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/settings/providers',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          patch: candidate.patch,
        },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe(candidate.error)
    }
  })

  it('creates and binds a model profile in one revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelProfiles: [],
      providerCredentials: [{ id: 'credential-memory', name: 'Memory', type: 'apiKey', apiKey: 'memory-key' }],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/create-and-bind',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        role: 'memory',
        profile: {
          name: 'Memory Profile',
          providerId: 'openai',
          modelId: 'gpt-5',
          providerOptions: { credentialId: 'credential-memory' },
        },
      },
    })

    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { revision: number; profileId: string; role: string; event: Record<string, unknown> }
    expect(body.revision).toBe(revision + 1)
    expect(body.profileId).toMatch(/^mp_/)
    expect(body.role).toBe('memory')
    expect(body.event).toMatchObject({
      type: 'modelProfile.createdAndBound',
      resource: 'modelProfile',
      id: body.profileId,
      revision: revision + 1,
    })

    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      modelProfiles: [
        {
          id: body.profileId,
          name: 'Memory Profile',
          providerId: 'openai',
          modelId: 'gpt-5',
          providerOptions: { credentialId: 'credential-memory' },
        },
      ],
      modelRoleProfiles: {
        memory: { mode: 'profile', profileId: body.profileId },
      },
    })
  })

  it('rejects missing credential references on profile create, update, and create-and-bind', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [],
      modelProfiles: [{ id: 'profile-a', name: 'Profile A', providerId: 'openai', modelId: 'gpt-5' }],
    })
    const profile = {
      name: 'Missing credential',
      providerId: 'openai',
      modelId: 'gpt-5',
      providerOptions: { credentialId: 'credential-missing' },
    }

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, profile },
    })
    expect(created.statusCode).toBe(400)
    expect(created.json().error).toBe(
      'profile.providerOptions.credentialId must reference an existing provider credential',
    )

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/model-profiles/profile-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        expectedProfile: { id: 'profile-a', name: 'Profile A', providerId: 'openai', modelId: 'gpt-5' },
        profile: { ...profile, id: 'profile-a' },
      },
    })
    expect(updated.statusCode).toBe(400)
    expect(updated.json().error).toBe(
      'profile.providerOptions.credentialId must reference an existing provider credential',
    )

    const bound = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/create-and-bind',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, role: 'memory', profile },
    })
    expect(bound.statusCode).toBe(400)
    expect(bound.json().error).toBe(
      'profile.providerOptions.credentialId must reference an existing provider credential',
    )
  })

  it('updates role bindings and their selected model-preset mirror atomically', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [
        { id: 'credential-anthropic', name: 'Anthropic', type: 'apiKey', apiKey: 'anthropic-secret' },
      ],
      modelProfiles: [
        {
          id: 'profile-a',
          name: 'Profile A',
          providerId: 'debug-echo',
          modelId: 'echo_model',
        },
      ],
      modelPresets: [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
      ],
      modelPresetsId: 0,
    })

    const updated = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/model-role-profiles',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        bindings: { chatMain: { mode: 'profile', profileId: 'profile-a' } },
        modelPresetId: 'model-a',
      },
    })

    expect(updated.statusCode, updated.body).toBe(200)
    expect(updated.json()).toMatchObject({
      revision: revision + 1,
      roles: ['chatMain'],
      event: {
        type: 'modelPreset.updated',
        resource: 'modelPreset',
        id: 'model-a',
      },
    })
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      modelRoleProfiles: Record<string, unknown>
      modelPresets: unknown[]
    }
    expect(persisted.modelRoleProfiles).toMatchObject({
      chatMain: { mode: 'profile', profileId: 'profile-a' },
    })
    expect(persisted.modelPresets).toEqual([
      expect.objectContaining({
        id: 'model-a',
        modelRoleProfiles: expect.objectContaining({
          chatMain: { mode: 'profile', profileId: 'profile-a' },
        }),
      }),
      expect.objectContaining({ id: 'model-b', name: 'Model B' }),
    ])

    const missingPreset = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/model-role-profiles',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 1,
        bindings: { chatAux: { mode: 'profile', profileId: 'profile-a' } },
        modelPresetId: 'missing-preset',
      },
    })
    expect(missingPreset.statusCode).toBe(404)
    const afterRejectedMirror = loadPersistedFromDir(harness.dataDir).database as {
      modelRoleProfiles: Record<string, unknown>
    }
    expect(afterRejectedMirror.modelRoleProfiles).toMatchObject({
      chatAux: { mode: 'legacy' },
    })
  })

  it('rejects a memory role binding that the summary worker cannot execute', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [
        { id: 'credential-anthropic', name: 'Anthropic', type: 'apiKey', apiKey: 'anthropic-secret' },
      ],
      modelProfiles: [
        {
          id: 'anthropic-memory',
          name: 'Anthropic Memory',
          providerId: 'anthropic',
          modelId: 'claude-3-5-sonnet-latest',
          providerOptions: { credentialId: 'credential-anthropic' },
        },
      ],
    })

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/model-role-profiles',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        bindings: { memory: { mode: 'profile', profileId: 'anthropic-memory' } },
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe(
      'bindings.memory is unsupported: summarization memory provider is not API-backed OpenAI-compatible: anthropic',
    )
    const persisted = loadPersistedFromDir(harness.dataDir).database as Database
    expect(persisted.modelRoleProfiles).toMatchObject({
      memory: { mode: 'legacy' },
    })
  })

  it('creates, renames, rotates, and deletes provider credentials with masked placeholder semantics', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [{ id: 'credential-in-use', name: 'In use', type: 'apiKey', apiKey: 'in-use-secret' }],
      modelProfiles: [
        {
          id: 'profile-a',
          name: 'Profile A',
          providerId: 'openai',
          modelId: 'gpt-5',
          providerOptions: { credentialId: 'credential-in-use' },
        },
      ],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/provider-credentials',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        credential: { name: 'Created API key', type: 'apiKey', apiKey: 'created-secret' },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const credentialId = created.json().credentialId as string
    expect(credentialId).toMatch(/^cred_[0-9a-f]{20}$/)
    expect(created.json().event).toMatchObject({
      type: 'providerCredential.created',
      resource: 'providerCredential',
      id: credentialId,
    })

    const renamed = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/provider-credentials/${credentialId}`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        expectedCredential: {
          id: credentialId,
          name: 'Created API key',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
        credential: {
          id: credentialId,
          name: 'Renamed API key',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
      },
    })
    expect(renamed.statusCode, renamed.body).toBe(200)
    expect(
      (
        loadPersistedFromDir(harness.dataDir).database as {
          providerCredentials: Array<Record<string, unknown>>
        }
      ).providerCredentials,
    ).toContainEqual({
      id: credentialId,
      name: 'Renamed API key',
      type: 'apiKey',
      apiKey: 'created-secret',
    })

    const rotated = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/provider-credentials/${credentialId}`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: renamed.json().revision,
        expectedCredential: {
          id: credentialId,
          name: 'Renamed API key',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
        credential: {
          id: credentialId,
          name: 'Renamed API key',
          type: 'apiKey',
          apiKey: 'rotated-secret',
        },
      },
    })
    expect(rotated.statusCode, rotated.body).toBe(200)
    expect(
      (
        loadPersistedFromDir(harness.dataDir).database as {
          providerCredentials: Array<Record<string, unknown>>
        }
      ).providerCredentials,
    ).toContainEqual({
      id: credentialId,
      name: 'Renamed API key',
      type: 'apiKey',
      apiKey: 'rotated-secret',
    })

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/provider-credentials/${credentialId}`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: rotated.json().revision,
        expectedCredential: {
          id: credentialId,
          name: 'Created API key',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
        credential: {
          id: credentialId,
          name: 'Stale rename',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
      },
    })
    expect(stale.statusCode, stale.body).toBe(409)

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/commands/provider-credentials/${credentialId}`,
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: rotated.json().revision },
    })
    expect(deleted.statusCode, deleted.body).toBe(200)

    const inUse = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/provider-credentials/credential-in-use',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: deleted.json().revision },
    })
    expect(inUse.statusCode, inUse.body).toBe(400)
    expect(inUse.json().error).toContain('Profile A (profile-a)')
  })

  it('rejects unresolved masked secrets when changing credential types', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [
        { id: 'credential-api', name: 'API', type: 'apiKey', apiKey: 'api-secret' },
        {
          id: 'credential-vertex',
          name: 'Vertex',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'vertex@example.com', privateKey: 'vertex-secret' },
        },
      ],
    })

    const cases = [
      {
        credentialId: 'credential-api',
        expectedCredential: {
          id: 'credential-api',
          name: 'API',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
        credential: {
          id: 'credential-api',
          name: 'API switched to Vertex',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'switched@example.com', privateKey: MASKED_PROVIDER_SECRET },
        },
      },
      {
        credentialId: 'credential-vertex',
        expectedCredential: {
          id: 'credential-vertex',
          name: 'Vertex',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'vertex@example.com', privateKey: MASKED_PROVIDER_SECRET },
        },
        credential: {
          id: 'credential-vertex',
          name: 'Vertex switched to API',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
      },
    ] as const

    for (const testCase of cases) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/commands/provider-credentials/${testCase.credentialId}`,
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          expectedCredential: testCase.expectedCredential,
          credential: testCase.credential,
        },
      })
      expect(response.statusCode, response.body).toBe(400)
      expect(response.json().error).toBe(
        'Masked provider secret placeholders must resolve before a credential can be saved',
      )
    }

    const unresolvedExpected = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/provider-credentials/credential-api',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        expectedCredential: {
          id: 'credential-api',
          name: 'Wrong expected type',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'wrong@example.com', privateKey: MASKED_PROVIDER_SECRET },
        },
        credential: {
          id: 'credential-api',
          name: 'API rotated',
          type: 'apiKey',
          apiKey: 'new-api-secret',
        },
      },
    })
    expect(unresolvedExpected.statusCode, unresolvedExpected.body).toBe(409)

    expect(
      (
        loadPersistedFromDir(harness.dataDir).database as {
          providerCredentials: Array<Record<string, unknown>>
        }
      ).providerCredentials,
    ).toEqual([
      { id: 'credential-api', name: 'API', type: 'apiKey', apiKey: 'api-secret' },
      {
        id: 'credential-vertex',
        name: 'Vertex',
        type: 'vertexServiceAccount',
        vertex: { clientEmail: 'vertex@example.com', privateKey: 'vertex-secret' },
      },
    ])
  })

  it('rejects stale model profile rows even when the caller has the latest global revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [{ id: 'credential-profile', name: 'Profile', type: 'apiKey', apiKey: 'profile-key' }],
      modelProfiles: [
        {
          id: 'profile-a',
          name: 'Profile A',
          providerId: 'openai',
          modelId: 'gpt-5',
          providerOptions: { credentialId: 'credential-profile', requestModel: 'wire-v1' },
          runtimeOptions: { temperature: 50 },
        },
      ],
    })
    const originalProfile = {
      id: 'profile-a',
      name: 'Profile A',
      providerId: 'openai',
      modelId: 'gpt-5',
      providerOptions: { credentialId: 'credential-profile', requestModel: 'wire-v1' },
      runtimeOptions: { temperature: 50 },
    }
    const concurrentProfile = {
      ...originalProfile,
      providerOptions: { credentialId: 'credential-profile', requestModel: 'wire-v2' },
      runtimeOptions: { temperature: 70 },
    }

    const concurrent = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/model-profiles/profile-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        expectedProfile: originalProfile,
        profile: concurrentProfile,
      },
    })
    expect(concurrent.statusCode, concurrent.body).toBe(200)
    const concurrentRevision = concurrent.json().revision as number

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/model-profiles/profile-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: concurrentRevision,
        expectedProfile: originalProfile,
        profile: { ...originalProfile, name: 'Locally renamed' },
      },
    })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: concurrentRevision })
    expect(
      (loadPersistedFromDir(harness.dataDir).database as { modelProfiles: Array<Record<string, any>> })
        .modelProfiles[0],
    ).toMatchObject({
      name: 'Profile A',
      providerOptions: { credentialId: 'credential-profile', requestModel: 'wire-v2' },
      runtimeOptions: { temperature: 70 },
    })

    const cleared = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/model-profiles/profile-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: concurrentRevision,
        expectedProfile: concurrentProfile,
        profile: {
          ...concurrentProfile,
          providerOptions: { requestModel: 'wire-v2' },
        },
      },
    })
    expect(cleared.statusCode, cleared.body).toBe(200)
    const clearedRevision = cleared.json().revision as number

    const staleCredentialReference = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/model-profiles/profile-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: clearedRevision,
        expectedProfile: concurrentProfile,
        profile: { ...concurrentProfile, name: 'Stale credential edit' },
      },
    })
    expect(staleCredentialReference.statusCode, staleCredentialReference.body).toBe(409)
    const persistedAfterClear = (
      loadPersistedFromDir(harness.dataDir).database as { modelProfiles: Array<Record<string, any>> }
    ).modelProfiles[0]
    expect(persistedAfterClear.name).toBe('Profile A')
    expect(persistedAfterClear.providerOptions).toEqual({ requestModel: 'wire-v2' })
  })

  it('duplicates model profiles while naturally preserving credential references', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [
        {
          id: 'credential-vertex',
          name: 'Vertex',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'svc@example.com', privateKey: 'vertex-private' },
        },
      ],
      modelProfiles: [
        {
          id: 'profile-a',
          name: 'Profile A',
          providerId: 'vertex',
          modelId: 'gemini-2.5-pro-vertex',
          providerOptions: {
            credentialId: 'credential-vertex',
            requestModel: 'wire-model',
            vertex: {
              projectId: 'project-a',
              region: 'us-central1',
            },
          },
        },
      ],
    })

    const duplicated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/profile-a/duplicate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, name: 'Profile Copy' },
    })
    expect(duplicated.statusCode, duplicated.body).toBe(200)
    const duplicatedId = duplicated.json().profileId as string

    const profiles = (loadPersistedFromDir(harness.dataDir).database as { modelProfiles: Array<Record<string, any>> })
      .modelProfiles
    const copied = profiles.find((profile) => profile.id === duplicatedId)
    expect(copied).toMatchObject({
      id: duplicatedId,
      name: 'Profile Copy',
      providerOptions: {
        credentialId: 'credential-vertex',
        requestModel: 'wire-model',
        vertex: {
          projectId: 'project-a',
          region: 'us-central1',
        },
      },
    })
  })

  it('reorders model profiles only with a complete stable-id order', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelProfiles: [
        { id: 'profile-a', name: 'A', modelId: 'gpt-5' },
        { id: 'profile-b', name: 'B', modelId: 'gpt-4o' },
        { id: 'profile-c', name: 'C', modelId: 'claude-sonnet-4-5' },
      ],
    })

    const incomplete = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, profileIds: ['profile-b', 'profile-a'] },
    })
    expect(incomplete.statusCode).toBe(400)
    expect(incomplete.json().error).toBe('profileIds must include every existing model profile exactly once')

    const duplicate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, profileIds: ['profile-a', 'profile-a', 'profile-c'] },
    })
    expect(duplicate.statusCode).toBe(400)
    expect(duplicate.json().error).toBe('Duplicate model profile id: profile-a')

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        order: [
          { kind: 'profile', profileId: 'profile-c' },
          { kind: 'divider', id: 'divider-a' },
          { kind: 'profile', profileId: 'profile-a' },
          { kind: 'profile', profileId: 'profile-b' },
        ],
      },
    })
    expect(reordered.statusCode, reordered.body).toBe(200)
    expect(reordered.json()).toMatchObject({
      revision: revision + 1,
      profileIds: ['profile-c', 'profile-a', 'profile-b'],
      order: [
        { kind: 'profile', profileId: 'profile-c' },
        { kind: 'divider', id: 'divider-a' },
        { kind: 'profile', profileId: 'profile-a' },
        { kind: 'profile', profileId: 'profile-b' },
      ],
      event: { type: 'modelProfile.reordered', resource: 'modelProfile' },
    })
    const database = loadPersistedFromDir(harness.dataDir).database as {
      modelProfiles: Array<Record<string, unknown>>
      modelProfileOrder: Array<Record<string, unknown>>
    }
    expect(database.modelProfiles).toMatchObject([{ id: 'profile-c' }, { id: 'profile-a' }, { id: 'profile-b' }])
    expect(database.modelProfileOrder).toEqual([
      { kind: 'profile', profileId: 'profile-c' },
      { kind: 'divider', id: 'divider-a' },
      { kind: 'profile', profileId: 'profile-a' },
      { kind: 'profile', profileId: 'profile-b' },
    ])
  })

  it('blocks model profile deletion when any Model Preset role binding uses it', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelProfiles: [
        { id: 'profile-main', name: 'Main', modelId: 'gpt-5' },
        { id: 'profile-alt', name: 'Alt', modelId: 'gpt-4o' },
      ],
      modelProfileOrder: [
        { kind: 'profile', profileId: 'profile-main' },
        { kind: 'divider', id: 'divider-a' },
        { kind: 'profile', profileId: 'profile-alt' },
      ],
      modelRoleProfiles: {},
      modelPresets: [
        { id: 'model-a', name: 'Unrelated', modelRoleProfiles: {} },
        {
          id: 'model-b',
          name: 'Uses Main',
          modelRoleProfiles: { memory: { mode: 'profile', profileId: 'profile-main' } },
        },
      ],
      modelPresetsId: 0,
    })

    const blocked = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/model-profiles/profile-main',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, reassignments: {} },
    })
    expect(blocked.statusCode).toBe(400)
    expect(blocked.json().error).toBe('Model profile profile-main is used by Model Presets: Uses Main')
    expect(
      (loadPersistedFromDir(harness.dataDir).database as { modelProfiles: Array<Record<string, unknown>> })
        .modelProfiles,
    ).toMatchObject([{ id: 'profile-main' }, { id: 'profile-alt' }])
  })

  it('validates model profile delete reassignments and applies direct role updates atomically', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelProfiles: [
        { id: 'profile-main', name: 'Main', modelId: 'gpt-5' },
        { id: 'profile-alt', name: 'Alt', modelId: 'gpt-4o' },
      ],
      modelProfileOrder: [
        { kind: 'profile', profileId: 'profile-main' },
        { kind: 'divider', id: 'divider-a' },
        { kind: 'profile', profileId: 'profile-alt' },
      ],
      modelRoleProfiles: {
        chatMain: { mode: 'profile', profileId: 'profile-main' },
        memory: { mode: 'profile', profileId: 'profile-main' },
      },
    })

    const missingMain = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/model-profiles/profile-main',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, reassignments: { memory: { mode: 'inherit' } } },
    })
    expect(missingMain.statusCode).toBe(400)
    expect(missingMain.json().error).toBe('reassignments.chatMain is required')

    const badInherit = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/model-profiles/profile-main',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        reassignments: {
          chatMain: { mode: 'inherit' },
          memory: { mode: 'inherit' },
        },
      },
    })
    expect(badInherit.statusCode).toBe(400)
    expect(badInherit.json().error).toBe('modelRoleProfiles.chatMain.mode does not support inherit')

    const badTarget = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/model-profiles/profile-main',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        reassignments: {
          chatMain: { mode: 'profile', profileId: 'missing-profile' },
          memory: { mode: 'inherit' },
        },
      },
    })
    expect(badTarget.statusCode).toBe(400)
    expect(badTarget.json().error).toBe('reassignments.chatMain.profileId must reference an existing profile')

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/model-profiles/profile-main',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        reassignments: {
          chatMain: { mode: 'legacy' },
          memory: { mode: 'inherit' },
        },
      },
    })
    expect(deleted.statusCode, deleted.body).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: revision + 1,
      profileId: 'profile-main',
      reassignedRoles: ['chatMain', 'memory'],
    })
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      modelProfiles: [{ id: 'profile-alt' }],
      modelProfileOrder: [
        { kind: 'divider', id: 'divider-a' },
        { kind: 'profile', profileId: 'profile-alt' },
      ],
      modelRoleProfiles: {
        chatMain: { mode: 'legacy' },
        memory: { mode: 'inherit' },
      },
    })
  })

  it('rolls back stale legacy conversion without bumping the revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDatabase(harness.app, assertion, {
      aiModel: 'gpt-5',
      subModel: 'claude-sonnet-4-5',
      modelProfiles: [],
    })

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/convert-legacy',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0 },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json()).toMatchObject({ revision: 1 })
    expect(bootstrap.resourceDatabase).toMatchObject({
      modelProfiles: [
        expect.objectContaining({ id: 'mp_legacy_chatMain', modelId: 'gpt-5' }),
        expect.objectContaining({ id: 'mp_legacy_chatAux', modelId: 'claude-sonnet-4-5' }),
      ],
    })
  })

  it('converts legacy model settings into profiles, role bindings, and runtime defaults', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      aiModel: 'gpt-5',
      subModel: 'claude-sonnet-4-5',
      openAIKey: 'openai-key',
      claudeAPIKey: 'claude-key',
      google: { accessToken: 'google-key', projectId: 'vertex-project' },
      vertexClientEmail: 'vertex@example.com',
      vertexPrivateKey: 'vertex-private-key',
      vertexRegion: 'us-central1',
      forceReplaceUrl: 'https://proxy.example.com/chat/risu',
      proxyKey: 'proxy-key',
      customProxyRequestModel: 'local-model',
      customAPIFormat: LLMFormat.OpenAICompatible,
      maxContext: 12345,
      maxResponse: 777,
      temperature: 66,
      top_p: 0.82,
      frequencyPenalty: 51,
      PresensePenalty: 61,
      modelRoles: {
        memory: 'gpt-5',
      },
      seperateModelsForAxModels: true,
      seperateModels: {
        emotion: 'gemini-2.5-flash',
        translate: 'gemini-2.5-pro-vertex',
        scriptAux: 'reverse_proxy',
      },
      seperateParametersEnabled: true,
      seperateParameters: {
        memory: { temperature: 22, top_p: 0.5 },
        otherAx: { temperature: 44 },
        scriptAux: { top_k: 5 },
      },
      fallbackModels: {
        model: ['fallback-main'],
        memory: ['fallback-memory'],
      },
      modelProfiles: [],
    })

    const converted = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/convert-legacy',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })

    expect(converted.statusCode, converted.body).toBe(200)
    const body = converted.json() as {
      profileIdsByRole: Record<string, string>
      convertedRoles: string[]
    }
    expect(body.convertedRoles).toEqual(MODEL_ROLES)
    for (const role of MODEL_ROLES) {
      expect(body.profileIdsByRole[role]).toMatch(/^mp_/)
    }

    const database = loadPersistedFromDir(harness.dataDir).database as {
      modelProfiles: Array<Record<string, any>>
      providerCredentials: Array<Record<string, any>>
      modelRoleProfiles: Record<string, any>
      modelRuntimeDefaults: Record<string, unknown>
    }
    const profileById = new Map(database.modelProfiles.map((profile) => [profile.id, profile]))
    const main = profileById.get(body.profileIdsByRole.chatMain)
    const aux = profileById.get(body.profileIdsByRole.chatAux)
    const memory = profileById.get(body.profileIdsByRole.memory)
    const emotion = profileById.get(body.profileIdsByRole.emotion)
    const translate = profileById.get(body.profileIdsByRole.translate)
    const scriptAux = profileById.get(body.profileIdsByRole.scriptAux)
    const credentialById = new Map(database.providerCredentials.map((credential) => [credential.id, credential]))

    expect(database.modelRuntimeDefaults).toMatchObject({
      maxContext: 12345,
      maxResponse: 777,
      temperature: 66,
      topP: 0.82,
      frequencyPenalty: 51,
      presencePenalty: 61,
    })
    expect(main).toMatchObject({
      name: 'Main Chat',
      providerId: 'openai',
      modelId: 'gpt-5',
      providerOptions: { credentialId: expect.stringMatching(/^cred_/) },
      fallbacks: [{ mode: 'model', modelId: 'fallback-main' }],
    })
    expect(aux).toMatchObject({
      name: 'Auxiliary',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      providerOptions: { credentialId: expect.stringMatching(/^cred_/) },
      runtimeOptions: { temperature: 44 },
    })
    expect(memory).toMatchObject({
      name: 'Memory',
      providerId: 'openai',
      modelId: 'gpt-5',
      runtimeOptions: { temperature: 22, topP: 0.5 },
      fallbacks: [{ mode: 'model', modelId: 'fallback-memory' }],
    })
    expect(memory?.providerOptions.credentialId).toBe(main?.providerOptions.credentialId)
    expect(emotion).toMatchObject({
      name: 'Emotion',
      providerId: 'vertex',
      modelId: 'gemini-2.5-flash',
      providerOptions: {
        credentialId: expect.stringMatching(/^cred_/),
        vertex: { projectId: 'vertex-project', region: 'us-central1' },
      },
    })
    expect(translate).toMatchObject({
      name: 'Translate',
      providerId: 'vertex',
      modelId: 'gemini-2.5-pro-vertex',
      providerOptions: {
        credentialId: expect.stringMatching(/^cred_/),
        vertex: { projectId: 'vertex-project', region: 'us-central1' },
      },
    })
    expect(emotion?.providerOptions.credentialId).toBe(translate?.providerOptions.credentialId)
    expect(scriptAux).toMatchObject({
      name: 'Script Auxiliary',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: expect.stringMatching(/^cred_/),
        baseUrl: 'https://proxy.example.com/chat/risu/v1',
        requestModel: 'local-model',
      },
      runtimeOptions: { topK: 5 },
    })
    expect(credentialById.get(main?.providerOptions.credentialId)).toMatchObject({
      name: 'OpenAI (imported)',
      type: 'apiKey',
      apiKey: 'openai-key',
    })
    expect(credentialById.get(aux?.providerOptions.credentialId)).toMatchObject({
      name: 'Anthropic (imported)',
      type: 'apiKey',
      apiKey: 'claude-key',
    })
    expect(credentialById.get(emotion?.providerOptions.credentialId)).toMatchObject({
      name: 'Vertex AI (imported)',
      type: 'vertexServiceAccount',
      vertex: { clientEmail: 'vertex@example.com', privateKey: 'vertex-private-key' },
    })
    expect(credentialById.get(translate?.providerOptions.credentialId)).toMatchObject({
      name: 'Vertex AI (imported)',
      type: 'vertexServiceAccount',
      vertex: { clientEmail: 'vertex@example.com', privateKey: 'vertex-private-key' },
    })
    expect(credentialById.get(scriptAux?.providerOptions.credentialId)).toMatchObject({
      name: 'Proxy (imported)',
      type: 'apiKey',
      apiKey: 'proxy-key',
    })
    expect(database.providerCredentials).toContainEqual(
      expect.objectContaining({
        name: 'Google (imported)',
        type: 'apiKey',
        apiKey: 'google-key',
      }),
    )
    expect(database.modelRoleProfiles).toMatchObject({
      chatMain: { mode: 'profile', profileId: body.profileIdsByRole.chatMain },
      chatAux: { mode: 'profile', profileId: body.profileIdsByRole.chatAux },
      memory: { mode: 'profile', profileId: body.profileIdsByRole.memory },
      emotion: { mode: 'profile', profileId: body.profileIdsByRole.emotion },
      otherAx: { mode: 'inherit' },
      translate: { mode: 'profile', profileId: body.profileIdsByRole.translate },
      scriptAux: { mode: 'profile', profileId: body.profileIdsByRole.scriptAux },
    })
  })
})
