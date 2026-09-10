import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./platform', async (importActual) => {
  const actual = await importActual<typeof import('./platform')>()
  return {
    ...actual,
    isFastifyServer: true,
  }
})

vi.mock('./storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'proxy-auth-token',
}))

vi.mock('./process/modules', async (importActual) => {
  const actual = await importActual<typeof import('./process/modules')>()
  return { ...actual, moduleUpdate: vi.fn() }
})

import { testDatabaseState } from './__tests__/resourceDatabaseState'
import { getFileSrc } from './globalApi.svelte'

beforeEach(() => {
  // Seed the minimal Database shape so the module-load $effect chain in
  // `stores.svelte → modules.ts → getDatabase()` does not throw before the
  // tests run. The test does not exercise these fields.
  testDatabaseState.db = {
    usePlainFetch: false,
    requestLocation: '',
    modules: [],
    enabledModules: [],
    characters: [],
  }
})

describe('getFileSrc Fastify-mode shape gate', () => {
  const assetUrl = '/api/v1/assets/' + 'a'.repeat(64)
  const rawId = 'b'.repeat(64)
  const legacyId = 'c'.repeat(64)

  it.each<[string, string, string]>([
    ['absolute /api/v1/assets URLs unchanged', assetUrl, assetUrl],
    ['data: URLs unchanged', 'data:image/png;base64,iVBORw0KGgo=', 'data:image/png;base64,iVBORw0KGgo='],
    ['blob: URLs unchanged', 'blob:http://localhost/abc-123', 'blob:http://localhost/abc-123'],
    ['a raw 64-char asset id to /api/v1/assets/<id>', rawId, `/api/v1/assets/${rawId}`],
    ['a legacy assets/<sha>.<ext> path to /api/v1/assets/<id>', `assets/${legacyId}.png`, `/api/v1/assets/${legacyId}`],
    ['an arbitrary http URL with empty string (no fingerprint fetch)', 'http://attacker.invalid/poisoned.png', ''],
    ['an arbitrary https URL with empty string', 'https://attacker.invalid/poisoned.png', ''],
    ['an empty string with empty string', '', ''],
    ['a garbage string with empty string', 'definitely-not-an-asset', ''],
  ])('resolves %s', async (_case, input, expected) => {
    expect(await getFileSrc(input)).toBe(expected)
  })
})
