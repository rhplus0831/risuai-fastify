import { beforeEach, describe, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({
  begin: vi.fn<() => Promise<'accepted' | 'ambiguous'>>(async () => 'accepted'),
  finalize: vi.fn<() => Promise<'accepted' | 'ambiguous'>>(async () => 'accepted'),
  abandon: vi.fn<() => Promise<'accepted' | 'ambiguous'>>(async () => 'accepted'),
}))

vi.mock('./generationEffectLedger', () => ({
  beginPreparedGenerationInlay: ledger.begin,
  finalizePreparedGenerationInlay: ledger.finalize,
  abandonPreparedGenerationInlay: ledger.abandon,
}))

import {
  abandonServerBackedInlayMessage,
  finalizeServerBackedInlayMessage,
  prepareServerBackedInlayMessage,
} from './inlayFinalization'

const effectLedger = {
  version: 1 as const,
  databaseLineage: 'lineage-a',
  keyType: 'operation' as const,
  keyId: 'operation-a',
  generationId: 'generation-a',
  characterId: 'character-a',
  chatId: 'chat-a',
  messageId: 'message-a',
}
const chatOccupancyAuthority = {
  version: 1 as const,
  databaseLineage: 'lineage-a',
  chatId: 'chat-a',
  sessionId: 'session-a',
  sessionGeneration: 3,
  occupancyEpoch: 7,
  claimClass: 'owner' as const,
}
const preparation = {
  effectLedger,
  chatOccupancyAuthority,
  operationId: 'operation-a',
  preparationId: 'preparation-a',
  expectedData: '<ImgGen="cat">',
}

beforeEach(() => {
  ledger.begin.mockReset().mockResolvedValue('accepted')
  ledger.finalize.mockReset().mockResolvedValue('accepted')
  ledger.abandon.mockReset().mockResolvedValue('accepted')
})

describe('server-backed accepted-operation inlay transport', () => {
  it('begins through the lineage-bearing effect transport before provider work', async () => {
    await expect(prepareServerBackedInlayMessage(preparation)).resolves.toBe(true)
    expect(ledger.begin).toHaveBeenCalledWith(effectLedger, chatOccupancyAuthority, {
      operationId: 'operation-a',
      preparationId: 'preparation-a',
      expectedData: '<ImgGen="cat">',
    })
  })

  it('finalizes through the same exact preparation and accepted operation', async () => {
    await expect(finalizeServerBackedInlayMessage({ ...preparation, finalData: '{{inlay::asset-a}}' })).resolves.toBe(
      true,
    )
    expect(ledger.finalize).toHaveBeenCalledWith(effectLedger, chatOccupancyAuthority, {
      operationId: 'operation-a',
      preparationId: 'preparation-a',
      expectedData: '<ImgGen="cat">',
      finalData: '{{inlay::asset-a}}',
    })
  })

  it('abandons only the exact preparation and reports ambiguous transport as unaccepted', async () => {
    ledger.abandon.mockResolvedValueOnce('ambiguous')
    await expect(abandonServerBackedInlayMessage(preparation)).resolves.toBe(false)
    expect(ledger.abandon).toHaveBeenCalledWith(effectLedger, chatOccupancyAuthority, {
      operationId: 'operation-a',
      preparationId: 'preparation-a',
    })
  })
})
