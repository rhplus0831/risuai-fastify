import { describe, expect, it } from 'vitest'
import {
  DISPLAY_SOURCE_LAYERS,
  DISPLAY_SOURCE_LIMITS,
  DISPLAY_SOURCE_PROTOCOL_VERSION,
  DISPLAY_SOURCE_TRANSFORM_VERSION,
  displaySourceNamespaceJson,
  isDisplaySourceRequest,
  isDisplaySourceResponse,
  isDisplaySourceStreamEvent,
  normalizeDisplayDependencyValue,
  normalizeDisplayRequestContext,
  stableDisplayDependencyJson,
} from '@risuai/protocol/display-source'

const target = {
  requestKey: 'request-1',
  characterId: 'character-1',
  messageId: 'message-1',
  index: 2,
  role: 'char',
  firstMessage: false,
  layer: 'translation',
  source: 'hello',
  sourceHash: 'a'.repeat(64),
  projectionEpoch: 3,
  streaming: false,
  name: 'Mira',
} as const

describe('display-source protocol', () => {
  it('publishes the exact versions, layer taxonomy, and limits', () => {
    expect(DISPLAY_SOURCE_PROTOCOL_VERSION).toBe(1)
    expect(DISPLAY_SOURCE_TRANSFORM_VERSION).toBe('editdisplay-v2-ephemeral-state')
    expect(DISPLAY_SOURCE_LAYERS).toEqual(['original', 'translation', 'bilingual', 'greeting', 'preview'])
    expect(DISPLAY_SOURCE_LIMITS).toEqual({
      maxTargets: 64,
      maxSourceBytes: 512 * 1024,
      maxRequestSourceBytes: 4 * 1024 * 1024,
      maxRequestKeyLength: 128,
      maxPageSessionIdLength: 128,
    })
  })

  it('normalizes viewport context while requiring a bounded ephemeral page id', () => {
    expect(
      normalizeDisplayRequestContext({
        pageSessionId: ' page-a ',
        browserLanguage: ' ko-KR ',
        screenWidth: 777.4,
        screenHeight: 555.6,
      }),
    ).toEqual({ pageSessionId: 'page-a', browserLanguage: 'ko-KR', screenWidth: 777, screenHeight: 556 })
    expect(normalizeDisplayRequestContext({ screenWidth: 777 })).toBeUndefined()
    expect(normalizeDisplayRequestContext({ pageSessionId: 'x'.repeat(129) })).toBeUndefined()
  })

  it('normalizes nested dependencies without retaining undefined values or functions', () => {
    expect(
      normalizeDisplayDependencyValue({
        z: [{ b: 2, a: 1, omitted: undefined }],
        fn: () => undefined,
        a: null,
      }),
    ).toEqual({ a: null, z: [{ a: 1, b: 2 }] })
    expect(stableDisplayDependencyJson(undefined)).toBe('null')
  })

  it('serializes dependencies canonically and includes every namespace dimension', () => {
    expect(stableDisplayDependencyJson({ z: 1, a: { y: 2, x: 3 }, omitted: undefined })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    )
    const first = displaySourceNamespaceJson({
      databaseLineage: 'lineage-a',
      activeWriterEpoch: 1,
      context: { pageSessionId: 'page-a', screenWidth: 800, screenHeight: 600, browserLanguage: 'en-US' },
    })
    const changedHeight = displaySourceNamespaceJson({
      databaseLineage: 'lineage-a',
      activeWriterEpoch: 1,
      context: { pageSessionId: 'page-a', screenWidth: 800, screenHeight: 601, browserLanguage: 'en-US' },
    })
    expect(first).toBe(
      '{"activeWriterEpoch":1,"browserLanguage":"en-US","databaseLineage":"lineage-a","pageSessionId":"page-a","protocolVersion":1,"screenHeight":600,"screenWidth":800}',
    )
    expect(changedHeight).not.toBe(first)
  })

  it.each(DISPLAY_SOURCE_LAYERS)('accepts the %s request layer', (layer) => {
    expect(
      isDisplaySourceRequest({
        protocolVersion: 1,
        baseRevision: 7,
        context: { pageSessionId: 'page-a' },
        targets: [{ ...target, layer }],
      }),
    ).toBe(true)
  })

  it('rejects unknown request fields, layers, and protocol versions', () => {
    expect(
      isDisplaySourceRequest({
        protocolVersion: 1,
        baseRevision: 7,
        context: { pageSessionId: 'page-a' },
        targets: [target],
        future: true,
      }),
    ).toBe(false)
    expect(
      isDisplaySourceRequest({
        protocolVersion: 2,
        baseRevision: 7,
        context: { pageSessionId: 'page-a' },
        targets: [{ ...target, layer: 'unknown' }],
      }),
    ).toBe(false)
  })

  it.each(['client_fallback', 'stale', 'error'] as const)('accepts the %s fallback response', (status) => {
    expect(
      isDisplaySourceResponse({
        protocolVersion: 1,
        revision: 7,
        contextFingerprint: 'context',
        entries: [{ requestKey: 'request-1', status, sourceHash: target.sourceHash, reason: 'reason' }],
      }),
    ).toBe(true)
  })

  it('accepts exact success responses and rejects cross-paired response fields', () => {
    expect(
      isDisplaySourceResponse({
        protocolVersion: 1,
        revision: 7,
        contextFingerprint: 'context',
        entries: [
          {
            requestKey: 'request-1',
            status: 'ok',
            sourceHash: target.sourceHash,
            dependencyFingerprint: 'dependency',
            displaySource: 'rendered',
          },
        ],
      }),
    ).toBe(true)
    expect(
      isDisplaySourceResponse({
        protocolVersion: 1,
        revision: 7,
        contextFingerprint: 'context',
        entries: [{ requestKey: 'request-1', status: 'ok', sourceHash: target.sourceHash, reason: 'wrong' }],
      }),
    ).toBe(false)
  })
})

describe('display source streaming protocol', () => {
  it('validates finite stream events and explicit request priorities', () => {
    expect(
      isDisplaySourceRequest({
        protocolVersion: 1,
        baseRevision: 7,
        context: { pageSessionId: 'p' },
        targets: [target],
        priorityKeys: [target.requestKey],
      }),
    ).toBe(true)
    const context = { protocolVersion: 1, revision: 7, contextFingerprint: 'namespace' }
    expect(
      isDisplaySourceStreamEvent({
        type: 'result',
        ...context,
        entry: {
          requestKey: target.requestKey,
          sourceHash: target.sourceHash,
          status: 'ok',
          displaySource: 'rendered',
          dependencyFingerprint: 'dep',
        },
      }),
    ).toBe(true)
    expect(isDisplaySourceStreamEvent({ type: 'done', ...context, targetCount: 1 })).toBe(true)
    expect(isDisplaySourceStreamEvent({ type: 'done', ...context, targetCount: 65 })).toBe(false)
    expect(isDisplaySourceStreamEvent({ type: 'result', ...context, entry: { status: 'ok' } })).toBe(false)
    expect(
      isDisplaySourceStreamEvent({ type: 'invalidated', revision: 8, reason: 'revision_changed_during_transform' }),
    ).toBe(true)
    expect(isDisplaySourceStreamEvent({ type: 'error', reason: 'failed' })).toBe(true)
  })
})
