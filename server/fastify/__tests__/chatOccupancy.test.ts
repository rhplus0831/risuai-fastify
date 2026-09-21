import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertChatMutationAllowedInTransaction,
  assertForeignOccupiedChatStatePreservedInTransaction,
  assertChatsUnoccupiedInTransaction,
  captureForeignOccupiedChatStateInTransaction,
  ChatOccupancyError,
  ChatOccupancyService,
  createChatOccupancyTable,
  type ChatOccupancyPin,
} from '../src/chatOccupancy.js'
import { createCommandMutationReceiptTable } from '../src/commandMutationReceipts.js'
import {
  createDatabaseMetadataTable,
  getDatabaseLineage,
  registerDatabaseWriterSession,
  rotateDatabaseLineage,
} from '../src/databaseLineage.js'
import { createCharacterTables } from '../src/repository.js'

let db: DatabaseSync
let now: number
let pins: Map<string, ChatOccupancyPin[]>
let service: ChatOccupancyService

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, revision INTEGER NOT NULL)')
  db.prepare('INSERT INTO schema_version (id, version, revision) VALUES (1, 40, 7)').run()
  createDatabaseMetadataTable(db)
  createCommandMutationReceiptTable(db)
  createCharacterTables(db)
  createChatOccupancyTable(db)
  db.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, 0, ?)').run(
    'character-a',
    JSON.stringify({ chaId: 'character-a', name: 'Ada' }),
  )
  for (const [position, chatId] of ['chat-a', 'chat-b', 'chat-c', 'chat-d'].entries()) {
    db.prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, ?, ?)').run(
      chatId,
      'character-a',
      position,
      JSON.stringify({ id: chatId, message: [] }),
    )
  }
  now = 1_000
  pins = new Map()
  service = new ChatOccupancyService(db, { now: () => now, pinQuery: (_db, chatId) => pins.get(chatId) ?? [] })
})

afterEach(() => db.close())

function lineage(): string {
  return getDatabaseLineage(db)
}

function expectCode(run: () => unknown, code: string): ChatOccupancyError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ChatOccupancyError)
    expect((error as ChatOccupancyError).code).toBe(code)
    return error as ChatOccupancyError
  }
  throw new Error(`expected ${code}`)
}

describe('chat occupancy service', () => {
  it('allows the durable owner to occupy multiple chats while admitting one row per chat-only session', () => {
    registerDatabaseWriterSession(db, 'owner-a')
    const ownerA = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'owner-a',
      claimClass: 'owner',
      expectedOccupancyEpoch: 0,
    })
    const ownerB = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-b',
      sessionId: 'owner-a',
      claimClass: 'owner',
      expectedOccupancyEpoch: 0,
    })
    const reader = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-c',
      sessionId: 'reader-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })

    expect([ownerA.claimClass, ownerB.claimClass, reader.claimClass]).toEqual(['owner', 'owner', 'chat_only'])
    expectCode(
      () =>
        service.claim({
          databaseLineage: lineage(),
          chatId: 'chat-d',
          sessionId: 'reader-a',
          claimClass: 'chat_only',
          expectedOccupancyEpoch: 0,
        }),
      'chat_occupancy_switch_required',
    )
    expectCode(
      () =>
        service.claim({
          databaseLineage: lineage(),
          chatId: 'chat-c',
          sessionId: 'owner-a',
          claimClass: 'owner',
          expectedOccupancyEpoch: reader.occupancyEpoch,
        }),
      'chat_occupied',
    )
    expect(db.prepare('SELECT revision FROM schema_version WHERE id = 1').get()).toEqual({ revision: 7 })
  })

  it('requires durable owner identity for owner admission and preserves idempotent epochs', { tags: 'core' }, () => {
    registerDatabaseWriterSession(db, 'owner-a')
    expectCode(
      () =>
        service.claim({
          databaseLineage: lineage(),
          chatId: 'chat-a',
          sessionId: 'reader-a',
          claimClass: 'owner',
          expectedOccupancyEpoch: 0,
        }),
      'active_writer_stale',
    )
    const first = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'owner-a',
      claimClass: 'owner',
      expectedOccupancyEpoch: 0,
    })
    now += 5_000
    expectCode(
      () =>
        service.claim({
          databaseLineage: lineage(),
          chatId: 'chat-a',
          sessionId: 'owner-a',
          claimClass: 'owner',
          expectedOccupancyEpoch: 0,
        }),
      'chat_occupancy_stale',
    )
    const repeated = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'owner-a',
      claimClass: 'owner',
      expectedOccupancyEpoch: first.occupancyEpoch,
    })
    expect(repeated.occupancyEpoch).toBe(first.occupancyEpoch)
    expect(repeated.leaseExpiresAtMs).toBe(now + 90_000)
  })

  it('publishes complete post-commit snapshots without changing command revision', () => {
    const events: Parameters<Parameters<ChatOccupancyService['subscribe']>[0]>[0][] = []
    service.subscribe(() => {
      throw new Error('broken SSE listener')
    })
    const unsubscribe = service.subscribe((event) => events.push(event))

    const claimed = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })
    expect(events).toEqual([
      {
        type: 'occupancy.snapshot',
        version: 1,
        databaseLineage: lineage(),
        occupancies: [claimed],
      },
    ])
    expect(service.snapshot()).toMatchObject({ version: 1, databaseLineage: lineage(), occupancies: [claimed] })
    expect(db.prepare('SELECT revision FROM schema_version WHERE id = 1').get()).toEqual({ revision: 7 })

    expectCode(
      () =>
        service.release({
          databaseLineage: lineage(),
          chatId: 'chat-a',
          sessionId: 'reader-a',
          occupancyEpoch: claimed.occupancyEpoch + 1,
        }),
      'chat_occupancy_stale',
    )
    expect(events).toHaveLength(1)

    unsubscribe()
    service.renew({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-a',
      occupancyEpoch: claimed.occupancyEpoch,
    })
    expect(events).toHaveLength(1)
  })

  it('fences stale epochs across renew, release, and reclaim after expiry', () => {
    const first = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })
    now = first.leaseExpiresAtMs!
    expectCode(
      () =>
        service.renew({
          databaseLineage: lineage(),
          chatId: 'chat-a',
          sessionId: 'reader-a',
          occupancyEpoch: first.occupancyEpoch,
        }),
      'chat_occupancy_stale',
    )

    const second = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-b',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: first.occupancyEpoch,
    })
    expect(second.occupancyEpoch).toBe(first.occupancyEpoch + 1)
    expectCode(
      () =>
        service.release({
          databaseLineage: lineage(),
          chatId: 'chat-a',
          sessionId: 'reader-a',
          occupancyEpoch: first.occupancyEpoch,
        }),
      'chat_occupancy_stale',
    )

    const released = service.release({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-b',
      occupancyEpoch: second.occupancyEpoch,
    })
    expect(released.state).toBe('released')
    expect(released.occupancyEpoch).toBe(second.occupancyEpoch + 1)
  })

  it('fences delayed controls when the same session reacquires after an intervening occupant', () => {
    const first = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })
    now = first.leaseExpiresAtMs!

    const intervening = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-b',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: first.occupancyEpoch,
    })
    const tombstone = service.release({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-b',
      occupancyEpoch: intervening.occupancyEpoch,
    })
    const reacquired = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: tombstone.occupancyEpoch,
    })
    expect(reacquired).toMatchObject({
      occupantSessionId: 'reader-a',
      occupancyEpoch: tombstone.occupancyEpoch + 1,
      state: 'occupied',
    })

    expectCode(
      () =>
        service.renew({
          databaseLineage: lineage(),
          chatId: 'chat-a',
          sessionId: 'reader-a',
          occupancyEpoch: first.occupancyEpoch,
        }),
      'chat_occupancy_stale',
    )
    expectCode(
      () =>
        service.release({
          databaseLineage: lineage(),
          chatId: 'chat-a',
          sessionId: 'reader-a',
          occupancyEpoch: first.occupancyEpoch,
        }),
      'chat_occupancy_stale',
    )
    expectCode(
      () =>
        service.switch({
          databaseLineage: lineage(),
          chatId: 'chat-a',
          sessionId: 'reader-a',
          occupancyEpoch: first.occupancyEpoch,
          targetChatId: 'chat-b',
        }),
      'chat_occupancy_stale',
    )
    expect(service.snapshot().occupancies.find((row) => row.chatId === 'chat-a')).toEqual(reacquired)
    expect(service.snapshot().occupancies.find((row) => row.chatId === 'chat-b')).toBeUndefined()
  })

  it('keeps expired pinned rows fenced for foreign direct, broad, and indirect writes', () => {
    const occupied = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })
    const captured = captureForeignOccupiedChatStateInTransaction(db, 'owner-a', {
      now: () => now,
      pinQuery: (_db, chatId) => pins.get(chatId) ?? [],
    })
    now = occupied.leaseExpiresAtMs!
    pins.set('chat-a', [{ id: 'held-provider', kind: 'memory_job' }])

    expectCode(
      () =>
        assertChatMutationAllowedInTransaction(db, 'chat-a', 'owner-a', {
          now: () => now,
          pinQuery: (_db, chatId) => pins.get(chatId) ?? [],
        }),
      'chat_occupied',
    )
    expectCode(
      () =>
        assertChatsUnoccupiedInTransaction(db, ['chat-a'], {
          now: () => now,
          pinQuery: (_db, chatId) => pins.get(chatId) ?? [],
        }),
      'chat_occupied',
    )

    db.prepare("UPDATE chats SET data_json = json_set(data_json, '$.name', 'forbidden') WHERE id = ?").run('chat-a')
    expectCode(
      () =>
        assertForeignOccupiedChatStatePreservedInTransaction(db, captured, {
          now: () => now,
          pinQuery: (_db, chatId) => pins.get(chatId) ?? [],
        }),
      'chat_occupied',
    )

    pins.clear()
    expect(() =>
      assertChatMutationAllowedInTransaction(db, 'chat-a', 'owner-a', {
        now: () => now,
        pinQuery: (_db, chatId) => pins.get(chatId) ?? [],
      }),
    ).not.toThrow()
  })

  it('blocks expiry reclaim and atomic switch while injected durable pins exist', () => {
    const source = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })
    pins.set('chat-a', [{ id: 'operation-a', kind: 'generation' }])
    expectCode(
      () =>
        service.switch({
          databaseLineage: lineage(),
          chatId: 'chat-a',
          sessionId: 'reader-a',
          occupancyEpoch: source.occupancyEpoch,
          targetChatId: 'chat-b',
        }),
      'chat_occupancy_recovery_blocked',
    )
    expect(service.snapshot().occupancies.find((row) => row.chatId === 'chat-b')).toBeUndefined()

    now = source.leaseExpiresAtMs!
    expectCode(
      () =>
        service.claim({
          databaseLineage: lineage(),
          chatId: 'chat-a',
          sessionId: 'reader-b',
          claimClass: 'chat_only',
          expectedOccupancyEpoch: source.occupancyEpoch,
        }),
      'chat_occupancy_recovery_blocked',
    )
  })

  it('blocks a first claim when legacy durable work pins a chat without an occupancy row', () => {
    pins.set('chat-d', [{ id: 'legacy-memory-job', kind: 'legacy_memory' }])

    const error = expectCode(
      () =>
        service.claim({
          databaseLineage: lineage(),
          chatId: 'chat-d',
          sessionId: 'reader-a',
          claimClass: 'chat_only',
          expectedOccupancyEpoch: 0,
        }),
      'chat_occupancy_recovery_blocked',
    )

    expect(error.details).toMatchObject({
      chatId: 'chat-d',
      blockingChatIds: ['chat-d'],
      blocking: [{ chatId: 'chat-d', id: 'legacy-memory-job', kind: 'legacy_memory' }],
    })
    expect(service.snapshot().occupancies.find((row) => row.chatId === 'chat-d')).toBeUndefined()
  })

  it('reconciles an expired nonselected row before an atomic cross-chat claim', () => {
    const reconciled: string[] = []
    service = new ChatOccupancyService(db, {
      now: () => now,
      pinQuery: (_db, chatId) => pins.get(chatId) ?? [],
      reconcileExpiredOccupancy: (_db, input) => {
        reconciled.push(input.chatId)
        pins.delete(input.chatId)
      },
    })
    const expired = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })
    pins.set('chat-a', [{ id: 'abandoned-a', kind: 'generation_operation' }])
    now = expired.leaseExpiresAtMs!

    const claimed = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-b',
      sessionId: 'reader-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })

    expect(reconciled).toEqual(['chat-a'])
    expect(claimed).toMatchObject({ chatId: 'chat-b', occupantSessionId: 'reader-a', occupancyEpoch: 1 })
    expect(service.snapshot().occupancies.find((row) => row.chatId === 'chat-a')).toMatchObject({
      occupantSessionId: null,
      occupancyEpoch: expired.occupancyEpoch + 1,
      state: 'released',
    })
  })

  it('reconciles expired nonselected rows before demotion normalization', () => {
    const reconciled: string[] = []
    service = new ChatOccupancyService(db, {
      now: () => now,
      pinQuery: (_db, chatId) => pins.get(chatId) ?? [],
      reconcileExpiredOccupancy: (_db, input) => {
        reconciled.push(input.chatId)
        pins.delete(input.chatId)
      },
    })
    registerDatabaseWriterSession(db, 'session-a')
    const expired = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'session-a',
      claimClass: 'owner',
      expectedOccupancyEpoch: 0,
    })
    now += 1_000
    const selected = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-b',
      sessionId: 'session-a',
      claimClass: 'owner',
      expectedOccupancyEpoch: 0,
    })
    registerDatabaseWriterSession(db, 'owner-b')
    pins.set('chat-a', [{ id: 'abandoned-a', kind: 'generation_operation' }])
    now = expired.leaseExpiresAtMs!

    const normalized = service.normalize({
      databaseLineage: lineage(),
      chatId: 'chat-b',
      sessionId: 'session-a',
      occupancyEpoch: selected.occupancyEpoch,
    })

    expect(reconciled).toEqual(['chat-a'])
    expect(normalized).toMatchObject({
      chatId: 'chat-b',
      occupantSessionId: 'session-a',
      occupancyEpoch: selected.occupancyEpoch,
      claimClass: 'chat_only',
    })
    expect(service.snapshot().occupancies.find((row) => row.chatId === 'chat-a')).toMatchObject({
      occupantSessionId: null,
      occupancyEpoch: expired.occupancyEpoch + 1,
    })
  })

  it('reports a live foreign occupancy before recovery pins on the same target', () => {
    const occupied = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })
    pins.set('chat-a', [{ id: 'operation-a', kind: 'generation' }])

    const error = expectCode(
      () =>
        service.claim({
          databaseLineage: lineage(),
          chatId: 'chat-a',
          sessionId: 'reader-b',
          claimClass: 'chat_only',
          expectedOccupancyEpoch: occupied.occupancyEpoch,
        }),
      'chat_occupied',
    )

    expect(error.statusCode).toBe(423)
    expect(error.details.safeRelease).toEqual(expect.any(String))
  })

  it('normalizes all mixed-class session rows atomically after demotion', () => {
    const selectedChatOnly = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'session-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })
    registerDatabaseWriterSession(db, 'session-a')
    const ownerB = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-b',
      sessionId: 'session-a',
      claimClass: 'owner',
      expectedOccupancyEpoch: 0,
    })
    const ownerC = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-c',
      sessionId: 'session-a',
      claimClass: 'owner',
      expectedOccupancyEpoch: 0,
    })
    registerDatabaseWriterSession(db, 'owner-b')
    pins.set('chat-a', [{ id: 'finalize-a', kind: 'finalization' }])

    expectCode(
      () =>
        service.claim({
          databaseLineage: lineage(),
          chatId: 'chat-b',
          sessionId: 'session-a',
          claimClass: 'chat_only',
          expectedOccupancyEpoch: ownerB.occupancyEpoch,
        }),
      'chat_occupancy_switch_required',
    )
    expectCode(
      () =>
        service.claim({
          databaseLineage: lineage(),
          chatId: 'chat-a',
          sessionId: 'session-a',
          claimClass: 'chat_only',
          expectedOccupancyEpoch: selectedChatOnly.occupancyEpoch,
        }),
      'chat_occupancy_switch_required',
    )

    const beforeBlockedRows = db.prepare('SELECT * FROM chat_occupancies ORDER BY chat_id').all()
    const blocked = expectCode(
      () =>
        service.normalize({
          databaseLineage: lineage(),
          chatId: 'chat-b',
          sessionId: 'session-a',
          occupancyEpoch: ownerB.occupancyEpoch,
        }),
      'chat_occupancy_recovery_blocked',
    )
    expect(blocked.details).toMatchObject({ chatId: 'chat-a', blockingChatIds: ['chat-a'] })
    expect(db.prepare('SELECT * FROM chat_occupancies ORDER BY chat_id').all()).toEqual(beforeBlockedRows)

    pins.clear()
    // Accepted work on the selected chat is retained and must not prevent
    // demotion from preserving that exact authority tuple.
    pins.set('chat-b', [{ id: 'accepted-b', kind: 'generation_operation' }])
    const normalized = service.normalize({
      databaseLineage: lineage(),
      chatId: 'chat-b',
      sessionId: 'session-a',
      occupancyEpoch: ownerB.occupancyEpoch,
    })
    expect(normalized.claimClass).toBe('chat_only')
    expect(normalized.occupancyEpoch).toBe(ownerB.occupancyEpoch)
    expect(service.snapshot().occupancies.filter((row) => row.occupantSessionId === 'session-a')).toEqual([normalized])
    expect(service.snapshot().occupancies).toEqual([
      expect.objectContaining({
        chatId: 'chat-a',
        occupantSessionId: null,
        occupancyEpoch: selectedChatOnly.occupancyEpoch + 1,
        claimClass: null,
        state: 'released',
      }),
      normalized,
      expect.objectContaining({
        chatId: 'chat-c',
        occupantSessionId: null,
        occupancyEpoch: ownerC.occupancyEpoch + 1,
        claimClass: null,
        state: 'released',
      }),
    ])
  })

  it('clears every occupancy on lineage rotation and rejects old tuples', () => {
    const occupied = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })
    const previousLineage = occupied.databaseLineage
    const replacementLineage = rotateDatabaseLineage(db)
    expect(replacementLineage).not.toBe(previousLineage)
    expect(service.snapshot().occupancies).toEqual([])
    expectCode(
      () =>
        service.renew({
          databaseLineage: previousLineage,
          chatId: 'chat-a',
          sessionId: 'reader-a',
          occupancyEpoch: occupied.occupancyEpoch,
        }),
      'chat_occupancy_stale',
    )
  })

  it('ignores an old-lineage occupancy row when a current-lineage database reuses the chat id', () => {
    const previousLineage = lineage()
    rotateDatabaseLineage(db)
    db.prepare(
      `INSERT INTO chat_occupancies (
         chat_id, database_lineage, occupant_session_id, occupancy_epoch, claim_class,
         claimed_at_ms, lease_expires_at_ms, updated_at_ms, released_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run('chat-a', previousLineage, 'stale-reader', 1, 'chat_only', now, now + 90_000, now)

    expect(() => assertChatMutationAllowedInTransaction(db, 'chat-a', 'owner-a', { now: () => now })).not.toThrow()

    const current = service.claim({
      databaseLineage: lineage(),
      chatId: 'chat-a',
      sessionId: 'reader-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })
    expect(current).toMatchObject({ databaseLineage: lineage(), occupantSessionId: 'reader-a', occupancyEpoch: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM chat_occupancies').get()).toEqual({ count: 1 })
  })
})
