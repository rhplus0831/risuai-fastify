import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CharacterShellHydrationRowState } from 'src/ts/server/characterShellHydration.svelte'

vi.mock('src/ts/server/characterShellHydration.svelte', () => {
  const characterShellHydrationState = $state({ rows: {} as Record<string, CharacterShellHydrationRowState> })
  return {
    characterShellHydrationState,
    retryCharacterShellHydration: vi.fn(async (_characterId: string) => true),
  }
})

import { language } from 'src/lang'
import {
  characterShellHydrationState,
  retryCharacterShellHydration,
} from 'src/ts/server/characterShellHydration.svelte'
import CharacterShellHydrationGate from './CharacterShellHydrationGate.svelte'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLDivElement

function retryButton() {
  return Array.from(target.querySelectorAll('button')).find((button) => button.textContent?.trim() === language.retry)
}

function expectLoading() {
  const status = target.querySelector('[role="status"]')
  expect(status?.textContent).toContain(language.loadingCharacter)
  expect(status?.getAttribute('aria-busy')).toBe('true')
  expect(target.querySelector('[role="alert"]')).toBeNull()
  expect(retryButton()).toBeUndefined()
}

function expectFailure() {
  expect(target.querySelector('[role="alert"]')?.textContent).toContain(language.characterDataLoadFailed)
  expect(target.querySelector('[role="status"]')).toBeNull()
  const retry = retryButton()
  expect(retry).toBeDefined()
  expect(retry!.disabled).toBe(false)
  return retry!
}

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  characterShellHydrationState.rows = {}
  vi.mocked(retryCharacterShellHydration).mockReset().mockResolvedValue(true)
})

afterEach(async () => {
  if (component) {
    await unmount(component)
    component = undefined
  }
  target.remove()
})

describe('CharacterShellHydrationGate', () => {
  it('renders localized loading state while selected detail is pending', async () => {
    characterShellHydrationState.rows['char-a'] = { status: 'loading', error: null }
    component = mount(CharacterShellHydrationGate, { target, props: { characterId: 'char-a' } })
    await tick()

    expectLoading()
  })

  it('renders a localized failure and retries the exact character', async () => {
    characterShellHydrationState.rows['char-a'] = { status: 'error', error: 'timeout' }
    component = mount(CharacterShellHydrationGate, { target, props: { characterId: 'char-a' } })
    await tick()

    expectFailure().click()
    expect(retryCharacterShellHydration).toHaveBeenCalledExactlyOnceWith('char-a')
  })

  it('replaces loading with failure and returns to loading when retry starts', async () => {
    characterShellHydrationState.rows['char-a'] = { status: 'loading', error: null }
    component = mount(CharacterShellHydrationGate, { target, props: { characterId: 'char-a' } })
    await tick()
    expectLoading()

    characterShellHydrationState.rows['char-a'] = { status: 'error', error: 'unavailable' }
    await tick()
    expectFailure().click()
    expect(retryCharacterShellHydration).toHaveBeenCalledExactlyOnceWith('char-a')

    // The hydration service owns the retry transition; the gate must observe it without remounting.
    characterShellHydrationState.rows['char-a'] = { status: 'loading', error: null }
    await tick()
    expectLoading()
  })

  it('follows a changed character and ignores updates to the previous character', async () => {
    characterShellHydrationState.rows['char-a'] = { status: 'error', error: 'timeout' }
    characterShellHydrationState.rows['char-b'] = { status: 'loading', error: null }
    const props = $state({ characterId: 'char-a' })
    component = mount(CharacterShellHydrationGate, { target, props })
    await tick()
    expectFailure()

    props.characterId = 'char-b'
    await tick()
    expectLoading()

    characterShellHydrationState.rows['char-b'] = { status: 'error', error: 'unavailable' }
    await tick()
    expectFailure()

    characterShellHydrationState.rows['char-a'] = { status: 'loading', error: null }
    await tick()
    expectFailure().click()
    expect(retryCharacterShellHydration).toHaveBeenCalledExactlyOnceWith('char-b')
  })
})
