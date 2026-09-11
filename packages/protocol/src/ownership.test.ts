import { describe, expect, it } from 'vitest'
import { isOwnershipResponse } from '@risuai/protocol/ownership'

describe('ownership protocol', () => {
  it.each([
    { version: 1, databaseLineage: 'database-a', writer: { sessionId: null, epoch: 0 } },
    { version: 1, databaseLineage: 'database-a', writer: { sessionId: 'writer-a', epoch: 3 } },
  ])('accepts a coherent ownership snapshot', (value) => {
    expect(isOwnershipResponse(value)).toBe(true)
  })

  it.each([
    null,
    {},
    { version: 2, databaseLineage: 'database-a', writer: { sessionId: null, epoch: 0 } },
    { version: 1, databaseLineage: '', writer: { sessionId: null, epoch: 0 } },
    { version: 1, databaseLineage: 'database-a', writer: { sessionId: '', epoch: 0 } },
    { version: 1, databaseLineage: 'database-a', writer: { sessionId: ' writer-a', epoch: 0 } },
    { version: 1, databaseLineage: 'database-a', writer: { sessionId: 'writer-a', epoch: -1 } },
    { version: 1, databaseLineage: 'database-a', writer: { sessionId: null, epoch: 0 }, extra: true },
  ])('rejects an invalid ownership snapshot: %j', (value) => {
    expect(isOwnershipResponse(value)).toBe(false)
  })
})
