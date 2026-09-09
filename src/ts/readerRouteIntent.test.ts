import { beforeEach, describe, expect, it } from 'vitest'

import {
  consumeReaderRouteIntent,
  peekReaderRouteIntent,
  recordReaderRouteIntent,
  resetReaderRouteIntentForTests,
} from './readerRouteIntent'

describe('reader route intent', () => {
  beforeEach(() => resetReaderRouteIntentForTests())

  it('replaces an older presentation choice with the latest route', () => {
    const first = recordReaderRouteIntent({ kind: 'character', path: '/character/a', chaId: 'a' })
    const latest = recordReaderRouteIntent({
      kind: 'character',
      path: '/character/b/chat-b',
      chaId: 'b',
      chatId: 'chat-b',
    })

    expect(latest.sequence).toBeGreaterThan(first.sequence)
    expect(peekReaderRouteIntent()).toEqual(latest)
  })

  it('does not create a new intent for the same semantic route', () => {
    const first = recordReaderRouteIntent({ kind: 'character', path: '/characters/a', chaId: 'a' })
    const duplicate = recordReaderRouteIntent({ kind: 'character', path: '/character/a', chaId: 'a' })

    expect(duplicate).toEqual(first)
  })

  it('consumes only the exact latest intent once', () => {
    const stale = recordReaderRouteIntent({ kind: 'home', path: '/' })
    const latest = recordReaderRouteIntent({ kind: 'grid', path: '/grid' })

    expect(consumeReaderRouteIntent(stale.sequence)).toBeNull()
    expect(consumeReaderRouteIntent(latest.sequence)).toEqual(latest)
    expect(consumeReaderRouteIntent(latest.sequence)).toBeNull()
  })

  it('keeps a newer intent when an older reconciliation finishes late', () => {
    const older = recordReaderRouteIntent({ kind: 'character', path: '/character/a', chaId: 'a' })
    const newer = recordReaderRouteIntent({ kind: 'character', path: '/character/b', chaId: 'b' })

    expect(consumeReaderRouteIntent(older.sequence)).toBeNull()
    expect(peekReaderRouteIntent()).toEqual(newer)
  })
})
