import { settingsIntent } from './pendingMutationOutbox.testSupport'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { measureJsonWork, reportBrowserWork } from '../__tests__/browserWorkProbe'
import {
  clearPendingMutationOutbox,
  discardPendingMutation,
  replaceStagedPendingMutationIntent,
  listPendingMutations,
  MAX_DURABLE_MUTATION_PAYLOAD_BYTES,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
  stagePendingMutation,
  type DurableMutationIntent,
} from './pendingMutationOutbox'
import { resetPersistenceActivityForTests } from './persistenceActivity.svelte'

const fixtures = [
  { name: 'small', requests: 1, textBytesPerRequest: 128 },
  { name: 'intermediate-multi-request', requests: 8, textBytesPerRequest: 8_192 },
  { name: 'large-near-limit', requests: 1, textBytesPerRequest: MAX_DURABLE_MUTATION_PAYLOAD_BYTES - 1_024 },
]

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetPendingMutationOutboxForTests()
  resetPersistenceActivityForTests()
  await preparePendingMutationOutbox({
    writerSessionId: 'browser-work-writer',
    writerEpoch: 1,
    databaseLineage: 'browser-work-lineage',
    requestedWriterWasActive: true,
  })
})

afterEach(async () => {
  await clearPendingMutationOutbox()
  resetPendingMutationOutboxForTests()
  resetPersistenceActivityForTests()
  vi.unstubAllGlobals()
})

describe('F05 durable staging work probe', () => {
  for (const fixture of fixtures) {
    for (const immutable of [false, true]) {
      it(`captures ${fixture.name} ${immutable ? 'immutable' : 'mutable'} intent before caller edits`, async () => {
        const text = 'x'.repeat(fixture.textBytesPerRequest)
        const intent: DurableMutationIntent = {
          version: 1,
          requests: Array.from({ length: fixture.requests }, () => ({
            method: 'PATCH',
            path: '/settings/runtime',
            body: { patch: { username: text } },
          })),
        }
        if (immutable) {
          for (const request of intent.requests) {
            Object.freeze(request.body.patch)
            Object.freeze(request.body)
          }
        }
        const expectedPayloadBytes = new TextEncoder().encode(JSON.stringify({ intent })).byteLength
        expect(expectedPayloadBytes).toBeLessThan(MAX_DURABLE_MUTATION_PAYLOAD_BYTES)
        const measured = await measureJsonWork(
          async () => {
            const handle = stagePendingMutation(`browser-work:${fixture.name}`, intent)
            if (!immutable) {
              for (const request of intent.requests) {
                ;(request.body.patch as { username: string }).username = 'caller changed this after staging'
              }
            }
            return handle.ready
          },
          (stack) => {
            if (stack.includes('normalizeRequest')) return 'normalizationClones'
            if (stack.includes('serializePendingMutationIntent')) return 'encryptedEnvelopeSerialization'
            return undefined
          },
        )
        expect(measured.result).toBe('persisted')
        expect(measured.counters.normalizationClones?.count ?? 0).toBe(immutable ? 0 : fixture.requests)
        expect(measured.counters.normalizationClones?.bytes ?? 0).toBe(
          immutable
            ? 0
            : fixture.requests * new TextEncoder().encode(JSON.stringify({ patch: { username: text } })).byteLength,
        )
        expect(measured.counters.encryptedEnvelopeSerialization?.count).toBe(1)
        expect(measured.counters.encryptedEnvelopeSerialization?.bytes).toBe(expectedPayloadBytes)

        const restored = await listPendingMutations()
        expect(restored).toHaveLength(1)
        expect(restored[0]?.intent.requests).toHaveLength(fixture.requests)
        for (const request of restored[0]!.intent.requests) {
          expect(request.body).toEqual({ patch: { username: text } })
        }
        reportBrowserWork('F05', {
          ...fixture,
          immutable,
          expectedPayloadBytes,
          normalizationClones: measured.counters.normalizationClones ?? { count: 0, bytes: 0 },
          encryptedEnvelopeSerialization: measured.counters.encryptedEnvelopeSerialization ?? { count: 0, bytes: 0 },
          transportSerialization: { count: 0, bytes: 0 },
        })
      })
    }
  }
})

describe('pending mutation outbox replacement work', () => {
  it.each(['replaced', 'successor'] as const)(
    'owns one normalized snapshot when a prepared intent is %s',
    async (expectedStatus) => {
      const placeholder = stagePendingMutation('settings:runtime', settingsIntent('placeholder'))
      await placeholder.ready
      if (expectedStatus === 'successor') {
        await expect(discardPendingMutation((await listPendingMutations())[0]!.handle)).resolves.toBe('deleted')
      }
      const input = settingsIntent('exact captured value')
      const measured = await measureJsonWork(
        async () => {
          const replacement = replaceStagedPendingMutationIntent(placeholder, input)
          input.requests[0]!.body.patch = { openAIKey: 'caller changed after capture' }
          return replacement
        },
        (stack) => (stack.includes('normalizeRequest') ? 'normalization' : undefined),
      )
      expect(measured.result.status).toBe(expectedStatus)
      expect(measured.counters.normalization?.count).toBe(1)
      expect((await listPendingMutations()).map((entry) => entry.intent)).toEqual([
        settingsIntent('exact captured value'),
      ])
      if (measured.result.status === 'successor')
        expect(measured.result.handle.mutationId).not.toBe(placeholder.mutationId)
    },
  )
})
