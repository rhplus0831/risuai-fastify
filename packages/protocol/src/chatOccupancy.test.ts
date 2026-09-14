import { describe, expect, it } from 'vitest'
import {
  CHAT_OCCUPANCY_LEASE_MS,
  CHAT_OCCUPANCY_PROTOCOL_VERSION,
  CHAT_OCCUPANCY_RENEW_AFTER_MS,
  isChatOccupancyEvent,
  isChatOccupancyClaimRequest,
  isChatOccupancyNormalizeRequest,
  isChatOccupancySnapshot,
  isChatOccupancySwitchRequest,
  isChatOccupancyVersionRequest,
} from './chatOccupancy.js'

describe('chat occupancy protocol', () => {
  it('accepts exact v1 requests and rejects version or shape drift', () => {
    expect(isChatOccupancyClaimRequest({ version: 1, claimClass: 'chat_only' })).toBe(true)
    expect(isChatOccupancyVersionRequest({ version: 1 })).toBe(true)
    expect(isChatOccupancySwitchRequest({ version: 1, sourceChatId: 'chat-a', targetChatId: 'chat-b' })).toBe(true)
    expect(isChatOccupancyNormalizeRequest({ version: 1, selectedChatId: 'chat-a' })).toBe(true)

    expect(isChatOccupancyClaimRequest({ version: 2, claimClass: 'chat_only' })).toBe(false)
    expect(isChatOccupancyClaimRequest({ version: 1, claimClass: 'owner', extra: true })).toBe(false)
    expect(isChatOccupancySwitchRequest({ version: 1, targetChatId: 'chat-b' })).toBe(false)
  })

  it('validates an exact-key, lineage-coherent snapshot projection', () => {
    const occupied = {
      databaseLineage: 'lineage-a',
      chatId: 'chat-a',
      occupantSessionId: 'session-a',
      occupancyEpoch: 1,
      claimClass: 'chat_only' as const,
      state: 'occupied' as const,
      claimedAtMs: 1_000,
      leaseExpiresAtMs: 1_000 + CHAT_OCCUPANCY_LEASE_MS,
      updatedAtMs: 1_000,
      releasedAtMs: null,
    }
    const snapshot = {
      version: CHAT_OCCUPANCY_PROTOCOL_VERSION,
      databaseLineage: 'lineage-a',
      occupancies: [occupied],
    }

    expect(isChatOccupancySnapshot(snapshot)).toBe(true)
    expect(isChatOccupancySnapshot({ ...snapshot, occupancies: [{ ...occupied, databaseLineage: 'lineage-b' }] })).toBe(
      false,
    )
    expect(isChatOccupancySnapshot({ ...snapshot, occupancies: [occupied, occupied] })).toBe(false)
    expect(isChatOccupancySnapshot({ version: CHAT_OCCUPANCY_PROTOCOL_VERSION, occupancies: [] })).toBe(false)
    expect(isChatOccupancySnapshot({ ...snapshot, occupancies: [{ ...occupied, occupantSessionId: null }] })).toBe(
      false,
    )
    expect(
      isChatOccupancySnapshot({ ...snapshot, occupancies: [{ ...occupied, state: 'released', releasedAtMs: 2_000 }] }),
    ).toBe(false)
    expect(
      isChatOccupancySnapshot({
        ...snapshot,
        occupancies: [
          {
            ...occupied,
            occupantSessionId: null,
            claimClass: null,
            claimedAtMs: null,
            leaseExpiresAtMs: null,
            state: 'released',
            releasedAtMs: 2_000,
          },
        ],
      }),
    ).toBe(true)
    expect(isChatOccupancySnapshot({ ...snapshot, occupancies: [{ ...occupied, state: 'expired' }] })).toBe(true)
    expect(CHAT_OCCUPANCY_RENEW_AFTER_MS).toBeLessThan(CHAT_OCCUPANCY_LEASE_MS)
  })

  it('validates closed revision-free occupancy event snapshots', () => {
    const event = {
      type: 'occupancy.snapshot',
      version: CHAT_OCCUPANCY_PROTOCOL_VERSION,
      databaseLineage: 'lineage-a',
      occupancies: [],
    }

    expect(isChatOccupancyEvent(event)).toBe(true)
    expect(isChatOccupancyEvent({ ...event, revision: 7 })).toBe(false)
    expect(isChatOccupancyEvent({ ...event, id: '7' })).toBe(false)
    expect(isChatOccupancyEvent({ ...event, databaseLineage: '' })).toBe(false)
    const occupied = {
      databaseLineage: 'lineage-a',
      chatId: 'chat-a',
      occupantSessionId: 'session-a',
      occupancyEpoch: 1,
      claimClass: 'chat_only',
      state: 'occupied',
      claimedAtMs: 1_000,
      leaseExpiresAtMs: 91_000,
      updatedAtMs: 1_000,
      releasedAtMs: null,
    }
    expect(isChatOccupancyEvent({ ...event, occupancies: [occupied] })).toBe(true)
    expect(isChatOccupancyEvent({ ...event, occupancies: [{ ...occupied, releasedAtMs: 1_500 }] })).toBe(false)
    expect(isChatOccupancyEvent({ ...event, occupancies: [{ ...occupied, databaseLineage: 'lineage-b' }] })).toBe(false)
    expect(isChatOccupancyEvent({ ...event, occupancies: [occupied, occupied] })).toBe(false)
  })
})
