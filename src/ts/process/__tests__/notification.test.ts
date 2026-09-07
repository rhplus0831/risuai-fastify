import { resetClientSessionForTests } from '../../clientSession'
import {
  setManagedReaderForTest,
  setManagedWriterForTest,
  demoteAndRepromoteForTest,
} from '../../__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireDesktopNotification } from '../postGeneration/notification'

interface NotificationCall {
  title: string
  options?: { body?: string; icon?: string; badge?: string }
}

function setupNotification(opts: {
  permission?: 'granted' | 'denied' | 'default'
  requestRejects?: boolean
  constructorThrows?: boolean
}): { calls: NotificationCall[]; instances: { onclick: (() => void) | null }[] } {
  const calls: NotificationCall[] = []
  const instances: { onclick: (() => void) | null }[] = []
  class MockNotification {
    onclick: (() => void) | null = null
    constructor(title: string, options?: { body?: string }) {
      if (opts.constructorThrows) throw new Error('blocked')
      calls.push({ title, options })
      instances.push(this)
    }
    static requestPermission = opts.requestRejects
      ? vi.fn(() => Promise.reject(new Error('blocked')))
      : vi.fn(() => Promise.resolve(opts.permission ?? 'default'))
  }
  vi.stubGlobal('Notification', MockNotification)
  return { calls, instances }
}

describe('fireDesktopNotification', () => {
  let focusSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    focusSpy = vi.fn()
    vi.stubGlobal('window', { focus: focusSpy })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fires a Notification when permission is granted and wires onclick to window.focus', async () => {
    const { calls, instances } = setupNotification({ permission: 'granted' })
    await fireDesktopNotification('hello')
    expect(calls).toEqual([
      { title: 'Risuai', options: { body: 'hello', icon: '/logo_192.png', badge: '/logo_192.png' } },
    ])
    expect(instances).toHaveLength(1)
    instances[0].onclick?.()
    expect(focusSpy).toHaveBeenCalledTimes(1)
  })

  it('uses the provided character asset as the notification icon', async () => {
    const assetId = 'a'.repeat(64)
    const { calls } = setupNotification({ permission: 'granted' })

    await fireDesktopNotification({ body: 'hello', icon: assetId })

    expect(calls).toEqual([
      {
        title: 'Risuai',
        options: { body: 'hello', icon: `/api/v1/assets/${assetId}`, badge: '/logo_192.png' },
      },
    ])
  })

  it('truncates long notification bodies before constructing the Notification', async () => {
    const { calls } = setupNotification({ permission: 'granted' })

    await fireDesktopNotification({ body: 'Long custom message '.repeat(400), icon: null })

    expect(calls).toHaveLength(1)
    const body = calls[0].options?.body ?? ''
    expect(body.endsWith('...')).toBe(true)
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(1024)
  })

  it('does not construct a Notification when permission is denied', async () => {
    const { calls } = setupNotification({ permission: 'denied' })
    await fireDesktopNotification('hello')
    expect(calls).toEqual([])
  })

  it('does not construct a Notification when permission is default', async () => {
    const { calls } = setupNotification({ permission: 'default' })
    await fireDesktopNotification('hello')
    expect(calls).toEqual([])
  })

  it('swallows requestPermission rejection silently', async () => {
    const { calls } = setupNotification({ requestRejects: true })
    await expect(fireDesktopNotification('hello')).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  it('swallows Notification constructor throw silently', async () => {
    setupNotification({ permission: 'granted', constructorThrows: true })
    await expect(fireDesktopNotification('hello')).resolves.toBeUndefined()
  })

  it('does not throw when the Notification global is missing entirely', async () => {
    vi.stubGlobal('Notification', undefined)
    await expect(fireDesktopNotification('hello')).resolves.toBeUndefined()
  })
})

beforeEach(() => resetClientSessionForTests())
afterEach(() => vi.unstubAllGlobals())

it('does not ask for notification permission in a reader', async () => {
  setManagedReaderForTest()
  const { calls } = setupNotification({ permission: 'granted' })
  await fireDesktopNotification('reader output')
  expect(Notification.requestPermission).not.toHaveBeenCalled()
  expect(calls).toHaveLength(0)
})

it('does not show a late notification after permission crosses repromotion', async () => {
  setManagedWriterForTest()
  const { calls } = setupNotification({ permission: 'granted' })
  let release!: (permission: NotificationPermission) => void
  vi.mocked(Notification.requestPermission).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    }),
  )
  const pending = fireDesktopNotification('old output')
  demoteAndRepromoteForTest()
  release('granted')
  await pending
  expect(calls).toHaveLength(0)
})
