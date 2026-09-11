import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BROWSER_OPERATION_BINDINGS,
  BROWSER_OPERATION_NON_OVERLAPS,
  BROWSER_RAW_GENERATION_OPERATION_IDS,
  validateBrowserOperationBindings,
  validateBrowserOperationNonOverlaps,
  type BrowserOperationBinding,
} from './browserOperationManifest'

const repositoryRoot = process.cwd()

describe('browser operation manifest', () => {
  it('keeps the reviewed browser vocabularies explicit and non-authoritative', () => {
    expect(BROWSER_OPERATION_BINDINGS).toHaveLength(57)
    expect(
      Object.fromEntries(
        ['resource', 'cache', 'generation', 'raw-generation'].map((family) => [
          family,
          BROWSER_OPERATION_BINDINGS.filter((binding) => binding.family === family).length,
        ]),
      ),
    ).toEqual({ resource: 33, cache: 12, generation: 10, 'raw-generation': 2 })
    expect(BROWSER_OPERATION_NON_OVERLAPS).toHaveLength(7)
    expect(BROWSER_RAW_GENERATION_OPERATION_IDS).toEqual({
      atomicSubmit: 'generation-operation-submit',
      compatibilityChat: 'generation-chat',
    })

    for (const entry of [...BROWSER_OPERATION_BINDINGS, ...BROWSER_OPERATION_NON_OVERLAPS]) {
      expect(entry).not.toHaveProperty('authentication')
      expect(entry).not.toHaveProperty('activeWriter')
      expect(entry).not.toHaveProperty('handler')
    }
  })

  it('maps every browser entry to current shared route metadata', () => {
    expect(validateBrowserOperationBindings(BROWSER_OPERATION_BINDINGS)).toEqual([])
    expect(validateBrowserOperationNonOverlaps(BROWSER_OPERATION_NON_OVERLAPS)).toEqual([])
  })

  it('keeps every reviewed owner and source anchor live', () => {
    for (const { owner } of [...BROWSER_OPERATION_BINDINGS, ...BROWSER_OPERATION_NON_OVERLAPS]) {
      const [file, anchor] = owner.split('#')
      const absolute = path.join(repositoryRoot, file)
      expect(existsSync(absolute), owner).toBe(true)
      expect(readFileSync(absolute, 'utf8'), owner).toContain(anchor)
    }
  })

  it('rejects duplicate, stale, and contradictory route mappings', () => {
    const current: BrowserOperationBinding = BROWSER_OPERATION_BINDINGS[0]

    expect(validateBrowserOperationBindings([current, current])).toContain(
      `duplicate browser operation key: ${current.key}`,
    )
    expect(
      validateBrowserOperationBindings([{ ...current, key: 'stale', routeOperationId: 'removed-operation' }]),
    ).toEqual(['stale browser route operation id: removed-operation'])
    expect(validateBrowserOperationBindings([{ ...current, key: 'wrong-cache', cache: 'no-store' }])).toEqual([
      'browser operation cache mismatch: wrong-cache expected unspecified, got no-store',
    ])
    expect(
      validateBrowserOperationBindings([{ ...current, key: 'wrong-route', examplePath: '/api/v1/settings' }]),
    ).toEqual(['browser operation route mismatch: wrong-route -> GET /api/v1/settings'])
  })

  it('rejects duplicate or unreviewed non-overlap records', () => {
    const current = BROWSER_OPERATION_NON_OVERLAPS[0]
    expect(validateBrowserOperationNonOverlaps([current, current])).toContain(
      `duplicate browser non-overlap id: ${current.id}`,
    )
    expect(validateBrowserOperationNonOverlaps([{ ...current, reason: 'unreviewed' }])).toEqual([
      'unknown browser non-overlap reason: unreviewed',
    ])
  })
})
