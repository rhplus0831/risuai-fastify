import { jsonResponse, makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  createBardWikiDocumentCommand,
  deleteBardWikiDocumentCommand,
  patchBardWikiChatSettingsCommand,
  previewBardWikiRebuildCommand,
  queueBardWikiRebuildCommand,
  importBardWikiVaultCommand,
  peekCachedServerCommandRevision,
  updateBardWikiDocumentCommand,
  setCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
} from './commands'

describe('BardWiki command adapters', () => {
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
})
