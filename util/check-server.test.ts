import { describe, expect, it } from 'vitest'
import {
  architectureInventoryCheck,
  downstreamServerChecks,
  protocolCheck,
  runServerChecks,
  sharedCoreCheck,
  type ServerCheck,
} from './check-server.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('check:server orchestration', () => {
  it('runs prerequisites in order and independent consumers concurrently', async () => {
    const server = deferred<number>()
    const browser = deferred<number>()
    const started: ServerCheck['id'][] = []

    const result = runServerChecks(async (check) => {
      started.push(check.id)
      if (check.id === 'server') return server.promise
      if (check.id === 'browser-smoke') return browser.promise
      return 0
    })

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual([
      protocolCheck.id,
      sharedCoreCheck.id,
      architectureInventoryCheck.id,
      ...downstreamServerChecks.map((check) => check.id),
    ])

    server.resolve(0)
    await Promise.resolve()
    let settled = false
    void result.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    browser.resolve(0)
    await expect(result).resolves.toBe(0)
  })

  it.each([
    ['protocol', ['protocol']],
    ['shared-core', ['protocol', 'shared-core']],
    ['architecture-inventory', ['protocol', 'shared-core', 'architecture-inventory']],
  ] as const)('stops after a failing %s prerequisite', async (failingId, expectedStarted) => {
    const started: ServerCheck['id'][] = []
    const result = await runServerChecks(async (check) => {
      started.push(check.id)
      return check.id === failingId ? 2 : 0
    })

    expect(result).toBe(1)
    expect(started).toEqual(expectedStarted)
  })

  it('preserves a downstream failure after both consumers finish', async () => {
    const started: ServerCheck['id'][] = []
    const result = await runServerChecks(async (check) => {
      started.push(check.id)
      return check.id === 'server' ? 2 : 0
    })

    expect(result).toBe(1)
    expect(started).toContain('browser-smoke')
  })

  it('can run only the typechecks for the minimal agent profile', async () => {
    const started: ServerCheck['id'][] = []

    await expect(
      runServerChecks(
        async (check) => {
          started.push(check.id)
          return 0
        },
        { includeArchitectureInventory: false },
      ),
    ).resolves.toBe(0)

    expect(started).toEqual([protocolCheck.id, sharedCoreCheck.id, ...downstreamServerChecks.map((check) => check.id)])
  })
})
