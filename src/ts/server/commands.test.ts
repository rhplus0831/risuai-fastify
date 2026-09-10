import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { serializeChatGenerationSettingsDigestInput } from '../chatGenerationSettings'
import { PROMPT_SETTINGS_KEYS } from '@risuai/shared-core/prompt-settings'
import {
  serializePersonaCollectionDigestInput,
  serializePersonaIdsDigestInput,
  serializePersonaProfileDigestInput,
} from '../personaMutationCertificate'
import { serializeScriptDefinitionCollectionDigestInput } from './scriptDefinitionMutations'
import { resetWriterAccessLostForTests } from './activeWriterSession'
import {
  recordStartupMilestone,
  resetStartupReadinessForTests,
  revokeStartupWriterCapabilities,
} from '../startupReadiness'

vi.mock('../platform', () => ({ isFastifyServer: true }))

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'test-auth-token',
}))

import {
  acknowledgeServerMutationReceipts,
  appendMessageCommand,
  bulkPluginStorageCommand,
  createAgentCommand,
  createAgentPresetCommand,
  createAgentPresetStepCommand,
  createAgentPresetUseCommand,
  createChatCommand,
  createChatFolderCommand,
  createAndSelectCharacterCommand,
  createCharacterCommand,
  createLoadoutCommand,
  createModuleCommand,
  createModuleFolderCommand,
  createPersonaCommand,
  createPluginCommand,
  createBardWikiDocumentCommand,
  clearAppliedServerResourceRevision,
  clearCachedServerCommandRevision,
  completeOnboardingCommand,
  createChatGenerationSettingsCommandDurableBody,
  createPromptItemCommand,
  createPresetCommand,
  createTranslatorPresetCommand,
  createAndBindModelProfileCommand,
  createModelProfileCommand,
  createProviderCredentialCommand,
  createGlobalLorebookCommand,
  convertLegacyModelProfilesCommand,
  copyPresetCommand,
  deleteAgentPresetCommand,
  deleteAgentPresetStepCommand,
  deleteAgentPresetUseCommand,
  deleteAgentCommand,
  deleteCharacterLorebookEntryCommand,
  deleteChatCommand,
  deleteChatFolderCommand,
  deleteChatLorebookEntryCommand,
  deleteCharacterCommand,
  deleteGlobalLorebookCommand,
  deleteGlobalLorebookEntryCommand,
  deleteLoadoutCommand,
  deleteMessageCommand,
  deleteModelProfileCommand,
  deleteProviderCredentialCommand,
  deleteModuleCommand,
  deleteModuleFolderCommand,
  deleteModuleLorebookEntryCommand,
  deletePersonaCommand,
  deletePluginCommand,
  deleteBardWikiDocumentCommand,
  deletePluginStorageCommand,
  deferOwnServerCommandReconciliation,
  deletePromptItemCommand,
  deleteTranslatorPresetCommand,
  enablePromptItemsCommand,
  favoriteLoadoutCommand,
  enablePluginCommand,
  enableModuleCommand,
  forkChatCommand,
  getServerCommandBaseRevision,
  patchPromptSettingsCommand,
  patchChatScriptstateCommand,
  patchServerBackedSettings,
  patchRuntimeSettings,
  patchBardWikiChatSettingsCommand,
  previewBardWikiRebuildCommand,
  queueBardWikiRebuildCommand,
  importBardWikiVaultCommand,
  patchSettingsGroup,
  patchSettingsObjectFieldsCommand,
  peekAppliedServerResourceRevision,
  peekCachedServerCommandRevision,
  importPresetCommand,
  initializeServerDatabaseForBootstrap,
  mutateCharacterScriptsCommand,
  mutateGlobalScriptsCommand,
  mutateCharacterTriggersCommand,
  mutateModuleScriptsCommand,
  mutateModuleTriggersCommand,
  persistGenerationResultCommand,
  duplicateAgentPresetCommand,
  duplicateAgentPresetStepCommand,
  duplicateAgentCommand,
  duplicateModelProfileCommand,
  putPluginStorageCommand,
  saveChatGenerationSettingsCommand,
  reorderCharactersCommand,
  reorderChatFoldersCommand,
  reorderChatsCommand,
  resetChatsCommand,
  reorderPersonasCommand,
  reorderGlobalLorebooksCommand,
  reorderCharacterLorebookEntriesCommand,
  reorderCharacterModulesCommand,
  reorderChatLorebookEntriesCommand,
  reorderModulesCommand,
  reorderModuleFoldersCommand,
  reorderModelPresetsCommand,
  reorderModelProfilesCommand,
  reorderGlobalLorebookEntriesCommand,
  reorderModuleLorebookEntriesCommand,
  reorderPluginsCommand,
  runServerCommandWithoutMutationReceipt,
  runServerCommandWithMutationReceipt,
  reorderPromptItemsCommand,
  reorderAgentPresetsCommand,
  reorderAgentPresetStepsCommand,
  reorderAgentPresetUsesCommand,
  reorderAgentsCommand,
  reorderPresetsCommand,
  replayDurableMutationRequests,
  replayDurableMutationRequestsInline,
  runServerCommand,
  runServerCommandSequence,
  runServerPresetCommand,
  replaceTailMessagesCommand,
  replaceMessagesCommand,
  replaceCharacterScriptsCommand,
  replaceCharacterTriggersCommand,
  replaceCharacterLorebooksCommand,
  replaceChatLorebooksCommand,
  replaceGlobalLorebookEntriesCommand,
  replaceModuleLorebooksCommand,
  replaceModuleScriptsCommand,
  replaceModuleTriggersCommand,
  updateModuleFolderCommand,
  selectCharacterCommand,
  selectGlobalLorebookCommand,
  setAgentPresetDefaultCommand,
  settingsGroupForKey,
  selectPersonaCommand,
  selectPluginProviderCommand,
  selectTranslatorPresetCommand,
  touchLoadoutCommand,
  truncateMessagesCommand,
  translateGreetingCommand,
  translateMessageCommand,
  withDirectServerCommandEventReconciliation,
  updateCharacterCommand,
  updateChatCommand,
  updateChatFolderCommand,
  updateAgentPresetCommand,
  updateAgentPresetStepCommand,
  updateAgentPresetUseCommand,
  updateAgentCommand,
  updateGlobalLorebookCommand,
  updateLoadoutCommand,
  updateMessageCommand,
  updateModelProfileCommand,
  updateProviderCredentialCommand,
  updateModelRoleProfilesCommand,
  updateModelRuntimeDefaultsCommand,
  updateModelPresetCommand,
  updateModuleCommand,
  updatePersonaCommand,
  updatePluginCommand,
  updateBardWikiDocumentCommand,
  upsertCharacterLorebookEntryCommand,
  upsertChatLorebookEntryCommand,
  upsertGlobalLorebookEntryCommand,
  upsertModuleLorebookEntryCommand,
  updateTranslatorPresetCommand,
  selectPresetCommand,
  setAppliedServerResourceRevision,
  setCachedServerCommandRevision,
  setServerCommandConflictGapHandler,
  setServerCommandSuccessReconciler,
  sha256HexUtf8Sync,
  type AgentPresetStepSnapshot,
  type PromptItemSnapshot,
  type ServerCommandLocalEffect,
  type ServerCommandResult,
  updatePromptItemCommand,
  updatePromptPresetCommand,
  updatePresetCommand,
} from './commands'
import { captureDestructiveRefreshEpoch, createDestructiveRefreshToken } from './staleStateGuards'
import { SERVER_SETTINGS_KEYS_BY_GROUP } from './settingsGroups'

interface CapturedFetch {
  url: string
  method: string
  authHeader: string | null
  contentType: string | null
  body: unknown
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeCommandFetch(bodyForUrl: (url: string, init: RequestInit) => unknown): {
  calls: CapturedFetch[]
  fetch: typeof fetch
} {
  const calls: CapturedFetch[] = []
  return {
    calls,
    fetch: vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      const rawBody = typeof init.body === 'string' ? JSON.parse(init.body) : null
      const url = String(input)
      calls.push({
        url,
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        contentType: headers?.['content-type'] ?? null,
        body: rawBody,
      })
      const body = bodyForUrl(url, init)
      return body instanceof Response ? body : jsonResponse(body)
    }) as unknown as typeof fetch,
  }
}

function canonicalLoadoutSnapshot(id = 'loadout-a') {
  return {
    id,
    name: 'A',
    lastUsed: 100,
    favorite: false,
    characterIds: ['char-a'],
    modules: ['module-a'],
    globalVariables: { mood: 'bright' },
    presetName: 'Preset A',
    modelPresetId: '',
    modelPresetName: '',
    promptPresetId: '',
    promptPresetName: '',
    personaId: 'persona-a',
  }
}

beforeEach(() => {
  resetStartupReadinessForTests()
  for (const milestone of ['entry', 'shell-mounted', 'reader-ready', 'writer-ready'] as const) {
    recordStartupMilestone(milestone)
  }
  resetWriterAccessLostForTests()
  clearAppliedServerResourceRevision()
  clearCachedServerCommandRevision()
  setServerCommandConflictGapHandler(null)
  setServerCommandSuccessReconciler(null)
})

afterEach(() => {
  resetStartupReadinessForTests()
  resetWriterAccessLostForTests()
  vi.unstubAllGlobals()
})

describe('server command API adapter', () => {
  it('dispatches BardWiki settings and fenced document commands to their focused routes', async () => {
    const commandFetch = makeCommandFetch(() => ({
      revision: 2,
      event: { type: 'bardwiki.updated', revision: 2, resource: 'bardWikiDocument' },
      settings: {},
      document: { id: 'document-a' },
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const fence = { expectedVersion: 3, expectedContentHash: 'a'.repeat(64) }

    await patchBardWikiChatSettingsCommand({
      baseRevision: 1,
      chatId: 'chat/a',
      patch: { enabledOverride: true },
    })
    await createBardWikiDocumentCommand({
      baseRevision: 1,
      chatId: 'chat/a',
      document: { kind: 'event', title: 'Arrival', logicalPath: 'Events/Arrival', markdown: 'Hello.' },
    })
    await updateBardWikiDocumentCommand({
      baseRevision: 1,
      chatId: 'chat/a',
      documentId: 'document/a',
      ...fence,
      patch: { title: 'Return' },
    })
    await deleteBardWikiDocumentCommand({
      baseRevision: 1,
      chatId: 'chat/a',
      documentId: 'document/a',
      ...fence,
    })
    await previewBardWikiRebuildCommand('chat/a', 'full')
    await queueBardWikiRebuildCommand({
      baseRevision: 1,
      chatId: 'chat/a',
      policy: 'full',
      expectedSourceCount: 4,
    })
    await importBardWikiVaultCommand({
      baseRevision: 1,
      chatId: 'chat/a',
      dryRun: false,
      strategy: 'rename',
      archiveBase64: 'UEs=',
      expectedTargets: [],
    })

    expect(commandFetch.calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      {
        url: '/api/v1/commands/bardwiki/chats/chat%2Fa/settings',
        method: 'PATCH',
        body: { baseRevision: 1, patch: { enabledOverride: true } },
      },
      {
        url: '/api/v1/commands/bardwiki/chats/chat%2Fa/documents',
        method: 'POST',
        body: {
          baseRevision: 1,
          document: { kind: 'event', title: 'Arrival', logicalPath: 'Events/Arrival', markdown: 'Hello.' },
        },
      },
      {
        url: '/api/v1/commands/bardwiki/chats/chat%2Fa/documents/document%2Fa',
        method: 'PATCH',
        body: { baseRevision: 1, ...fence, patch: { title: 'Return' } },
      },
      {
        url: '/api/v1/commands/bardwiki/chats/chat%2Fa/documents/document%2Fa',
        method: 'DELETE',
        body: { baseRevision: 1, ...fence },
      },
      {
        url: '/api/v1/commands/bardwiki/chats/chat%2Fa/rebuilds',
        method: 'POST',
        body: { preview: true, policy: 'full' },
      },
      {
        url: '/api/v1/commands/bardwiki/chats/chat%2Fa/rebuilds',
        method: 'POST',
        body: {
          baseRevision: 1,
          preview: false,
          confirm: true,
          policy: 'full',
          expectedSourceCount: 4,
        },
      },
      {
        url: '/api/v1/commands/bardwiki/chats/chat%2Fa/imports',
        method: 'POST',
        body: {
          baseRevision: 1,
          dryRun: false,
          strategy: 'rename',
          archiveBase64: 'UEs=',
          expectedTargets: [],
        },
      },
    ])
  })

  it('accepts exact eventless BardWiki rebuild previews and vault dry runs', async () => {
    const preview = {
      chatId: 'chat/a',
      policy: 'full',
      sourceCount: 4,
      replaceDerivedDocumentCount: 2,
      preserveUserDocumentCount: 1,
      activeJobId: null,
    }
    const plan = {
      format: 'risu-bardwiki-vault',
      version: 1,
      strategy: 'rename',
      creates: 1,
      replacements: 0,
      noops: 0,
      skips: 0,
      renames: 0,
      applicable: true,
      actions: [
        {
          sourceDocumentId: 'source-a',
          targetDocumentId: 'target-a',
          action: 'create',
          logicalPath: 'Imported/Arrival',
          conflict: null,
        },
      ],
    }
    const responses = [
      { revision: 7, preview },
      { revision: 7, dryRun: true, plan },
    ]
    const commandFetch = makeCommandFetch(() => responses.shift())
    const reconciler = vi.fn()
    setServerCommandSuccessReconciler(reconciler)
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(previewBardWikiRebuildCommand('chat/a', 'full')).resolves.toEqual({
      status: 'ok',
      revision: 7,
      preview,
    })
    await expect(
      importBardWikiVaultCommand({
        chatId: 'chat/a',
        dryRun: true,
        strategy: 'rename',
        archiveBase64: 'UEs=',
      }),
    ).resolves.toEqual({ status: 'ok', revision: 7, dryRun: true, plan })
    expect(reconciler).not.toHaveBeenCalled()
    expect(peekCachedServerCommandRevision()).toBe(7)
  })

  it('rejects malformed or incorrect eventless BardWiki receipts', async () => {
    const preview = {
      chatId: 'chat/a',
      policy: 'full',
      sourceCount: 4,
      replaceDerivedDocumentCount: 2,
      preserveUserDocumentCount: 1,
      activeJobId: null,
    }
    const plan = {
      format: 'risu-bardwiki-vault',
      version: 1,
      strategy: 'rename',
      creates: 1,
      replacements: 0,
      noops: 0,
      skips: 0,
      renames: 0,
      applicable: true,
      actions: [
        {
          sourceDocumentId: 'source-a',
          targetDocumentId: 'target-a',
          action: 'create',
          logicalPath: 'Imported/Arrival',
          conflict: null,
        },
      ],
    }
    const previewCommand = () => previewBardWikiRebuildCommand('chat/a', 'full')
    const dryRunCommand = () =>
      importBardWikiVaultCommand({
        chatId: 'chat/a',
        dryRun: true,
        strategy: 'rename',
        archiveBase64: 'UEs=',
      })
    const cases: Array<{ label: string; response: unknown; command: () => Promise<unknown> }> = [
      {
        label: 'preview for another chat',
        response: { revision: 7, preview: { ...preview, chatId: 'chat/b' } },
        command: previewCommand,
      },
      {
        label: 'preview with a malformed count',
        response: { revision: 7, preview: { ...preview, sourceCount: 1.5 } },
        command: previewCommand,
      },
      {
        label: 'preview with an explicit null event',
        response: { revision: 7, event: null, preview },
        command: previewCommand,
      },
      {
        label: 'dry run with the wrong strategy',
        response: { revision: 7, dryRun: true, plan: { ...plan, strategy: 'skip' } },
        command: dryRunCommand,
      },
      {
        label: 'dry run with inconsistent action counts',
        response: { revision: 7, dryRun: true, plan: { ...plan, creates: 0 } },
        command: dryRunCommand,
      },
      {
        label: 'dry run with a malformed action',
        response: {
          revision: 7,
          dryRun: true,
          plan: { ...plan, actions: [{ ...plan.actions[0], unexpected: true }] },
        },
        command: dryRunCommand,
      },
      {
        label: 'dry run response marked as a mutation',
        response: { revision: 7, dryRun: false, plan },
        command: dryRunCommand,
      },
      {
        label: 'mutating import without an event',
        response: { revision: 8, dryRun: false, plan },
        command: () =>
          importBardWikiVaultCommand({
            baseRevision: 7,
            chatId: 'chat/a',
            dryRun: false,
            strategy: 'rename',
            archiveBase64: 'UEs=',
          }),
      },
      {
        label: 'queued rebuild without an event',
        response: { revision: 8, job: { id: 'job-a' } },
        command: () =>
          queueBardWikiRebuildCommand({
            baseRevision: 7,
            chatId: 'chat/a',
            policy: 'full',
            expectedSourceCount: 4,
          }),
      },
    ]

    for (const testCase of cases) {
      setCachedServerCommandRevision(6)
      const reconciler = vi.fn()
      setServerCommandSuccessReconciler(reconciler)
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(testCase.response)) as unknown as typeof fetch)

      await expect(testCase.command(), testCase.label).resolves.toEqual({
        status: 'error',
        error: 'Invalid command response',
      })
      expect(reconciler, testCase.label).not.toHaveBeenCalled()
      expect(peekCachedServerCommandRevision(), testCase.label).toBe(6)
    }
  })

  it('blocks ordinary APIs before writer readiness while allowing only initialization and pending replay', async () => {
    resetStartupReadinessForTests()
    const command = vi.fn()
    const commandFetch = makeCommandFetch((url) =>
      url.endsWith('/state/initialize')
        ? {
            revision: 1,
            initialized: true,
            event: { type: 'state.initialized', revision: 1, resource: 'state' },
          }
        : {
            revision: 2,
            event: { type: 'settings.updated', revision: 2, resource: 'settings' },
          },
    )
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(patchRuntimeSettings({ baseRevision: 0, patch: { maxContext: 4_000 } })).resolves.toEqual({
      status: 'unavailable',
    })
    await expect(runServerCommand({ command })).resolves.toEqual({ status: 'unavailable' })
    expect(command).not.toHaveBeenCalled()
    expect(commandFetch.fetch).not.toHaveBeenCalled()

    await expect(initializeServerDatabaseForBootstrap()).resolves.toMatchObject({ status: 'ok', revision: 1 })
    await expect(
      replayDurableMutationRequests(
        [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 8_000 } } }],
        'pending-before-ready',
        'database-a',
      ),
    ).resolves.toEqual({ status: 'ok' })
    expect(commandFetch.fetch).toHaveBeenCalledTimes(2)
  })

  it('rechecks ordinary capability after a queued command loses writer ownership', async () => {
    setCachedServerCommandRevision(1)
    type HeldCommandResult = {
      status: 'ok'
      revision: number
      event: { type: string; revision: number; resource: string }
    }
    let releaseFirst!: (result: HeldCommandResult) => void
    const firstCommand = vi.fn(
      (_baseRevision: number) =>
        new Promise<HeldCommandResult>((resolve) => {
          releaseFirst = resolve
        }),
    )
    const secondCommand = vi.fn()

    const first = runServerCommand({ command: firstCommand })
    await vi.waitFor(() => expect(firstCommand).toHaveBeenCalledOnce())
    const second = runServerCommand({ command: secondCommand })
    revokeStartupWriterCapabilities()
    releaseFirst({
      status: 'ok',
      revision: 2,
      event: { type: 'settings.updated', revision: 2, resource: 'settings' },
    })

    await expect(first).resolves.toMatchObject({ status: 'ok' })
    await expect(second).resolves.toEqual({ status: 'unavailable' })
    expect(secondCommand).not.toHaveBeenCalled()
  })

  it('patches runtime settings with the auth header and baseRevision', async () => {
    const event = { type: 'settings.updated', revision: 2, resource: 'settings' }
    const commandFetch = makeCommandFetch(() => ({ revision: 2, event }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchRuntimeSettings({
      baseRevision: 1,
      patch: { streamGeminiThoughts: true },
    })

    expect(result).toEqual({ status: 'ok', revision: 2, event })
    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/commands/settings/runtime',
        method: 'PATCH',
        authHeader: 'test-auth-token',
        contentType: 'application/json',
        body: {
          baseRevision: 1,
          patch: { streamGeminiThoughts: true },
        },
      },
    ])
  })

  it('rejects malformed 2xx command receipts and rolls back the optimistic command', async () => {
    const validEvent = { type: 'settings.updated', revision: 2, resource: 'settings' }
    const cases: Array<{ label: string; response: () => Response }> = [
      {
        label: 'empty response body',
        response: () => new Response(null, { status: 200 }),
      },
      {
        label: 'missing event',
        response: () => jsonResponse({ revision: 2 }),
      },
      {
        label: 'malformed event',
        response: () => jsonResponse({ revision: 2, event: { ...validEvent, resource: null } }),
      },
      {
        label: 'response/event revision mismatch',
        response: () => jsonResponse({ revision: 3, event: validEvent }),
      },
    ]

    for (const testCase of cases) {
      setCachedServerCommandRevision(1)
      const rollback = vi.fn()
      const reconciler = vi.fn()
      setServerCommandSuccessReconciler(reconciler)
      vi.stubGlobal('fetch', vi.fn(async () => testCase.response()) as unknown as typeof fetch)

      const result = await runServerCommand({
        command: (baseRevision) =>
          patchRuntimeSettings({
            baseRevision,
            patch: { streamGeminiThoughts: true },
          }),
        rollback,
      })

      expect(result, testCase.label).toEqual({ status: 'error', error: 'Invalid command response' })
      expect(rollback, testCase.label).toHaveBeenCalledTimes(1)
      expect(reconciler, testCase.label).not.toHaveBeenCalled()
      expect(peekCachedServerCommandRevision(), testCase.label).toBe(1)
    }
  })

  it('allows only the intentional eventless already-initialized receipt', async () => {
    const responses = [
      { revision: 7, initialized: false },
      { revision: 8, initialized: false, event: null },
      { revision: 8, initialized: true },
      {
        revision: 8,
        initialized: true,
        event: { type: 'state.initialized', revision: 8, resource: 'state' },
      },
    ]
    const commandFetch = makeCommandFetch(() => responses.shift())
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(initializeServerDatabaseForBootstrap()).resolves.toEqual({
      status: 'ok',
      revision: 7,
      initialized: false,
    })
    await expect(initializeServerDatabaseForBootstrap()).resolves.toEqual({
      status: 'error',
      error: 'Invalid command response',
    })
    await expect(initializeServerDatabaseForBootstrap()).resolves.toEqual({
      status: 'error',
      error: 'Invalid command response',
    })
    await expect(initializeServerDatabaseForBootstrap()).resolves.toEqual({
      status: 'ok',
      revision: 8,
      initialized: true,
      event: { type: 'state.initialized', revision: 8, resource: 'state' },
    })
    expect(peekCachedServerCommandRevision()).toBe(8)
  })

  it('preserves initialize_conflict as a distinct command failure', async () => {
    const commandFetch = makeCommandFetch(() => jsonResponse({ error: 'initialize_conflict' }, 409))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(initializeServerDatabaseForBootstrap()).resolves.toEqual({
      status: 'error',
      error: 'initialize_conflict',
      reason: 'initialize-conflict',
    })
  })

  it('sends onboarding preset owners and settings through one command request', async () => {
    const event = { type: 'onboarding.completed', revision: 3, resource: 'legacyBotPreset' }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      modelPresetId: 'model-owner',
      promptPresetId: 'prompt-owner',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await completeOnboardingCommand({
      baseRevision: 2,
      modelPresetId: 'model-owner',
      promptPresetId: 'prompt-owner',
      modelPatch: { aiModel: 'openrouter' },
      promptPatch: { mainPrompt: 'onboarding prompt' },
      settingsPatch: { didFirstSetup: true },
    })

    expect(result).toEqual({
      status: 'ok',
      revision: 3,
      event,
      modelPresetId: 'model-owner',
      promptPresetId: 'prompt-owner',
    })
    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/commands/onboarding',
        method: 'POST',
        authHeader: 'test-auth-token',
        contentType: 'application/json',
        body: {
          baseRevision: 2,
          modelPresetId: 'model-owner',
          promptPresetId: 'prompt-owner',
          modelPatch: { aiModel: 'openrouter' },
          promptPatch: { mainPrompt: 'onboarding prompt' },
          settingsPatch: { didFirstSetup: true },
        },
      },
    ])
  })

  it('patches grouped scalar settings with the auth header and baseRevision', async () => {
    const event = { type: 'settings.updated', revision: 3, resource: 'settings' }
    const commandFetch = makeCommandFetch(() => ({ revision: 3, event }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchSettingsGroup({
      group: 'display',
      baseRevision: 2,
      patch: { theme: 'light', zoomsize: 90 },
    })

    expect(result).toEqual({ status: 'ok', revision: 3, event })
    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/commands/settings/display',
        method: 'PATCH',
        authHeader: 'test-auth-token',
        contentType: 'application/json',
        body: {
          baseRevision: 2,
          patch: { theme: 'light', zoomsize: 90 },
        },
      },
    ])
  })

  it('exposes the canonical settings patch as a response-confirmed local effect', async () => {
    const event = {
      type: 'settings.updated',
      revision: 3,
      resource: 'settings',
      id: 'display',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      acknowledgedKeys: ['theme', 'zoomsize'],
      settings: { theme: 'light' },
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await patchSettingsGroup({
      group: 'display',
      baseRevision: 2,
      patch: { theme: 'LIGHT', zoomsize: 90 },
      acknowledgeOptimistic: true,
      optimisticProjectionEpoch: 12,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'display',
        attemptedPatch: { theme: 'LIGHT', zoomsize: 90 },
        settings: { theme: 'light', zoomsize: 90 },
        settingsProjectionEpoch: 12,
      },
    ])
  })

  it('reconstructs omitted large verbatim settings in the local effect', async () => {
    const customCSS = `/* large */${'x'.repeat(64 * 1024)}`
    const event = {
      type: 'settings.updated',
      revision: 3,
      resource: 'settings',
      id: 'display',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      acknowledgedKeys: ['customCSS'],
      settings: {},
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await patchSettingsGroup({
      group: 'display',
      baseRevision: 2,
      patch: { customCSS },
      acknowledgeOptimistic: true,
      optimisticProjectionEpoch: 13,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'display',
        attemptedPatch: { customCSS },
        settings: { customCSS },
        settingsProjectionEpoch: 13,
      },
    ])
  })

  it('requires opt-in and a projection epoch before acknowledging a settings patch locally', async () => {
    const commandFetch = makeCommandFetch((_url, init) => {
      const request = JSON.parse(String(init?.body)) as { baseRevision: number }
      const revision = request.baseRevision + 1
      return {
        revision,
        event: {
          type: 'settings.updated',
          revision,
          resource: 'settings',
          id: 'display',
        },
        acknowledgedKeys: ['theme'],
        settings: { theme: 'light' },
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    setCachedServerCommandRevision(1)
    const observedEffects: ServerCommandLocalEffect[][] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push([...localEffects.values()])
    })

    await patchServerBackedSettings({ patch: { theme: 'LIGHT' } })
    await patchServerBackedSettings({ patch: { theme: 'LIGHT' }, acknowledgeOptimistic: true })
    await patchServerBackedSettings({
      patch: { theme: 'LIGHT' },
      acknowledgeOptimistic: true,
      optimisticProjectionEpochs: { display: 7 },
    })

    expect(observedEffects).toEqual([
      [],
      [],
      [
        {
          kind: 'settingsPatch',
          group: 'display',
          attemptedPatch: { theme: 'LIGHT' },
          settings: { theme: 'light' },
          settingsProjectionEpoch: 7,
        },
      ],
    ])
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      { baseRevision: 1, patch: { theme: 'LIGHT' } },
      { baseRevision: 2, patch: { theme: 'LIGHT' } },
      { baseRevision: 3, patch: { theme: 'LIGHT' } },
    ])
    expect(commandFetch.calls[2]?.body).not.toHaveProperty('acknowledgeOptimistic')
    expect(commandFetch.calls[2]?.body).not.toHaveProperty('optimisticProjectionEpochs')
  })

  it('sends only shallow object changes while reconstructing the full optimistic settings value locally', async () => {
    const attemptedObject = {
      width: 832,
      height: 768,
      vibe_data: { thumbnail: 'x'.repeat(64 * 1024) },
    }
    const event = {
      type: 'settings.updated',
      revision: 3,
      resource: 'settings',
      id: 'media',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      group: 'media',
      key: 'NAIImgConfig',
      certificate: 'settings-object-patch-v1',
      patchedKeys: ['width'],
      deletedKeys: [],
      canonicalValues: {},
      canonicalDeletedKeys: [],
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await patchSettingsObjectFieldsCommand({
      group: 'media',
      key: 'NAIImgConfig',
      baseRevision: 2,
      update: { patch: { width: 832 } },
      attemptedObject,
      optimisticProjectionEpoch: 12,
    })

    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/commands/settings/media/objects/NAIImgConfig',
        method: 'PATCH',
        authHeader: 'test-auth-token',
        contentType: 'application/json',
        body: { baseRevision: 2, patch: { width: 832 } },
      },
    ])
    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'media',
        attemptedPatch: { NAIImgConfig: attemptedObject },
        settings: { NAIImgConfig: attemptedObject },
        settingsProjectionEpoch: 12,
      },
    ])
  })

  it('applies a masked secret override from a compact shallow settings acknowledgement', async () => {
    const attemptedObject = { key: 'new-secret', model: 'flux' }
    const event = {
      type: 'settings.updated',
      revision: 3,
      resource: 'settings',
      id: 'media',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      group: 'media',
      key: 'wavespeedImage',
      certificate: 'settings-object-patch-v1',
      patchedKeys: ['key'],
      deletedKeys: [],
      canonicalValues: { key: '__RISU_SECRET_MASKED__' },
      canonicalDeletedKeys: [],
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await patchSettingsObjectFieldsCommand({
      group: 'media',
      key: 'wavespeedImage',
      baseRevision: 2,
      update: { patch: { key: 'new-secret' } },
      attemptedObject,
      optimisticProjectionEpoch: 4,
    })

    expect(commandFetch.calls[0].body).toEqual({ baseRevision: 2, patch: { key: 'new-secret' } })
    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'media',
        attemptedPatch: { wavespeedImage: attemptedObject },
        settings: { wavespeedImage: { key: '__RISU_SECRET_MASKED__', model: 'flux' } },
        settingsProjectionEpoch: 4,
      },
    ])
  })

  it('keeps malformed shallow settings acknowledgements on the authoritative fallback path', async () => {
    const event = {
      type: 'settings.updated',
      revision: 3,
      resource: 'settings',
      id: 'media',
    }
    const malformedBodies = [
      {
        revision: 3,
        event,
        group: 'media',
        key: 'NAIImgConfig',
        certificate: 'settings-object-patch-v1',
        patchedKeys: ['height'],
        deletedKeys: [],
        canonicalValues: {},
        canonicalDeletedKeys: [],
      },
      {
        revision: 3,
        event,
        group: 'media',
        key: 'NAIImgConfig',
        certificate: 'settings-object-patch-v1',
        patchedKeys: ['width'],
        deletedKeys: [],
        canonicalValues: { height: 900 },
        canonicalDeletedKeys: [],
      },
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => malformedBodies[responseIndex++])
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    for (const _body of malformedBodies) {
      await patchSettingsObjectFieldsCommand({
        group: 'media',
        key: 'NAIImgConfig',
        baseRevision: 2,
        update: { patch: { width: 832 } },
        attemptedObject: { width: 832, height: 768 },
        optimisticProjectionEpoch: 1,
      })
    }

    expect(observedEffectCounts).toEqual([0, 0])
  })

  it('keeps malformed compact settings acknowledgements on the authoritative fallback path', async () => {
    const event = {
      type: 'settings.updated',
      revision: 3,
      resource: 'settings',
      id: 'display',
    }
    const malformedBodies: Array<Record<string, unknown>> = [
      {
        revision: 3,
        event,
        acknowledgedKeys: ['theme'],
        settings: {},
      },
      {
        revision: 3,
        event,
        acknowledgedKeys: ['theme', 'theme', 'zoomsize'],
        settings: {},
      },
      {
        revision: 3,
        event,
        acknowledgedKeys: ['theme', 'zoomsize'],
        settings: { customCSS: 'not acknowledged' },
      },
      {
        revision: 3,
        event,
        acknowledgedKeys: ['theme', 'zoomsize'],
        settings: { theme: Number.NaN },
      },
      {
        revision: 3,
        event: { ...event, type: 'settings.other' },
        acknowledgedKeys: ['theme', 'zoomsize'],
        settings: {},
      },
      {
        revision: 3,
        event: { ...event, parentId: 'unexpected' },
        acknowledgedKeys: ['theme', 'zoomsize'],
        settings: {},
      },
    ]
    let responseIndex = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = malformedBodies[responseIndex++]
        return {
          status: 200,
          ok: true,
          json: async () => body,
        } as Response
      }) as unknown as typeof fetch,
    )
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    for (const _body of malformedBodies) {
      await patchSettingsGroup({
        group: 'display',
        baseRevision: 2,
        patch: { theme: 'light', zoomsize: 90 },
      })
    }

    expect(observedEffectCounts).toEqual(malformedBodies.map(() => 0))
  })

  it('notifies the command success reconciler before resolving an ok command', async () => {
    const event = {
      type: 'generation.persisted',
      revision: 3,
      resource: 'generation',
      id: 'message-a',
      parentId: 'chat-a',
      databaseLineage: 'database-a',
      operationId: 'operation-a',
      sourceMessageId: 'message-user-a',
      jobId: 'job-a',
      origin: { writerSessionId: 'w1' },
    }
    const commandFetch = makeCommandFetch(() => ({ revision: 3, event }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observed: unknown[] = []

    setServerCommandSuccessReconciler(async (commandEvent) => {
      observed.push(commandEvent)
    })

    const result = await patchSettingsGroup({
      group: 'display',
      baseRevision: 2,
      patch: { theme: 'light' },
    })

    expect(result).toEqual({ status: 'ok', revision: 3, event })
    expect(observed).toEqual([event])
  })

  it('notifies the command success reconciler for custom runServerCommand factories', async () => {
    const event = { type: 'custom.updated', revision: 8, resource: 'asset' }
    const observed: unknown[] = []
    setCachedServerCommandRevision(7)
    setServerCommandSuccessReconciler(async (commandEvent) => {
      observed.push(commandEvent)
    })

    const result = await runServerCommand({
      command: async (baseRevision) => ({
        status: 'ok' as const,
        revision: baseRevision + 1,
        event,
      }),
    })

    expect(result).toEqual({ status: 'ok', revision: 8, event })
    expect(observed).toEqual([event])
  })

  it('serializes independent high-level mutations so each request uses the previously accepted revision', async () => {
    const firstResponse = createDeferred<Response>()
    const calls: Array<{ body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        if (calls.length === 1) return firstResponse.promise
        return jsonResponse({
          revision: 12,
          event: { type: 'settings.updated', revision: 12, resource: 'settings' },
        })
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(10)

    const first = runServerCommand({
      command: (baseRevision) =>
        patchRuntimeSettings({
          baseRevision,
          patch: { maxContext: 8_000 },
        }),
    })
    const second = patchServerBackedSettings({
      patch: { maxResponse: 1_000 },
    })

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.body).toEqual({
      baseRevision: 10,
      patch: { maxContext: 8_000 },
    })

    firstResponse.resolve(
      jsonResponse({
        revision: 11,
        event: { type: 'settings.updated', revision: 11, resource: 'settings' },
      }),
    )

    await expect(first).resolves.toMatchObject({ status: 'ok', revision: 11 })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]?.body).toEqual({
      baseRevision: 11,
      patch: { maxResponse: 1_000 },
    })
    await expect(second).resolves.toMatchObject({ status: 'ok', revision: 12 })
  })

  it('uses stable per-request mutation ids for a durable multi-command replay', async () => {
    const calls: Array<{ body: Record<string, unknown>; databaseLineage: string | null; mutationId: string | null }> =
      []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string>
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        calls.push({
          body,
          databaseLineage: headers['risu-database-lineage'] ?? null,
          mutationId: headers['risu-mutation-id'] ?? null,
        })
        const revision = 21 + calls.length
        return jsonResponse({
          revision,
          event: {
            type: calls.length === 1 ? 'settings.updated' : 'character.updated',
            revision,
            resource: calls.length === 1 ? 'settings' : 'characterRow',
          },
        })
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(21)

    const result = await replayDurableMutationRequests(
      [
        { method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 8_000 } } },
        { method: 'PATCH', path: '/characters/char-a', body: { patch: { name: 'Recovered name' } } },
      ],
      'pending-replay-a',
      'database-a',
    )

    expect(result).toEqual({ status: 'ok' })
    expect(calls).toEqual([
      {
        body: { baseRevision: 21, patch: { maxContext: 8_000 } },
        databaseLineage: 'database-a',
        mutationId: 'pending-replay-a',
      },
      {
        body: { baseRevision: 22, patch: { name: 'Recovered name' } },
        databaseLineage: 'database-a',
        mutationId: 'pending-replay-a.1',
      },
    ])
  })

  it('replays a predecessor inline before its queued successor without losing either receipt context', async () => {
    const calls: Array<{ body: Record<string, unknown>; mutationId: string | null }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string>
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        calls.push({ body, mutationId: headers['risu-mutation-id'] ?? null })
        const revision = 21 + calls.length
        return jsonResponse({
          revision,
          event: { type: 'settings.updated', revision, resource: 'settings' },
        })
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(21)

    const result = await runServerCommand({
      mutationId: 'successor-b',
      databaseLineage: 'database-a',
      executionWrapper: async (execute) => {
        await expect(
          replayDurableMutationRequestsInline(
            [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 8_000 } } }],
            'predecessor-a',
            'database-a',
          ),
        ).resolves.toEqual({ status: 'ok' })
        return execute()
      },
      command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxResponse: 1_000 } }),
    })

    expect(result).toMatchObject({ status: 'ok', revision: 23 })
    expect(calls).toEqual([
      {
        body: { baseRevision: 21, patch: { maxContext: 8_000 } },
        mutationId: 'predecessor-a',
      },
      {
        body: { baseRevision: 22, patch: { maxResponse: 1_000 } },
        mutationId: 'successor-b',
      },
    ])
  })

  it('suppresses durable receipt headers when browser persistence is unavailable', async () => {
    let capturedHeaders: Record<string, string> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        capturedHeaders = init.headers as Record<string, string>
        return jsonResponse({
          revision: 22,
          event: { type: 'settings.updated', revision: 22, resource: 'settings' },
        })
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(21)

    await expect(
      runServerCommand({
        mutationId: 'unavailable-browser-storage',
        databaseLineage: 'database-a',
        executionWrapper: (execute) => runServerCommandWithoutMutationReceipt(execute),
        command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 7_000 } }),
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 22 })

    expect(capturedHeaders?.['risu-mutation-id']).toBeUndefined()
    expect(capturedHeaders?.['risu-database-lineage']).toBeUndefined()
  })

  it('restores the reserved receipt context when an exact context throws', async () => {
    let capturedHeaders: Record<string, string> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        capturedHeaders = init.headers as Record<string, string>
        return jsonResponse({
          revision: 22,
          event: { type: 'settings.updated', revision: 22, resource: 'settings' },
        })
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(21)

    await expect(
      runServerCommand({
        mutationId: 'reserved-placeholder',
        databaseLineage: 'database-a',
        executionWrapper: async (execute) => {
          await expect(
            runServerCommandWithMutationReceipt(
              async () => {
                throw new Error('prepared execution failed')
              },
              'exact-successor',
              'database-a',
            ),
          ).rejects.toThrow('prepared execution failed')
          return execute()
        },
        command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 7_000 } }),
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 22 })

    expect(capturedHeaders?.['risu-mutation-id']).toBe('reserved-placeholder')
    expect(capturedHeaders?.['risu-database-lineage']).toBe('database-a')
  })

  it('retries a durable conflict with live revisions while preserving receipt ids', async () => {
    const calls: Array<{ body: Record<string, unknown>; mutationId: string | null }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string>
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        calls.push({ body, mutationId: headers['risu-mutation-id'] ?? null })
        if (calls.length === 1 || calls.length === 3) {
          return jsonResponse({
            revision: 31,
            event: { type: 'settings.updated', revision: 31, resource: 'settings' },
          })
        }
        if (calls.length === 2) return jsonResponse({ error: 'revision_conflict', currentRevision: 32 }, 409)
        return jsonResponse({
          revision: 33,
          event: { type: 'character.updated', revision: 33, resource: 'characterRow' },
        })
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(30)

    const result = await replayDurableMutationRequests(
      [
        { method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 9_000 } } },
        { method: 'PATCH', path: '/characters/char-b', body: { patch: { name: 'Recovered' } } },
      ],
      'pending-replay-conflict',
      'database-a',
    )

    expect(result).toEqual({ status: 'ok' })
    expect(calls.map((call) => call.mutationId)).toEqual([
      'pending-replay-conflict',
      'pending-replay-conflict.1',
      'pending-replay-conflict',
      'pending-replay-conflict.1',
    ])
    expect(calls.map((call) => call.body.baseRevision)).toEqual([30, 31, 32, 32])
    expect(peekCachedServerCommandRevision()).toBe(33)
  })

  it('sends lineage-bound durable receipt acknowledgements', async () => {
    let captured: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        captured = init
        return jsonResponse({ acknowledged: 1, requested: 1 })
      }) as unknown as typeof fetch,
    )

    await expect(acknowledgeServerMutationReceipts('pending-a', 1, 'database-a')).resolves.toBe(true)

    expect(captured?.method).toBe('POST')
    expect(JSON.parse(String(captured?.body))).toEqual({
      mutationId: 'pending-a',
      requestCount: 1,
      databaseLineage: 'database-a',
    })
    expect(captured?.headers).toEqual(
      expect.objectContaining({
        'content-type': 'application/json',
        'risu-auth': 'test-auth-token',
        'risu-writer-session': expect.any(String),
      }),
    )
  })

  it('classifies a database lineage mismatch before generic revision conflict handling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'database_lineage_conflict', databaseLineage: 'database-b' }, 409),
      ) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(2)

    await expect(
      replayDurableMutationRequests(
        [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 9_000 } } }],
        'pending-old-lineage',
        'database-a',
      ),
    ).resolves.toEqual({
      status: 'error',
      error: 'database_lineage_conflict',
      reason: 'database-lineage',
    })
  })

  it('carries the enqueue-time refresh epoch through a command that waits in the queue', async () => {
    const firstResponse = createDeferred<Response>()
    const secondResponse = createDeferred<Response>()
    const calls: string[] = []
    let observedEffect: ServerCommandLocalEffect | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return calls.length === 1 ? firstResponse.promise : secondResponse.promise
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(10)
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffect = localEffects.get(12)
    })

    const first = runServerCommand({
      command: (baseRevision) =>
        patchRuntimeSettings({
          baseRevision,
          patch: { maxContext: 8_000 },
        }),
    })
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    const queuedEpoch = captureDestructiveRefreshEpoch()
    const second = runServerCommand({
      command: (baseRevision) =>
        updateCharacterCommand({
          baseRevision,
          characterId: 'char-b',
          patch: { name: 'accepted optimistic name' },
        }),
    })
    createDestructiveRefreshToken('queued-character-patch-refresh')

    firstResponse.resolve(
      jsonResponse({
        revision: 11,
        event: { type: 'settings.updated', revision: 11, resource: 'settings' },
      }),
    )
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    secondResponse.resolve(
      jsonResponse({
        revision: 12,
        event: {
          type: 'character.updated',
          revision: 12,
          resource: 'characterRow',
          id: 'char-b',
        },
        characterId: 'char-b',
      }),
    )

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 'ok', revision: 11 },
      { status: 'ok', revision: 12 },
    ])
    expect(observedEffect?.destructiveRefreshEpoch).toBe(queuedEpoch)
    expect(observedEffect?.destructiveRefreshEpoch).not.toBe(captureDestructiveRefreshEpoch())
  })

  it('starts a queued transport before reconciling the older command and never restores its older optimistic value', async () => {
    const firstResponse = createDeferred<Response>()
    const secondResponse = createDeferred<Response>()
    const reconcileRelease = createDeferred<void>()
    const calls: Array<{ body: unknown }> = []
    const reconciled: Array<{ revision: number; coalescedRevisions: number[] }> = []
    let visibleValue = 'first optimistic value'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        return calls.length === 1 ? firstResponse.promise : secondResponse.promise
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(10)
    setServerCommandSuccessReconciler(async (event, coalescedEvents) => {
      reconciled.push({
        revision: event.revision,
        coalescedRevisions: coalescedEvents.map((coalescedEvent) => coalescedEvent.revision),
      })
      await reconcileRelease.promise
      visibleValue = event.revision === 11 ? 'first server value' : 'second optimistic value'
    })

    const first = runServerCommand({
      command: (baseRevision) =>
        patchRuntimeSettings({
          baseRevision,
          patch: { maxContext: 8_000 },
        }),
    })
    visibleValue = 'second optimistic value'
    const second = patchServerBackedSettings({
      patch: { maxResponse: 1_000 },
    })
    let commandsSettled = false
    const commands = Promise.all([first, second]).then((results) => {
      commandsSettled = true
      return results
    })

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    firstResponse.resolve(
      jsonResponse({
        revision: 11,
        event: { type: 'settings.updated', revision: 11, resource: 'settings' },
      }),
    )

    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]?.body).toEqual({
      baseRevision: 11,
      patch: { maxResponse: 1_000 },
    })
    expect(reconciled).toEqual([])
    expect(visibleValue).toBe('second optimistic value')

    secondResponse.resolve(
      jsonResponse({
        revision: 12,
        event: { type: 'settings.updated', revision: 12, resource: 'settings' },
      }),
    )

    await vi.waitFor(() => expect(reconciled).toEqual([{ revision: 12, coalescedRevisions: [11, 12] }]))
    expect(commandsSettled).toBe(false)
    expect(visibleValue).toBe('second optimistic value')
    reconcileRelease.resolve()

    await expect(commands).resolves.toEqual([
      expect.objectContaining({ status: 'ok', revision: 11 }),
      expect.objectContaining({ status: 'ok', revision: 12 }),
    ])
    expect(reconciled).toEqual([{ revision: 12, coalescedRevisions: [11, 12] }])
    expect(visibleValue).toBe('second optimistic value')
  })

  it('runs a multi-step sequence with advancing revisions and one coalesced local-effect reconciliation', async () => {
    const attempts = [{ maxContext: 8_000 }, { maxResponse: 1_000 }]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => {
      const patch = attempts[responseIndex]
      const revision = 11 + responseIndex
      responseIndex += 1
      return {
        revision,
        event: {
          type: 'settings.updated',
          revision,
          resource: 'settings',
          id: 'runtime',
        },
        acknowledgedKeys: Object.keys(patch),
        settings: {},
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    setCachedServerCommandRevision(10)
    const reconciliations: Array<{
      latestRevision: number
      revisions: number[]
      localEffects: Array<[number, ServerCommandLocalEffect]>
    }> = []
    setServerCommandSuccessReconciler((event, events, localEffects) => {
      reconciliations.push({
        latestRevision: event.revision,
        revisions: events.map((candidate) => candidate.revision),
        localEffects: Array.from(localEffects.entries()),
      })
    })
    const rollback = vi.fn()

    const result = await runServerCommandSequence(
      [
        (baseRevision) =>
          patchSettingsGroup({
            group: 'runtime',
            baseRevision,
            patch: attempts[0],
            acknowledgeOptimistic: true,
            optimisticProjectionEpoch: 9,
          }),
        (baseRevision) =>
          patchSettingsGroup({
            group: 'runtime',
            baseRevision,
            patch: attempts[1],
            acknowledgeOptimistic: true,
            optimisticProjectionEpoch: 9,
          }),
      ],
      rollback,
    )

    expect(result).toBeNull()
    expect(rollback).not.toHaveBeenCalled()
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      { baseRevision: 10, patch: attempts[0] },
      { baseRevision: 11, patch: attempts[1] },
    ])
    expect(reconciliations).toEqual([
      {
        latestRevision: 12,
        revisions: [11, 12],
        localEffects: [
          [
            11,
            {
              kind: 'settingsPatch',
              group: 'runtime',
              attemptedPatch: attempts[0],
              settings: attempts[0],
              settingsProjectionEpoch: 9,
            },
          ],
          [
            12,
            {
              kind: 'settingsPatch',
              group: 'runtime',
              attemptedPatch: attempts[1],
              settings: attempts[1],
              settingsProjectionEpoch: 9,
            },
          ],
        ],
      },
    ])
  })

  it('keeps a command sequence atomic against unrelated queued work and advances custom success revisions', async () => {
    const firstStarted = createDeferred<void>()
    const releaseFirst = createDeferred<void>()
    const order: string[] = []
    const bases: number[] = []
    const success = (revision: number, type: string): ServerCommandResult => ({
      status: 'ok',
      revision,
      event: { type, revision, resource: 'asset' },
    })
    setCachedServerCommandRevision(20)

    const sequence = runServerCommandSequence([
      async (baseRevision) => {
        order.push('sequence-1')
        bases.push(baseRevision)
        firstStarted.resolve()
        await releaseFirst.promise
        return success(baseRevision + 1, 'sequence.first')
      },
      async (baseRevision) => {
        order.push('sequence-2')
        bases.push(baseRevision)
        return success(baseRevision + 1, 'sequence.second')
      },
    ])

    await firstStarted.promise
    const unrelated = runServerCommand({
      command: async (baseRevision) => {
        order.push('unrelated')
        bases.push(baseRevision)
        return success(baseRevision + 1, 'unrelated.updated')
      },
    })
    releaseFirst.resolve()

    await expect(Promise.all([sequence, unrelated])).resolves.toEqual([
      null,
      expect.objectContaining({ status: 'ok', revision: 23 }),
    ])
    expect(order).toEqual(['sequence-1', 'sequence-2', 'unrelated'])
    expect(bases).toEqual([20, 21, 22])
    expect(peekCachedServerCommandRevision()).toBe(23)
  })

  it('runs a per-step execution wrapper before that step acquires its base revision', async () => {
    const order: string[] = []
    const bases: number[] = []
    const success = (revision: number, type: string): ServerCommandResult => ({
      status: 'ok',
      revision,
      event: { type, revision, resource: 'asset' },
    })
    setCachedServerCommandRevision(30)

    const result = await runServerCommandSequence([
      async (baseRevision) => {
        order.push('first-command')
        bases.push(baseRevision)
        return success(baseRevision + 1, 'sequence.first')
      },
      {
        command: async (baseRevision) => {
          order.push('wrapped-command')
          bases.push(baseRevision)
          return success(baseRevision + 1, 'sequence.wrapped')
        },
        executionWrapper: async (execute) => {
          order.push('wrapped-predecessor')
          setCachedServerCommandRevision(40)
          return execute()
        },
      },
      async (baseRevision) => {
        order.push('last-command')
        bases.push(baseRevision)
        return success(baseRevision + 1, 'sequence.last')
      },
    ])

    expect(result).toBeNull()
    expect(order).toEqual(['first-command', 'wrapped-predecessor', 'wrapped-command', 'last-command'])
    expect(bases).toEqual([30, 40, 41])
    expect(peekCachedServerCommandRevision()).toBe(42)
  })

  it('rolls back when a command execution wrapper retains the mutation without sending', async () => {
    const rollback = vi.fn()
    const command = vi.fn(async () => ({ status: 'unavailable' as const }))

    await expect(
      runServerCommand({
        command,
        rollback,
        executionWrapper: async () => ({ status: 'unavailable' }),
      }),
    ).resolves.toEqual({ status: 'unavailable' })

    expect(command).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('keeps an optimistic projection when a durable execution wrapper retains the exact row', async () => {
    const rollback = vi.fn()
    const command = vi.fn(async () => ({ status: 'unavailable' as const }))

    await expect(
      runServerCommand({
        command,
        rollback,
        executionWrapper: async () => ({ status: 'unavailable' }),
        failureRollbackDisposition: () => 'retain',
      }),
    ).resolves.toEqual({ status: 'unavailable' })

    expect(command).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
  })

  it('consults a durable rollback disposition when an execution wrapper rejects', async () => {
    const rollback = vi.fn()
    let retained = false

    await expect(
      runServerCommand({
        command: async () => ({ status: 'unavailable' }),
        rollback,
        executionWrapper: async () => {
          retained = true
          throw new Error('durable lock failed')
        },
        failureRollbackDisposition: () => (retained ? 'retain' : 'rollback'),
      }),
    ).rejects.toThrow('durable lock failed')

    expect(rollback).not.toHaveBeenCalled()
  })

  it('normalizes a rejected per-step execution wrapper and rolls the sequence back once', async () => {
    setCachedServerCommandRevision(50)
    const rollback = vi.fn()
    const wrappedCommand = vi.fn(async () => ({ status: 'unavailable' as const }))
    const skipped = vi.fn(async () => ({ status: 'unavailable' as const }))

    const result = await runServerCommandSequence(
      [
        {
          command: wrappedCommand,
          executionWrapper: async () => {
            throw new Error('prepared durability failed')
          },
        },
        skipped,
      ],
      rollback,
    )

    expect(result).toEqual({
      status: 'error',
      error: 'Command execution wrapper rejected: prepared durability failed',
    })
    expect(wrappedCommand).not.toHaveBeenCalled()
    expect(skipped).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('fails a sequence fast and rolls back before reconciling its accepted events', async () => {
    const order: string[] = []
    let reconciledRevisions: number[] = []
    let reconciledLocalEffects: Array<[number, ServerCommandLocalEffect]> = []
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => {
      responseIndex += 1
      if (responseIndex === 1) {
        order.push('accepted-response')
        return {
          revision: 51,
          event: { type: 'settings.updated', revision: 51, resource: 'settings', id: 'runtime' },
          acknowledgedKeys: ['maxContext'],
          settings: { maxContext: 8_000 },
        }
      }
      order.push('conflict-response')
      return jsonResponse({ currentRevision: 55 }, 409)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    setCachedServerCommandRevision(50)
    setServerCommandSuccessReconciler((_event, events, localEffects) => {
      order.push('reconcile')
      reconciledRevisions = events.map((event) => event.revision)
      reconciledLocalEffects = Array.from(localEffects.entries())
    })
    const rollback = vi.fn(async () => {
      order.push('rollback-start')
      await Promise.resolve()
      order.push('rollback-finish')
    })
    const skipped = vi.fn(async (baseRevision: number) => ({
      status: 'ok' as const,
      revision: baseRevision + 1,
      event: { type: 'skipped.updated', revision: baseRevision + 1, resource: 'asset' },
    }))

    const result = await runServerCommandSequence(
      [
        (baseRevision) =>
          patchSettingsGroup({
            group: 'runtime',
            baseRevision,
            patch: { maxContext: 8_000 },
            acknowledgeOptimistic: true,
            optimisticProjectionEpoch: 9,
          }),
        (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxResponse: 1_000 } }),
        skipped,
      ],
      rollback,
    )

    expect(result).toEqual({ status: 'conflict', currentRevision: 55 })
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      { baseRevision: 50, patch: { maxContext: 8_000 } },
      { baseRevision: 51, patch: { maxResponse: 1_000 } },
    ])
    expect(skipped).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['accepted-response', 'conflict-response', 'rollback-start', 'rollback-finish', 'reconcile'])
    expect(reconciledRevisions).toEqual([51])
    expect(reconciledLocalEffects).toEqual([])
    expect(peekCachedServerCommandRevision()).toBe(55)
  })

  it('invalidates an asynchronous sequence rollback when a destructive refresh wins during cleanup', async () => {
    setCachedServerCommandRevision(50)
    const cleanupStarted = createDeferred<void>()
    const cleanupRelease = createDeferred<void>()
    const restoreProjection = vi.fn()

    const sequence = runServerCommandSequence(
      [async () => ({ status: 'error' as const, error: 'terminal failure' })],
      async (rollbackIsCurrent) => {
        expect(rollbackIsCurrent()).toBe(true)
        cleanupStarted.resolve()
        await cleanupRelease.promise
        if (rollbackIsCurrent()) restoreProjection()
      },
    )

    await cleanupStarted.promise
    createDestructiveRefreshToken('sequence-cleanup-refresh')
    cleanupRelease.resolve()

    await expect(sequence).resolves.toEqual({ status: 'error', error: 'terminal failure' })
    expect(restoreProjection).not.toHaveBeenCalled()
  })

  it('completes compatibility sequences whose successful result has no command event', async () => {
    setCachedServerCommandRevision(60)
    const reconciler = vi.fn()
    const rollback = vi.fn()
    setServerCommandSuccessReconciler(reconciler)

    const result = await runServerCommandSequence(
      [async () => ({ status: 'ok' }) as unknown as ServerCommandResult],
      rollback,
    )

    expect(result).toBeNull()
    expect(rollback).not.toHaveBeenCalled()
    expect(reconciler).not.toHaveBeenCalled()
    expect(peekCachedServerCommandRevision()).toBe(60)
  })

  it('keeps unqueued translation response reconciliation immediate during an unrelated queued mutation', async () => {
    const queuedResponse = createDeferred<Response>()
    const reconciledRevisions: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/messages/message-1/translate')) {
          return jsonResponse({
            revision: 11,
            event: { type: 'message.updated', revision: 11, resource: 'message', id: 'message-1' },
            chatId: 'chat-1',
            messageId: 'message-1',
            translation: { source: 'raw', text: 'translated' },
          })
        }
        return queuedResponse.promise
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(10)
    setServerCommandSuccessReconciler(async (event) => {
      reconciledRevisions.push(event.revision)
    })

    const queued = runServerCommand({
      command: (baseRevision) =>
        patchRuntimeSettings({
          baseRevision,
          patch: { maxContext: 8_000 },
        }),
    })
    const translation = await translateMessageCommand({
      baseRevision: 10,
      messageId: 'message-1',
      jobId: 'translation-job-1',
    })

    expect(translation).toMatchObject({ status: 'ok', revision: 11 })
    expect(reconciledRevisions).toEqual([11])

    queuedResponse.resolve(
      jsonResponse({
        revision: 12,
        event: { type: 'settings.updated', revision: 12, resource: 'settings' },
      }),
    )
    await expect(queued).resolves.toMatchObject({ status: 'ok', revision: 12 })
    expect(reconciledRevisions).toEqual([11, 12])
  })

  it('maps projection-sweep toggles to server-backed settings groups', () => {
    expect(settingsGroupForKey('notification')).toBe('display')
    expect(settingsGroupForKey('useAutoSuggestions')).toBe('runtime')
    expect(settingsGroupForKey('useAutoTranslateInput')).toBe('language')
    expect(settingsGroupForKey('translatorExcludeThoughts')).toBe('language')
    expect(settingsGroupForKey('globalChatVariables')).toBe('sidebar')
    expect(settingsGroupForKey('jailbreakToggle')).toBe('sidebar')
    expect(settingsGroupForKey('customSidebarItems')).toBe('sidebar')
    expect(settingsGroupForKey('ooba')).toBe('providers')
    expect(settingsGroupForKey('reverseProxyOobaArgs')).toBe('providers')
    expect(settingsGroupForKey('localStopStrings')).toBe('runtime')
    expect(settingsGroupForKey('NAIsettings')).toBe('providers')
    expect(settingsGroupForKey('ainconfig')).toBe('providers')
    expect(settingsGroupForKey('bias')).toBe('providers')
    expect(settingsGroupForKey('additionalParams')).toBe('providers')
    expect(settingsGroupForKey('aiModel')).toBe('providers')
    expect(settingsGroupForKey('subModel')).toBe('providers')
    expect(settingsGroupForKey('google')).toBe('providers')
    expect(settingsGroupForKey('vertexClientEmail')).toBe('providers')
    expect(settingsGroupForKey('vertexPrivateKey')).toBe('providers')
    expect(settingsGroupForKey('vertexAccessToken')).toBe('providers')
    expect(settingsGroupForKey('vertexAccessTokenExpires')).toBe('providers')
    expect(settingsGroupForKey('vertexRegion')).toBe('providers')
    expect(settingsGroupForKey('novelai')).toBe('providers')
    expect(settingsGroupForKey('OaiCompAPIKeys')).toBe('providers')
    expect(settingsGroupForKey('hordeConfig')).toBe('providers')
    expect(settingsGroupForKey('ollamaCloudModel')).toBe('providers')
    expect(settingsGroupForKey('ollamaCloudModelName')).toBe('providers')
    expect(settingsGroupForKey('nanogptRequestModel')).toBe('providers')
    expect(settingsGroupForKey('nanogptRequestModelName')).toBe('providers')
    expect(settingsGroupForKey('openrouterRequestModel')).toBe('providers')
    expect(settingsGroupForKey('openrouterFallback')).toBe('providers')
    expect(settingsGroupForKey('openrouterMiddleOut')).toBe('providers')
    expect(settingsGroupForKey('openrouterProvider')).toBe('providers')
    expect(settingsGroupForKey('useInstructPrompt')).toBe('providers')
    expect(settingsGroupForKey('instructChatTemplate')).toBe('providers')
    expect(settingsGroupForKey('JinjaTemplate')).toBe('providers')
    expect(settingsGroupForKey('providerCredentials')).toBe('providers')
    expect(settingsGroupForKey('modelProfiles')).toBe('providers')
    expect(settingsGroupForKey('modelRoleProfiles')).toBe('providers')
    expect(settingsGroupForKey('modelRuntimeDefaults')).toBe('providers')
    expect(settingsGroupForKey('modelRoles')).toBe('providers')
    expect(settingsGroupForKey('seperateModels')).toBe('runtime')
    expect(settingsGroupForKey('seperateModelsForAxModels')).toBe('runtime')
    expect(settingsGroupForKey('doNotChangeSeperateModels')).toBe('runtime')
    expect(settingsGroupForKey('seperateParameters')).toBe('runtime')
    expect(settingsGroupForKey('seperateParametersByModel')).toBe('runtime')
    expect(settingsGroupForKey('seperateParametersEnabled')).toBe('runtime')
    expect(settingsGroupForKey('disableSeperateParameterChangeOnPresetChange')).toBe('runtime')
    expect(settingsGroupForKey('epEnabled')).toBe('runtime')
    expect(settingsGroupForKey('streamGeminiThoughts')).toBe('runtime')
    expect(settingsGroupForKey('verbosity')).toBe('runtime')
    expect(settingsGroupForKey('doNotWarnExternalServers')).toBe('advanced')
    expect(settingsGroupForKey('pluginCompatibilityMode')).toBe('advanced')
    expect(settingsGroupForKey('strictScriptCheck')).toBe('advanced')
    expect(settingsGroupForKey('regexOutputSizeLimitMiB')).toBe('advanced')
    expect(settingsGroupForKey('sdProvider')).toBe('media')
    expect(settingsGroupForKey('webUiUrl')).toBe('media')
    expect(settingsGroupForKey('sdSteps')).toBe('media')
    expect(settingsGroupForKey('sdCFG')).toBe('media')
    expect(settingsGroupForKey('sdConfig')).toBe('media')
    expect(settingsGroupForKey('NAIImgUrl')).toBe('media')
    expect(settingsGroupForKey('NAIApiKey')).toBe('media')
    expect(settingsGroupForKey('NAIImgModel')).toBe('media')
    expect(settingsGroupForKey('NAII2I')).toBe('media')
    expect(settingsGroupForKey('NAIImgConfig')).toBe('media')
    expect(settingsGroupForKey('dallEQuality')).toBe('media')
    expect(settingsGroupForKey('stabilityKey')).toBe('media')
    expect(settingsGroupForKey('stabilityModel')).toBe('media')
    expect(settingsGroupForKey('stabllityStyle')).toBe('media')
    expect(settingsGroupForKey('comfyConfig')).toBe('media')
    expect(settingsGroupForKey('comfyUiUrl')).toBe('media')
    expect(settingsGroupForKey('falToken')).toBe('media')
    expect(settingsGroupForKey('falModel')).toBe('media')
    expect(settingsGroupForKey('falLora')).toBe('media')
    expect(settingsGroupForKey('falLoraScale')).toBe('media')
    expect(settingsGroupForKey('ImagenModel')).toBe('media')
    expect(settingsGroupForKey('ImagenImageSize')).toBe('media')
    expect(settingsGroupForKey('ImagenAspectRatio')).toBe('media')
    expect(settingsGroupForKey('ImagenPersonGeneration')).toBe('media')
    expect(settingsGroupForKey('openaiCompatImage')).toBe('media')
    expect(settingsGroupForKey('wavespeedImage')).toBe('media')
    expect(settingsGroupForKey('ttsAutoSpeech')).toBe('media')
    expect(settingsGroupForKey('elevenLabKey')).toBe('media')
    expect(settingsGroupForKey('voicevoxUrl')).toBe('media')
    expect(settingsGroupForKey('huggingfaceKey')).toBe('providers')
    expect(settingsGroupForKey('fishSpeechKey')).toBe('media')
    expect(settingsGroupForKey('emotionProcesser')).toBe('media')
    expect(settingsGroupForKey('hypaV3')).toBe('memory')
    expect(settingsGroupForKey('hypaV3Presets')).toBe('memory')
    expect(settingsGroupForKey('hypaV3PresetId')).toBe('memory')
    expect(settingsGroupForKey('hypaModel')).toBe('memory')
    expect(settingsGroupForKey('hypaV3Key')).toBe('memory')
    expect(settingsGroupForKey('hypaCustomSettings')).toBe('memory')
    expect(settingsGroupForKey('voyageApiKey')).toBe('memory')
    expect(settingsGroupForKey('enableCustomFlags')).toBe('advanced')
    expect(settingsGroupForKey('customFlags')).toBe('advanced')
    expect(settingsGroupForKey('enabledModules')).toBe('modules')
  })

  it('owns the exact prompt settings projection, including the four moved fields', () => {
    expect(PROMPT_SETTINGS_KEYS).toHaveLength(21)
    expect(new Set(PROMPT_SETTINGS_KEYS)).toHaveProperty('size', 21)
    expect(SERVER_SETTINGS_KEYS_BY_GROUP.prompt).toEqual([...PROMPT_SETTINGS_KEYS])
    expect(PROMPT_SETTINGS_KEYS.every((key) => settingsGroupForKey(key) === 'prompt')).toBe(true)

    expect(SERVER_SETTINGS_KEYS_BY_GROUP.media).not.toContain('outputImageModal')
    for (const key of ['fallbackModels', 'fallbackWhenBlankResponse', 'doNotChangeFallbackModels']) {
      expect(SERVER_SETTINGS_KEYS_BY_GROUP.runtime).not.toContain(key)
    }
  })

  it('does not map retired Context Agent settings to command groups', () => {
    expect(settingsGroupForKey('agentContextEnabled')).toBeNull()
    expect(settingsGroupForKey('agentContextPrompt')).toBeNull()
    expect(settingsGroupForKey('agentContextMaxOutput')).toBeNull()
    expect(settingsGroupForKey('agentContextMaxToolRounds')).toBeNull()
  })

  it('reads and caches the command base revision from bootstrap', async () => {
    const commandFetch = makeCommandFetch(() => ({ revision: 12 }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(getServerCommandBaseRevision()).resolves.toBe(12)
    await expect(getServerCommandBaseRevision()).resolves.toBe(12)

    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/bootstrap',
        method: 'GET',
        authHeader: 'test-auth-token',
        contentType: null,
        body: null,
      },
    ])
  })

  it('does not let an older asynchronous response move the cached revision backward', () => {
    setCachedServerCommandRevision(12)
    setCachedServerCommandRevision(9)

    expect(peekCachedServerCommandRevision()).toBe(12)
  })

  it('tracks the known command revision independently from the applied resource revision', () => {
    setAppliedServerResourceRevision(7)
    setCachedServerCommandRevision(9)

    expect(peekCachedServerCommandRevision()).toBe(9)
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('maps revision conflicts to a typed conflict result', async () => {
    const commandFetch = makeCommandFetch(() => jsonResponse({ error: 'revision_conflict', currentRevision: 7 }, 409))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchRuntimeSettings({
      baseRevision: 6,
      patch: { streamGeminiThoughts: true },
    })

    expect(result).toEqual({ status: 'conflict', currentRevision: 7 })
    expect(peekCachedServerCommandRevision()).toBe(7)
    expect(peekAppliedServerResourceRevision()).toBeNull()
  })

  it('reports revision conflicts that prove the resource projection is behind', async () => {
    const commandFetch = makeCommandFetch(() => jsonResponse({ error: 'revision_conflict', currentRevision: 9 }, 409))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const onConflictGap = vi.fn()
    setAppliedServerResourceRevision(6)
    setServerCommandConflictGapHandler(onConflictGap)

    await expect(
      patchRuntimeSettings({
        baseRevision: 6,
        patch: { streamGeminiThoughts: true },
      }),
    ).resolves.toEqual({ status: 'conflict', currentRevision: 9 })

    expect(onConflictGap).toHaveBeenCalledWith(9, 6)
  })

  it.each([
    { status: 400, reason: 'invalid-request' as const },
    { status: 404, reason: 'not-found' as const },
    { status: 401 },
    { status: 403 },
    { status: 429 },
    { status: 500 },
  ])('classifies command HTTP $status without making transient failures terminal', async ({ status, reason }) => {
    const error = `command failed with ${status}`
    const commandFetch = makeCommandFetch(() => jsonResponse({ error }, status))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchRuntimeSettings({
      baseRevision: 1,
      patch: { streamGeminiThoughts: true },
    })

    expect(result).toEqual({
      status: 'error',
      error,
      ...(reason ? { reason } : {}),
    })
  })

  it.each([400, 404, 423])(
    'marks an HTTP %s with a non-command error envelope for explicit durable disposal',
    async (status) => {
      const commandFetch = makeCommandFetch(() =>
        jsonResponse(
          { statusCode: status, error: status === 423 ? 'Locked' : 'Not Found', message: 'proxy response' },
          status,
        ),
      )
      vi.stubGlobal('fetch', commandFetch.fetch)

      await expect(
        patchRuntimeSettings({
          baseRevision: 1,
          patch: { streamGeminiThoughts: true },
        }),
      ).resolves.toEqual({
        status: 'error',
        error: status === 423 ? 'Locked' : 'Not Found',
        reason: 'unrecognized-rejection',
      })
      resetWriterAccessLostForTests()
    },
  )

  it('patches mixed server-backed settings by group with the latest revision', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 10 }
      if (url.endsWith('/settings/providers')) {
        return {
          revision: 11,
          event: { type: 'settings.updated', revision: 11, resource: 'settings', id: 'providers' },
          acknowledgedKeys: ['aiModel'],
          settings: {},
        }
      }
      return {
        revision: 12,
        event: { type: 'settings.updated', revision: 12, resource: 'settings', id: 'runtime' },
        acknowledgedKeys: ['maxContext'],
        settings: {},
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    const result = await patchServerBackedSettings({
      patch: {
        aiModel: 'openrouter',
        maxContext: 12000,
      },
      acknowledgeOptimistic: true,
      optimisticProjectionEpochs: { providers: 20, runtime: 30 },
    })

    expect(result).toEqual({
      status: 'ok',
      revision: 12,
      event: { type: 'settings.updated', revision: 12, resource: 'settings', id: 'runtime' },
      acknowledgedKeys: ['maxContext'],
      settings: {},
    })
    expect(commandFetch.calls.map((call) => ({ url: call.url, body: call.body }))).toEqual([
      {
        url: '/api/v1/bootstrap',
        body: null,
      },
      {
        url: '/api/v1/commands/settings/providers',
        body: {
          baseRevision: 10,
          patch: { aiModel: 'openrouter' },
        },
      },
      {
        url: '/api/v1/commands/settings/runtime',
        body: {
          baseRevision: 11,
          patch: { maxContext: 12000 },
        },
      },
    ])
    expect(observedEffects).toEqual([])
  })

  it('keeps earlier accepted groups authoritative when a later settings group fails', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 10 }
      if (url.endsWith('/settings/providers')) {
        return {
          revision: 11,
          event: { type: 'settings.updated', revision: 11, resource: 'settings', id: 'providers' },
          acknowledgedKeys: ['aiModel'],
          settings: {},
        }
      }
      return jsonResponse({ error: 'maxContext must be a number' }, 400)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const rollback = vi.fn()
    const reconciliations: Array<{ revisions: number[]; localEffects: ServerCommandLocalEffect[] }> = []
    setServerCommandSuccessReconciler((_event, events, localEffects) => {
      reconciliations.push({
        revisions: events.map((event) => event.revision),
        localEffects: [...localEffects.values()],
      })
    })

    const result = await patchServerBackedSettings({
      patch: { aiModel: 'openrouter', maxContext: 'invalid' },
      acknowledgeOptimistic: true,
      optimisticProjectionEpochs: { providers: 20, runtime: 30 },
      rollback,
    })

    expect(result).toEqual({
      status: 'error',
      error: 'maxContext must be a number',
      reason: 'invalid-request',
    })
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(reconciliations).toEqual([{ revisions: [11], localEffects: [] }])
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      null,
      { baseRevision: 10, patch: { aiModel: 'openrouter' } },
      { baseRevision: 11, patch: { maxContext: 'invalid' } },
    ])
  })

  it('routes residual manual settings through existing settings groups', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 20 }
      if (url.endsWith('/settings/display')) {
        return {
          revision: 21,
          event: { type: 'settings.updated', revision: 21, resource: 'settings' },
        }
      }
      if (url.endsWith('/settings/providers')) {
        return {
          revision: 22,
          event: { type: 'settings.updated', revision: 22, resource: 'settings' },
        }
      }
      return {
        revision: 23,
        event: { type: 'settings.updated', revision: 23, resource: 'settings' },
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchServerBackedSettings({
      patch: {
        colorSchemeName: 'custom',
        textScreenColor: null,
        promptDiffPrefs: { diffStyle: 'line', contextRadius: 2 },
        customModels: [{ id: 'model-a', name: 'Model A' }],
        bias: [['token', -10]],
        additionalParams: [['stop', 'value']],
        moduleIntergration: 'module-ns',
        globalscript: [{ id: 'script-a', in: 'foo', out: 'bar', type: 'editinput' }],
        banCharacterset: ['Latn'],
        allowAllExtentionFiles: true,
        auxModelUnderModelSettings: true,
        showUnrecommended: true,
        enableCustomFlags: true,
        customFlags: [8],
      },
    })

    expect(result).toEqual({
      status: 'ok',
      revision: 23,
      event: { type: 'settings.updated', revision: 23, resource: 'settings' },
    })
    expect(commandFetch.calls.map((call) => ({ url: call.url, body: call.body }))).toEqual([
      {
        url: '/api/v1/bootstrap',
        body: null,
      },
      {
        url: '/api/v1/commands/settings/display',
        body: {
          baseRevision: 20,
          patch: {
            colorSchemeName: 'custom',
            textScreenColor: null,
            promptDiffPrefs: { diffStyle: 'line', contextRadius: 2 },
          },
        },
      },
      {
        url: '/api/v1/commands/settings/providers',
        body: {
          baseRevision: 21,
          patch: {
            customModels: [{ id: 'model-a', name: 'Model A' }],
            bias: [['token', -10]],
            additionalParams: [['stop', 'value']],
          },
        },
      },
      {
        url: '/api/v1/commands/settings/advanced',
        body: {
          baseRevision: 22,
          patch: {
            moduleIntergration: 'module-ns',
            globalscript: [{ id: 'script-a', in: 'foo', out: 'bar', type: 'editinput' }],
            banCharacterset: ['Latn'],
            allowAllExtentionFiles: true,
            auxModelUnderModelSettings: true,
            showUnrecommended: true,
            enableCustomFlags: true,
            customFlags: [8],
          },
        },
      },
    ])
  })

  it('surfaces server-backed settings patch conflicts without retrying', async () => {
    let providerAttempts = 0
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 4 }
      if (url.endsWith('/settings/providers')) {
        providerAttempts += 1
        if (providerAttempts === 1) {
          return jsonResponse({ error: 'revision_conflict', currentRevision: 8 }, 409)
        }
        throw new Error('unexpected retry')
      }
      return { revision: 10 }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      patchServerBackedSettings({
        patch: { openrouterKey: 'secret' },
      }),
    ).resolves.toEqual({ status: 'conflict', currentRevision: 8 })

    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      null,
      { baseRevision: 4, patch: { openrouterKey: 'secret' } },
    ])
  })

  it('rolls back optimistic settings when a server-backed patch fails', async () => {
    const rollback = vi.fn()
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 1 }
      return jsonResponse({ error: 'aiModel must be a string' }, 400)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchServerBackedSettings({
      patch: { aiModel: 1 },
      rollback,
    })

    expect(result).toEqual({
      status: 'error',
      error: 'aiModel must be a string',
      reason: 'invalid-request',
    })
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('skips settings rollback when a destructive refresh lands before patch failure', async () => {
    const liveSettings = { aiModel: 'attempted' }
    const rollback = vi.fn(() => {
      if (liveSettings.aiModel === 'attempted') liveSettings.aiModel = 'before'
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 1 }
      createDestructiveRefreshToken('test-full-settings-restore')
      liveSettings.aiModel = 'attempted'
      return jsonResponse({ error: 'aiModel must be a string' }, 400)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchServerBackedSettings({
      patch: { aiModel: 1 },
      rollback,
    })

    expect(result).toEqual({
      status: 'error',
      error: 'aiModel must be a string',
      reason: 'invalid-request',
    })
    expect(rollback).not.toHaveBeenCalled()
    expect(liveSettings.aiModel).toBe('attempted')
  })

  it('creates presets through the typed command helper', async () => {
    const event = { type: 'preset.created', revision: 2, resource: 'preset', id: 'preset-a' }
    const commandFetch = makeCommandFetch(() => ({ revision: 2, event, presetId: 'preset-a' }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await createPresetCommand({
      baseRevision: 1,
      preset: { id: 'preset-a', name: 'A', mainPrompt: 'hello' },
    })

    expect(result).toEqual({ status: 'ok', revision: 2, event, presetId: 'preset-a' })
    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/commands/presets',
        method: 'POST',
        authHeader: 'test-auth-token',
        contentType: 'application/json',
        body: {
          baseRevision: 1,
          preset: { id: 'preset-a', name: 'A', mainPrompt: 'hello' },
        },
      },
    ])
  })

  it('copies and imports presets through typed command helpers with stable ids', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/presets/preset-a/copy')) {
        return {
          revision: 2,
          event: { type: 'preset.copied', revision: 2, resource: 'preset', id: 'preset-copy' },
          presetId: 'preset-copy',
          sourcePresetId: 'preset-a',
        }
      }
      return {
        revision: 3,
        event: { type: 'preset.imported', revision: 3, resource: 'preset', id: 'preset-import' },
        presetId: 'preset-import',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      copyPresetCommand({
        baseRevision: 1,
        presetId: 'preset-a',
        newPresetId: 'preset-copy',
        name: 'A Copy',
        saveCurrent: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, presetId: 'preset-copy' })

    await expect(
      importPresetCommand({
        baseRevision: 2,
        preset: { id: 'preset-import', name: 'Imported' },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, presetId: 'preset-import' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/presets/preset-a/copy',
        body: {
          baseRevision: 1,
          newPresetId: 'preset-copy',
          name: 'A Copy',
          saveCurrent: true,
        },
      },
      {
        url: '/api/v1/commands/presets/import',
        body: {
          baseRevision: 2,
          preset: { id: 'preset-import', name: 'Imported' },
        },
      },
    ])
  })

  it('selects and reorders presets through typed command helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/presets/select')) {
        return {
          revision: 3,
          event: { type: 'preset.selected', revision: 3, resource: 'preset', id: 'preset-b' },
          presetId: 'preset-b',
        }
      }
      return {
        revision: 4,
        event: { type: 'preset.reordered', revision: 4, resource: 'preset' },
        selectedPresetId: 'preset-b',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      selectPresetCommand({
        baseRevision: 2,
        presetId: 'preset-b',
        apply: true,
        saveCurrent: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, presetId: 'preset-b' })

    await expect(
      reorderPresetsCommand({
        baseRevision: 3,
        presetIds: ['preset-b', 'preset-a'],
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 4, selectedPresetId: 'preset-b' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/presets/select',
        body: {
          baseRevision: 2,
          presetId: 'preset-b',
          apply: true,
          saveCurrent: true,
        },
      },
      {
        url: '/api/v1/commands/presets/reorder',
        body: {
          baseRevision: 3,
          presetIds: ['preset-b', 'preset-a'],
        },
      },
    ])
  })

  it('emits strict legacy/model preset reorder effects without serializing projection proofs', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/presets/reorder')) {
        return {
          revision: 4,
          event: {
            type: 'preset.reordered',
            revision: 4,
            resource: 'presetCollectionWithPointer',
          },
          presetReorderCertificate: 'preset-reorder-v1',
          presetKind: 'legacy',
          presetIds: ['preset-b', 'preset-a'],
          selectedPresetId: 'preset-a',
          settingsWritten: true,
        }
      }
      return {
        revision: 5,
        event: { type: 'modelPreset.reordered', revision: 5, resource: 'modelPreset' },
        presetReorderCertificate: 'preset-reorder-v1',
        presetKind: 'model',
        presetIds: ['model-c', 'model-b', 'model-a'],
        selectedModelPresetId: 'model-b',
        settingsWritten: false,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await reorderPresetsCommand({
      baseRevision: 3,
      presetIds: ['preset-b', 'preset-a'],
      optimisticAcknowledgement: {
        presetKind: 'legacy',
        collectionProjectionEpoch: 4,
        settingsProjectionEpoch: 5,
        beforePresetIds: ['preset-a', 'preset-b'],
        attemptedPresetIds: ['preset-b', 'preset-a'],
        beforeSelectedPresetId: 'preset-a',
        attemptedSelectedPresetId: 'preset-a',
        settingsWritten: true,
      },
    })
    await reorderModelPresetsCommand({
      baseRevision: 4,
      modelPresetIds: ['model-c', 'model-b', 'model-a'],
      optimisticAcknowledgement: {
        presetKind: 'model',
        collectionProjectionEpoch: 6,
        settingsProjectionEpoch: 7,
        beforePresetIds: ['model-a', 'model-b', 'model-c'],
        attemptedPresetIds: ['model-c', 'model-b', 'model-a'],
        beforeSelectedPresetId: 'model-b',
        attemptedSelectedPresetId: 'model-b',
        settingsWritten: false,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'presetReorder',
        presetKind: 'legacy',
        collectionProjectionEpoch: 4,
        settingsProjectionEpoch: 5,
        presetIds: ['preset-b', 'preset-a'],
        selectedPresetId: 'preset-a',
        settingsWritten: true,
      },
      {
        kind: 'presetReorder',
        presetKind: 'model',
        collectionProjectionEpoch: 6,
        settingsProjectionEpoch: 7,
        presetIds: ['model-c', 'model-b', 'model-a'],
        selectedPresetId: 'model-b',
        settingsWritten: false,
      },
    ])
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      { baseRevision: 3, presetIds: ['preset-b', 'preset-a'] },
      { baseRevision: 4, modelPresetIds: ['model-c', 'model-b', 'model-a'] },
    ])
  })

  it('rejects malformed legacy preset reorder receipts so authoritative reconciliation remains available', async () => {
    const exactEvent = {
      type: 'preset.reordered',
      revision: 4,
      resource: 'presetCollectionWithPointer',
    }
    const exactReceipt = {
      revision: 4,
      event: exactEvent,
      presetReorderCertificate: 'preset-reorder-v1',
      presetKind: 'legacy',
      presetIds: ['preset-b', 'preset-a'],
      selectedPresetId: 'preset-a',
      settingsWritten: true,
    }
    const bodies = [
      { ...exactReceipt, presetReorderCertificate: undefined },
      { ...exactReceipt, presetIds: ['preset-a', 'preset-b'] },
      { ...exactReceipt, selectedPresetId: 'preset-b' },
      { ...exactReceipt, settingsWritten: false },
      { ...exactReceipt, event: { ...exactEvent, resource: 'presetCollection' } },
    ]
    let bodyIndex = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(bodies[bodyIndex++])),
    )
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    for (const _body of bodies) {
      await reorderPresetsCommand({
        baseRevision: 3,
        presetIds: ['preset-b', 'preset-a'],
        optimisticAcknowledgement: {
          presetKind: 'legacy',
          collectionProjectionEpoch: 4,
          settingsProjectionEpoch: 5,
          beforePresetIds: ['preset-a', 'preset-b'],
          attemptedPresetIds: ['preset-b', 'preset-a'],
          beforeSelectedPresetId: 'preset-a',
          attemptedSelectedPresetId: 'preset-a',
          settingsWritten: true,
        },
      })
    }

    expect(observedEffectCounts).toEqual(bodies.map(() => 0))
  })

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

  it('dispatches Agent Preset commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      const event = { type: 'agentPreset.test', revision: 99, resource: 'agentPreset' }
      if (url.endsWith('/agent-presets/ap_a/steps/aps_a/duplicate')) {
        return { revision: 99, event, presetId: 'ap_a', stepId: 'aps_copy', sourceStepId: 'aps_a' }
      }
      if (url.endsWith('/agent-presets/ap_a/steps/aps_b')) {
        return { revision: 99, event, presetId: 'ap_a', stepId: 'aps_b' }
      }
      if (url.endsWith('/agent-presets/ap_a/steps/aps_a')) {
        return { revision: 99, event, presetId: 'ap_a', stepId: 'aps_a' }
      }
      if (url.endsWith('/agent-presets/ap_a/steps/reorder')) {
        return { revision: 99, event, presetId: 'ap_a' }
      }
      if (url.endsWith('/agent-presets/ap_a/steps')) {
        return { revision: 99, event, presetId: 'ap_a', stepId: 'aps_a' }
      }
      if (url.endsWith('/agent-presets/default')) {
        return { revision: 99, event, agentPresetDefaultId: 'ap_b' }
      }
      if (url.endsWith('/agent-presets/reorder')) {
        return { revision: 99, event, agentPresetDefaultId: 'ap_a' }
      }
      if (url.endsWith('/agent-presets/ap_a/duplicate')) {
        return { revision: 99, event, presetId: 'ap_copy', sourcePresetId: 'ap_a' }
      }
      if (url.endsWith('/agent-presets/ap_b')) {
        return {
          revision: 99,
          event: { type: 'agentPreset.deleted', revision: 99, resource: 'agentPresetDeleted', id: 'ap_b' },
          presetId: 'ap_b',
          clearedDefault: true,
          clearedChatCount: 2,
          clearedLoadoutCount: 1,
        }
      }
      if (url.endsWith('/agent-presets/ap_a')) {
        return { revision: 99, event, presetId: 'ap_a' }
      }
      return { revision: 99, event, presetId: 'ap_a' }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createAgentPresetCommand({
      baseRevision: 1,
      preset: { name: 'Created' },
    })
    await updateAgentPresetCommand({
      baseRevision: 2,
      presetId: 'ap_a',
      patch: { name: 'Updated', enabled: false },
    })
    await duplicateAgentPresetCommand({
      baseRevision: 3,
      presetId: 'ap_a',
      name: 'Copy',
    })
    await deleteAgentPresetCommand({
      baseRevision: 4,
      presetId: 'ap_b',
    })
    await reorderAgentPresetsCommand({
      baseRevision: 5,
      presetIds: ['ap_b', 'ap_a'],
    })
    await setAgentPresetDefaultCommand({
      baseRevision: 6,
      agentPresetId: 'ap_b',
    })
    await createAgentPresetStepCommand({
      baseRevision: 7,
      presetId: 'ap_a',
      step: { name: 'Step' },
    })
    await updateAgentPresetStepCommand({
      baseRevision: 8,
      presetId: 'ap_a',
      stepId: 'aps_a',
      patch: { outputKey: 'facts' },
    })
    await duplicateAgentPresetStepCommand({
      baseRevision: 9,
      presetId: 'ap_a',
      stepId: 'aps_a',
      name: 'Step Copy',
    })
    await deleteAgentPresetStepCommand({
      baseRevision: 10,
      presetId: 'ap_a',
      stepId: 'aps_b',
    })
    await reorderAgentPresetStepsCommand({
      baseRevision: 11,
      presetId: 'ap_a',
      stepIds: ['aps_b', 'aps_a'],
    })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/agent-presets',
        method: 'POST',
        body: {
          baseRevision: 1,
          preset: { name: 'Created' },
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          patch: { name: 'Updated', enabled: false },
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/duplicate',
        method: 'POST',
        body: {
          baseRevision: 3,
          name: 'Copy',
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_b',
        method: 'DELETE',
        body: {
          baseRevision: 4,
        },
      },
      {
        url: '/api/v1/commands/agent-presets/reorder',
        method: 'POST',
        body: {
          baseRevision: 5,
          presetIds: ['ap_b', 'ap_a'],
        },
      },
      {
        url: '/api/v1/commands/agent-presets/default',
        method: 'POST',
        body: {
          baseRevision: 6,
          agentPresetId: 'ap_b',
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/steps',
        method: 'POST',
        body: {
          baseRevision: 7,
          step: { name: 'Step' },
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/steps/aps_a',
        method: 'PATCH',
        body: {
          baseRevision: 8,
          patch: { outputKey: 'facts' },
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/steps/aps_a/duplicate',
        method: 'POST',
        body: {
          baseRevision: 9,
          name: 'Step Copy',
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/steps/aps_b',
        method: 'DELETE',
        body: {
          baseRevision: 10,
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/steps/reorder',
        method: 'POST',
        body: {
          baseRevision: 11,
          stepIds: ['aps_b', 'aps_a'],
        },
      },
    ])
  })

  it('dispatches standalone Agent and preset-use commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      const event = { type: 'agent.test', revision: 99, resource: 'agentPreset' }
      if (url.endsWith('/agents/ag_a/duplicate')) {
        return { revision: 99, event, agentId: 'ag_b', sourceAgentId: 'ag_a' }
      }
      if (url.endsWith('/agents/ag_b')) return { revision: 99, event, agentId: 'ag_b' }
      if (url.endsWith('/agents/ag_a')) return { revision: 99, event, agentId: 'ag_a' }
      if (url.endsWith('/agents/reorder')) return { revision: 99, event }
      if (url.endsWith('/agents')) return { revision: 99, event, agentId: 'ag_a' }
      if (url.endsWith('/agent-presets/ap_a/uses/use_a')) {
        return { revision: 99, event, presetId: 'ap_a', stepId: 'use_a', useId: 'use_a', agentId: 'ag_a' }
      }
      return { revision: 99, event, presetId: 'ap_a', stepId: 'use_a', useId: 'use_a', agentId: 'ag_a' }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const agent = {
      name: 'Researcher',
      instruction: 'Collect facts.',
      modelDefaults: { mode: 'inheritMain' as const },
      runtimeDefaults: { timeoutMs: 30_000 },
      inputScopes: ['currentUserMessage' as const],
      outputFormat: 'text' as const,
    }
    await createAgentCommand({ baseRevision: 1, agent })
    await updateAgentCommand({ baseRevision: 2, agentId: 'ag_a', patch: { instruction: 'Verify facts.' } })
    await duplicateAgentCommand({ baseRevision: 3, agentId: 'ag_a', name: 'Researcher Copy' })
    await deleteAgentCommand({ baseRevision: 4, agentId: 'ag_b' })
    await reorderAgentsCommand({ baseRevision: 5, agentIds: ['ag_a'] })
    await createAgentPresetUseCommand({
      baseRevision: 6,
      presetId: 'ap_a',
      use: {
        agentId: 'ag_a',
        enabled: true,
        phase: 'beforeMain',
        dependencies: [],
        outputKey: 'facts',
        destination: 'promptOutput',
        failurePolicy: { mode: 'required' },
      },
    })
    await updateAgentPresetUseCommand({
      baseRevision: 7,
      presetId: 'ap_a',
      useId: 'use_a',
      patch: { runtimeOverride: { timeoutMs: 45_000 } },
    })
    await deleteAgentPresetUseCommand({ baseRevision: 8, presetId: 'ap_a', useId: 'use_a' })
    await reorderAgentPresetUsesCommand({ baseRevision: 9, presetId: 'ap_a', useIds: ['use_b'] })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/agents',
        method: 'POST',
        body: { baseRevision: 1, agent },
      },
      {
        url: '/api/v1/commands/agents/ag_a',
        method: 'PATCH',
        body: { baseRevision: 2, patch: { instruction: 'Verify facts.' } },
      },
      {
        url: '/api/v1/commands/agents/ag_a/duplicate',
        method: 'POST',
        body: { baseRevision: 3, name: 'Researcher Copy' },
      },
      {
        url: '/api/v1/commands/agents/ag_b',
        method: 'DELETE',
        body: { baseRevision: 4 },
      },
      {
        url: '/api/v1/commands/agents/reorder',
        method: 'POST',
        body: { baseRevision: 5, agentIds: ['ag_a'] },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/uses',
        method: 'POST',
        body: {
          baseRevision: 6,
          use: {
            agentId: 'ag_a',
            enabled: true,
            phase: 'beforeMain',
            dependencies: [],
            outputKey: 'facts',
            destination: 'promptOutput',
            failurePolicy: { mode: 'required' },
          },
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/uses/use_a',
        method: 'PATCH',
        body: { baseRevision: 7, patch: { runtimeOverride: { timeoutMs: 45_000 } } },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/uses/use_a',
        method: 'DELETE',
        body: { baseRevision: 8 },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/uses/reorder',
        method: 'POST',
        body: { baseRevision: 9, useIds: ['use_b'] },
      },
    ])
  })

  it('exposes exact Agent Preset field acknowledgements without serializing optimistic proof', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/agent-presets/ap_a/steps/aps_a')) {
        return {
          revision: 4,
          event: {
            type: 'agentPreset.step.updated',
            revision: 4,
            resource: 'agentPreset',
            id: 'aps_a',
            parentId: 'ap_a',
          },
          presetId: 'ap_a',
          stepId: 'aps_a',
          acknowledgedKeys: ['outputKey'],
          canonicalValues: { outputKey: 'facts' },
          canonicalDeletedKeys: [],
          updatedAt: 400,
        }
      }
      return {
        revision: 3,
        event: {
          type: 'agentPreset.updated',
          revision: 3,
          resource: 'agentPreset',
          id: 'ap_a',
        },
        presetId: 'ap_a',
        acknowledgedKeys: ['name', 'description', 'moduleIntergration'],
        canonicalValues: { name: 'Canonical Name' },
        canonicalDeletedKeys: ['description', 'moduleIntergration'],
        updatedAt: 300,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await updateAgentPresetCommand({
      baseRevision: 2,
      presetId: 'ap_a',
      patch: { name: '  Canonical Name  ', description: null, moduleIntergration: null },
      optimisticAcknowledgement: {
        settingsProjectionEpoch: 12,
        attemptedFields: {
          name: { present: true, value: '  Canonical Name  ' },
          description: { present: true, value: null },
          moduleIntergration: { present: true, value: null },
        },
      },
    })
    await updateAgentPresetStepCommand({
      baseRevision: 3,
      presetId: 'ap_a',
      stepId: 'aps_a',
      patch: { outputKey: ' facts ' },
      optimisticAcknowledgement: {
        settingsProjectionEpoch: 12,
        attemptedFields: { outputKey: { present: true, value: ' facts ' } },
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'agentPresetPatch',
        presetId: 'ap_a',
        settingsProjectionEpoch: 12,
        fields: {
          name: {
            attempted: { present: true, value: '  Canonical Name  ' },
            canonical: { present: true, value: 'Canonical Name' },
          },
          description: {
            attempted: { present: true, value: null },
            canonical: { present: false },
          },
          moduleIntergration: {
            attempted: { present: true, value: null },
            canonical: { present: false },
          },
        },
        updatedAt: 300,
      },
      {
        kind: 'agentPresetStepPatch',
        presetId: 'ap_a',
        stepId: 'aps_a',
        settingsProjectionEpoch: 12,
        fields: {
          outputKey: {
            attempted: { present: true, value: ' facts ' },
            canonical: { present: true, value: 'facts' },
          },
        },
        updatedAt: 400,
      },
    ])
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      {
        baseRevision: 2,
        patch: { name: '  Canonical Name  ', description: null, moduleIntergration: null },
      },
      {
        baseRevision: 3,
        patch: { outputKey: ' facts ' },
      },
    ])
    expect(commandFetch.calls[0]?.body).not.toHaveProperty('optimisticAcknowledgement')
    expect(commandFetch.calls[1]?.body).not.toHaveProperty('optimisticAcknowledgement')
  })

  it('keeps contradictory Agent Preset field receipts on authoritative reconciliation', async () => {
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event: {
        type: 'agentPreset.updated',
        revision: 3,
        resource: 'agentPreset',
        id: 'ap_a',
      },
      presetId: 'ap_a',
      acknowledgedKeys: ['enabled'],
      canonicalValues: { enabled: false },
      canonicalDeletedKeys: [],
      updatedAt: 300,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await updateAgentPresetCommand({
      baseRevision: 2,
      presetId: 'ap_a',
      patch: { name: 'Attempted' },
      optimisticAcknowledgement: {
        settingsProjectionEpoch: 12,
        attemptedFields: { name: { present: true, value: 'Attempted' } },
      },
    })

    expect(observedEffects).toEqual([])
  })

  it.each([
    {
      label: 'non-boolean enabled',
      field: 'enabled',
      attemptedValue: false,
      canonicalValue: 'yes',
    },
    {
      label: 'out-of-range maxConcurrency',
      field: 'maxConcurrency',
      attemptedValue: 4,
      canonicalValue: 17,
    },
    {
      label: 'non-canonical name',
      field: 'name',
      attemptedValue: 'Canonical name',
      canonicalValue: '  Canonical name  ',
    },
  ])('rejects a 2xx Agent Preset metadata receipt with $label', async ({ field, attemptedValue, canonicalValue }) => {
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event: {
        type: 'agentPreset.updated',
        revision: 3,
        resource: 'agentPreset',
        id: 'ap_a',
      },
      presetId: 'ap_a',
      acknowledgedKeys: [field],
      canonicalValues: { [field]: canonicalValue },
      canonicalDeletedKeys: [],
      updatedAt: 300,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await updateAgentPresetCommand({
      baseRevision: 2,
      presetId: 'ap_a',
      patch: { [field]: attemptedValue } as never,
      optimisticAcknowledgement: {
        settingsProjectionEpoch: 12,
        attemptedFields: { [field]: { present: true, value: attemptedValue } },
      },
    })

    expect(observedEffects).toEqual([])
  })

  it.each([
    {
      label: 'non-boolean enabled',
      field: 'enabled',
      attemptedValue: false,
      canonicalValue: 'yes',
    },
    {
      label: 'invalid phase',
      field: 'phase',
      attemptedValue: 'afterMain',
      canonicalValue: 'duringMain',
    },
    {
      label: 'non-canonical dependencies',
      field: 'dependencies',
      attemptedValue: ['aps_a'],
      canonicalValue: ['aps_a', 'aps_a'],
    },
    {
      label: 'invalid model selection',
      field: 'model',
      attemptedValue: { mode: 'modelProfile', profileId: 'profile-a' },
      canonicalValue: { mode: 'modelProfile', profileId: ' ' },
    },
    {
      label: 'out-of-range runtime',
      field: 'runtime',
      attemptedValue: { timeoutMs: 1_000 },
      canonicalValue: { timeoutMs: 200 },
    },
    {
      label: 'non-canonical input scopes',
      field: 'inputScopes',
      attemptedValue: ['recentChatTail'],
      canonicalValue: ['recentChatTail', 'recentChatTail'],
    },
    {
      label: 'invalid output format',
      field: 'outputFormat',
      attemptedValue: 'jsonObject',
      canonicalValue: 'yaml',
    },
    {
      label: 'invalid destination',
      field: 'destination',
      attemptedValue: 'intermediate',
      canonicalValue: 'archive',
    },
    {
      label: 'non-canonical failure policy',
      field: 'failurePolicy',
      attemptedValue: { mode: 'optional' },
      canonicalValue: { mode: 'required', text: 'unexpected' },
    },
  ])('rejects a 2xx Agent Preset step receipt with $label', async ({ field, attemptedValue, canonicalValue }) => {
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event: {
        type: 'agentPreset.step.updated',
        revision: 3,
        resource: 'agentPreset',
        id: 'aps_a',
        parentId: 'ap_a',
      },
      presetId: 'ap_a',
      stepId: 'aps_a',
      acknowledgedKeys: [field],
      canonicalValues: { [field]: canonicalValue },
      canonicalDeletedKeys: [],
      updatedAt: 300,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await updateAgentPresetStepCommand({
      baseRevision: 2,
      presetId: 'ap_a',
      stepId: 'aps_a',
      patch: { [field]: attemptedValue } as never,
      optimisticAcknowledgement: {
        settingsProjectionEpoch: 12,
        attemptedFields: { [field]: { present: true, value: attemptedValue } },
      },
    })

    expect(observedEffects).toEqual([])
  })

  it('accepts canonical structured Agent Preset step receipt values', async () => {
    const patch = {
      dependencies: ['aps_dependency'],
      model: { mode: 'modelProfile', profileId: 'profile-a' },
      runtime: {
        temperature: 120,
        maxInputChars: 2_000,
        maxOutputChars: 1_000,
        timeoutMs: 10_000,
        structuredOutputStrict: true,
      },
      inputScopes: ['recentChatTail', 'mainDraft'],
      failurePolicy: { mode: 'fallbackText', text: 'Fallback' },
    } satisfies AgentPresetStepSnapshot
    const attemptedFields = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, { present: true as const, value }]),
    )
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event: {
        type: 'agentPreset.step.updated',
        revision: 3,
        resource: 'agentPreset',
        id: 'aps_a',
        parentId: 'ap_a',
      },
      presetId: 'ap_a',
      stepId: 'aps_a',
      acknowledgedKeys: Object.keys(patch),
      canonicalValues: patch,
      canonicalDeletedKeys: [],
      updatedAt: 300,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await updateAgentPresetStepCommand({
      baseRevision: 2,
      presetId: 'ap_a',
      stepId: 'aps_a',
      patch,
      optimisticAcknowledgement: {
        settingsProjectionEpoch: 12,
        attemptedFields,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'agentPresetStepPatch',
        presetId: 'ap_a',
        stepId: 'aps_a',
        settingsProjectionEpoch: 12,
        fields: Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [
            key,
            {
              attempted: { present: true, value },
              canonical: { present: true, value },
            },
          ]),
        ),
        updatedAt: 300,
      },
    ])
  })

  it('runs server preset commands with revision lookup and surfaces conflicts', async () => {
    let selectAttempts = 0
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 5 }
      selectAttempts += 1
      if (selectAttempts === 1) {
        return jsonResponse({ error: 'revision_conflict', currentRevision: 8 }, 409)
      }
      throw new Error('unexpected retry')
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      runServerPresetCommand({
        command: (baseRevision) =>
          selectPresetCommand({
            baseRevision,
            presetId: 'preset-b',
          }),
      }),
    ).resolves.toEqual({ status: 'conflict', currentRevision: 8 })

    expect(commandFetch.calls.map((call) => call.body)).toEqual([null, { baseRevision: 5, presetId: 'preset-b' }])
  })

  it('dispatches prompt settings and prompt item commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/settings/prompt')) {
        return {
          revision: 2,
          event: { type: 'settings.updated', revision: 2, resource: 'settings', id: 'prompt' },
          acknowledgedKeys: [
            'mainPrompt',
            'jailbreak',
            'globalNote',
            'formatingOrder',
            'promptPreprocess',
            'presetRegex',
            'promptSettings',
          ],
          settings: {},
        }
      }
      if (url.endsWith('/prompt-items/reorder')) {
        return {
          revision: 6,
          event: { type: 'prompt.item.reordered', revision: 6, resource: 'promptItem' },
        }
      }
      if (url.endsWith('/prompt-items/enable')) {
        return {
          revision: 7,
          event: { type: 'prompt.item.enabled', revision: 7, resource: 'promptItem' },
          enabled: true,
        }
      }
      if (url.endsWith('/prompt-items/item-a')) {
        return {
          revision: 5,
          event: { type: 'prompt.item.deleted', revision: 5, resource: 'promptItem', id: 'item-a' },
          itemId: 'item-a',
        }
      }
      if (url.endsWith('/prompt-items/item-b')) {
        return {
          revision: 4,
          event: { type: 'prompt.item.updated', revision: 4, resource: 'promptItem', id: 'item-b' },
          itemId: 'item-b',
        }
      }
      return {
        revision: 3,
        event: { type: 'prompt.item.created', revision: 3, resource: 'promptItem', id: 'item-b' },
        itemId: 'item-b',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      patchPromptSettingsCommand({
        baseRevision: 1,
        patch: {
          mainPrompt: 'MAIN',
          jailbreak: 'JB',
          globalNote: 'GN',
          formatingOrder: ['main', 'jailbreak'],
          promptPreprocess: true,
          presetRegex: [{ id: 'regex-a', type: 'editinput', in: 'hello', out: 'hi' }],
          promptSettings: { sendName: true },
        },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2 })

    await expect(
      createPromptItemCommand({
        baseRevision: 2,
        promptPresetId: 'prompt-preset-a',
        promptItem: { id: 'item-b', type: 'memory', role2: 'assistant' },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, itemId: 'item-b' })

    await expect(
      updatePromptItemCommand({
        baseRevision: 3,
        promptPresetId: 'prompt-preset-a',
        itemId: 'item-b',
        patch: { type: 'description', role2: 'char' },
        deleteKeys: ['text'],
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 4, itemId: 'item-b' })

    await expect(
      deletePromptItemCommand({
        baseRevision: 4,
        promptPresetId: 'prompt-preset-a',
        itemId: 'item-a',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, itemId: 'item-a' })

    await expect(
      reorderPromptItemsCommand({
        baseRevision: 5,
        promptPresetId: 'prompt-preset-a',
        itemIds: ['item-b'],
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 6 })

    await expect(
      enablePromptItemsCommand({
        baseRevision: 6,
        promptPresetId: 'prompt-preset-a',
        enabled: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 7, enabled: true })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/settings/prompt',
        method: 'PATCH',
        body: {
          baseRevision: 1,
          patch: {
            mainPrompt: 'MAIN',
            jailbreak: 'JB',
            globalNote: 'GN',
            formatingOrder: ['main', 'jailbreak'],
            promptPreprocess: true,
            presetRegex: [{ id: 'regex-a', type: 'editinput', in: 'hello', out: 'hi' }],
            promptSettings: { sendName: true },
          },
        },
      },
      {
        url: '/api/v1/commands/prompt-items',
        method: 'POST',
        body: {
          baseRevision: 2,
          promptPresetId: 'prompt-preset-a',
          promptItem: { id: 'item-b', type: 'memory', role2: 'bot' },
        },
      },
      {
        url: '/api/v1/commands/prompt-items/item-b',
        method: 'PATCH',
        body: {
          baseRevision: 3,
          promptPresetId: 'prompt-preset-a',
          patch: { type: 'description', role2: 'bot' },
          deleteKeys: ['text'],
        },
      },
      {
        url: '/api/v1/commands/prompt-items/item-a',
        method: 'DELETE',
        body: { baseRevision: 4, promptPresetId: 'prompt-preset-a' },
      },
      {
        url: '/api/v1/commands/prompt-items/reorder',
        method: 'POST',
        body: { baseRevision: 5, promptPresetId: 'prompt-preset-a', itemIds: ['item-b'] },
      },
      {
        url: '/api/v1/commands/prompt-items/enable',
        method: 'POST',
        body: { baseRevision: 6, promptPresetId: 'prompt-preset-a', enabled: true },
      },
    ])
  })

  it('emits an exact prompt-settings acknowledgement without serializing client projection metadata', async () => {
    const event = {
      type: 'settings.updated',
      revision: 2,
      resource: 'settings',
      id: 'prompt',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 2,
      event,
      acknowledgedKeys: ['mainPrompt', 'fallbackModels'],
      settings: { mainPrompt: 'canonical' },
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await patchPromptSettingsCommand({
      baseRevision: 1,
      patch: { mainPrompt: 'optimistic', fallbackModels: ['model-a'] },
      acknowledgeOptimistic: true,
      optimisticProjectionEpoch: 17,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'prompt',
        attemptedPatch: { mainPrompt: 'optimistic', fallbackModels: ['model-a'] },
        settings: { mainPrompt: 'canonical', fallbackModels: ['model-a'] },
        settingsProjectionEpoch: 17,
      },
    ])
    expect(commandFetch.calls).toEqual([
      expect.objectContaining({
        url: '/api/v1/commands/settings/prompt',
        method: 'PATCH',
        body: {
          baseRevision: 1,
          patch: { mainPrompt: 'optimistic', fallbackModels: ['model-a'] },
        },
      }),
    ])
    expect(commandFetch.calls[0]?.body).not.toHaveProperty('acknowledgeOptimistic')
    expect(commandFetch.calls[0]?.body).not.toHaveProperty('optimisticProjectionEpoch')
  })

  it('keeps untrusted prompt-settings acknowledgements on authoritative reconciliation', async () => {
    const exactEvent = {
      type: 'settings.updated',
      revision: 2,
      resource: 'settings',
      id: 'prompt',
    }
    const cases: Array<{
      label: string
      body: Record<string, unknown>
      epoch?: number
    }> = [
      {
        label: 'missing projection epoch',
        body: { revision: 2, event: exactEvent, acknowledgedKeys: ['mainPrompt'], settings: {} },
      },
      {
        label: 'negative projection epoch',
        epoch: -1,
        body: { revision: 2, event: exactEvent, acknowledgedKeys: ['mainPrompt'], settings: {} },
      },
      {
        label: 'fractional projection epoch',
        epoch: 1.5,
        body: { revision: 2, event: exactEvent, acknowledgedKeys: ['mainPrompt'], settings: {} },
      },
      {
        label: 'non-finite projection epoch',
        epoch: Number.NaN,
        body: { revision: 2, event: exactEvent, acknowledgedKeys: ['mainPrompt'], settings: {} },
      },
      {
        label: 'wrong event type',
        epoch: 4,
        body: {
          revision: 2,
          event: { ...exactEvent, type: 'prompt.settings.updated' },
          acknowledgedKeys: ['mainPrompt'],
          settings: {},
        },
      },
      {
        label: 'wrong event resource',
        epoch: 4,
        body: {
          revision: 2,
          event: { ...exactEvent, resource: 'prompt' },
          acknowledgedKeys: ['mainPrompt'],
          settings: {},
        },
      },
      {
        label: 'wrong event group',
        epoch: 4,
        body: {
          revision: 2,
          event: { ...exactEvent, id: 'runtime' },
          acknowledgedKeys: ['mainPrompt'],
          settings: {},
        },
      },
      {
        label: 'parent-scoped event',
        epoch: 4,
        body: {
          revision: 2,
          event: { ...exactEvent, parentId: 'unexpected' },
          acknowledgedKeys: ['mainPrompt'],
          settings: {},
        },
      },
      {
        label: 'inexact acknowledgement keys',
        epoch: 4,
        body: { revision: 2, event: exactEvent, acknowledgedKeys: ['mainPrompt', 'jailbreak'], settings: {} },
      },
      {
        label: 'duplicate acknowledgement keys',
        epoch: 4,
        body: {
          revision: 2,
          event: exactEvent,
          acknowledgedKeys: ['mainPrompt', 'mainPrompt'],
          settings: {},
        },
      },
      {
        label: 'foreign canonical override',
        epoch: 4,
        body: {
          revision: 2,
          event: exactEvent,
          acknowledgedKeys: ['mainPrompt'],
          settings: { jailbreak: 'foreign' },
        },
      },
      {
        label: 'non-JSON canonical override',
        epoch: 4,
        body: {
          revision: 2,
          event: exactEvent,
          acknowledgedKeys: ['mainPrompt'],
          settings: { mainPrompt: Number.NaN },
        },
      },
    ]
    let responseIndex = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = cases[responseIndex++].body
        return { status: 200, ok: true, json: async () => body } as Response
      }) as unknown as typeof fetch,
    )
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    for (const testCase of cases) {
      await patchPromptSettingsCommand({
        baseRevision: 1,
        patch: { mainPrompt: 'optimistic' },
        acknowledgeOptimistic: true,
        optimisticProjectionEpoch: testCase.epoch as number,
      })
    }

    expect(observedEffectCounts, cases.map(({ label }) => label).join(', ')).toEqual(cases.map(() => 0))
  })

  it('emits exact split-preset PATCH acknowledgements without serializing projection proofs', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url.includes('/model-presets/')) {
        return {
          revision: 2,
          event: { type: 'modelPreset.updated', revision: 2, resource: 'modelPreset', id: 'model-a' },
          modelPresetId: 'model-a',
          acknowledgedKeys: ['temperature'],
          preset: { temperature: 0.5 },
          settings: { temperature: 0.5 },
          selectedProjectionApplied: true,
          ownerProjectionApplied: false,
          selectedPromptPresetId: 'prompt-a',
        }
      }
      return {
        revision: 3,
        event: { type: 'promptPreset.updated', revision: 3, resource: 'promptPreset', id: 'prompt-a' },
        promptPresetId: 'prompt-a',
        acknowledgedKeys: ['name'],
        preset: {},
        settings: {},
        selectedProjectionApplied: false,
        ownerProjectionApplied: false,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await updateModelPresetCommand({
      baseRevision: 1,
      modelPresetId: 'model-a',
      patch: { temperature: 0.6 },
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 4,
        settingsProjectionEpoch: 5,
        selectedPresetId: 'model-a',
        selectedPromptPresetId: 'prompt-a',
        attemptedSettings: { temperature: 0.6 },
        selectedProjectionExpected: true,
        ownerProjectionExpected: false,
      },
    })
    await updatePromptPresetCommand({
      baseRevision: 2,
      promptPresetId: 'prompt-a',
      patch: { name: 'Prompt renamed' },
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 6,
        settingsProjectionEpoch: 7,
        selectedPresetId: 'prompt-a',
        selectedPromptPresetId: 'prompt-a',
        attemptedSettings: {},
        selectedProjectionExpected: false,
        ownerProjectionExpected: false,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'splitPresetPatch',
        presetKind: 'model',
        presetId: 'model-a',
        attemptedPatch: { temperature: 0.6 },
        preset: { temperature: 0.5 },
        attemptedSettings: { temperature: 0.6 },
        settings: { temperature: 0.5 },
        selectedProjectionApplied: true,
        ownerProjectionApplied: false,
        collectionProjectionEpoch: 4,
        settingsProjectionEpoch: 5,
        selectedPresetId: 'model-a',
        selectedPromptPresetId: 'prompt-a',
      },
      {
        kind: 'splitPresetPatch',
        presetKind: 'prompt',
        presetId: 'prompt-a',
        attemptedPatch: { name: 'Prompt renamed' },
        preset: { name: 'Prompt renamed' },
        attemptedSettings: {},
        settings: {},
        selectedProjectionApplied: false,
        ownerProjectionApplied: false,
        collectionProjectionEpoch: 6,
        settingsProjectionEpoch: 7,
        selectedPresetId: 'prompt-a',
      },
    ])
    expect(commandFetch.calls[0]?.body).toEqual({ baseRevision: 1, patch: { temperature: 0.6 } })
    expect(commandFetch.calls[1]?.body).toEqual({ baseRevision: 2, patch: { name: 'Prompt renamed' } })
  })

  it('emits an exact legacy-preset PATCH acknowledgement without serializing its optimistic proof', async () => {
    const event = {
      type: 'preset.updated',
      revision: 2,
      resource: 'presetRow',
      id: 'preset-a',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 2,
      event,
      presetId: 'preset-a',
      acknowledgedKeys: ['name'],
      canonicalValues: { name: 'Canonical name' },
      canonicalDeletedKeys: ['agentPresetDefaultId'],
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await updatePresetCommand({
      baseRevision: 1,
      presetId: 'preset-a',
      patch: { name: 'Optimistic name' },
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 17,
        attemptedFields: {
          name: { present: true, value: 'Optimistic name' },
          agents: { present: false },
          agentPresets: { present: false },
          agentPresetDefaultId: { present: true, value: 'missing-agent' },
        },
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'legacyPresetPatch',
        presetId: 'preset-a',
        collectionProjectionEpoch: 17,
        fields: {
          name: {
            attempted: { present: true, value: 'Optimistic name' },
            canonical: { present: true, value: 'Canonical name' },
          },
          agentPresetDefaultId: {
            attempted: { present: true, value: 'missing-agent' },
            canonical: { present: false },
          },
        },
      },
    ])
    expect(commandFetch.calls[0]?.body).toEqual({
      baseRevision: 1,
      patch: { name: 'Optimistic name' },
    })
    expect(commandFetch.calls[0]?.body).not.toHaveProperty('optimisticAcknowledgement')
  })

  it('keeps malformed legacy-preset PATCH receipts on authoritative reconciliation', async () => {
    const exactEvent = {
      type: 'preset.updated',
      revision: 2,
      resource: 'presetRow',
      id: 'preset-a',
    }
    const exactBody = {
      revision: 2,
      event: exactEvent,
      presetId: 'preset-a',
      acknowledgedKeys: ['name'],
      canonicalValues: { name: 'Canonical name' },
      canonicalDeletedKeys: [] as string[],
    }
    const cases: Array<{
      body?: Record<string, unknown>
      acknowledgement?: {
        collectionProjectionEpoch: number
        attemptedFields: Record<string, unknown>
      }
    }> = [
      { body: { ...exactBody, event: { ...exactEvent, resource: 'preset' } } },
      { body: { ...exactBody, presetId: 'preset-b' } },
      { body: { ...exactBody, acknowledgedKeys: ['name', 'extra'] } },
      { body: { ...exactBody, canonicalValues: { id: 'preset-b' } } },
      { body: { ...exactBody, canonicalValues: { foreign: true } } },
      {
        body: {
          ...exactBody,
          canonicalValues: { name: 'Canonical name' },
          canonicalDeletedKeys: ['name'],
        },
      },
      {
        acknowledgement: {
          collectionProjectionEpoch: 17,
          attemptedFields: { name: { present: false, value: 'invalid' } },
        },
      },
      {
        acknowledgement: {
          collectionProjectionEpoch: 17,
          attemptedFields: {
            name: { present: true, value: 'Optimistic name' },
            agentPresetDefaultId: { present: false },
          },
        },
      },
      {
        acknowledgement: {
          collectionProjectionEpoch: 17,
          attemptedFields: {
            name: { present: true, value: 'Optimistic name' },
            agentPresets: { present: false },
            agentPresetDefaultId: { present: false },
            foreign: { present: false },
          },
        },
      },
      { acknowledgement: { collectionProjectionEpoch: -1, attemptedFields: {} } },
    ]
    let responseIndex = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(cases[responseIndex].body ?? exactBody)) as unknown as typeof fetch,
    )
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    for (const testCase of cases) {
      await updatePresetCommand({
        baseRevision: 1,
        presetId: 'preset-a',
        patch: { name: 'Optimistic name' },
        optimisticAcknowledgement: (testCase.acknowledgement ?? {
          collectionProjectionEpoch: 17,
          attemptedFields: {
            name: { present: true, value: 'Optimistic name' },
            agentPresets: { present: false },
            agentPresetDefaultId: { present: false },
          },
        }) as never,
      })
      responseIndex += 1
    }

    expect(observedEffectCounts).toEqual(cases.map(() => 0))
  })

  it('keeps malformed split-preset receipts on authoritative reconciliation', async () => {
    const exactEvent = { type: 'modelPreset.updated', revision: 2, resource: 'modelPreset', id: 'model-a' }
    const cases = [
      { ...exactEvent, resource: 'promptPreset', responseRevision: 2 },
      { ...exactEvent, id: 'model-b', responseRevision: 2 },
    ]
    let responseIndex = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const testCase = cases[responseIndex++]
        return jsonResponse({
          revision: testCase.responseRevision,
          event: {
            type: testCase.type,
            revision: 2,
            resource: testCase.resource,
            id: testCase.id,
          },
          modelPresetId: 'model-a',
          acknowledgedKeys: ['temperature'],
          preset: {},
          settings: {},
          selectedProjectionApplied: true,
          ownerProjectionApplied: false,
          selectedPromptPresetId: 'prompt-a',
        })
      }) as unknown as typeof fetch,
    )
    const observedSizes: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedSizes.push(localEffects.size)
    })

    for (const _testCase of cases) {
      await updateModelPresetCommand({
        baseRevision: 1,
        modelPresetId: 'model-a',
        patch: { temperature: 0.6 },
        optimisticAcknowledgement: {
          collectionProjectionEpoch: 1,
          settingsProjectionEpoch: 1,
          selectedPresetId: 'model-a',
          selectedPromptPresetId: 'prompt-a',
          attemptedSettings: { temperature: 0.6 },
          selectedProjectionExpected: true,
        },
      })
    }

    expect(observedSizes).toEqual([0, 0])
  })

  it('emits exact prompt-item optimistic acknowledgements without serializing their snapshots or epochs', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const responses = [
      {
        revision: 1,
        event: {
          type: 'prompt.item.created',
          revision: 1,
          resource: 'promptItem',
          id: 'item-b',
          parentId: 'prompt-preset-a',
        },
        itemId: 'item-b',
      },
      {
        revision: 2,
        event: {
          type: 'prompt.item.updated',
          revision: 2,
          resource: 'promptItem',
          id: 'item-b',
          parentId: 'prompt-preset-a',
        },
        itemId: 'item-b',
      },
      {
        revision: 3,
        event: {
          type: 'prompt.item.deleted',
          revision: 3,
          resource: 'promptItem',
          id: 'item-a',
          parentId: 'prompt-preset-a',
        },
        itemId: 'item-a',
      },
      {
        revision: 4,
        event: {
          type: 'prompt.item.reordered',
          revision: 4,
          resource: 'promptItem',
          parentId: 'prompt-preset-a',
        },
      },
      {
        revision: 5,
        event: {
          type: 'prompt.item.enabled',
          revision: 5,
          resource: 'promptItem',
          parentId: 'prompt-preset-a',
        },
        enabled: false,
      },
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => responses[responseIndex++])
    vi.stubGlobal('fetch', commandFetch.fetch)
    const itemA = { id: 'item-a', type: 'plain', text: 'A' }
    const itemB = { id: 'item-b', type: 'memory', text: 'B' }
    const acknowledgement = (ownerState: { enabled: true; items: PromptItemSnapshot[] } | { enabled: false }) => ({
      collectionProjectionEpoch: 11,
      ownerProjectionEpoch: 12,
      ownerState,
    })

    await createPromptItemCommand({
      baseRevision: 0,
      promptPresetId: 'prompt-preset-a',
      promptItem: itemB,
      optimisticAcknowledgement: acknowledgement({ enabled: true, items: [itemA, itemB] }),
    })
    await updatePromptItemCommand({
      baseRevision: 1,
      promptPresetId: 'prompt-preset-a',
      itemId: 'item-b',
      patch: { type: 'description' },
      deleteKeys: ['text'],
      optimisticAcknowledgement: acknowledgement({
        enabled: true,
        items: [itemA, { id: 'item-b', type: 'description' }],
      }),
    })
    await deletePromptItemCommand({
      baseRevision: 2,
      promptPresetId: 'prompt-preset-a',
      itemId: 'item-a',
      optimisticAcknowledgement: acknowledgement({ enabled: true, items: [{ id: 'item-b', type: 'description' }] }),
    })
    await reorderPromptItemsCommand({
      baseRevision: 3,
      promptPresetId: 'prompt-preset-a',
      itemIds: ['item-b', 'item-a'],
      optimisticAcknowledgement: acknowledgement({ enabled: true, items: [itemB, itemA] }),
    })
    await enablePromptItemsCommand({
      baseRevision: 4,
      promptPresetId: 'prompt-preset-a',
      enabled: false,
      optimisticAcknowledgement: acknowledgement({ enabled: false }),
    })

    expect(observedEffects).toEqual([
      expect.objectContaining({ kind: 'promptItemMutation', operation: 'create', itemId: 'item-b' }),
      expect.objectContaining({ kind: 'promptItemMutation', operation: 'update', itemId: 'item-b' }),
      expect.objectContaining({ kind: 'promptItemMutation', operation: 'delete', itemId: 'item-a' }),
      expect.objectContaining({
        kind: 'promptItemMutation',
        operation: 'reorder',
        itemIds: ['item-b', 'item-a'],
      }),
      expect.objectContaining({ kind: 'promptItemMutation', operation: 'enable', enabled: false }),
    ])
    expect(
      observedEffects.every(
        (effect) => effect.kind !== 'promptItemMutation' || effect.promptPresetId === 'prompt-preset-a',
      ),
    ).toBe(true)
    expect(
      commandFetch.calls.every(
        (call) => !Object.prototype.hasOwnProperty.call(call.body ?? {}, 'optimisticAcknowledgement'),
      ),
    ).toBe(true)
  })

  it('keeps malformed prompt-item acknowledgements on authoritative reconciliation', async () => {
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })
    const responses = [
      {
        revision: 1,
        event: { type: 'prompt.item.updated', revision: 1, resource: 'promptItem', id: 'wrong-item' },
        itemId: 'item-a',
      },
      {
        revision: 2,
        event: {
          type: 'prompt.item.updated',
          revision: 2,
          resource: 'promptItem',
          id: 'item-a',
          parentId: 'foreign-owner',
        },
        itemId: 'item-a',
      },
      {
        revision: 3,
        event: { type: 'prompt.item.reordered', revision: 3, resource: 'promptItem' },
      },
      {
        revision: 4,
        event: { type: 'prompt.item.enabled', revision: 4, resource: 'promptItem' },
        enabled: true,
      },
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => responses[responseIndex++])
    vi.stubGlobal('fetch', commandFetch.fetch)
    const baseAcknowledgement = {
      collectionProjectionEpoch: 1,
      ownerProjectionEpoch: 2,
      ownerState: { enabled: true as const, items: [{ id: 'item-a', type: 'description' }] },
    }

    await updatePromptItemCommand({
      baseRevision: 0,
      itemId: 'item-a',
      patch: { type: 'description' },
      optimisticAcknowledgement: baseAcknowledgement,
    })
    await updatePromptItemCommand({
      baseRevision: 1,
      itemId: 'item-a',
      patch: { type: 'description' },
      optimisticAcknowledgement: baseAcknowledgement,
    })
    await reorderPromptItemsCommand({
      baseRevision: 2,
      itemIds: ['item-a'],
      optimisticAcknowledgement: {
        ...baseAcknowledgement,
        ownerState: {
          enabled: true,
          items: [
            { id: 'item-a', type: 'plain' },
            { id: 'item-a', type: 'memory' },
          ],
        },
      },
    })
    await enablePromptItemsCommand({
      baseRevision: 3,
      enabled: false,
      optimisticAcknowledgement: { ...baseAcknowledgement, ownerState: { enabled: false } },
    })

    expect(observedEffectCounts).toEqual([0, 0, 0, 0])
  })

  it('dispatches persona commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/personas/select')) {
        return {
          revision: 5,
          event: { type: 'persona.selected', revision: 5, resource: 'persona', id: 'persona-b' },
          personaId: 'persona-b',
        }
      }
      if (url.endsWith('/personas/reorder')) {
        return {
          revision: 6,
          event: { type: 'persona.reordered', revision: 6, resource: 'persona' },
          selectedPersonaId: 'persona-b',
        }
      }
      if (url.endsWith('/personas/persona-a')) {
        return {
          revision: 4,
          event: { type: 'persona.deleted', revision: 4, resource: 'persona', id: 'persona-a' },
          personaId: 'persona-a',
          selectedPersonaId: 'persona-b',
        }
      }
      if (url.endsWith('/personas/persona-b')) {
        return {
          revision: 3,
          event: { type: 'persona.updated', revision: 3, resource: 'persona', id: 'persona-b' },
          personaId: 'persona-b',
        }
      }
      return {
        revision: 2,
        event: { type: 'persona.created', revision: 2, resource: 'persona', id: 'persona-b' },
        personaId: 'persona-b',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      createPersonaCommand({
        baseRevision: 1,
        persona: { id: 'persona-b', name: 'B', icon: '', personaPrompt: 'hello' },
        mirrorLegacyProfile: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, personaId: 'persona-b' })

    await expect(
      updatePersonaCommand({
        baseRevision: 2,
        personaId: 'persona-b',
        patch: { name: 'Bee', largePortrait: true },
        mirrorLegacyProfile: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, personaId: 'persona-b' })

    await expect(
      deletePersonaCommand({
        baseRevision: 3,
        personaId: 'persona-a',
        selectPersonaId: 'persona-b',
        mirrorLegacyProfile: true,
        saveCurrent: true,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      revision: 4,
      personaId: 'persona-a',
      selectedPersonaId: 'persona-b',
    })

    await expect(
      selectPersonaCommand({
        baseRevision: 4,
        personaId: 'persona-b',
        mirrorLegacyProfile: true,
        saveCurrent: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, personaId: 'persona-b' })

    await expect(
      reorderPersonasCommand({
        baseRevision: 5,
        personaIds: ['persona-b'],
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 6, selectedPersonaId: 'persona-b' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/personas',
        method: 'POST',
        body: {
          baseRevision: 1,
          persona: { id: 'persona-b', name: 'B', icon: '', personaPrompt: 'hello' },
          mirrorLegacyProfile: true,
        },
      },
      {
        url: '/api/v1/commands/personas/persona-b',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          patch: { name: 'Bee', largePortrait: true },
          mirrorLegacyProfile: true,
        },
      },
      {
        url: '/api/v1/commands/personas/persona-a',
        method: 'DELETE',
        body: {
          baseRevision: 3,
          selectPersonaId: 'persona-b',
          mirrorLegacyProfile: true,
          saveCurrent: true,
        },
      },
      {
        url: '/api/v1/commands/personas/select',
        method: 'POST',
        body: {
          baseRevision: 4,
          personaId: 'persona-b',
          mirrorLegacyProfile: true,
          saveCurrent: true,
        },
      },
      {
        url: '/api/v1/commands/personas/reorder',
        method: 'POST',
        body: { baseRevision: 5, personaIds: ['persona-b'] },
      },
    ])
  })

  it('acknowledges stable structural persona owners while keeping delete cascade reconciliation authoritative', async () => {
    const profileA = { name: 'A', icon: 'asset-a', personaPrompt: 'Prompt A', note: 'Note A' }
    const profileB = { name: 'B', icon: 'asset-b', personaPrompt: 'Prompt B', note: 'Note B' }
    const personaA = { id: 'persona-a', ...profileA }
    const personaB = { id: 'persona-b', ...profileB }
    const [idsAB, collectionAB, collectionB, profileBDigest] = await Promise.all([
      sha256Hex(serializePersonaIdsDigestInput(['persona-a', 'persona-b'])),
      sha256Hex(serializePersonaCollectionDigestInput([personaA, personaB])),
      sha256Hex(serializePersonaCollectionDigestInput([personaB])),
      sha256Hex(serializePersonaProfileDigestInput(profileB)),
    ])
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/personas/select')) {
        return {
          revision: 4,
          event: { type: 'persona.selected', revision: 4, resource: 'persona', id: 'persona-b' },
          personaId: 'persona-b',
          personaMutationCertificate: 'persona-mutation-v1',
          operation: 'select',
          personaProjectionDigest: idsAB,
          selectedPersonaId: 'persona-b',
          collectionWritten: false,
          settingsWritten: true,
          legacyProfileProjectionApplied: false,
          legacyProfileDigest: null,
        }
      }
      if (url.endsWith('/personas/reorder')) {
        return {
          revision: 5,
          event: { type: 'persona.reordered', revision: 5, resource: 'persona' },
          personaMutationCertificate: 'persona-mutation-v1',
          operation: 'reorder',
          personaProjectionDigest: collectionAB,
          selectedPersonaId: 'persona-b',
          collectionWritten: true,
          settingsWritten: true,
          legacyProfileProjectionApplied: false,
          legacyProfileDigest: null,
        }
      }
      if (url.endsWith('/personas/persona-a')) {
        return {
          revision: 3,
          event: { type: 'persona.deleted', revision: 3, resource: 'persona', id: 'persona-a' },
          personaId: 'persona-a',
          personaMutationCertificate: 'persona-mutation-v1',
          operation: 'delete',
          personaProjectionDigest: collectionB,
          selectedPersonaId: 'persona-b',
          collectionWritten: true,
          settingsWritten: true,
          legacyProfileProjectionApplied: true,
          legacyProfileDigest: profileBDigest,
        }
      }
      return {
        revision: 2,
        event: { type: 'persona.created', revision: 2, resource: 'persona', id: 'persona-b' },
        personaId: 'persona-b',
        personaMutationCertificate: 'persona-mutation-v1',
        operation: 'create',
        personaProjectionDigest: collectionAB,
        selectedPersonaId: 'persona-b',
        collectionWritten: true,
        settingsWritten: true,
        legacyProfileProjectionApplied: false,
        legacyProfileDigest: null,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await createPersonaCommand({
      baseRevision: 1,
      persona: personaB,
      mirrorLegacyProfile: false,
      optimisticAcknowledgement: {
        operation: 'create',
        collectionProjectionEpoch: 10,
        settingsProjectionEpoch: 20,
        beforePersonaIds: ['persona-a'],
        attemptedPersonaIds: ['persona-a', 'persona-b'],
        attemptedPersonas: [personaA, personaB],
        beforeSelectedPersonaId: 'persona-a',
        attemptedSelectedPersonaId: 'persona-b',
        collectionWritten: true,
        settingsWritten: true,
        legacyProfileProjectionExpected: false,
        attemptedLegacyProfile: null,
      },
    })
    await deletePersonaCommand({
      baseRevision: 2,
      personaId: 'persona-a',
      selectPersonaId: 'persona-b',
      mirrorLegacyProfile: true,
      saveCurrent: true,
      optimisticAcknowledgement: {
        operation: 'delete',
        collectionProjectionEpoch: 11,
        settingsProjectionEpoch: 21,
        beforePersonaIds: ['persona-a', 'persona-b'],
        attemptedPersonaIds: ['persona-b'],
        attemptedPersonas: [personaB],
        beforeSelectedPersonaId: 'persona-b',
        attemptedSelectedPersonaId: 'persona-b',
        collectionWritten: true,
        settingsWritten: true,
        legacyProfileProjectionExpected: true,
        attemptedLegacyProfile: profileB,
      },
    })
    await selectPersonaCommand({
      baseRevision: 3,
      personaId: 'persona-b',
      mirrorLegacyProfile: false,
      saveCurrent: false,
      optimisticAcknowledgement: {
        operation: 'select',
        collectionProjectionEpoch: 12,
        settingsProjectionEpoch: 22,
        beforePersonaIds: ['persona-a', 'persona-b'],
        attemptedPersonaIds: ['persona-a', 'persona-b'],
        attemptedPersonas: [{ ...personaA, displayName: 'Unsent unrelated edit' }, personaB],
        beforeSelectedPersonaId: 'persona-b',
        attemptedSelectedPersonaId: 'persona-b',
        collectionWritten: false,
        settingsWritten: true,
        legacyProfileProjectionExpected: false,
        attemptedLegacyProfile: null,
      },
    })
    await reorderPersonasCommand({
      baseRevision: 4,
      personaIds: ['persona-a', 'persona-b'],
      optimisticAcknowledgement: {
        operation: 'reorder',
        collectionProjectionEpoch: 13,
        settingsProjectionEpoch: 23,
        beforePersonaIds: ['persona-a', 'persona-b'],
        attemptedPersonaIds: ['persona-a', 'persona-b'],
        attemptedPersonas: [personaA, personaB],
        beforeSelectedPersonaId: 'persona-b',
        attemptedSelectedPersonaId: 'persona-b',
        collectionWritten: true,
        settingsWritten: true,
        legacyProfileProjectionExpected: false,
        attemptedLegacyProfile: null,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'personaMutation',
        operation: 'create',
        targetPersonaId: 'persona-b',
        collectionProjectionEpoch: 10,
        settingsProjectionEpoch: 20,
        collectionWritten: true,
        settingsWritten: true,
      },
      {
        kind: 'personaMutation',
        operation: 'select',
        targetPersonaId: 'persona-b',
        collectionProjectionEpoch: 12,
        settingsProjectionEpoch: 22,
        collectionWritten: false,
        settingsWritten: true,
      },
      {
        kind: 'personaMutation',
        operation: 'reorder',
        targetPersonaId: null,
        collectionProjectionEpoch: 13,
        settingsProjectionEpoch: 23,
        collectionWritten: true,
        settingsWritten: true,
      },
    ])
    expect(commandFetch.calls.every((call) => !Object.hasOwn(call.body as object, 'optimisticAcknowledgement'))).toBe(
      true,
    )
  })

  it('keeps malformed structural persona receipts and contradictory proofs on authoritative reconciliation', async () => {
    const profileA = { name: 'A', icon: '', personaPrompt: 'A', note: '' }
    const profileB = { name: 'B', icon: '', personaPrompt: 'B', note: '' }
    const personaA = { id: 'persona-a', ...profileA }
    const personaB = { id: 'persona-b', ...profileB }
    const [personaProjectionDigest, profileBDigest] = await Promise.all([
      sha256Hex(serializePersonaCollectionDigestInput([personaA, personaB])),
      sha256Hex(serializePersonaProfileDigestInput(profileB)),
    ])
    const exactResponse = {
      revision: 3,
      event: { type: 'persona.selected', revision: 3, resource: 'persona', id: 'persona-b' },
      personaId: 'persona-b',
      personaMutationCertificate: 'persona-mutation-v1',
      operation: 'select',
      personaProjectionDigest,
      selectedPersonaId: 'persona-b',
      collectionWritten: true,
      settingsWritten: true,
      legacyProfileProjectionApplied: true,
      legacyProfileDigest: profileBDigest,
    }
    const responses = [
      { ...exactResponse, personaProjectionDigest: '0'.repeat(64) },
      { ...exactResponse, legacyProfileDigest: 'f'.repeat(64) },
      { ...exactResponse, event: { ...exactResponse.event, resource: 'settings' } },
      exactResponse,
      exactResponse,
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => responses[responseIndex++])
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })
    const acknowledgement = {
      operation: 'select' as const,
      collectionProjectionEpoch: 12,
      settingsProjectionEpoch: 22,
      beforePersonaIds: ['persona-a', 'persona-b'],
      attemptedPersonaIds: ['persona-a', 'persona-b'],
      attemptedPersonas: [personaA, personaB],
      beforeSelectedPersonaId: 'persona-a',
      attemptedSelectedPersonaId: 'persona-b',
      collectionWritten: true,
      settingsWritten: true,
      legacyProfileProjectionExpected: true,
      attemptedLegacyProfile: profileB,
    }

    for (let index = 0; index < responses.length; index += 1) {
      await selectPersonaCommand({
        baseRevision: 2,
        personaId: 'persona-b',
        mirrorLegacyProfile: true,
        saveCurrent: true,
        optimisticAcknowledgement:
          index === responses.length - 1
            ? { ...acknowledgement, settingsWritten: false }
            : index === responses.length - 2
              ? { ...acknowledgement, collectionWritten: false }
              : acknowledgement,
      })
    }

    expect(observedEffectCounts).toEqual([0, 0, 0, 0, 0])
  })

  it('exposes an exact persona PATCH acknowledgement without serializing optimistic proof', async () => {
    const event = {
      type: 'persona.updated',
      revision: 3,
      resource: 'persona',
      id: 'persona-b',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      personaId: 'persona-b',
      acknowledgedKeys: ['name', 'largePortrait'],
      legacyProfileProjectionApplied: true,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const attemptedPersona = {
      id: 'persona-b',
      name: 'Bee',
      displayName: 'B',
      icon: 'asset-b',
      personaPrompt: 'Prompt B',
      note: 'Note B',
      largePortrait: true,
    }

    await updatePersonaCommand({
      baseRevision: 2,
      personaId: 'persona-b',
      patch: { name: 'Bee', largePortrait: true },
      mirrorLegacyProfile: true,
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 11,
        settingsProjectionEpoch: 17,
        attemptedPersona,
        attemptedLegacyProfile: {
          username: 'Bee',
          userIcon: 'asset-b',
          personaPrompt: 'Prompt B',
          userNote: 'Note B',
        },
        legacyProfileProjectionExpected: true,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'personaPatch',
        personaId: 'persona-b',
        collectionProjectionEpoch: 11,
        settingsProjectionEpoch: 17,
        attemptedPatch: { name: 'Bee', largePortrait: true },
        attemptedPersona,
        attemptedLegacyProfile: {
          username: 'Bee',
          userIcon: 'asset-b',
          personaPrompt: 'Prompt B',
          userNote: 'Note B',
        },
        legacyProfileProjectionApplied: true,
      },
    ])
    expect(commandFetch.calls[0]?.body).toEqual({
      baseRevision: 2,
      patch: { name: 'Bee', largePortrait: true },
      mirrorLegacyProfile: true,
    })
    expect(commandFetch.calls[0]?.body).not.toHaveProperty('optimisticAcknowledgement')
  })

  it('keeps malformed or contradictory persona PATCH receipts on authoritative reconciliation', async () => {
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })
    const event = {
      type: 'persona.updated',
      revision: 3,
      resource: 'persona',
      id: 'persona-b',
    }
    const responses = [
      {
        revision: 3,
        event,
        personaId: 'persona-b',
        acknowledgedKeys: ['displayName'],
        legacyProfileProjectionApplied: true,
      },
      {
        revision: 3,
        event,
        personaId: 'persona-b',
        acknowledgedKeys: ['name'],
        legacyProfileProjectionApplied: false,
      },
      {
        revision: 3,
        event: { ...event, resource: 'settings' },
        personaId: 'persona-b',
        acknowledgedKeys: ['name'],
        legacyProfileProjectionApplied: true,
      },
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => responses[responseIndex++])
    vi.stubGlobal('fetch', commandFetch.fetch)
    const acknowledgement = {
      collectionProjectionEpoch: 11,
      settingsProjectionEpoch: 17,
      attemptedPersona: { id: 'persona-b', name: 'Bee', icon: '', personaPrompt: '', note: '' },
      attemptedLegacyProfile: {
        username: 'Bee',
        userIcon: '',
        personaPrompt: '',
        userNote: '',
      },
      legacyProfileProjectionExpected: true,
    }

    for (let index = 0; index < responses.length; index += 1) {
      await updatePersonaCommand({
        baseRevision: 2,
        personaId: 'persona-b',
        patch: { name: 'Bee' },
        mirrorLegacyProfile: true,
        optimisticAcknowledgement: acknowledgement,
      })
    }

    expect(observedEffectCounts).toEqual([0, 0, 0])
  })

  it('dispatches translator preset commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/translator-presets/select')) {
        return {
          revision: 5,
          event: {
            type: 'translatorPreset.selected',
            revision: 5,
            resource: 'translatorPreset',
            id: 'translator-b',
          },
          presetId: 'translator-b',
        }
      }
      if (url.endsWith('/translator-presets/translator-a')) {
        return {
          revision: 4,
          event: {
            type: 'translatorPreset.deleted',
            revision: 4,
            resource: 'translatorPreset',
            id: 'translator-a',
          },
          presetId: 'translator-a',
          selectedPresetId: 'translator-b',
        }
      }
      if (url.endsWith('/translator-presets/translator-b')) {
        return {
          revision: 3,
          event: {
            type: 'translatorPreset.updated',
            revision: 3,
            resource: 'translatorPreset',
            id: 'translator-b',
          },
          presetId: 'translator-b',
        }
      }
      return {
        revision: 2,
        event: {
          type: 'translatorPreset.created',
          revision: 2,
          resource: 'translatorPreset',
          id: 'translator-b',
        },
        presetId: 'translator-b',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      createTranslatorPresetCommand({
        baseRevision: 1,
        preset: {
          id: 'translator-b',
          name: 'B',
          prompt: 'translate to B',
          maxResponse: 200,
        },
        select: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, presetId: 'translator-b' })

    await expect(
      updateTranslatorPresetCommand({
        baseRevision: 2,
        presetId: 'translator-b',
        patch: { prompt: 'updated', maxResponse: 300 },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, presetId: 'translator-b' })

    await expect(
      deleteTranslatorPresetCommand({
        baseRevision: 3,
        presetId: 'translator-a',
        selectPresetId: 'translator-b',
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      revision: 4,
      presetId: 'translator-a',
      selectedPresetId: 'translator-b',
    })

    await expect(
      selectTranslatorPresetCommand({
        baseRevision: 4,
        presetId: 'translator-b',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, presetId: 'translator-b' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/translator-presets',
        method: 'POST',
        body: {
          baseRevision: 1,
          preset: {
            id: 'translator-b',
            name: 'B',
            prompt: 'translate to B',
            maxResponse: 200,
          },
          select: true,
        },
      },
      {
        url: '/api/v1/commands/translator-presets/translator-b',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          patch: { prompt: 'updated', maxResponse: 300 },
        },
      },
      {
        url: '/api/v1/commands/translator-presets/translator-a',
        method: 'DELETE',
        body: {
          baseRevision: 3,
          selectPresetId: 'translator-b',
        },
      },
      {
        url: '/api/v1/commands/translator-presets/select',
        method: 'POST',
        body: {
          baseRevision: 4,
          presetId: 'translator-b',
        },
      },
    ])
  })

  it('marks lifecycle persona and translator preset patches as keepalive requests', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/personas/persona-a')) {
        return {
          revision: 2,
          event: { type: 'persona.updated', revision: 2, resource: 'persona', id: 'persona-a' },
          personaId: 'persona-a',
        }
      }
      return {
        revision: 3,
        event: {
          type: 'translatorPreset.updated',
          revision: 3,
          resource: 'translatorPreset',
          id: 'translator-a',
        },
        presetId: 'translator-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await updatePersonaCommand(
      {
        baseRevision: 1,
        personaId: 'persona-a',
        patch: { personaPrompt: 'draft before pagehide' },
        mirrorLegacyProfile: true,
      },
      undefined,
      true,
    )
    await updateTranslatorPresetCommand(
      {
        baseRevision: 2,
        presetId: 'translator-a',
        patch: { prompt: 'draft before pagehide' },
      },
      undefined,
      true,
    )

    expect(vi.mocked(commandFetch.fetch).mock.calls).toHaveLength(2)
    expect(vi.mocked(commandFetch.fetch).mock.calls[0]?.[1]).toMatchObject({ keepalive: true })
    expect(vi.mocked(commandFetch.fetch).mock.calls[1]?.[1]).toMatchObject({ keepalive: true })
  })

  it('exposes an exact translator preset PATCH acknowledgement without serializing optimistic proof', async () => {
    const event = {
      type: 'translatorPreset.updated',
      revision: 3,
      resource: 'translatorPreset',
      id: 'translator-b',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      presetId: 'translator-b',
      acknowledgedKeys: ['prompt', 'maxResponse'],
      selectedPresetId: 'translator-a',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const attemptedPreset = {
      id: 'translator-b',
      name: 'B',
      prompt: 'updated prompt',
      maxResponse: 300,
    }

    await updateTranslatorPresetCommand({
      baseRevision: 2,
      presetId: 'translator-b',
      patch: { prompt: 'updated prompt', maxResponse: 300 },
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 11,
        languageSettingsProjectionEpoch: 17,
        selectedPresetId: 'translator-a',
        attemptedPreset,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'translatorPresetPatch',
        presetId: 'translator-b',
        collectionProjectionEpoch: 11,
        languageSettingsProjectionEpoch: 17,
        selectedPresetId: 'translator-a',
        attemptedPatch: { prompt: 'updated prompt', maxResponse: 300 },
        attemptedPreset,
      },
    ])
    expect(commandFetch.calls[0]?.body).toEqual({
      baseRevision: 2,
      patch: { prompt: 'updated prompt', maxResponse: 300 },
    })
    expect(commandFetch.calls[0]?.body).not.toHaveProperty('optimisticAcknowledgement')
  })

  it('accepts server-added legacy mirror keys for a steps-only translator preset PATCH acknowledgement', async () => {
    const event = {
      type: 'translatorPreset.updated',
      revision: 3,
      resource: 'translatorPreset',
      id: 'translator-b',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      presetId: 'translator-b',
      acknowledgedKeys: ['steps', 'prompt', 'maxResponse'],
      selectedPresetId: 'translator-a',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const steps = [
      {
        id: 'step-a',
        name: 'Renamed step',
        enabled: true,
        prompt: 'Translate the input',
        maxResponse: 300,
        model: { mode: 'inheritTranslate' as const },
        outputKey: 'translation',
      },
    ]
    const attemptedPreset = {
      id: 'translator-b',
      name: 'B',
      prompt: steps[0].prompt,
      maxResponse: steps[0].maxResponse,
      steps,
    }

    await updateTranslatorPresetCommand({
      baseRevision: 2,
      presetId: 'translator-b',
      patch: { steps },
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 11,
        languageSettingsProjectionEpoch: 17,
        selectedPresetId: 'translator-a',
        attemptedPreset,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'translatorPresetPatch',
        presetId: 'translator-b',
        collectionProjectionEpoch: 11,
        languageSettingsProjectionEpoch: 17,
        selectedPresetId: 'translator-a',
        attemptedPatch: { steps },
        attemptedPreset,
      },
    ])
    expect(commandFetch.calls[0]?.body).toEqual({
      baseRevision: 2,
      patch: { steps },
    })
  })

  it('rejects unrelated extra keys in a steps-only translator preset PATCH acknowledgement', async () => {
    const event = {
      type: 'translatorPreset.updated',
      revision: 3,
      resource: 'translatorPreset',
      id: 'translator-b',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      presetId: 'translator-b',
      acknowledgedKeys: ['steps', 'name'],
      selectedPresetId: 'translator-a',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const steps = [
      {
        id: 'step-a',
        name: 'Renamed step',
        enabled: true,
        prompt: 'Translate the input',
        maxResponse: 300,
        model: { mode: 'inheritTranslate' as const },
      },
    ]

    await updateTranslatorPresetCommand({
      baseRevision: 2,
      presetId: 'translator-b',
      patch: { steps },
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 11,
        languageSettingsProjectionEpoch: 17,
        selectedPresetId: 'translator-a',
        attemptedPreset: {
          id: 'translator-b',
          name: 'B',
          prompt: steps[0].prompt,
          maxResponse: steps[0].maxResponse,
          steps,
        },
      },
    })

    expect(observedEffects).toEqual([])
  })

  it('keeps malformed or contradictory translator preset PATCH receipts on authoritative reconciliation', async () => {
    const exactEvent = {
      type: 'translatorPreset.updated',
      revision: 3,
      resource: 'translatorPreset',
      id: 'translator-b',
    }
    const exactAcknowledgement = {
      collectionProjectionEpoch: 11,
      languageSettingsProjectionEpoch: 17,
      selectedPresetId: 'translator-a',
      attemptedPreset: {
        id: 'translator-b',
        name: 'B',
        prompt: 'updated prompt',
        maxResponse: 200,
      },
    }
    const cases = [
      {
        body: {
          revision: 3,
          event: exactEvent,
          presetId: 'translator-b',
          acknowledgedKeys: [],
          selectedPresetId: 'translator-a',
        },
        acknowledgement: exactAcknowledgement,
      },
      {
        body: {
          revision: 3,
          event: exactEvent,
          presetId: 'translator-b',
          acknowledgedKeys: ['name'],
          selectedPresetId: 'translator-a',
        },
        acknowledgement: exactAcknowledgement,
      },
      {
        body: {
          revision: 3,
          event: exactEvent,
          presetId: 'translator-b',
          acknowledgedKeys: ['prompt', 'prompt'],
          selectedPresetId: 'translator-a',
        },
        acknowledgement: exactAcknowledgement,
      },
      {
        body: {
          revision: 3,
          event: exactEvent,
          presetId: 'translator-b',
          acknowledgedKeys: ['prompt'],
          selectedPresetId: 'translator-b',
        },
        acknowledgement: exactAcknowledgement,
      },
      {
        body: {
          revision: 3,
          event: { ...exactEvent, resource: 'settings' },
          presetId: 'translator-b',
          acknowledgedKeys: ['prompt'],
          selectedPresetId: 'translator-a',
        },
        acknowledgement: exactAcknowledgement,
      },
      {
        body: {
          revision: 3,
          event: exactEvent,
          presetId: 'translator-b',
          acknowledgedKeys: ['prompt'],
          selectedPresetId: 'translator-a',
        },
        acknowledgement: {
          ...exactAcknowledgement,
          attemptedPreset: { ...exactAcknowledgement.attemptedPreset, prompt: 'different' },
        },
      },
      {
        body: {
          revision: 3,
          event: exactEvent,
          presetId: 'translator-b',
          acknowledgedKeys: ['prompt'],
          selectedPresetId: 'translator-a',
        },
        acknowledgement: { ...exactAcknowledgement, languageSettingsProjectionEpoch: -1 },
      },
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => cases[responseIndex++].body)
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    for (const testCase of cases) {
      await updateTranslatorPresetCommand({
        baseRevision: 2,
        presetId: 'translator-b',
        patch: { prompt: 'updated prompt' },
        optimisticAcknowledgement: testCase.acknowledgement,
      })
    }

    expect(observedEffectCounts).toEqual(cases.map(() => 0))
  })

  it('dispatches loadout commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/loadouts/loadout-a/touch')) {
        return {
          revision: 6,
          event: { type: 'loadout.touched', revision: 6, resource: 'loadout', id: 'loadout-a' },
          loadoutId: 'loadout-a',
        }
      }
      if (url.endsWith('/loadouts/loadout-a/favorite')) {
        return {
          revision: 5,
          event: { type: 'loadout.favorited', revision: 5, resource: 'loadout', id: 'loadout-a' },
          loadoutId: 'loadout-a',
        }
      }
      if (url.endsWith('/loadouts/loadout-b')) {
        return {
          revision: 4,
          event: { type: 'loadout.deleted', revision: 4, resource: 'loadout', id: 'loadout-b' },
          loadoutId: 'loadout-b',
        }
      }
      if (url.endsWith('/loadouts/loadout-a')) {
        return {
          revision: 3,
          event: { type: 'loadout.updated', revision: 3, resource: 'loadout', id: 'loadout-a' },
          loadoutId: 'loadout-a',
        }
      }
      return {
        revision: 2,
        event: { type: 'loadout.created', revision: 2, resource: 'loadout', id: 'loadout-a' },
        loadoutId: 'loadout-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      createLoadoutCommand({
        baseRevision: 1,
        loadout: canonicalLoadoutSnapshot(),
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, loadoutId: 'loadout-a' })

    await expect(
      updateLoadoutCommand({
        baseRevision: 2,
        loadoutId: 'loadout-a',
        patch: { name: 'A updated' },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, loadoutId: 'loadout-a' })

    await expect(
      deleteLoadoutCommand({
        baseRevision: 3,
        loadoutId: 'loadout-b',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 4, loadoutId: 'loadout-b' })

    await expect(
      favoriteLoadoutCommand({
        baseRevision: 4,
        loadoutId: 'loadout-a',
        favorite: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, loadoutId: 'loadout-a' })

    await expect(
      touchLoadoutCommand({
        baseRevision: 5,
        loadoutId: 'loadout-a',
        lastUsed: 1234,
        characterId: 'char-b',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 6, loadoutId: 'loadout-a' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/loadouts',
        method: 'POST',
        body: {
          baseRevision: 1,
          loadout: canonicalLoadoutSnapshot(),
        },
      },
      {
        url: '/api/v1/commands/loadouts/loadout-a',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          patch: { name: 'A updated' },
        },
      },
      {
        url: '/api/v1/commands/loadouts/loadout-b',
        method: 'DELETE',
        body: {
          baseRevision: 3,
        },
      },
      {
        url: '/api/v1/commands/loadouts/loadout-a/favorite',
        method: 'POST',
        body: {
          baseRevision: 4,
          favorite: true,
        },
      },
      {
        url: '/api/v1/commands/loadouts/loadout-a/touch',
        method: 'POST',
        body: {
          baseRevision: 5,
          lastUsed: 1234,
          characterId: 'char-b',
        },
      },
    ])
  })

  it('exposes only opted-in matching loadout acknowledgements as scoped local effects', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let touchCount = 0
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/favorite')) {
        return {
          revision: 5,
          event: { type: 'loadout.favorited', revision: 5, resource: 'loadout', id: 'loadout-a' },
          loadoutId: 'loadout-a',
        }
      }
      touchCount += 1
      return {
        revision: 6 + touchCount,
        event: {
          type: 'loadout.touched',
          revision: 6 + touchCount,
          resource: 'loadout',
          id: touchCount === 1 ? 'loadout-a' : 'mismatched-loadout',
        },
        loadoutId: 'loadout-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await favoriteLoadoutCommand({
      baseRevision: 4,
      loadoutId: 'loadout-a',
      favorite: true,
    })
    await favoriteLoadoutCommand({
      baseRevision: 5,
      loadoutId: 'loadout-a',
      favorite: true,
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 11,
    })
    await touchLoadoutCommand({
      baseRevision: 6,
      loadoutId: 'loadout-a',
      lastUsed: 1234,
      characterId: 'char-b',
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 11,
      settingsProjectionEpoch: 17,
      loadedName: 'Loadout A',
    })
    await touchLoadoutCommand({
      baseRevision: 7,
      loadoutId: 'loadout-a',
      lastUsed: 1235,
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 11,
      settingsProjectionEpoch: 17,
      loadedName: 'Loadout A',
    })

    expect(observedEffects).toEqual([
      {
        kind: 'loadoutMutation',
        operation: 'favorite',
        loadoutId: 'loadout-a',
        loadoutsProjectionEpoch: 11,
      },
      {
        kind: 'loadoutMutation',
        operation: 'touch',
        loadoutId: 'loadout-a',
        loadoutsProjectionEpoch: 11,
        settingsProjectionEpoch: 17,
        loadedName: 'Loadout A',
      },
    ])
  })

  it('strictly validates optimistic loadout create/delete acknowledgements without transmitting metadata', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let revision = 20
    let createCount = 0
    let deleteCount = 0
    const commandFetch = makeCommandFetch((url) => {
      revision += 1
      if (url === '/api/v1/commands/loadouts') {
        createCount += 1
        return {
          revision,
          event: { type: 'loadout.created', revision, resource: 'loadout', id: 'loadout-a' },
          loadoutId: createCount === 5 ? 'mismatched-loadout' : 'loadout-a',
        }
      }
      deleteCount += 1
      return {
        revision,
        event: {
          type: 'loadout.deleted',
          revision,
          resource: 'loadout',
          id: deleteCount === 2 ? 'mismatched-loadout' : 'loadout-b',
        },
        loadoutId: 'loadout-b',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const canonicalLoadout = canonicalLoadoutSnapshot()
    const missingPromptName = { ...canonicalLoadout }
    Reflect.deleteProperty(missingPromptName, 'promptPresetName')

    await createLoadoutCommand({
      baseRevision: 1,
      loadout: canonicalLoadout,
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 11,
    })
    await deleteLoadoutCommand({
      baseRevision: 2,
      loadoutId: 'loadout-b',
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 12,
    })
    await createLoadoutCommand({
      baseRevision: 3,
      loadout: { ...canonicalLoadout, legacyMetadata: true },
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 13,
    })
    await createLoadoutCommand({
      baseRevision: 4,
      loadout: missingPromptName,
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 14,
    })
    await createLoadoutCommand({
      baseRevision: 5,
      loadout: canonicalLoadout,
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: -1,
    })
    await createLoadoutCommand({
      baseRevision: 6,
      loadout: canonicalLoadout,
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 15,
    })
    await deleteLoadoutCommand({
      baseRevision: 7,
      loadoutId: 'loadout-b',
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 16,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'loadoutMutation',
        operation: 'create',
        loadoutId: 'loadout-a',
        loadoutsProjectionEpoch: 11,
      },
      {
        kind: 'loadoutMutation',
        operation: 'delete',
        loadoutId: 'loadout-b',
        loadoutsProjectionEpoch: 12,
      },
    ])
    expect(commandFetch.calls[0].body).toEqual({ baseRevision: 1, loadout: canonicalLoadout })
    expect(commandFetch.calls[1].body).toEqual({ baseRevision: 2 })
  })

  it('strips embedded chats from character create command payloads without mutating input', async () => {
    const commandFetch = makeCommandFetch((url) => ({
      revision: url.endsWith('/create-and-select') ? 3 : 2,
      event: {
        type: url.endsWith('/create-and-select') ? 'character.createdAndSelected' : 'character.created',
        revision: url.endsWith('/create-and-select') ? 3 : 2,
        resource: 'character',
        id: url.endsWith('/create-and-select') ? 'char-selected' : 'char-created',
      },
      characterId: url.endsWith('/create-and-select') ? 'char-selected' : 'char-created',
      selectedCharacterId: url.endsWith('/create-and-select') ? 'char-selected' : null,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const createChat = {
      id: 'chat-created',
      name: 'Starter',
      message: [{ role: 'user', data: 'hello' }],
    }
    const createCharacter = {
      chaId: 'char-created',
      name: 'Created',
      chatPage: 0,
      chats: [createChat],
    }
    const selectChat = {
      id: 'chat-selected',
      name: 'Starter',
      message: [{ role: 'char', data: 'hi' }],
    }
    const selectCharacter = {
      chaId: 'char-selected',
      name: 'Selected',
      chatPage: 0,
      chats: [selectChat],
    }
    const initialChat = {
      id: 'chat-initial',
      name: 'Chat 1',
      note: '',
      message: [],
      localLore: [],
    }

    await expect(
      createCharacterCommand({
        baseRevision: 1,
        character: createCharacter,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, characterId: 'char-created' })

    await expect(
      createAndSelectCharacterCommand({
        baseRevision: 2,
        character: selectCharacter,
        lastInteraction: 1234,
        initialChat,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, characterId: 'char-selected' })

    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      {
        baseRevision: 1,
        character: {
          chaId: 'char-created',
          name: 'Created',
          chatPage: 0,
        },
      },
      {
        baseRevision: 2,
        character: {
          chaId: 'char-selected',
          name: 'Selected',
          chatPage: 0,
        },
        lastInteraction: 1234,
        initialChat,
      },
    ])
    expect(createCharacter.chats).toEqual([createChat])
    expect(selectCharacter.chats).toEqual([selectChat])
  })

  it('exposes exact character collection acknowledgements as compact local effects', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url, init) => {
      if (url.endsWith('/create-and-select')) {
        return {
          revision: 3,
          event: {
            type: 'character.createdAndSelected',
            revision: 3,
            resource: 'character',
            id: 'char-selected',
          },
          characterId: 'char-selected',
          selectedCharacterId: 'char-selected',
        }
      }
      if (init.method === 'DELETE') {
        return {
          revision: 4,
          event: { type: 'character.deleted', revision: 4, resource: 'character', id: 'char-deleted' },
          characterId: 'char-deleted',
          selectedCharacterId: 'char-created',
        }
      }
      const characterId = (JSON.parse(String(init.body)) as { character: { chaId: string } }).character.chaId
      return {
        revision: characterId === 'char-mismatched' ? 5 : 2,
        event: {
          type: 'character.created',
          revision: characterId === 'char-mismatched' ? 5 : 2,
          resource: 'character',
          id: characterId,
          ...(characterId === 'char-mismatched' ? { parentId: 'unexpected-parent' } : {}),
        },
        characterId,
        selectedCharacterId: null,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createCharacterCommand({ baseRevision: 1, character: { chaId: 'char-created' } })
    await createAndSelectCharacterCommand({
      baseRevision: 2,
      character: { chaId: 'char-selected' },
      lastInteraction: 100,
    })
    await deleteCharacterCommand({ baseRevision: 3, characterId: 'char-deleted' })
    await createCharacterCommand({ baseRevision: 4, character: { chaId: 'char-mismatched' } })

    expect(observedEffects).toEqual([
      {
        kind: 'characterCollectionMutation',
        operation: 'create',
        characterId: 'char-created',
        selectedCharacterId: null,
      },
      {
        kind: 'characterCollectionMutation',
        operation: 'createAndSelect',
        characterId: 'char-selected',
        selectedCharacterId: 'char-selected',
      },
      {
        kind: 'characterCollectionMutation',
        operation: 'delete',
        characterId: 'char-deleted',
        selectedCharacterId: 'char-created',
      },
    ])
  })

  it('dispatches character commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/characters/reorder')) {
        return {
          revision: 6,
          event: { type: 'character.reordered', revision: 6, resource: 'character' },
          selectedCharacterId: 'char-a',
        }
      }
      if (url.endsWith('/characters/select')) {
        return {
          revision: 5,
          event: {
            type: 'character.selected',
            revision: 5,
            resource: 'characterSelection',
            id: 'char-a',
          },
          characterId: 'char-a',
        }
      }
      if (url.endsWith('/characters/create-and-select')) {
        return {
          revision: 7,
          event: {
            type: 'character.createdAndSelected',
            revision: 7,
            resource: 'character',
            id: 'char-c',
          },
          characterId: 'char-c',
          selectedCharacterId: 'char-c',
        }
      }
      if (url.endsWith('/characters/char-b')) {
        const method = commandFetch.calls.at(-1)?.method
        return method === 'DELETE'
          ? {
              revision: 4,
              event: {
                type: 'character.deleted',
                revision: 4,
                resource: 'character',
                id: 'char-b',
              },
              characterId: 'char-b',
              selectedCharacterId: 'char-a',
            }
          : {
              revision: 3,
              event: {
                type: 'character.updated',
                revision: 3,
                resource: 'character',
                id: 'char-b',
              },
              characterId: 'char-b',
            }
      }
      return {
        revision: 2,
        event: { type: 'character.created', revision: 2, resource: 'character', id: 'char-b' },
        characterId: 'char-b',
        selectedCharacterId: 'char-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      createCharacterCommand({
        baseRevision: 1,
        character: { chaId: 'char-b', name: 'B' },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, characterId: 'char-b' })

    await expect(
      updateCharacterCommand({
        baseRevision: 2,
        characterId: 'char-b',
        patch: {
          name: 'B renamed',
          image: 'a'.repeat(64),
          systemPrompt: 'new system prompt',
          ttsMode: 'openai',
          oaiTTSConfig: { enabled: true, voice: 'alloy', model: 'tts-1', format: 'mp3' },
          depth_prompt: { depth: 2, prompt: 'stay close' },
        },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, characterId: 'char-b' })

    await expect(
      deleteCharacterCommand({
        baseRevision: 3,
        characterId: 'char-b',
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      revision: 4,
      characterId: 'char-b',
      selectedCharacterId: 'char-a',
    })

    await expect(
      selectCharacterCommand({
        baseRevision: 4,
        characterId: 'char-a',
        lastInteraction: 1234,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, characterId: 'char-a' })

    await expect(
      reorderCharactersCommand({
        baseRevision: 5,
        characterOrder: [{ id: 'folder-a', name: 'Folder', color: '', data: ['char-a'] }],
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      revision: 6,
      selectedCharacterId: 'char-a',
    })

    await expect(
      createAndSelectCharacterCommand({
        baseRevision: 6,
        character: { chaId: 'char-c', name: 'C' },
        lastInteraction: 5678,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 7, characterId: 'char-c' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/characters',
        method: 'POST',
        body: {
          baseRevision: 1,
          character: { chaId: 'char-b', name: 'B' },
        },
      },
      {
        url: '/api/v1/commands/characters/char-b',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          patch: {
            name: 'B renamed',
            image: 'a'.repeat(64),
            systemPrompt: 'new system prompt',
            ttsMode: 'openai',
            oaiTTSConfig: { enabled: true, voice: 'alloy', model: 'tts-1', format: 'mp3' },
            depth_prompt: { depth: 2, prompt: 'stay close' },
          },
        },
      },
      {
        url: '/api/v1/commands/characters/char-b',
        method: 'DELETE',
        body: {
          baseRevision: 3,
        },
      },
      {
        url: '/api/v1/commands/characters/select',
        method: 'POST',
        body: {
          baseRevision: 4,
          characterId: 'char-a',
          lastInteraction: 1234,
        },
      },
      {
        url: '/api/v1/commands/characters/reorder',
        method: 'POST',
        body: {
          baseRevision: 5,
          characterOrder: [{ id: 'folder-a', name: 'Folder', color: '', data: ['char-a'] }],
        },
      },
      {
        url: '/api/v1/commands/characters/create-and-select',
        method: 'POST',
        body: {
          baseRevision: 6,
          character: { chaId: 'char-c', name: 'C' },
          lastInteraction: 5678,
        },
      },
    ])
  })

  it('dispatches chat and chat-folder commands through typed helpers', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/chat-folders/reorder')) {
        return {
          revision: 9,
          event: { type: 'chatFolder.reordered', revision: 9, resource: 'chatFolder' },
          selectedChatId: 'chat-a',
        }
      }
      if (url.endsWith('/chat-folders/folder-a')) {
        const method = commandFetch.calls.at(-1)?.method
        return method === 'DELETE'
          ? {
              revision: 8,
              event: {
                type: 'chatFolder.deleted',
                revision: 8,
                resource: 'chatFolder',
                id: 'folder-a',
              },
              folderId: 'folder-a',
            }
          : {
              revision: 7,
              event: {
                type: 'chatFolder.updated',
                revision: 7,
                resource: 'characterRow',
                id: 'folder-a',
                parentId: 'char-a',
              },
              folderId: 'folder-a',
            }
      }
      if (url.endsWith('/chat-folders')) {
        return {
          revision: 6,
          event: {
            type: 'chatFolder.created',
            revision: 6,
            resource: 'chatFolder',
            id: 'folder-a',
          },
          folderId: 'folder-a',
        }
      }
      if (url.endsWith('/chats/reorder')) {
        return {
          revision: 5,
          event: { type: 'chat.reordered', revision: 5, resource: 'chat' },
          selectedChatId: 'chat-a',
        }
      }
      if (url.endsWith('/chats/chat-a/fork')) {
        return {
          revision: 4,
          event: { type: 'chat.forked', revision: 4, resource: 'chat', id: 'chat-b' },
          chatId: 'chat-b',
          sourceChatId: 'chat-a',
          selectedChatId: 'chat-b',
        }
      }
      if (url.endsWith('/chats/chat-a')) {
        const method = commandFetch.calls.at(-1)?.method
        return method === 'DELETE'
          ? {
              revision: 3,
              event: { type: 'chat.deleted', revision: 3, resource: 'chat', id: 'chat-a' },
              chatId: 'chat-a',
              selectedChatId: 'chat-b',
            }
          : {
              revision: 2,
              event: { type: 'chat.updated', revision: 2, resource: 'chat', id: 'chat-a' },
              chatId: 'chat-a',
              selectedChatId: 'chat-a',
            }
      }
      return {
        revision: 1,
        event: { type: 'chat.created', revision: 1, resource: 'chat', id: 'chat-a' },
        chatId: 'chat-a',
        selectedChatId: 'chat-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      createChatCommand({
        baseRevision: 0,
        characterId: 'char-a',
        chat: { id: 'chat-a', name: 'A', note: '', message: [], localLore: [] },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 1, chatId: 'chat-a' })

    await expect(
      updateChatCommand({
        baseRevision: 1,
        chatId: 'chat-a',
        patch: { name: 'A renamed' },
        select: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, selectedChatId: 'chat-a' })

    await expect(
      deleteChatCommand({
        baseRevision: 2,
        chatId: 'chat-a',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, selectedChatId: 'chat-b' })

    await expect(
      forkChatCommand({
        baseRevision: 3,
        chatId: 'chat-a',
        chat: { id: 'chat-b', name: 'B', note: '', message: [], localLore: [] },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 4, chatId: 'chat-b' })

    await expect(
      reorderChatsCommand({
        baseRevision: 4,
        characterId: 'char-a',
        chatIds: ['chat-a', 'chat-b'],
        folderByChatId: { 'chat-a': null, 'chat-b': 'folder-a' },
        selectedChatId: 'chat-a',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, selectedChatId: 'chat-a' })

    await expect(
      createChatFolderCommand({
        baseRevision: 5,
        characterId: 'char-a',
        folder: { id: 'folder-a', name: 'Folder', folded: false },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 6, folderId: 'folder-a' })

    await expect(
      updateChatFolderCommand({
        baseRevision: 6,
        folderId: 'folder-a',
        patch: { folded: true },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 7, folderId: 'folder-a' })

    await expect(
      deleteChatFolderCommand({
        baseRevision: 7,
        folderId: 'folder-a',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 8, folderId: 'folder-a' })

    await expect(
      reorderChatFoldersCommand({
        baseRevision: 8,
        characterId: 'char-a',
        folderIds: ['folder-a'],
        selectedChatId: 'chat-a',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 9, selectedChatId: 'chat-a' })

    expect(observedEffects).toContainEqual({
      kind: 'characterRowMutation',
      operation: 'chatFolderUpdate',
      characterId: 'char-a',
      targetId: 'folder-a',
    })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/characters/char-a/chats',
        method: 'POST',
        body: {
          baseRevision: 0,
          chat: { id: 'chat-a', name: 'A', note: '', message: [], localLore: [] },
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a',
        method: 'PATCH',
        body: {
          baseRevision: 1,
          patch: { name: 'A renamed' },
          select: true,
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a',
        method: 'DELETE',
        body: {
          baseRevision: 2,
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a/fork',
        method: 'POST',
        body: {
          baseRevision: 3,
          chat: { id: 'chat-b', name: 'B', note: '', message: [], localLore: [] },
        },
      },
      {
        url: '/api/v1/commands/characters/char-a/chats/reorder',
        method: 'POST',
        body: {
          baseRevision: 4,
          chatIds: ['chat-a', 'chat-b'],
          folderByChatId: { 'chat-a': null, 'chat-b': 'folder-a' },
          selectedChatId: 'chat-a',
        },
      },
      {
        url: '/api/v1/commands/characters/char-a/chat-folders',
        method: 'POST',
        body: {
          baseRevision: 5,
          folder: { id: 'folder-a', name: 'Folder', folded: false },
        },
      },
      {
        url: '/api/v1/commands/chat-folders/folder-a',
        method: 'PATCH',
        body: {
          baseRevision: 6,
          patch: { folded: true },
        },
      },
      {
        url: '/api/v1/commands/chat-folders/folder-a',
        method: 'DELETE',
        body: {
          baseRevision: 7,
        },
      },
      {
        url: '/api/v1/commands/characters/char-a/chat-folders/reorder',
        method: 'POST',
        body: {
          baseRevision: 8,
          folderIds: ['folder-a'],
          selectedChatId: 'chat-a',
        },
      },
    ])
  })

  it('dispatches an atomic all-chat reset through the typed helper', async () => {
    const commandFetch = makeCommandFetch(() => ({
      revision: 12,
      event: {
        type: 'chats.reset',
        revision: 12,
        resource: 'characterRow',
        id: 'chat-new',
        parentId: 'char-a',
      },
      chatId: 'chat-new',
      selectedChatId: 'chat-new',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      resetChatsCommand({
        baseRevision: 11,
        characterId: 'char-a',
        chat: { id: 'chat-new', name: 'Chat 1', note: '', message: [], localLore: [], fmIndex: -1 },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 12, chatId: 'chat-new' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/characters/char-a/chats',
        method: 'PUT',
        body: {
          baseRevision: 11,
          chat: { id: 'chat-new', name: 'Chat 1', note: '', message: [], localLore: [], fmIndex: -1 },
        },
      },
    ])
  })

  it('emits strict opt-in local effects for optimistic chat structure mutations', async () => {
    const optimisticEpoch = captureDestructiveRefreshEpoch()
    const optimisticRowEpoch = 0
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const responses = [
      {
        revision: 1,
        event: {
          type: 'chat.created',
          revision: 1,
          resource: 'chatTranscript',
          id: 'chat-created',
          parentId: 'char-a',
        },
        chatId: 'chat-created',
        selectedChatId: 'chat-created',
        generationSettings: null,
      },
      {
        revision: 2,
        event: {
          type: 'chat.deleted',
          revision: 2,
          resource: 'characterRow',
          id: 'chat-deleted',
          parentId: 'char-a',
        },
        chatId: 'chat-deleted',
        selectedChatId: 'chat-created',
      },
      {
        revision: 3,
        event: {
          type: 'chat.forked',
          revision: 3,
          resource: 'chatTranscript',
          id: 'chat-forked',
          parentId: 'char-a',
        },
        chatId: 'chat-forked',
        sourceChatId: 'chat-created',
        selectedChatId: 'chat-forked',
        generationSettings: null,
      },
      {
        revision: 4,
        event: { type: 'chat.reordered', revision: 4, resource: 'characterRow', parentId: 'char-a' },
        selectedChatId: 'chat-created',
      },
      {
        revision: 5,
        event: {
          type: 'chatFolder.created',
          revision: 5,
          resource: 'characterRow',
          id: 'folder-a',
          parentId: 'char-a',
        },
        folderId: 'folder-a',
      },
      {
        revision: 6,
        event: {
          type: 'chatFolder.deleted',
          revision: 6,
          resource: 'characterRow',
          id: 'folder-a',
          parentId: 'char-a',
        },
        folderId: 'folder-a',
      },
      {
        revision: 7,
        event: { type: 'chatFolder.reordered', revision: 7, resource: 'characterRow', parentId: 'char-a' },
        selectedChatId: 'chat-created',
      },
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => responses[responseIndex++])
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createChatCommand({
      baseRevision: 0,
      characterId: 'char-a',
      chat: {
        id: 'chat-created',
        name: 'Created',
        note: '',
        localLore: [],
        message: [{ role: 'user', data: 'Created', chatId: 'message-a' }],
      },
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })
    await deleteChatCommand({
      baseRevision: 1,
      chatId: 'chat-deleted',
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })
    await forkChatCommand({
      baseRevision: 2,
      chatId: 'chat-created',
      chat: {
        id: 'chat-forked',
        name: 'Forked',
        note: '',
        localLore: [],
        message: [{ role: 'user', data: 'Forked', chatId: 'message-b' }],
      },
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })
    await reorderChatsCommand({
      baseRevision: 3,
      characterId: 'char-a',
      chatIds: ['chat-forked', 'chat-created'],
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })
    await createChatFolderCommand({
      baseRevision: 4,
      characterId: 'char-a',
      folder: { id: 'folder-a', folded: false },
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })
    await deleteChatFolderCommand({
      baseRevision: 5,
      folderId: 'folder-a',
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })
    await reorderChatFoldersCommand({
      baseRevision: 6,
      characterId: 'char-a',
      folderIds: ['folder-b', 'folder-a'],
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'chatStructureMutation',
        operation: 'create',
        characterId: 'char-a',
        targetId: 'chat-created',
        attemptedGenerationSettings: null,
        generationSettings: null,
        optimisticEpoch,
        optimisticRowEpoch,
      },
      {
        kind: 'chatStructureMutation',
        operation: 'delete',
        characterId: 'char-a',
        targetId: 'chat-deleted',
        optimisticEpoch,
        optimisticRowEpoch,
      },
      {
        kind: 'chatStructureMutation',
        operation: 'fork',
        characterId: 'char-a',
        targetId: 'chat-forked',
        attemptedGenerationSettings: null,
        generationSettings: null,
        optimisticEpoch,
        optimisticRowEpoch,
      },
      {
        kind: 'chatStructureMutation',
        operation: 'reorder',
        characterId: 'char-a',
        attemptedIds: ['chat-forked', 'chat-created'],
        optimisticEpoch,
        optimisticRowEpoch,
      },
      {
        kind: 'chatStructureMutation',
        operation: 'folderCreate',
        characterId: 'char-a',
        targetId: 'folder-a',
        optimisticEpoch,
        optimisticRowEpoch,
      },
      {
        kind: 'chatStructureMutation',
        operation: 'folderDelete',
        characterId: 'char-a',
        targetId: 'folder-a',
        optimisticEpoch,
        optimisticRowEpoch,
      },
      {
        kind: 'chatStructureMutation',
        operation: 'folderReorder',
        characterId: 'char-a',
        attemptedIds: ['folder-b', 'folder-a'],
        optimisticEpoch,
        optimisticRowEpoch,
      },
    ])
  })

  it('does not emit a structural local effect after a destructive refresh', async () => {
    const optimisticEpoch = captureDestructiveRefreshEpoch()
    createDestructiveRefreshToken('chat-structure-test-refresh')
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 1,
      event: {
        type: 'chat.created',
        revision: 1,
        resource: 'characterRow',
        id: 'chat-created',
        parentId: 'char-a',
      },
      chatId: 'chat-created',
      selectedChatId: 'chat-created',
      generationSettings: null,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createChatCommand({
      baseRevision: 0,
      characterId: 'char-a',
      chat: { id: 'chat-created', name: 'Created', note: '', localLore: [], message: [] },
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch: 0,
    })

    expect(observedEffects).toEqual([])
  })

  it('dispatches message translation commands through the typed helper', async () => {
    const translation = {
      text: 'translated raw',
      source: 'raw',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 2,
      event: {
        type: 'message.updated',
        revision: 2,
        resource: 'message',
        id: 'msg-a',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      messageId: 'msg-a',
      jobId: 'translation-job-a',
      translation,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      translateMessageCommand({
        baseRevision: 1,
        messageId: 'msg-a',
        jobId: 'translation-job-a',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, messageId: 'msg-a', translation })

    expect(observedEffects).toEqual([
      {
        kind: 'messageTranslation',
        chatId: 'chat-a',
        messageId: 'msg-a',
        translation,
      },
    ])

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/messages/msg-a/translate',
        method: 'POST',
        body: {
          baseRevision: 1,
          jobId: 'translation-job-a',
        },
      },
    ])
  })

  it('dispatches greeting translation immediately outside the durable mutation lane', async () => {
    const translation = {
      text: 'translated greeting',
      source: 'raw',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'google',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    const reconciled: number[] = []
    setServerCommandSuccessReconciler((event) => {
      reconciled.push(event.revision)
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 2,
      event: {
        type: 'character.greetingTranslation.updated',
        revision: 2,
        resource: 'greetingTranslation',
        id: 'char a',
      },
      characterId: 'char a',
      chatId: 'chat-a',
      greetingIndex: -1,
      jobId: 'greeting-job-a',
      settingsHash: 'b'.repeat(64),
      translation,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      translateGreetingCommand({
        baseRevision: 1,
        characterId: 'char a',
        chatId: 'chat-a',
        greetingIndex: -1,
        jobId: 'greeting-job-a',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, greetingIndex: -1, translation })
    expect(reconciled).toEqual([2])
    expect(commandFetch.calls).toEqual([
      expect.objectContaining({
        url: '/api/v1/commands/characters/char%20a/greetings/-1/translate',
        method: 'POST',
        body: { baseRevision: 1, chatId: 'chat-a', jobId: 'greeting-job-a' },
      }),
    ])
  })

  it('defers an own translation SSE echo until the canonical response arrives', async () => {
    const response = createDeferred<Response>()
    const translation = {
      text: 'translated raw',
      source: 'raw' as const,
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm' as const,
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    const event = {
      type: 'message.updated',
      revision: 2,
      resource: 'message',
      id: 'msg-a',
      parentId: 'chat-a',
    }
    const commandFetch = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', commandFetch)
    const reconciled: Array<{ revision: number; effects: unknown[] }> = []
    setServerCommandSuccessReconciler((commandEvent, _events, localEffects) => {
      reconciled.push({ revision: commandEvent.revision, effects: [...localEffects.values()] })
    })

    const pending = translateMessageCommand({
      baseRevision: 1,
      messageId: 'msg-a',
      jobId: 'translation-job-a',
    })
    await vi.waitFor(() => expect(commandFetch).toHaveBeenCalledTimes(1))
    expect(deferOwnServerCommandReconciliation(event)).toBe(true)
    expect(reconciled).toEqual([])

    response.resolve(
      jsonResponse({
        revision: 2,
        event,
        chatId: 'chat-a',
        messageId: 'msg-a',
        jobId: 'translation-job-a',
        translation,
      }),
    )
    await expect(pending).resolves.toMatchObject({ status: 'ok', revision: 2 })
    expect(reconciled).toEqual([
      {
        revision: 2,
        effects: [
          {
            kind: 'messageTranslation',
            chatId: 'chat-a',
            messageId: 'msg-a',
            translation,
          },
        ],
      },
    ])
  })

  it('keeps a direct event scope active before and during response reconciliation, then releases it', async () => {
    const event = {
      type: 'character.created',
      revision: 2,
      resource: 'character',
      id: 'char-imported',
    }
    const reconciliationStarted = createDeferred<void>()
    const releaseReconciliation = createDeferred<void>()
    const reconciled: number[] = []
    setServerCommandSuccessReconciler(async (commandEvent) => {
      reconciled.push(commandEvent.revision)
      reconciliationStarted.resolve()
      await releaseReconciliation.promise
    })

    const pending = withDirectServerCommandEventReconciliation(
      (candidate) => candidate.type === 'character.created' && candidate.resource === 'character',
      async (reconcileResponseEvent) => {
        // The SSE echo can lead the raw HTTP response.
        expect(deferOwnServerCommandReconciliation(event)).toBe(true)
        const applyingResponse = reconcileResponseEvent(event)
        await reconciliationStarted.promise

        // Keep buffering the same echo while the response-triggered resource
        // read is in flight, otherwise it could launch a duplicate read.
        expect(deferOwnServerCommandReconciliation(event)).toBe(true)
        releaseReconciliation.resolve()
        await applyingResponse
      },
    )

    await expect(pending).resolves.toBeUndefined()
    expect(reconciled).toEqual([2])
    // An echo delivered after the response reconciliation is no longer held;
    // bootstrap will see the advanced applied cursor and treat it as a no-op.
    expect(deferOwnServerCommandReconciliation(event)).toBe(false)
  })

  it('forwards a direct response local effect through reconciliation', async () => {
    const event = {
      type: 'message.appended',
      revision: 2,
      resource: 'message',
      id: 'message-a',
      parentId: 'chat-a',
    }
    const localEffect: ServerCommandLocalEffect = {
      kind: 'messageMutation',
      operation: 'append',
      chatId: 'chat-a',
      messageId: 'message-a',
      chatBodyProjectionEpoch: 4,
    }
    const reconciledEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      reconciledEffects.push(...localEffects.values())
    })

    await withDirectServerCommandEventReconciliation(
      (candidate) => candidate.type === 'message.appended' && candidate.id === 'message-a',
      async (reconcileResponseEvent) => reconcileResponseEvent(event, localEffect),
    )

    expect(reconciledEffects).toEqual([localEffect])
  })

  it('releases unmatched and failed direct events through ordinary reconciliation', async () => {
    const unrelatedEvent = {
      type: 'character.created',
      revision: 2,
      resource: 'character',
      id: 'char-unrelated',
    }
    const confirmedEvent = {
      type: 'character.created',
      revision: 3,
      resource: 'character',
      id: 'char-imported',
    }
    const laterEvent = {
      type: 'character.created',
      revision: 4,
      resource: 'character',
      id: 'char-later',
    }
    const failedRequestEvent = {
      type: 'character.created',
      revision: 5,
      resource: 'character',
      id: 'char-after-failure',
    }
    const reconciled: number[][] = []
    setServerCommandSuccessReconciler((_event, events) => {
      reconciled.push(events.map((event) => event.revision))
    })
    const matchesCreatedCharacter = (event: { type: string; resource: string }) =>
      event.type === 'character.created' && event.resource === 'character'

    await withDirectServerCommandEventReconciliation(matchesCreatedCharacter, async (reconcileResponseEvent) => {
      expect(deferOwnServerCommandReconciliation(unrelatedEvent)).toBe(true)
      expect(deferOwnServerCommandReconciliation(laterEvent)).toBe(true)
      await reconcileResponseEvent(confirmedEvent)
    })

    await expect(
      withDirectServerCommandEventReconciliation(matchesCreatedCharacter, async () => {
        expect(deferOwnServerCommandReconciliation(failedRequestEvent)).toBe(true)
        throw new Error('request failed')
      }),
    ).rejects.toThrow('request failed')

    expect(reconciled).toEqual([[2], [3], [4], [5]])
  })

  it('dispatches message history commands through typed helpers', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/messages/truncate')) {
        return {
          revision: 4,
          event: { type: 'message.truncated', revision: 4, resource: 'message', parentId: 'chat-a' },
          chatId: 'chat-a',
          afterMessageId: 'msg-a',
          removedCount: 2,
        }
      }
      if (url.endsWith('/messages/tail')) {
        return {
          revision: 5,
          event: { type: 'messages.replaced', revision: 5, resource: 'message', parentId: 'chat-a' },
          chatId: 'chat-a',
          afterMessageId: 'msg-a',
          replacedCount: 1,
        }
      }
      if (url.endsWith('/chats/chat-a/messages')) {
        const method = commandFetch.calls.at(-1)?.method
        return method === 'PUT'
          ? {
              revision: 6,
              event: { type: 'messages.replaced', revision: 6, resource: 'message', parentId: 'chat-a' },
              chatId: 'chat-a',
            }
          : {
              revision: 1,
              event: {
                type: 'message.appended',
                revision: 1,
                resource: 'message',
                id: 'msg-a',
                parentId: 'chat-a',
              },
              chatId: 'chat-a',
              messageId: 'msg-a',
            }
      }
      if (url.endsWith('/messages/msg-a')) {
        const method = commandFetch.calls.at(-1)?.method
        return method === 'DELETE'
          ? {
              revision: 3,
              event: {
                type: 'message.deleted',
                revision: 3,
                resource: 'message',
                id: 'msg-a',
                parentId: 'chat-a',
              },
              chatId: 'chat-a',
              messageId: 'msg-a',
            }
          : {
              revision: 2,
              event: {
                type: 'message.updated',
                revision: 2,
                resource: 'message',
                id: 'msg-a',
                parentId: 'chat-a',
              },
              chatId: 'chat-a',
              messageId: 'msg-a',
            }
      }
      if (url.endsWith('/chats/chat-a/generation-result')) {
        return {
          revision: 7,
          event: {
            type: 'generation.persisted',
            revision: 7,
            resource: 'generation',
            id: 'gen-a',
          },
          chatId: 'chat-a',
          messageId: 'gen-a',
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      appendMessageCommand({
        baseRevision: 0,
        chatId: 'chat-a',
        message: { role: 'user', data: 'hello', chatId: 'msg-a' },
        optimisticChatBodyProjectionEpoch: 11,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 1, messageId: 'msg-a' })

    await expect(
      updateMessageCommand({
        baseRevision: 1,
        messageId: 'msg-a',
        patch: { data: 'edited', disabled: true },
        expectedData: 'hello',
        expectedChatId: 'chat-a',
        expectedGenerationId: 'gen-a',
        optimisticChatId: 'chat-a',
        optimisticChatBodyProjectionEpoch: 11,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, messageId: 'msg-a' })

    await expect(
      deleteMessageCommand({
        baseRevision: 2,
        messageId: 'msg-a',
        optimisticChatId: 'chat-a',
        optimisticChatBodyProjectionEpoch: 11,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, messageId: 'msg-a' })

    await expect(
      truncateMessagesCommand({
        baseRevision: 3,
        chatId: 'chat-a',
        afterMessageId: 'msg-a',
        optimisticChatBodyProjectionEpoch: 11,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 4, removedCount: 2 })

    await expect(
      replaceTailMessagesCommand({
        baseRevision: 4,
        chatId: 'chat-a',
        afterMessageId: 'msg-a',
        messages: [{ role: 'char', data: 'replacement', chatId: 'msg-b' }],
        optimisticChatBodyProjectionEpoch: 11,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, chatId: 'chat-a', replacedCount: 1 })

    await expect(
      replaceMessagesCommand({
        baseRevision: 5,
        chatId: 'chat-a',
        messages: [{ role: 'char', data: 'replacement', chatId: 'msg-b' }],
        optimisticChatBodyProjectionEpoch: 11,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 6, chatId: 'chat-a' })

    await expect(
      persistGenerationResultCommand({
        baseRevision: 6,
        chatId: 'chat-a',
        generationResult: {
          targetMessageId: 'msg-b',
          message: {
            role: 'char',
            data: 'generated',
            chatId: 'gen-a',
            generationInfo: { generationId: 'gen-a' },
            promptInfo: { promptName: 'Preset' },
          },
        },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 7, messageId: 'gen-a' })

    expect(observedEffects).toEqual([
      {
        kind: 'messageMutation',
        operation: 'append',
        chatId: 'chat-a',
        messageId: 'msg-a',
        chatBodyProjectionEpoch: 11,
      },
      {
        kind: 'messageMutation',
        operation: 'update',
        chatId: 'chat-a',
        messageId: 'msg-a',
        chatBodyProjectionEpoch: 11,
      },
      {
        kind: 'messageMutation',
        operation: 'delete',
        chatId: 'chat-a',
        messageId: 'msg-a',
        chatBodyProjectionEpoch: 11,
      },
      { kind: 'messageMutation', operation: 'truncate', chatId: 'chat-a', chatBodyProjectionEpoch: 11 },
      { kind: 'messageMutation', operation: 'replaceTail', chatId: 'chat-a', chatBodyProjectionEpoch: 11 },
      { kind: 'messageMutation', operation: 'replaceAll', chatId: 'chat-a', chatBodyProjectionEpoch: 11 },
    ])

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/chats/chat-a/messages',
        method: 'POST',
        body: {
          baseRevision: 0,
          message: { role: 'user', data: 'hello', chatId: 'msg-a' },
        },
      },
      {
        url: '/api/v1/commands/messages/msg-a',
        method: 'PATCH',
        body: {
          baseRevision: 1,
          patch: { data: 'edited', disabled: true },
          expectedData: 'hello',
          expectedChatId: 'chat-a',
          expectedGenerationId: 'gen-a',
        },
      },
      {
        url: '/api/v1/commands/messages/msg-a',
        method: 'DELETE',
        body: {
          baseRevision: 2,
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a/messages/truncate',
        method: 'POST',
        body: {
          baseRevision: 3,
          afterMessageId: 'msg-a',
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a/messages/tail',
        method: 'POST',
        body: {
          baseRevision: 4,
          afterMessageId: 'msg-a',
          messages: [{ role: 'char', data: 'replacement', chatId: 'msg-b' }],
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a/messages',
        method: 'PUT',
        body: {
          baseRevision: 5,
          messages: [{ role: 'char', data: 'replacement', chatId: 'msg-b' }],
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a/generation-result',
        method: 'POST',
        body: {
          baseRevision: 6,
          generationResult: {
            targetMessageId: 'msg-b',
            message: {
              role: 'char',
              data: 'generated',
              chatId: 'gen-a',
              generationInfo: { generationId: 'gen-a' },
              promptInfo: { promptName: 'Preset' },
            },
          },
        },
      },
    ])
  })

  it('dispatches chat scriptstate commands through typed helpers', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/chats/chat-a/scriptstate')) {
        return {
          revision: 7,
          event: {
            type: 'chat.scriptstate.updated',
            revision: 7,
            resource: 'characterRow',
            id: 'chat-a',
            parentId: 'char-a',
          },
          chatId: 'chat-a',
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      patchChatScriptstateCommand({
        baseRevision: 6,
        chatId: 'chat-a',
        patch: { $score: '9', $count: 2 },
        deleteKeys: ['$old'],
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 7, chatId: 'chat-a' })

    expect(observedEffects).toEqual([
      {
        kind: 'characterRowMutation',
        operation: 'chatScriptstate',
        characterId: 'char-a',
        targetId: 'chat-a',
      },
    ])

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/chats/chat-a/scriptstate',
        method: 'PATCH',
        body: {
          baseRevision: 6,
          patch: { $score: '9', $count: 2 },
          deleteKeys: ['$old'],
        },
      },
    ])
  })

  it('exposes an exact character reorder as a local revision fence', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const event = { type: 'character.reordered', revision: 6, resource: 'characterOrder' }
    const commandFetch = makeCommandFetch(() => ({ revision: 6, event, selectedCharacterId: 'char-a' }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const attemptedOrder = [{ id: 'folder-a', name: 'Folder', color: '', data: ['char-a'] }]

    await reorderCharactersCommand({ baseRevision: 5, characterOrder: attemptedOrder })

    expect(observedEffects).toEqual([{ kind: 'characterOrder', attemptedOrder }])
  })

  it('dispatches chat generation settings through the dedicated typed helper', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const attemptedGenerationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      agentPresetId: 'agent-preset-a',
      togglePresetId: 'toggle-preset-a',
      jailbreakToggle: false,
      sidebarToggles: {
        mode: '0',
        notes: '',
      },
    }
    const canonicalGenerationSettings = {
      ...attemptedGenerationSettings,
      sidebarToggles: { mode: '0' },
    }
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/chats/chat-a/generation-settings')) {
        return {
          revision: 8,
          event: {
            type: 'chat.updated',
            revision: 8,
            resource: 'characterRow',
            id: 'chat-a',
            parentId: 'char-a',
          },
          chatId: 'chat-a',
          characterId: 'char-a',
          generationSettings: canonicalGenerationSettings,
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      saveChatGenerationSettingsCommand({
        baseRevision: 7,
        chatId: 'chat-a',
        generationSettings: attemptedGenerationSettings,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      revision: 8,
      chatId: 'chat-a',
      characterId: 'char-a',
      generationSettings: canonicalGenerationSettings,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'chatGenerationSettings',
        chatId: 'chat-a',
        characterId: 'char-a',
        attemptedGenerationSettings,
        generationSettings: canonicalGenerationSettings,
      },
    ])

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/chats/chat-a/generation-settings',
        method: 'PUT',
        body: {
          baseRevision: 7,
          generationSettings: {
            configured: true,
            personaId: 'persona-a',
            modelPresetId: 'model-preset-a',
            promptPresetId: 'preset-a',
            agentPresetId: 'agent-preset-a',
            togglePresetId: 'toggle-preset-a',
            jailbreakToggle: false,
            sidebarToggles: {
              mode: '0',
              notes: '',
            },
          },
        },
      },
    ])
  })

  it('matches the synchronous generation-settings digest to WebCrypto SHA-256', async () => {
    const baseGenerationSettings = {
      configured: true,
      personaId: 'persona-한글',
      jailbreakToggle: false,
      sidebarToggles: { notes: 'line one\nline two' },
    }
    const serialized = serializeChatGenerationSettingsDigestInput(baseGenerationSettings)
    expect(sha256HexUtf8Sync(serialized)).toBe(await sha256Hex(serialized))

    const body = createChatGenerationSettingsCommandDurableBody({
      chatId: 'chat-a',
      generationSettings: { ...baseGenerationSettings, personaId: 'persona-next' },
      sparseUpdate: { patch: { personaId: 'persona-next' } },
      sparseBaseGenerationSettings: baseGenerationSettings,
    })
    expect(body.baseGenerationSettingsDigest).toBe(await sha256Hex(serialized))
  })

  it('sends a sparse generation-settings update and reconstructs its value-free acknowledgement', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const attemptedGenerationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-b',
      jailbreakToggle: false,
      sidebarToggles: {
        mode: 'cold',
        stale: '1',
      },
    }
    const sparseUpdate = {
      patch: {
        promptPresetId: 'preset-b',
        sidebarToggles: { mode: 'cold' },
      },
      deleteKeys: ['agentPresetId'] as const,
      sidebarToggleDeleteKeys: ['notes'],
    }
    const event = {
      type: 'chat.updated',
      revision: 8,
      resource: 'characterRow',
      id: 'chat-a',
      parentId: 'char-a',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 8,
      event,
      chatId: 'chat-a',
      characterId: 'char-a',
      certificate: 'chat-generation-settings-sparse-v1',
      patchedKeys: ['promptPresetId', 'sidebarToggles'],
      deletedKeys: ['agentPresetId'],
      sidebarTogglePatchedKeys: ['mode'],
      sidebarToggleDeletedKeys: ['notes'],
      prunedSidebarToggleKeys: ['stale'],
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await saveChatGenerationSettingsCommand({
      baseRevision: 7,
      chatId: 'chat-a',
      generationSettings: attemptedGenerationSettings,
      sparseUpdate: {
        patch: sparseUpdate.patch,
        deleteKeys: [...sparseUpdate.deleteKeys],
        sidebarToggleDeleteKeys: sparseUpdate.sidebarToggleDeleteKeys,
      },
      sparseBaseGenerationSettings: null,
      expectedCharacterId: 'char-a',
      optimisticCharacterRowEpoch: 7,
    })

    expect(result).toMatchObject({
      status: 'ok',
      acknowledgedGenerationSettings: {
        ...attemptedGenerationSettings,
        sidebarToggles: { mode: 'cold' },
      },
    })
    expect(observedEffects).toEqual([
      {
        kind: 'chatGenerationSettings',
        chatId: 'chat-a',
        characterId: 'char-a',
        attemptedGenerationSettings,
        generationSettings: {
          ...attemptedGenerationSettings,
          sidebarToggles: { mode: 'cold' },
        },
        characterRowProjectionEpoch: 7,
      },
    ])
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      {
        baseRevision: 7,
        baseGenerationSettingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        patch: sparseUpdate.patch,
        deleteKeys: ['agentPresetId'],
        sidebarToggleDeleteKeys: ['notes'],
      },
    ])
  })

  it('withholds sparse generation-settings effects for inexact acknowledgements', async () => {
    const attemptedGenerationSettings = {
      configured: true,
      personaId: 'persona-a',
      promptPresetId: 'preset-b',
      jailbreakToggle: false,
      sidebarToggles: { mode: 'cold', stale: '1' },
    }
    const sparseUpdate = {
      patch: {
        promptPresetId: 'preset-b',
        sidebarToggles: { mode: 'cold' },
      },
      deleteKeys: ['agentPresetId' as const],
      sidebarToggleDeleteKeys: ['notes'],
    }
    const validBody = {
      revision: 8,
      event: {
        type: 'chat.updated',
        revision: 8,
        resource: 'characterRow',
        id: 'chat-a',
        parentId: 'char-a',
      },
      chatId: 'chat-a',
      characterId: 'char-a',
      certificate: 'chat-generation-settings-sparse-v1',
      patchedKeys: ['promptPresetId', 'sidebarToggles'],
      deletedKeys: ['agentPresetId'],
      sidebarTogglePatchedKeys: ['mode'],
      sidebarToggleDeletedKeys: ['notes'],
      prunedSidebarToggleKeys: ['stale'],
    }
    const malformedBodies = [
      { ...validBody, patchedKeys: ['promptPresetId'] },
      { ...validBody, deletedKeys: ['agentPresetId', 'agentPresetId'] },
      { ...validBody, prunedSidebarToggleKeys: ['missing'] },
      { ...validBody, certificate: 'chat-generation-settings-sparse-v2' },
      {
        ...validBody,
        event: { ...validBody.event, parentId: 'char-b' },
      },
      {
        ...validBody,
        characterId: 'char-b',
        event: { ...validBody.event, parentId: 'char-b' },
      },
      {
        ...validBody,
        patchedKeys: ['unexpected'],
        acknowledgedGenerationSettings: { jailbreakToggle: true },
      },
    ]

    for (const body of malformedBodies) {
      const observedEffects: unknown[] = []
      setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
        observedEffects.push(...localEffects.values())
      })
      const commandFetch = makeCommandFetch(() => body)
      vi.stubGlobal('fetch', commandFetch.fetch)

      const result = await saveChatGenerationSettingsCommand({
        baseRevision: 7,
        chatId: 'chat-a',
        generationSettings: attemptedGenerationSettings,
        sparseUpdate,
        sparseBaseGenerationSettings: null,
        expectedCharacterId: 'char-a',
        optimisticCharacterRowEpoch: 7,
      })

      expect(result.status).toBe('ok')
      expect(result).toHaveProperty('acknowledgedGenerationSettings', undefined)
      expect(observedEffects).toEqual([])
    }
  })

  it('reports an accepted character-row patch as a local command effect', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event: {
        type: 'character.updated',
        revision: 3,
        resource: 'characterRow',
        id: 'char-b',
      },
      characterId: 'char-b',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      updateCharacterCommand({
        baseRevision: 2,
        characterId: 'char-b',
        patch: { name: 'B renamed' },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, characterId: 'char-b' })

    expect(observedEffects).toEqual([
      {
        kind: 'characterPatch',
        characterId: 'char-b',
        patch: { name: 'B renamed' },
      },
    ])
  })

  it('captures the destructive-refresh epoch before a local-effect command request', async () => {
    const requestEpoch = captureDestructiveRefreshEpoch()
    let observedEffect: ServerCommandLocalEffect | undefined
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffect = [...localEffects.values()][0]
    })
    const commandFetch = makeCommandFetch(() => {
      createDestructiveRefreshToken('character-patch-in-flight-refresh')
      return {
        revision: 3,
        event: {
          type: 'character.updated',
          revision: 3,
          resource: 'characterRow',
          id: 'char-b',
        },
        characterId: 'char-b',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await updateCharacterCommand({
      baseRevision: 2,
      characterId: 'char-b',
      patch: { name: 'B renamed' },
    })

    expect(observedEffect?.destructiveRefreshEpoch).toBe(requestEpoch)
    expect(Object.keys(observedEffect ?? {})).not.toContain('destructiveRefreshEpoch')
  })

  it('reports an accepted character selection as a local command effect', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 4,
      event: {
        type: 'character.selected',
        revision: 4,
        resource: 'characterSelection',
        id: 'char-b',
      },
      characterId: 'char-b',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      selectCharacterCommand({
        baseRevision: 3,
        characterId: 'char-b',
        lastInteraction: 1234,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 4, characterId: 'char-b' })

    expect(observedEffects).toEqual([
      {
        kind: 'characterSelection',
        characterId: 'char-b',
        lastInteraction: 1234,
      },
    ])
  })

  it('reports an accepted chat update as a local command effect', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 5,
      event: {
        type: 'chat.updated',
        revision: 5,
        resource: 'characterRow',
        id: 'chat-a',
        parentId: 'char-a',
      },
      chatId: 'chat-a',
      selectedChatId: 'chat-a',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      updateChatCommand({
        baseRevision: 4,
        chatId: 'chat-a',
        patch: {},
        select: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, selectedChatId: 'chat-a' })

    expect(observedEffects).toEqual([
      {
        kind: 'chatPatch',
        characterId: 'char-a',
        chatId: 'chat-a',
        patch: {},
        select: true,
      },
    ])
  })

  it('dispatches lorebook commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (
        url.includes('/lorebooks') ||
        url.includes('/characters/') ||
        url.includes('/chats/') ||
        url.includes('/modules/')
      ) {
        return {
          revision: 9,
          event: {
            type: 'lorebook.entries.replaced',
            revision: 9,
            resource: 'lorebook',
          },
          lorebookId: 'book-a',
          characterId: 'char-a',
          chatId: 'chat-a',
          moduleId: 'mod-a',
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const entry = {
      id: 'entry-a',
      key: 'key',
      secondkey: '',
      insertorder: 100,
      comment: 'Lore',
      content: 'body',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }

    await createGlobalLorebookCommand({
      baseRevision: 1,
      lorebook: { id: 'book-a', name: 'A', data: [] },
    })
    await updateGlobalLorebookCommand({
      baseRevision: 2,
      lorebookId: 'book-a',
      patch: { name: 'Renamed' },
    })
    await deleteGlobalLorebookCommand({ baseRevision: 3, lorebookId: 'book-a' })
    await reorderGlobalLorebooksCommand({ baseRevision: 4, lorebookIds: ['book-a'] })
    await selectGlobalLorebookCommand({ baseRevision: 5, lorebookId: 'book-a' })
    await replaceGlobalLorebookEntriesCommand({
      baseRevision: 6,
      lorebookId: 'book-a',
      entries: [entry],
    })
    await replaceCharacterLorebooksCommand({
      baseRevision: 7,
      characterId: 'char-a',
      entries: [entry],
    })
    await replaceChatLorebooksCommand({ baseRevision: 8, chatId: 'chat-a', entries: [entry] })
    await replaceModuleLorebooksCommand({ baseRevision: 9, moduleId: 'mod-a', entries: [entry] })
    await upsertGlobalLorebookEntryCommand({
      baseRevision: 10,
      lorebookId: 'book-a',
      entryId: 'entry-a',
      entry,
    })
    await upsertCharacterLorebookEntryCommand({
      baseRevision: 11,
      characterId: 'char-a',
      entryId: 'entry-a',
      entry,
    })
    await upsertChatLorebookEntryCommand({
      baseRevision: 12,
      chatId: 'chat-a',
      entryId: 'entry-a',
      entry,
    })
    await upsertModuleLorebookEntryCommand({
      baseRevision: 13,
      moduleId: 'mod-a',
      entryId: 'entry-a',
      entry,
    })
    await deleteGlobalLorebookEntryCommand({ baseRevision: 14, lorebookId: 'book-a', entryId: 'entry-a' })
    await deleteCharacterLorebookEntryCommand({ baseRevision: 15, characterId: 'char-a', entryId: 'entry-a' })
    await deleteChatLorebookEntryCommand({ baseRevision: 16, chatId: 'chat-a', entryId: 'entry-a' })
    await deleteModuleLorebookEntryCommand({ baseRevision: 17, moduleId: 'mod-a', entryId: 'entry-a' })
    await reorderGlobalLorebookEntriesCommand({
      baseRevision: 18,
      lorebookId: 'book-a',
      entryIds: ['entry-b', 'entry-a'],
    })
    await reorderCharacterLorebookEntriesCommand({
      baseRevision: 19,
      characterId: 'char-a',
      entryIds: ['entry-b', 'entry-a'],
    })
    await reorderChatLorebookEntriesCommand({
      baseRevision: 20,
      chatId: 'chat-a',
      entryIds: ['entry-b', 'entry-a'],
    })
    await reorderModuleLorebookEntriesCommand({
      baseRevision: 21,
      moduleId: 'mod-a',
      entryIds: ['entry-b', 'entry-a'],
    })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/lorebooks',
        method: 'POST',
        body: { baseRevision: 1, lorebook: { id: 'book-a', name: 'A', data: [] } },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a',
        method: 'PATCH',
        body: { baseRevision: 2, patch: { name: 'Renamed' } },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a',
        method: 'DELETE',
        body: { baseRevision: 3 },
      },
      {
        url: '/api/v1/commands/lorebooks/reorder',
        method: 'POST',
        body: { baseRevision: 4, lorebookIds: ['book-a'] },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a/select',
        method: 'POST',
        body: { baseRevision: 5 },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a/entries',
        method: 'PUT',
        body: { baseRevision: 6, entries: [entry] },
      },
      {
        url: '/api/v1/commands/characters/char-a/lorebooks',
        method: 'PUT',
        body: { baseRevision: 7, entries: [entry] },
      },
      {
        url: '/api/v1/commands/chats/chat-a/lorebooks',
        method: 'PUT',
        body: { baseRevision: 8, entries: [entry] },
      },
      {
        url: '/api/v1/commands/modules/mod-a/lorebooks',
        method: 'PUT',
        body: { baseRevision: 9, entries: [entry] },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a/entries/entry-a',
        method: 'PUT',
        body: { baseRevision: 10, entry },
      },
      {
        url: '/api/v1/commands/characters/char-a/lorebooks/entries/entry-a',
        method: 'PUT',
        body: { baseRevision: 11, entry },
      },
      {
        url: '/api/v1/commands/chats/chat-a/lorebooks/entries/entry-a',
        method: 'PUT',
        body: { baseRevision: 12, entry },
      },
      {
        url: '/api/v1/commands/modules/mod-a/lorebooks/entries/entry-a',
        method: 'PUT',
        body: { baseRevision: 13, entry },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a/entries/entry-a',
        method: 'DELETE',
        body: { baseRevision: 14 },
      },
      {
        url: '/api/v1/commands/characters/char-a/lorebooks/entries/entry-a',
        method: 'DELETE',
        body: { baseRevision: 15 },
      },
      {
        url: '/api/v1/commands/chats/chat-a/lorebooks/entries/entry-a',
        method: 'DELETE',
        body: { baseRevision: 16 },
      },
      {
        url: '/api/v1/commands/modules/mod-a/lorebooks/entries/entry-a',
        method: 'DELETE',
        body: { baseRevision: 17 },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a/entries/reorder',
        method: 'POST',
        body: { baseRevision: 18, entryIds: ['entry-b', 'entry-a'] },
      },
      {
        url: '/api/v1/commands/characters/char-a/lorebooks/entries/reorder',
        method: 'POST',
        body: { baseRevision: 19, entryIds: ['entry-b', 'entry-a'] },
      },
      {
        url: '/api/v1/commands/chats/chat-a/lorebooks/entries/reorder',
        method: 'POST',
        body: { baseRevision: 20, entryIds: ['entry-b', 'entry-a'] },
      },
      {
        url: '/api/v1/commands/modules/mod-a/lorebooks/entries/reorder',
        method: 'POST',
        body: { baseRevision: 21, entryIds: ['entry-b', 'entry-a'] },
      },
    ])
  })

  it('sends sparse lorebook entry patches in every scope and accepts only exact compact receipts', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let revision = 30
    const commandFetch = makeCommandFetch((url) => {
      revision += 1
      const scope = url.includes('/characters/')
        ? 'character'
        : url.includes('/chats/')
          ? 'chat'
          : url.includes('/modules/')
            ? 'module'
            : 'global'
      const id =
        scope === 'character' ? 'char-a' : scope === 'chat' ? 'chat-a' : scope === 'module' ? 'mod-a' : 'book-a'
      return {
        revision,
        event: {
          type: 'lorebook.entries.replaced',
          revision,
          resource:
            scope === 'character'
              ? 'characterLorebook'
              : scope === 'chat'
                ? 'characterRow'
                : scope === 'module'
                  ? 'moduleUpdated'
                  : 'globalLorebook',
          id,
          ...(scope === 'chat' ? { parentId: 'char-a' } : {}),
        },
        ...(scope === 'character'
          ? { characterId: id }
          : scope === 'chat'
            ? { chatId: id }
            : scope === 'module'
              ? { moduleId: id }
              : { lorebookId: id }),
        entryId: 'entry-a',
        entryIndex: 0,
        created: false,
        patchedKeys: ['content', 'nullableExtension'],
        deletedKeys: ['activationPercent'],
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const entry = {
      id: 'entry-a',
      key: 'key',
      secondkey: '',
      insertorder: 100,
      comment: 'Lore',
      content: 'edited',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
      nullableExtension: null,
    }
    const sparseUpdate = {
      patch: { content: 'edited', nullableExtension: null },
      deleteKeys: ['activationPercent'],
    }

    await upsertGlobalLorebookEntryCommand({
      baseRevision: 1,
      lorebookId: 'book-a',
      entryId: 'entry-a',
      entry,
      sparseUpdate,
      optimisticEntries: [entry],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
      optimisticEntryIndex: 0,
      optimisticEntryCreated: false,
    })
    await upsertCharacterLorebookEntryCommand({
      baseRevision: 2,
      characterId: 'char-a',
      entryId: 'entry-a',
      entry,
      sparseUpdate,
      optimisticEntries: [entry],
      acknowledgeOptimistic: true,
      optimisticRowEpoch: 2,
      optimisticLorebookEpoch: 3,
      optimisticEntryIndex: 0,
      optimisticEntryCreated: false,
    })
    await upsertChatLorebookEntryCommand({
      baseRevision: 3,
      chatId: 'chat-a',
      entryId: 'entry-a',
      entry,
      sparseUpdate,
      optimisticEntries: [entry],
      acknowledgeOptimistic: true,
      optimisticCharacterId: 'char-a',
      optimisticRowEpoch: 4,
      optimisticEntryIndex: 0,
      optimisticEntryCreated: false,
    })
    await upsertModuleLorebookEntryCommand(
      { baseRevision: 4, moduleId: 'mod-a', entryId: 'entry-a', entry, sparseUpdate },
      null,
      false,
      true,
    )

    expect(commandFetch.calls.map(({ body }) => body)).toEqual([
      { baseRevision: 1, patch: sparseUpdate.patch, deleteKeys: sparseUpdate.deleteKeys },
      { baseRevision: 2, patch: sparseUpdate.patch, deleteKeys: sparseUpdate.deleteKeys },
      { baseRevision: 3, patch: sparseUpdate.patch, deleteKeys: sparseUpdate.deleteKeys },
      { baseRevision: 4, patch: sparseUpdate.patch, deleteKeys: sparseUpdate.deleteKeys },
    ])
    for (const call of commandFetch.calls) {
      expect(call.body).not.toHaveProperty('entry')
      expect(call.body).not.toHaveProperty('optimisticEntries')
    }
    expect(observedEffects).toEqual([
      {
        kind: 'lorebookMutation',
        scope: 'global',
        operation: 'upsert',
        lorebookId: 'book-a',
        collectionProjectionEpoch: 1,
      },
      {
        kind: 'lorebookMutation',
        scope: 'character',
        operation: 'upsert',
        characterId: 'char-a',
        characterRowProjectionEpoch: 2,
        characterLorebookProjectionEpoch: 3,
      },
      {
        kind: 'lorebookMutation',
        scope: 'chat',
        operation: 'upsert',
        characterId: 'char-a',
        chatId: 'chat-a',
        characterRowProjectionEpoch: 4,
      },
      { kind: 'moduleCollectionMutation', operation: 'lorebooks', moduleId: 'mod-a' },
    ])
  })

  it('withholds sparse lorebook local effects for mismatched or create receipts', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let call = 0
    const commandFetch = makeCommandFetch((url) => {
      call += 1
      const module = url.includes('/modules/')
      return {
        revision: 40 + call,
        event: {
          type: 'lorebook.entries.replaced',
          revision: 40 + call,
          resource: module ? 'moduleUpdated' : 'globalLorebook',
          id: module ? 'mod-a' : 'book-a',
        },
        ...(module ? { moduleId: 'mod-a' } : { lorebookId: 'book-a' }),
        entryId: 'entry-a',
        entryIndex: 0,
        created: module,
        patchedKeys: module ? ['content'] : [],
        deletedKeys: [],
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const entry = {
      id: 'entry-a',
      key: 'key',
      secondkey: '',
      insertorder: 100,
      comment: 'Lore',
      content: 'edited',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    const sparseUpdate = { patch: { content: 'edited' } }

    await upsertGlobalLorebookEntryCommand({
      baseRevision: 1,
      lorebookId: 'book-a',
      entryId: 'entry-a',
      entry,
      sparseUpdate,
      optimisticEntries: [entry],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
      optimisticEntryIndex: 0,
      optimisticEntryCreated: false,
    })
    await upsertModuleLorebookEntryCommand(
      { baseRevision: 2, moduleId: 'mod-a', entryId: 'entry-a', entry, sparseUpdate },
      null,
      false,
      true,
    )

    expect(observedEffects).toEqual([])
  })

  it('emits strict opt-in local effects for top-level lorebook mutations without sending acknowledgement metadata', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let revision = 20
    const commandFetch = makeCommandFetch((url, init) => {
      revision += 1
      if (url.endsWith('/lorebooks/reorder')) {
        return {
          revision,
          event: { type: 'lorebook.reordered', revision, resource: 'globalLorebook' },
          selectedLorebookId: 'book-b',
        }
      }
      if (url.endsWith('/lorebooks/book-b/select')) {
        return {
          revision,
          event: { type: 'lorebook.selected', revision, resource: 'globalLorebook', id: 'book-b' },
          selectedLorebookId: 'book-b',
        }
      }
      const operation = url.endsWith('/lorebooks') ? 'created' : init.method === 'PATCH' ? 'updated' : 'deleted'
      const lorebookId = operation === 'created' ? 'book-c' : 'book-a'
      return {
        revision,
        event: { type: `lorebook.${operation}`, revision, resource: 'globalLorebook', id: lorebookId },
        lorebookId,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const canonicalEntry = {
      id: 'entry-a',
      key: 'a',
      secondkey: '',
      insertorder: 100,
      comment: 'A',
      content: 'A',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    await createGlobalLorebookCommand({
      baseRevision: 1,
      lorebook: { id: 'book-c', name: 'Book C', data: [canonicalEntry] },
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 11,
    })
    await updateGlobalLorebookCommand({
      baseRevision: 2,
      lorebookId: 'book-a',
      patch: { name: 'Renamed A' },
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 12,
    })
    await deleteGlobalLorebookCommand({
      baseRevision: 3,
      lorebookId: 'book-a',
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 13,
      optimisticPageEpoch: 14,
    })
    await reorderGlobalLorebooksCommand({
      baseRevision: 4,
      lorebookIds: ['book-b', 'book-a'],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 15,
      optimisticPageEpoch: 16,
      optimisticSelectedLorebookId: 'book-b',
    })
    await selectGlobalLorebookCommand({
      baseRevision: 5,
      lorebookId: 'book-b',
      acknowledgeOptimistic: true,
      optimisticPageEpoch: 17,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'globalLorebookMutation',
        operation: 'create',
        lorebookId: 'book-c',
        collectionProjectionEpoch: 11,
      },
      {
        kind: 'globalLorebookMutation',
        operation: 'update',
        lorebookId: 'book-a',
        collectionProjectionEpoch: 12,
      },
      {
        kind: 'globalLorebookMutation',
        operation: 'delete',
        lorebookId: 'book-a',
        collectionProjectionEpoch: 13,
        pageProjectionEpoch: 14,
      },
      {
        kind: 'globalLorebookMutation',
        operation: 'reorder',
        lorebookIds: ['book-b', 'book-a'],
        selectedLorebookId: 'book-b',
        collectionProjectionEpoch: 15,
        pageProjectionEpoch: 16,
      },
      {
        kind: 'globalLorebookMutation',
        operation: 'select',
        lorebookId: 'book-b',
        selectedLorebookId: 'book-b',
        pageProjectionEpoch: 17,
      },
    ])
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      { baseRevision: 1, lorebook: { id: 'book-c', name: 'Book C', data: [canonicalEntry] } },
      { baseRevision: 2, patch: { name: 'Renamed A' } },
      { baseRevision: 3 },
      { baseRevision: 4, lorebookIds: ['book-b', 'book-a'] },
      { baseRevision: 5 },
    ])
  })

  it('keeps noncanonical or mismatched top-level lorebook acknowledgements authoritative', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let call = 0
    const commandFetch = makeCommandFetch((url, init) => {
      call += 1
      if (url.endsWith('/reorder')) {
        return {
          revision: 30 + call,
          event: { type: 'lorebook.reordered', revision: 30 + call, resource: 'globalLorebook' },
          selectedLorebookId: call === 5 ? 'book-a' : 'book-b',
        }
      }
      const operation = url.endsWith('/lorebooks') ? 'created' : init.method === 'PATCH' ? 'updated' : 'selected'
      const id = operation === 'created' ? 'book-c' : 'book-a'
      return {
        revision: 30 + call,
        event: {
          type: `lorebook.${operation}`,
          revision: 30 + call,
          resource: 'globalLorebook',
          id,
          ...(call === 6 ? { parentId: 'unexpected-parent' } : {}),
        },
        lorebookId: id,
        selectedLorebookId: id,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createGlobalLorebookCommand({
      baseRevision: 1,
      lorebook: { id: 'book-c', name: 'Book C', data: [] },
    })
    await createGlobalLorebookCommand({
      baseRevision: 2,
      lorebook: { id: 'book-c', name: '', data: [] },
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
    })
    await updateGlobalLorebookCommand({
      baseRevision: 3,
      lorebookId: 'book-a',
      patch: { name: '' },
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
    })
    await reorderGlobalLorebooksCommand({
      baseRevision: 4,
      lorebookIds: ['book-a', 'book-a'],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
      optimisticPageEpoch: 2,
      optimisticSelectedLorebookId: 'book-a',
    })
    await reorderGlobalLorebooksCommand({
      baseRevision: 5,
      lorebookIds: ['book-a', 'book-b'],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
      optimisticPageEpoch: 2,
      optimisticSelectedLorebookId: 'book-b',
    })
    await selectGlobalLorebookCommand({
      baseRevision: 6,
      lorebookId: 'book-a',
      acknowledgeOptimistic: true,
      optimisticPageEpoch: 2,
    })

    expect(observedEffects).toEqual([])
  })

  it('emits strict opt-in local effects for scoped lorebook replace and entry deltas', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let revision = 30
    const commandFetch = makeCommandFetch((url, init) => {
      revision += 1
      const scope = url.includes('/characters/') ? 'character' : url.includes('/chats/') ? 'chat' : 'global'
      const targetId = scope === 'character' ? 'char-a' : scope === 'chat' ? 'chat-a' : 'book-a'
      const targetKey = scope === 'character' ? 'characterId' : scope === 'chat' ? 'chatId' : 'lorebookId'
      const entryMutation = url.includes('/entries/entry-b') && !url.endsWith('/reorder')
      return {
        revision,
        event: {
          type: 'lorebook.entries.replaced',
          revision,
          resource: scope === 'character' ? 'characterLorebook' : scope === 'chat' ? 'characterRow' : 'globalLorebook',
          id: targetId,
          ...(scope === 'chat' ? { parentId: 'char-a' } : {}),
        },
        [targetKey]: targetId,
        ...(entryMutation
          ? {
              entryId: 'entry-b',
              entryIndex: 1,
              ...(init.method === 'PUT' ? { created: false } : {}),
            }
          : {}),
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const entryA = {
      id: 'entry-a',
      key: 'a',
      secondkey: '',
      insertorder: 100,
      comment: 'A',
      content: 'A',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    const entryB = { ...entryA, id: 'entry-b', key: 'b', comment: 'B', content: 'B' }
    const scopes = [
      {
        scope: 'global' as const,
        metadata: { acknowledgeOptimistic: true, optimisticCollectionEpoch: 4 },
        replace: (optimisticEntries: (typeof entryA)[]) =>
          replaceGlobalLorebookEntriesCommand({
            baseRevision: 1,
            lorebookId: 'book-a',
            entries: optimisticEntries,
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCollectionEpoch: 4,
          }),
        upsert: (optimisticEntries: (typeof entryA)[]) =>
          upsertGlobalLorebookEntryCommand({
            baseRevision: 1,
            lorebookId: 'book-a',
            entryId: 'entry-b',
            entry: entryB,
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCollectionEpoch: 4,
            optimisticEntryIndex: 1,
            optimisticEntryCreated: false,
          }),
        delete: (optimisticEntries: (typeof entryA)[]) =>
          deleteGlobalLorebookEntryCommand({
            baseRevision: 1,
            lorebookId: 'book-a',
            entryId: 'entry-b',
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCollectionEpoch: 4,
            optimisticEntryIndex: 1,
          }),
        reorder: (optimisticEntries: (typeof entryA)[]) =>
          reorderGlobalLorebookEntriesCommand({
            baseRevision: 1,
            lorebookId: 'book-a',
            entryIds: optimisticEntries.map((entry) => entry.id),
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCollectionEpoch: 4,
          }),
      },
      {
        scope: 'character' as const,
        metadata: {
          acknowledgeOptimistic: true,
          optimisticRowEpoch: 5,
          optimisticLorebookEpoch: 6,
        },
        replace: (optimisticEntries: (typeof entryA)[]) =>
          replaceCharacterLorebooksCommand({
            baseRevision: 1,
            characterId: 'char-a',
            entries: optimisticEntries,
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticRowEpoch: 5,
            optimisticLorebookEpoch: 6,
          }),
        upsert: (optimisticEntries: (typeof entryA)[]) =>
          upsertCharacterLorebookEntryCommand({
            baseRevision: 1,
            characterId: 'char-a',
            entryId: 'entry-b',
            entry: entryB,
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticRowEpoch: 5,
            optimisticLorebookEpoch: 6,
            optimisticEntryIndex: 1,
            optimisticEntryCreated: false,
          }),
        delete: (optimisticEntries: (typeof entryA)[]) =>
          deleteCharacterLorebookEntryCommand({
            baseRevision: 1,
            characterId: 'char-a',
            entryId: 'entry-b',
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticRowEpoch: 5,
            optimisticLorebookEpoch: 6,
            optimisticEntryIndex: 1,
          }),
        reorder: (optimisticEntries: (typeof entryA)[]) =>
          reorderCharacterLorebookEntriesCommand({
            baseRevision: 1,
            characterId: 'char-a',
            entryIds: optimisticEntries.map((entry) => entry.id),
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticRowEpoch: 5,
            optimisticLorebookEpoch: 6,
          }),
      },
      {
        scope: 'chat' as const,
        metadata: { acknowledgeOptimistic: true, optimisticCharacterId: 'char-a', optimisticRowEpoch: 7 },
        replace: (optimisticEntries: (typeof entryA)[]) =>
          replaceChatLorebooksCommand({
            baseRevision: 1,
            chatId: 'chat-a',
            entries: optimisticEntries,
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCharacterId: 'char-a',
            optimisticRowEpoch: 7,
          }),
        upsert: (optimisticEntries: (typeof entryA)[]) =>
          upsertChatLorebookEntryCommand({
            baseRevision: 1,
            chatId: 'chat-a',
            entryId: 'entry-b',
            entry: entryB,
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCharacterId: 'char-a',
            optimisticRowEpoch: 7,
            optimisticEntryIndex: 1,
            optimisticEntryCreated: false,
          }),
        delete: (optimisticEntries: (typeof entryA)[]) =>
          deleteChatLorebookEntryCommand({
            baseRevision: 1,
            chatId: 'chat-a',
            entryId: 'entry-b',
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCharacterId: 'char-a',
            optimisticRowEpoch: 7,
            optimisticEntryIndex: 1,
          }),
        reorder: (optimisticEntries: (typeof entryA)[]) =>
          reorderChatLorebookEntriesCommand({
            baseRevision: 1,
            chatId: 'chat-a',
            entryIds: optimisticEntries.map((entry) => entry.id),
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCharacterId: 'char-a',
            optimisticRowEpoch: 7,
          }),
      },
    ]

    for (const scope of scopes) {
      await scope.replace([entryA, entryB])
      await scope.upsert([entryA, entryB])
      await scope.delete([entryA])
      await scope.reorder([entryB, entryA])
    }

    expect(observedEffects).toEqual(
      scopes.flatMap(({ scope, metadata }) =>
        (['replace', 'upsert', 'delete', 'reorder'] as const).map((operation) => ({
          kind: 'lorebookMutation',
          scope,
          operation,
          ...(scope === 'global'
            ? { lorebookId: 'book-a', collectionProjectionEpoch: metadata.optimisticCollectionEpoch }
            : scope === 'character'
              ? {
                  characterId: 'char-a',
                  characterRowProjectionEpoch: metadata.optimisticRowEpoch,
                  characterLorebookProjectionEpoch: metadata.optimisticLorebookEpoch,
                }
              : {
                  characterId: 'char-a',
                  chatId: 'chat-a',
                  characterRowProjectionEpoch: metadata.optimisticRowEpoch,
                }),
        })),
      ),
    )
  })

  it('keeps non-opt-in, noncanonical, and mismatched scoped lorebook commands authoritative', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => ({
      revision: 40,
      event: {
        type: 'lorebook.entries.replaced',
        revision: 40,
        resource: url.includes('/chats/') ? 'characterRow' : 'globalLorebook',
        id: url.includes('/chats/') ? 'chat-a' : 'book-a',
        ...(url.includes('/chats/') ? { parentId: 'wrong-character' } : {}),
      },
      lorebookId: 'book-a',
      chatId: 'chat-a',
      ...(url.endsWith('/entries/entry-a') ? { entryId: 'entry-a', entryIndex: 1, created: false } : {}),
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const malformedEntry = { id: 'entry-a', key: 'missing canonical fields' }
    const canonicalEntry = {
      id: 'entry-a',
      key: 'entry-a',
      secondkey: '',
      insertorder: 100,
      comment: 'Entry A',
      content: 'A',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    await replaceGlobalLorebookEntriesCommand({
      baseRevision: 1,
      lorebookId: 'book-a',
      entries: [],
    })
    await replaceGlobalLorebookEntriesCommand({
      baseRevision: 1,
      lorebookId: 'book-a',
      entries: [malformedEntry],
      optimisticEntries: [malformedEntry],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
    })
    await replaceChatLorebooksCommand({
      baseRevision: 1,
      chatId: 'chat-a',
      entries: [],
      optimisticEntries: [],
      acknowledgeOptimistic: true,
      optimisticCharacterId: 'char-a',
      optimisticRowEpoch: 1,
    })
    await upsertGlobalLorebookEntryCommand({
      baseRevision: 1,
      lorebookId: 'book-a',
      entryId: 'entry-a',
      entry: canonicalEntry,
      optimisticEntries: [canonicalEntry],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
      optimisticEntryIndex: 0,
      optimisticEntryCreated: true,
    })

    expect(observedEffects).toEqual([])
  })

  it('dispatches script and trigger definition commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.includes('/scripts')) {
        return {
          revision: 9,
          event: {
            type: 'scriptDefinitions.replaced',
            revision: 9,
            resource: 'scriptDefinition',
          },
          characterId: 'char-a',
          moduleId: 'mod-a',
        }
      }
      if (url.includes('/triggers')) {
        return {
          revision: 10,
          event: {
            type: 'triggerDefinitions.replaced',
            revision: 10,
            resource: 'triggerDefinition',
          },
          characterId: 'char-a',
          moduleId: 'mod-a',
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const script = {
      id: 'script-a',
      comment: 'Regex',
      in: 'a',
      out: 'b',
      type: 'editinput',
    }
    const trigger = {
      id: 'trigger-a',
      comment: 'Start',
      type: 'start',
      conditions: [],
      effect: [],
    }

    await replaceCharacterScriptsCommand({
      baseRevision: 1,
      characterId: 'char-a',
      scripts: [script],
    })
    await replaceCharacterTriggersCommand({
      baseRevision: 2,
      characterId: 'char-a',
      triggers: [trigger],
    })
    await replaceModuleScriptsCommand({
      baseRevision: 3,
      moduleId: 'mod-a',
      scripts: [script],
      optimisticCollectionEpoch: 9,
    })
    await replaceModuleTriggersCommand({
      baseRevision: 4,
      moduleId: 'mod-a',
      triggers: [trigger],
      optimisticCollectionEpoch: 9,
    })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/characters/char-a/scripts',
        method: 'PUT',
        body: { baseRevision: 1, scripts: [script] },
      },
      {
        url: '/api/v1/commands/characters/char-a/triggers',
        method: 'PUT',
        body: { baseRevision: 2, triggers: [trigger] },
      },
      {
        url: '/api/v1/commands/modules/mod-a/scripts',
        method: 'PUT',
        body: { baseRevision: 3, scripts: [script] },
      },
      {
        url: '/api/v1/commands/modules/mod-a/triggers',
        method: 'PUT',
        body: { baseRevision: 4, triggers: [trigger] },
      },
    ])
  })

  it('keeps the final global-script array client-only for a compact mutation', async () => {
    const expectedScripts = [
      { id: 'script-a', comment: 'Edited', in: 'small', out: 'x'.repeat(64 * 1024), type: 'editinput' },
    ]
    const expectedDigest = createHash('sha256')
      .update(serializeScriptDefinitionCollectionDigestInput(expectedScripts), 'utf8')
      .digest('hex')
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 12,
      event: {
        type: 'settings.updated',
        revision: 12,
        resource: 'settings',
        id: 'advanced',
      },
      group: 'advanced',
      key: 'globalscript',
      certificate: 'global-script-mutation-v1',
      operation: 'update',
      globalScriptsDigest: expectedDigest,
      acknowledgedKeys: ['globalscript'],
      settings: {},
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await mutateGlobalScriptsCommand({
      baseRevision: 11,
      mutation: { op: 'update', id: 'script-a', patch: { comment: 'Edited' }, deleteKeys: [] },
      expectedScripts,
      optimisticProjectionEpoch: 7,
    })

    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/commands/settings/advanced/global-scripts',
        method: 'PATCH',
        authHeader: 'test-auth-token',
        contentType: 'application/json',
        body: {
          baseRevision: 11,
          mutation: { op: 'update', id: 'script-a', patch: { comment: 'Edited' }, deleteKeys: [] },
        },
      },
    ])
    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'advanced',
        attemptedPatch: { globalscript: expectedScripts },
        settings: { globalscript: expectedScripts },
        settingsProjectionEpoch: 7,
      },
    ])
  })

  it('sends compact definition mutations while keeping final arrays client-only', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let revision = 30
    const commandFetch = makeCommandFetch((url) => {
      revision += 1
      const scripts = url.endsWith('/scripts')
      const module = url.includes('/modules/')
      return {
        revision,
        event: {
          type: scripts ? 'scriptDefinitions.replaced' : 'triggerDefinitions.replaced',
          revision,
          resource: module ? (scripts ? 'moduleScriptDefinition' : 'moduleTriggerDefinition') : 'characterRow',
          id: module ? 'mod-a' : 'char-a',
        },
        ...(module ? { moduleId: 'mod-a' } : { characterId: 'char-a' }),
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const largeClientOnlyBody = 'x'.repeat(64 * 1024)
    await mutateCharacterScriptsCommand(
      {
        baseRevision: 1,
        characterId: 'char-a',
        mutation: { op: 'update', id: 'script-a', patch: { comment: 'small' }, deleteKeys: [] },
        expectedScripts: [{ id: 'script-a', body: largeClientOnlyBody }],
        optimisticRowEpoch: 4,
      },
      undefined,
      true,
      true,
    )
    await mutateCharacterTriggersCommand(
      {
        baseRevision: 2,
        characterId: 'char-a',
        mutation: { op: 'delete', id: 'trigger-a' },
        expectedTriggers: [{ id: 'trigger-b', body: largeClientOnlyBody }],
        optimisticRowEpoch: 4,
      },
      undefined,
      false,
      true,
    )
    await mutateModuleScriptsCommand(
      {
        baseRevision: 3,
        moduleId: 'mod-a',
        mutation: { op: 'create', row: { id: 'script-b', comment: 'small' }, index: 1 },
        expectedScripts: [
          { id: 'script-a', body: largeClientOnlyBody },
          { id: 'script-b', comment: 'small' },
        ],
        optimisticCollectionEpoch: 7,
      },
      undefined,
      false,
      true,
    )
    await mutateModuleTriggersCommand(
      {
        baseRevision: 4,
        moduleId: 'mod-a',
        mutation: { op: 'reorder', ids: ['trigger-b', 'trigger-a'] },
        expectedTriggers: [{ id: 'trigger-b', body: largeClientOnlyBody }, { id: 'trigger-a' }],
        optimisticCollectionEpoch: 7,
      },
      undefined,
      false,
      true,
    )

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/characters/char-a/scripts',
        method: 'PATCH',
        body: {
          baseRevision: 1,
          mutation: { op: 'update', id: 'script-a', patch: { comment: 'small' }, deleteKeys: [] },
        },
      },
      {
        url: '/api/v1/commands/characters/char-a/triggers',
        method: 'PATCH',
        body: { baseRevision: 2, mutation: { op: 'delete', id: 'trigger-a' } },
      },
      {
        url: '/api/v1/commands/modules/mod-a/scripts',
        method: 'PATCH',
        body: {
          baseRevision: 3,
          mutation: { op: 'create', row: { id: 'script-b', comment: 'small' }, index: 1 },
        },
      },
      {
        url: '/api/v1/commands/modules/mod-a/triggers',
        method: 'PATCH',
        body: { baseRevision: 4, mutation: { op: 'reorder', ids: ['trigger-b', 'trigger-a'] } },
      },
    ])
    expect(vi.mocked(commandFetch.fetch).mock.calls[0]?.[1]).toMatchObject({ keepalive: true })
    expect(JSON.stringify(commandFetch.calls)).not.toContain(largeClientOnlyBody)
    expect(observedEffects).toEqual([
      {
        kind: 'characterDefinitionMutation',
        operation: 'scripts',
        characterId: 'char-a',
        optimisticRowEpoch: 4,
        definitions: [{ id: 'script-a', body: largeClientOnlyBody }],
      },
      {
        kind: 'characterDefinitionMutation',
        operation: 'triggers',
        characterId: 'char-a',
        optimisticRowEpoch: 4,
        definitions: [{ id: 'trigger-b', body: largeClientOnlyBody }],
      },
      {
        kind: 'moduleCollectionMutation',
        operation: 'scripts',
        moduleId: 'mod-a',
        collectionProjectionEpoch: 7,
      },
      {
        kind: 'moduleCollectionMutation',
        operation: 'triggers',
        moduleId: 'mod-a',
        collectionProjectionEpoch: 7,
      },
    ])
  })

  it('keeps mismatched definition response revisions authoritative', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 12,
      event: {
        type: 'scriptDefinitions.replaced',
        revision: 11,
        resource: 'characterRow',
        id: 'char-a',
      },
      characterId: 'char-a',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await mutateCharacterScriptsCommand(
      {
        baseRevision: 1,
        characterId: 'char-a',
        mutation: { op: 'delete', id: 'script-a' },
        expectedScripts: [],
        optimisticRowEpoch: 4,
      },
      undefined,
      false,
      true,
    )

    expect(observedEffects).toEqual([])
  })

  it('emits opt-in character definition effects only for canonical matching commands', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let revision = 20
    const commandFetch = makeCommandFetch((url) => {
      const scripts = url.endsWith('/scripts')
      revision += 1
      return {
        revision,
        event: {
          type: scripts ? 'scriptDefinitions.replaced' : 'triggerDefinitions.replaced',
          revision,
          resource: 'characterRow',
          id: 'char-a',
        },
        characterId: 'char-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await replaceCharacterScriptsCommand(
      {
        baseRevision: 1,
        characterId: 'char-a',
        scripts: [{ id: 'script-a' }],
        optimisticRowEpoch: 4,
      },
      undefined,
      false,
      true,
    )
    await replaceCharacterTriggersCommand(
      {
        baseRevision: 2,
        characterId: 'char-a',
        triggers: [{ id: 'trigger-a' }],
        optimisticRowEpoch: 4,
      },
      undefined,
      false,
      true,
    )
    await replaceCharacterScriptsCommand(
      {
        baseRevision: 3,
        characterId: 'char-a',
        scripts: [{ id: 'duplicate' }, { id: 'duplicate' }],
        optimisticRowEpoch: 4,
      },
      undefined,
      false,
      true,
    )

    expect(observedEffects).toEqual([
      {
        kind: 'characterDefinitionMutation',
        operation: 'scripts',
        characterId: 'char-a',
        optimisticRowEpoch: 4,
        definitions: [{ id: 'script-a' }],
      },
      {
        kind: 'characterDefinitionMutation',
        operation: 'triggers',
        characterId: 'char-a',
        optimisticRowEpoch: 4,
        definitions: [{ id: 'trigger-a' }],
      },
    ])
  })

  it('dispatches module record and enablement commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (
        url.includes('/modules') ||
        url.includes('/module-folders') ||
        url.includes('/characters/char-a/modules/reorder')
      ) {
        return {
          revision: 9,
          event: {
            type: 'module.updated',
            revision: 9,
            resource: 'module',
          },
          moduleId: 'mod-a',
          characterId: 'char-a',
          enabled: true,
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createModuleCommand({
      baseRevision: 1,
      module: { id: 'mod-a', name: 'A', description: 'Module' },
    })
    await updateModuleCommand({
      baseRevision: 2,
      moduleId: 'mod-a',
      patch: { name: 'Renamed', assets: [['asset.png', 'b'.repeat(64), 'png']] },
    })
    await deleteModuleCommand({ baseRevision: 3, moduleId: 'mod-a' })
    await enableModuleCommand({ baseRevision: 4, moduleId: 'mod-a', enabled: true })
    await reorderModulesCommand({
      baseRevision: 5,
      moduleIds: ['mod-b', 'mod-a'],
      folderByModuleId: { 'mod-a': null, 'mod-b': 'folder-a' },
    })
    await reorderCharacterModulesCommand({
      baseRevision: 6,
      characterId: 'char-a',
      moduleIds: ['mod-a'],
    })
    await createModuleFolderCommand({ baseRevision: 7, folder: { id: 'folder-a', name: 'Folder A' } })
    await updateModuleFolderCommand({ baseRevision: 8, folderId: 'folder-a', patch: { name: 'Renamed' } })
    await reorderModuleFoldersCommand({ baseRevision: 9, folderIds: ['folder-b', 'folder-a'] })
    await deleteModuleFolderCommand({ baseRevision: 10, folderId: 'folder-a' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/modules',
        method: 'POST',
        body: {
          baseRevision: 1,
          module: { id: 'mod-a', name: 'A', description: 'Module' },
        },
      },
      {
        url: '/api/v1/commands/modules/mod-a',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          patch: { name: 'Renamed', assets: [['asset.png', 'b'.repeat(64), 'png']] },
        },
      },
      {
        url: '/api/v1/commands/modules/mod-a',
        method: 'DELETE',
        body: { baseRevision: 3 },
      },
      {
        url: '/api/v1/commands/modules/enable',
        method: 'POST',
        body: { baseRevision: 4, moduleId: 'mod-a', enabled: true },
      },
      {
        url: '/api/v1/commands/modules/reorder',
        method: 'POST',
        body: {
          baseRevision: 5,
          moduleIds: ['mod-b', 'mod-a'],
          folderByModuleId: { 'mod-a': null, 'mod-b': 'folder-a' },
        },
      },
      {
        url: '/api/v1/commands/characters/char-a/modules/reorder',
        method: 'POST',
        body: { baseRevision: 6, moduleIds: ['mod-a'] },
      },
      {
        url: '/api/v1/commands/module-folders',
        method: 'POST',
        body: { baseRevision: 7, folder: { id: 'folder-a', name: 'Folder A' } },
      },
      {
        url: '/api/v1/commands/module-folders/folder-a',
        method: 'PATCH',
        body: { baseRevision: 8, patch: { name: 'Renamed' } },
      },
      {
        url: '/api/v1/commands/module-folders/reorder',
        method: 'POST',
        body: { baseRevision: 9, folderIds: ['folder-b', 'folder-a'] },
      },
      {
        url: '/api/v1/commands/module-folders/folder-a',
        method: 'DELETE',
        body: { baseRevision: 10 },
      },
    ])
  })

  it('exposes only matching optimistic module mutations as compact local effects', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/characters/char-a/modules/reorder')) {
        return {
          revision: 10,
          event: {
            type: 'character.modules.reordered',
            revision: 10,
            resource: 'characterRow',
            id: 'char-a',
          },
          characterId: 'char-a',
        }
      }
      if (url.endsWith('/modules/reorder')) {
        return {
          revision: 10,
          event: { type: 'module.reordered', revision: 10, resource: 'moduleReordered' },
        }
      }
      if (url.endsWith('/modules/enable')) {
        return {
          revision: 10,
          event: { type: 'module.enabled', revision: 10, resource: 'moduleEnabled', id: 'mod-a' },
          moduleId: 'mod-a',
          enabled: true,
        }
      }
      if (url.endsWith('/modules/mod-a/lorebooks')) {
        return {
          revision: 10,
          event: { type: 'lorebook.entries.replaced', revision: 10, resource: 'moduleUpdated', id: 'mod-a' },
          moduleId: 'mod-a',
        }
      }
      if (url.endsWith('/modules/mod-a/scripts')) {
        return {
          revision: 10,
          event: {
            type: 'scriptDefinitions.replaced',
            revision: 10,
            resource: 'moduleScriptDefinition',
            id: 'mod-a',
          },
          moduleId: 'mod-a',
        }
      }
      if (url.endsWith('/modules/mod-a/triggers')) {
        return {
          revision: 10,
          event: {
            type: 'triggerDefinitions.replaced',
            revision: 10,
            resource: 'moduleTriggerDefinition',
            id: 'mod-a',
          },
          moduleId: 'mod-a',
        }
      }
      const created = url.endsWith('/modules')
      return {
        revision: 10,
        event: {
          type: created ? 'module.created' : 'module.updated',
          revision: 10,
          resource: created ? 'moduleCreated' : 'moduleUpdated',
          id: 'mod-a',
        },
        moduleId: 'mod-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const entry = {
      id: 'entry-a',
      key: 'key',
      secondkey: '',
      insertorder: 100,
      comment: 'Lore',
      content: 'body',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    await createModuleCommand({ baseRevision: 1, module: { id: 'mod-a', name: 'A', description: '' } }, undefined, true)
    await updateModuleCommand({ baseRevision: 2, moduleId: 'mod-a', patch: { name: 'Renamed' } }, undefined, true)
    await enableModuleCommand({ baseRevision: 3, moduleId: 'mod-a', enabled: true }, undefined, true)
    await reorderModulesCommand({ baseRevision: 4, moduleIds: ['mod-b', 'mod-a'] }, undefined, true)
    await replaceModuleLorebooksCommand(
      { baseRevision: 5, moduleId: 'mod-a', entries: [entry] },
      undefined,
      false,
      true,
    )
    await replaceModuleScriptsCommand(
      {
        baseRevision: 6,
        moduleId: 'mod-a',
        scripts: [{ id: 'script-a' }],
        optimisticCollectionEpoch: 4,
      },
      undefined,
      false,
      true,
    )
    await replaceModuleTriggersCommand(
      {
        baseRevision: 7,
        moduleId: 'mod-a',
        triggers: [{ id: 'trigger-a' }],
        optimisticCollectionEpoch: 4,
      },
      undefined,
      false,
      true,
    )
    await reorderCharacterModulesCommand(
      { baseRevision: 8, characterId: 'char-a', moduleIds: ['mod-a'] },
      undefined,
      true,
    )

    expect(observedEffects).toEqual([
      { kind: 'moduleCollectionMutation', operation: 'create', moduleId: 'mod-a' },
      { kind: 'moduleCollectionMutation', operation: 'update', moduleId: 'mod-a' },
      { kind: 'moduleEnabled', moduleId: 'mod-a', enabled: true },
      { kind: 'moduleCollectionMutation', operation: 'reorder', moduleIds: ['mod-b', 'mod-a'] },
      { kind: 'moduleCollectionMutation', operation: 'lorebooks', moduleId: 'mod-a' },
      {
        kind: 'moduleCollectionMutation',
        operation: 'scripts',
        moduleId: 'mod-a',
        collectionProjectionEpoch: 4,
      },
      {
        kind: 'moduleCollectionMutation',
        operation: 'triggers',
        moduleId: 'mod-a',
        collectionProjectionEpoch: 4,
      },
      { kind: 'characterPatch', characterId: 'char-a', patch: { modules: ['mod-a'] } },
    ])
  })

  it('keeps module definition acknowledgements authoritative without a valid collection epoch', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      const scripts = url.endsWith('/scripts')
      return {
        revision: 10,
        event: {
          type: scripts ? 'scriptDefinitions.replaced' : 'triggerDefinitions.replaced',
          revision: 10,
          resource: scripts ? 'moduleScriptDefinition' : 'moduleTriggerDefinition',
          id: 'mod-a',
        },
        moduleId: 'mod-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await replaceModuleScriptsCommand(
      { baseRevision: 1, moduleId: 'mod-a', scripts: [{ id: 'script-a' }] },
      undefined,
      false,
      true,
    )
    await replaceModuleTriggersCommand(
      {
        baseRevision: 2,
        moduleId: 'mod-a',
        triggers: [{ id: 'trigger-a' }],
        optimisticCollectionEpoch: -1,
      },
      undefined,
      false,
      true,
    )
    await replaceModuleScriptsCommand(
      {
        baseRevision: 3,
        moduleId: 'mod-a',
        scripts: [{ id: 'script-b' }],
        optimisticCollectionEpoch: 1.5,
      },
      undefined,
      false,
      true,
    )

    expect(observedEffects).toEqual([])
  })

  it('keeps module deletion, non-optimistic calls, and mismatched responses authoritative', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url, init) => {
      if (url.endsWith('/characters/char-a/modules/reorder')) {
        return {
          revision: 10,
          event: {
            type: 'character.modules.reordered',
            revision: 10,
            resource: 'characterRow',
            id: 'char-a',
            parentId: 'chat-a',
          },
          characterId: 'char-a',
        }
      }
      return {
        revision: 10,
        event: {
          type: init.method === 'DELETE' ? 'module.deleted' : 'module.updated',
          revision: 10,
          resource: init.method === 'DELETE' ? 'module' : 'moduleUpdated',
          id: 'mod-a',
        },
        moduleId: url.endsWith('/mod-mismatch') ? 'different-module' : 'mod-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await deleteModuleCommand({ baseRevision: 1, moduleId: 'mod-a' })
    await updateModuleCommand({ baseRevision: 2, moduleId: 'mod-a', patch: { name: 'Not projected' } })
    await updateModuleCommand(
      { baseRevision: 3, moduleId: 'mod-mismatch', patch: { name: 'Projected' } },
      undefined,
      true,
    )
    await reorderCharacterModulesCommand(
      { baseRevision: 4, characterId: 'char-a', moduleIds: ['mod-a'] },
      undefined,
      true,
    )

    expect(observedEffects).toEqual([])
  })

  it('dispatches plugin record and configuration commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.includes('/plugins')) {
        return {
          revision: 10,
          event: {
            type: 'plugin.updated',
            revision: 10,
            resource: 'plugin',
          },
          pluginId: 'plugin-a',
          provider: 'provider-a',
          enabled: true,
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createPluginCommand({
      baseRevision: 1,
      plugin: {
        name: 'plugin-a',
        script: 'Risuai.log("hello")',
        arguments: { token: 'string' },
        realArg: { token: '' },
        customLink: [],
        argMeta: {},
        version: '3.0',
        enabled: true,
      },
    })
    await updatePluginCommand({
      baseRevision: 2,
      pluginId: 'plugin-a',
      patch: { realArg: { token: 'abc' } },
    })
    await deletePluginCommand({ baseRevision: 3, pluginId: 'plugin-a' })
    await enablePluginCommand({ baseRevision: 4, pluginId: 'plugin-a', enabled: true })
    await selectPluginProviderCommand({ baseRevision: 5, provider: 'provider-a' })
    await reorderPluginsCommand({ baseRevision: 6, pluginIds: ['plugin-b', 'plugin-a'] })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/plugins',
        method: 'POST',
        body: {
          baseRevision: 1,
          plugin: {
            name: 'plugin-a',
            script: 'Risuai.log("hello")',
            arguments: { token: 'string' },
            realArg: { token: '' },
            customLink: [],
            argMeta: {},
            version: '3.0',
            enabled: true,
          },
        },
      },
      {
        url: '/api/v1/commands/plugins/plugin-a',
        method: 'PATCH',
        body: { baseRevision: 2, patch: { realArg: { token: 'abc' } } },
      },
      {
        url: '/api/v1/commands/plugins/plugin-a',
        method: 'DELETE',
        body: { baseRevision: 3 },
      },
      {
        url: '/api/v1/commands/plugins/plugin-a/enable',
        method: 'POST',
        body: { baseRevision: 4, enabled: true },
      },
      {
        url: '/api/v1/commands/plugins/provider',
        method: 'POST',
        body: { baseRevision: 5, provider: 'provider-a' },
      },
      {
        url: '/api/v1/commands/plugins/reorder',
        method: 'POST',
        body: { baseRevision: 6, pluginIds: ['plugin-b', 'plugin-a'] },
      },
    ])
  })

  it('exposes matching plugin mutations as compact response-confirmed local effects', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url, init) => {
      const method = init.method ?? 'GET'
      if (url.endsWith('/plugins/provider')) {
        return {
          revision: 10,
          event: {
            type: 'plugin.provider.selected',
            revision: 10,
            resource: 'pluginProvider',
            id: 'provider-a',
          },
          provider: 'provider-a',
        }
      }
      if (url.endsWith('/plugins/reorder')) {
        return {
          revision: 10,
          event: { type: 'plugin.reordered', revision: 10, resource: 'pluginCollection' },
        }
      }

      const operation =
        method === 'DELETE' ? 'delete' : url.endsWith('/enable') ? 'enable' : method === 'POST' ? 'create' : 'update'
      return {
        revision: 10,
        event: {
          type: `plugin.${operation === 'enable' ? 'enabled' : `${operation}d`}`,
          revision: 10,
          resource: 'pluginCollection',
          id: 'plugin-a',
        },
        pluginId: 'plugin-a',
        ...(operation === 'enable' ? { enabled: true } : {}),
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createPluginCommand({ baseRevision: 1, plugin: { name: 'plugin-a' } })
    await updatePluginCommand({ baseRevision: 2, pluginId: 'plugin-a', patch: { displayName: 'A' } })
    await deletePluginCommand({ baseRevision: 3, pluginId: 'plugin-a' })
    await enablePluginCommand({ baseRevision: 4, pluginId: 'plugin-a', enabled: true })
    await selectPluginProviderCommand({ baseRevision: 5, provider: 'provider-a' })
    await reorderPluginsCommand({ baseRevision: 6, pluginIds: ['plugin-b', 'plugin-a'] })

    expect(observedEffects).toEqual([
      { kind: 'pluginCollectionMutation', operation: 'create', pluginId: 'plugin-a' },
      { kind: 'pluginCollectionMutation', operation: 'update', pluginId: 'plugin-a' },
      { kind: 'pluginCollectionMutation', operation: 'delete', pluginId: 'plugin-a' },
      { kind: 'pluginCollectionMutation', operation: 'enable', pluginId: 'plugin-a' },
      { kind: 'pluginProvider', provider: 'provider-a' },
      {
        kind: 'pluginCollectionMutation',
        operation: 'reorder',
        pluginIds: ['plugin-b', 'plugin-a'],
      },
    ])
  })

  it('keeps cross-resource plugin deletion on authoritative reconciliation', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 10,
      event: {
        type: 'plugin.deleted',
        revision: 10,
        resource: 'pluginCollectionWithProvider',
        id: 'plugin-a',
      },
      pluginId: 'plugin-a',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await deletePluginCommand({ baseRevision: 9, pluginId: 'plugin-a' })

    expect(observedEffects).toEqual([])
  })

  it('dispatches plugin-storage commands through typed helpers', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url, init) => {
      if (url.includes('/plugin-storage')) {
        const operation = url.endsWith('/bulk') ? 'bulk' : init.method === 'DELETE' ? 'delete' : 'put'
        return {
          revision: 10,
          event: {
            type:
              operation === 'put'
                ? 'pluginStorage.updated'
                : operation === 'delete'
                  ? 'pluginStorage.deleted'
                  : 'pluginStorage.bulkUpdated',
            revision: 10,
            resource: 'pluginStorage',
            ...(operation === 'bulk' ? {} : { id: 'theme' }),
          },
          ...(operation === 'bulk' ? {} : { key: 'theme' }),
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await putPluginStorageCommand({ baseRevision: 1, key: 'theme', value: { mode: 'dark' } })
    await deletePluginStorageCommand({ baseRevision: 2, key: 'theme' })
    await bulkPluginStorageCommand({
      baseRevision: 3,
      values: { score: 42 },
      deleteKeys: ['old'],
      clear: false,
    })

    expect(observedEffects).toEqual([
      { kind: 'pluginStorage', operation: 'put', key: 'theme' },
      { kind: 'pluginStorage', operation: 'delete', key: 'theme' },
      { kind: 'pluginStorage', operation: 'bulk' },
    ])

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/plugin-storage/theme',
        method: 'PUT',
        body: { baseRevision: 1, value: { mode: 'dark' } },
      },
      {
        url: '/api/v1/commands/plugin-storage/theme',
        method: 'DELETE',
        body: { baseRevision: 2 },
      },
      {
        url: '/api/v1/commands/plugin-storage/bulk',
        method: 'POST',
        body: { baseRevision: 3, values: { score: 42 }, deleteKeys: ['old'], clear: false },
      },
    ])
  })
})

describe('runner rejection rollback', () => {
  it('rolls back a failed command result when no destructive refresh occurred', async () => {
    setCachedServerCommandRevision(12)
    const rollback = vi.fn()

    const result = await runServerCommand({
      command: async () => ({ status: 'error' as const, error: 'forced failure' }),
      rollback,
    })

    expect(result).toEqual({ status: 'error', error: 'forced failure' })
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('skips command-result rollback when the destructive refresh epoch changed after dispatch', async () => {
    setCachedServerCommandRevision(12)
    const rollback = vi.fn()

    const result = await runServerCommand({
      command: async () => {
        createDestructiveRefreshToken('test-full-resync')
        return { status: 'error' as const, error: 'forced failure' }
      },
      rollback,
    })

    expect(result).toEqual({ status: 'error', error: 'forced failure' })
    expect(rollback).not.toHaveBeenCalled()
  })

  it('captures a fresh epoch for commands dispatched after a destructive refresh', async () => {
    setCachedServerCommandRevision(12)
    createDestructiveRefreshToken('test-refresh-before-dispatch')
    const rollback = vi.fn()

    const result = await runServerCommand({
      command: async () => ({ status: 'error' as const, error: 'forced failure' }),
      rollback,
    })

    expect(result).toEqual({ status: 'error', error: 'forced failure' })
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('a rejected command factory rolls back once and resolves to an error result', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 7 }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rollback = vi.fn()

    // Pre-fix the rejection escaped `void runServerCommand(...)` as an
    // unhandled rejection and the rollback never ran.
    const result = await runServerCommand({
      command: async () => {
        throw new Error('factory exploded')
      },
      rollback,
    })

    expect(result).toEqual({
      status: 'error',
      error: 'Command factory rejected: factory exploded',
    })
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('a synchronous factory throw is also surfaced and rolled back', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 7 }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rollback = vi.fn()

    const result = await runServerCommand({
      command: () => {
        throw new TypeError('bad command input')
      },
      rollback,
    })

    expect(result.status).toBe('error')
    expect(rollback).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })
})
