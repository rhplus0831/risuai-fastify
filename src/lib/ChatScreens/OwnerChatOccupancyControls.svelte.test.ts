import type { ChatOccupancyProjection } from '@risuai/protocol/chat-occupancy'
import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  claim: vi.fn(),
  snapshot: vi.fn(),
  normalize: vi.fn(),
  release: vi.fn(),
  renew: vi.fn(),
  switch: vi.fn(),
}))
const identity = vi.hoisted(() => ({
  current: { sessionId: 'owner-a', exclusive: true, previousSessionId: null as string | null },
}))

vi.mock('../../ts/server/chatOccupancyTransport', () => ({
  claimChatOccupancy: transport.claim,
  fetchChatOccupancySnapshot: transport.snapshot,
  normalizeChatOccupancies: transport.normalize,
  releaseChatOccupancy: transport.release,
  renewChatOccupancy: transport.renew,
  switchChatOccupancy: transport.switch,
}))
vi.mock('../../ts/server/connectedTabIdentity', () => ({
  resolveConnectedTabIdentity: async () => identity.current,
}))
vi.mock('../../ts/server/browserDiagnostics', () => ({
  recordBrowserDiagnostic: vi.fn(),
  resetBrowserDiagnosticsSession: vi.fn(),
}))

import { language } from '../../lang'
import {
  authorizeClientWriterRecovery,
  beginClientSession,
  completeClientWriterRecovery,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
} from '../../ts/clientSession'
import {
  configureClientChatOccupancy,
  projectClientChatOccupancy,
  resetClientChatOccupancyForTests,
  setClientChatOccupancyIdentity,
  type ClientChatOccupancyActionResult,
} from '../../ts/server/chatOccupancy'
import OwnerChatOccupancyControls from './OwnerChatOccupancyControls.svelte'

const capability = { version: 1 as const, enabled: true, leaseMs: 90_000 as const, renewAfterMs: 30_000 as const }

let target: HTMLElement
let component: ReturnType<typeof mount> | undefined

function occupancy(
  occupantSessionId: string | null,
  occupancyEpoch: number,
  claimClass: ChatOccupancyProjection['claimClass'] = occupantSessionId ? 'chat_only' : null,
): ChatOccupancyProjection {
  const active = occupantSessionId !== null
  return {
    databaseLineage: 'database-a',
    chatId: 'chat-a',
    occupantSessionId,
    occupancyEpoch,
    claimClass,
    state: active ? 'occupied' : 'released',
    claimedAtMs: active ? Date.now() : null,
    leaseExpiresAtMs: active ? Date.now() + 90_000 : null,
    updatedAtMs: Date.now(),
    releasedAtMs: active ? null : Date.now(),
  }
}

function becomeWriter(row: ChatOccupancyProjection, enabled = true): void {
  const operation = beginClientSession('owner-a')
  expect(setClientChatOccupancyIdentity(identity.current, operation.generation)).toBe(true)
  expect(
    authorizeClientWriterRecovery(operation, {
      databaseLineage: 'database-a',
      writer: { sessionId: 'owner-a', epoch: 1 },
    }),
  ).toBe(true)
  setClientProjectionReady(true)
  setClientConnectionState('live')
  expect(completeClientWriterRecovery(operation)).toBe(true)
  expect(
    configureClientChatOccupancy(
      { ...capability, enabled },
      { version: 1, databaseLineage: 'database-a', occupancies: [row] },
    ),
  ).toBe(true)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  flushSync()
  await tick()
  await Promise.resolve()
  flushSync()
}

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  for (const mock of Object.values(transport)) mock.mockReset()
  resetClientChatOccupancyForTests()
  resetClientSessionForTests()
})

afterEach(async () => {
  if (component) await unmount(component)
  component = undefined
  target.remove()
  resetClientChatOccupancyForTests()
  resetClientSessionForTests()
})

describe('owner chat occupancy controls', () => {
  it('releases an inherited chat-only tuple before claiming a fresh owner tuple', async () => {
    const inherited = occupancy('owner-a', 1)
    const released = occupancy(null, 2)
    const ownerClaim = occupancy('owner-a', 3, 'owner')
    becomeWriter(inherited)
    transport.release.mockResolvedValue({ status: 'ok', occupancy: released })
    transport.claim.mockResolvedValue({ status: 'ok', occupancy: ownerClaim })
    component = mount(OwnerChatOccupancyControls, { target, props: { chatId: 'chat-a' } })
    await settle()

    expect(target.querySelector('[data-owner-chat-occupancy-class="chat_only"]')).not.toBeNull()
    target.querySelector<HTMLButtonElement>('[data-owner-occupancy-promote]')!.click()

    await vi.waitFor(() =>
      expect(target.querySelector('[data-owner-occupancy-feedback]')?.textContent).toContain(
        language.connectedReaders.chatOccupancy.ownerUpgradeSucceeded,
      ),
    )
    expect(transport.release).toHaveBeenCalledWith(
      expect.objectContaining({ databaseLineage: 'database-a', sessionId: 'owner-a' }),
      inherited,
      expect.any(AbortSignal),
    )
    expect(transport.claim).toHaveBeenCalledWith(
      expect.objectContaining({ databaseLineage: 'database-a', sessionId: 'owner-a' }),
      { chatId: 'chat-a', expectedOccupancyEpoch: 2, claimClass: 'owner' },
      expect.any(AbortSignal),
    )
    expect(projectClientChatOccupancy('chat-a')).toMatchObject({
      kind: 'self-owned',
      occupancy: { occupancyEpoch: 3, claimClass: 'owner' },
    })
    expect(target.querySelector('[data-owner-occupancy-promote]')).toBeNull()
    expect(target.querySelector('[data-owner-occupancy-release]')).not.toBeNull()
  })

  it('keeps the chat-only tuple when a pinned generation rejects the exact release', async () => {
    const inherited = occupancy('owner-a', 4)
    becomeWriter(inherited)
    transport.release.mockResolvedValue({
      status: 'error',
      error: 'chat_occupancy_recovery_blocked',
      httpStatus: 409,
      details: { chatId: 'chat-a' },
    })
    component = mount(OwnerChatOccupancyControls, { target, props: { chatId: 'chat-a' } })
    await settle()

    target.querySelector<HTMLButtonElement>('[data-owner-occupancy-promote]')!.click()

    await vi.waitFor(() =>
      expect(target.querySelector('[data-owner-occupancy-feedback]')?.textContent).toContain(
        language.connectedReaders.chatOccupancy.recoveryBlocked,
      ),
    )
    expect(transport.claim).not.toHaveBeenCalled()
    expect(projectClientChatOccupancy('chat-a')).toMatchObject({
      kind: 'self-owned',
      occupancy: { occupancyEpoch: 4, claimClass: 'chat_only' },
    })
  })

  it('retries only the owner claim after the exact release has already succeeded', async () => {
    const inherited = occupancy('owner-a', 5)
    const released = occupancy(null, 6)
    const ownerClaim = occupancy('owner-a', 7, 'owner')
    becomeWriter(inherited)
    transport.release.mockResolvedValue({ status: 'ok', occupancy: released })
    transport.claim
      .mockResolvedValueOnce({ status: 'error', error: 'temporary_failure', httpStatus: 503 })
      .mockResolvedValueOnce({ status: 'ok', occupancy: ownerClaim })
    component = mount(OwnerChatOccupancyControls, { target, props: { chatId: 'chat-a' } })
    await settle()

    target.querySelector<HTMLButtonElement>('[data-owner-occupancy-promote]')!.click()
    await vi.waitFor(() =>
      expect(target.querySelector('[data-owner-occupancy-feedback]')?.textContent).toContain(
        language.connectedReaders.chatOccupancy.actionFailed,
      ),
    )
    expect(projectClientChatOccupancy('chat-a')).toMatchObject({ kind: 'available', expectedOccupancyEpoch: 6 })

    target.querySelector<HTMLButtonElement>('[data-owner-occupancy-promote]')!.click()
    await vi.waitFor(() =>
      expect(target.querySelector('[data-owner-occupancy-feedback]')?.textContent).toContain(
        language.connectedReaders.chatOccupancy.ownerUpgradeSucceeded,
      ),
    )
    expect(transport.release).toHaveBeenCalledOnce()
    expect(transport.claim).toHaveBeenCalledTimes(2)
    expect(transport.claim).toHaveBeenLastCalledWith(
      expect.objectContaining({ databaseLineage: 'database-a', sessionId: 'owner-a' }),
      { chatId: 'chat-a', expectedOccupancyEpoch: 6, claimClass: 'owner' },
      expect.any(AbortSignal),
    )
  })

  it('keeps safe release enabled while rollout-disabled and blocks owner reacquisition', async () => {
    const inherited = occupancy('owner-a', 7)
    const released = occupancy(null, 8)
    becomeWriter(inherited, false)
    transport.release.mockResolvedValue({ status: 'ok', occupancy: released })
    component = mount(OwnerChatOccupancyControls, { target, props: { chatId: 'chat-a' } })
    await settle()

    expect(target.querySelector<HTMLButtonElement>('[data-owner-occupancy-promote]')?.disabled).toBe(true)
    const release = target.querySelector<HTMLButtonElement>('[data-owner-occupancy-release]')!
    expect(release.disabled).toBe(false)
    release.click()

    await vi.waitFor(() => expect(transport.release).toHaveBeenCalledOnce())
    expect(transport.claim).not.toHaveBeenCalled()
    expect(projectClientChatOccupancy('chat-a')).toMatchObject({ kind: 'available', expectedOccupancyEpoch: 8 })
  })

  it('retires a delayed release action when navigation reuses the controls for another chat', async () => {
    const inherited = occupancy('owner-a', 1)
    const ownerB = { ...occupancy('owner-a', 1, 'owner'), chatId: 'chat-b' }
    const released = occupancy(null, 2)
    const releaseResult = deferred<ClientChatOccupancyActionResult>()
    becomeWriter(inherited)
    expect(
      configureClientChatOccupancy(capability, {
        version: 1,
        databaseLineage: 'database-a',
        occupancies: [inherited, ownerB],
      }),
    ).toBe(true)
    transport.release.mockReturnValue(releaseResult.promise)
    const props = $state({ chatId: 'chat-a' })
    component = mount(OwnerChatOccupancyControls, { target, props })
    await settle()

    target.querySelector<HTMLButtonElement>('[data-owner-occupancy-promote]')!.click()
    await vi.waitFor(() => expect(transport.release).toHaveBeenCalledOnce())
    props.chatId = 'chat-b'
    await settle()
    releaseResult.resolve({ status: 'ok', occupancy: released })

    await vi.waitFor(() =>
      expect(projectClientChatOccupancy('chat-a')).toMatchObject({ kind: 'available', expectedOccupancyEpoch: 2 }),
    )
    expect(transport.claim).not.toHaveBeenCalled()
    expect(target.querySelector('[data-owner-chat-occupancy-class="owner"]')).not.toBeNull()
    expect(target.querySelector<HTMLButtonElement>('[data-owner-occupancy-release]')?.disabled).toBe(false)
  })

  it('does not leave the next chat busy when an owner claim finishes after navigation', async () => {
    const inherited = occupancy('owner-a', 3)
    const ownerB = { ...occupancy('owner-a', 1, 'owner'), chatId: 'chat-b' }
    const released = occupancy(null, 4)
    const ownerClaim = occupancy('owner-a', 5, 'owner')
    const claimResult = deferred<ClientChatOccupancyActionResult>()
    becomeWriter(inherited)
    expect(
      configureClientChatOccupancy(capability, {
        version: 1,
        databaseLineage: 'database-a',
        occupancies: [inherited, ownerB],
      }),
    ).toBe(true)
    transport.release.mockResolvedValue({ status: 'ok', occupancy: released })
    transport.claim.mockReturnValue(claimResult.promise)
    const props = $state({ chatId: 'chat-a' })
    component = mount(OwnerChatOccupancyControls, { target, props })
    await settle()

    target.querySelector<HTMLButtonElement>('[data-owner-occupancy-promote]')!.click()
    await vi.waitFor(() => expect(transport.claim).toHaveBeenCalledOnce())
    props.chatId = 'chat-b'
    await settle()
    expect(target.querySelector<HTMLButtonElement>('[data-owner-occupancy-release]')?.disabled).toBe(false)

    claimResult.resolve({ status: 'ok', occupancy: ownerClaim })
    await vi.waitFor(() =>
      expect(projectClientChatOccupancy('chat-a')).toMatchObject({
        kind: 'self-owned',
        occupancy: { occupancyEpoch: 5, claimClass: 'owner' },
      }),
    )
    expect(target.querySelector('[data-owner-chat-occupancy-class="owner"]')).not.toBeNull()
    expect(target.querySelector<HTMLButtonElement>('[data-owner-occupancy-release]')?.disabled).toBe(false)
  })

  it('does not resume a retired release after navigating away and back to its chat', async () => {
    const inherited = occupancy('owner-a', 1)
    const ownerB = { ...occupancy('owner-a', 1, 'owner'), chatId: 'chat-b' }
    const releaseResult = deferred<ClientChatOccupancyActionResult>()
    becomeWriter(inherited)
    expect(
      configureClientChatOccupancy(capability, {
        version: 1,
        databaseLineage: 'database-a',
        occupancies: [inherited, ownerB],
      }),
    ).toBe(true)
    transport.release.mockReturnValue(releaseResult.promise)
    transport.claim.mockResolvedValue({ status: 'ok', occupancy: occupancy('owner-a', 3, 'owner') })
    const props = $state({ chatId: 'chat-a' })
    component = mount(OwnerChatOccupancyControls, { target, props })
    await settle()

    target.querySelector<HTMLButtonElement>('[data-owner-occupancy-promote]')!.click()
    await vi.waitFor(() => expect(transport.release).toHaveBeenCalledOnce())
    props.chatId = 'chat-b'
    await settle()
    props.chatId = 'chat-a'
    await settle()
    releaseResult.resolve({ status: 'ok', occupancy: occupancy(null, 2) })
    await settle()
    await settle()

    expect(transport.claim).not.toHaveBeenCalled()
    expect(projectClientChatOccupancy('chat-a')).toMatchObject({ kind: 'available', expectedOccupancyEpoch: 2 })
  })

  it('does not continue owner promotion after the controls are destroyed', async () => {
    becomeWriter(occupancy('owner-a', 1))
    const releaseResult = deferred<ClientChatOccupancyActionResult>()
    transport.release.mockReturnValue(releaseResult.promise)
    transport.claim.mockResolvedValue({ status: 'ok', occupancy: occupancy('owner-a', 3, 'owner') })
    component = mount(OwnerChatOccupancyControls, { target, props: { chatId: 'chat-a' } })
    await settle()

    target.querySelector<HTMLButtonElement>('[data-owner-occupancy-promote]')!.click()
    await vi.waitFor(() => expect(transport.release).toHaveBeenCalledOnce())
    await unmount(component)
    component = undefined
    releaseResult.resolve({ status: 'ok', occupancy: occupancy(null, 2) })
    await settle()
    await settle()

    expect(transport.claim).not.toHaveBeenCalled()
    expect(projectClientChatOccupancy('chat-a')).toMatchObject({ kind: 'available', expectedOccupancyEpoch: 2 })
  })
})
