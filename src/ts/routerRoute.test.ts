import { describe, expect, it } from 'vitest'
import {
  characterRoutePath,
  normalizePath,
  parseRoute,
  personaSettingsRoutePath,
  routeKey,
  routePathFromState,
  type AppRoute,
  type StateRouteInput,
} from './routerRoute'

describe('parseRoute', () => {
  it('maps settings aliases and numeric sections to their stable indexes', () => {
    const cases: Array<[string, string, number]> = [
      ['/settings/agent_presets/', 'agent-presets', 19],
      ['/settings/input-hooks?from=menu', 'input-hooks', 20],
      ['/settings/sourcecode#editor', 'sourcecode', 22],
      ['/settings/requesthistory', 'requesthistory', 21],
      ['/settings/prompt-preset', 'prompt-preset', 18],
      ['/settings/memory', 'memory', 2],
      ['/settings/other-bots', 'other-bots', 2],
      ['/settings/otherbots', 'otherbots', 2],
      ['/settings/bardwiki', 'bardwiki', 23],
      ['/settings/accessibility', 'accessibility', 11],
      ['/settings/interaction', 'interaction', 24],
      ['/settings/24', '24', 24],
      ['/settings/77', '77', 77],
      ['/settings/5', '5', 17],
      ['/settings/unknown', 'unknown', 17],
    ]

    for (const [path, section, index] of cases) {
      expect(parseRoute(path)).toMatchObject({ kind: 'settings', section, index })
    }
  })

  it('handles bare, persona, retired, and malformed settings routes', () => {
    expect(parseRoute('/settings')).toEqual({ kind: 'settings', path: '/settings', section: '', index: -1 })
    expect(parseRoute('/settings/persona/persona%20%2F%20one')).toEqual({
      kind: 'settings',
      path: '/settings/persona/persona%20%2F%20one',
      section: 'persona',
      index: 12,
      personaId: 'persona / one',
    })
    expect(parseRoute('/settings/context_agent')).toEqual({
      kind: 'not-found',
      path: '/settings/context_agent',
    })
    expect(parseRoute('/settings/persona/%E0%A4%A')).toMatchObject({ personaId: '%E0%A4%A' })
  })

  it('maps playground aliases, numeric tools, and defaults', () => {
    const cases: Array<[string, string, number]> = [
      ['/playground', '', 1],
      ['/playground/image_generation', 'image-generation', 7],
      ['/playground/translator', 'translator', 11],
      ['/playground/docs', 'docs', 13],
      ['/playground/101', '101', 101],
      ['/playground/100', '100', 1],
    ]

    for (const [path, tool, index] of cases) {
      expect(parseRoute(path)).toMatchObject({ kind: 'playground', tool, index })
    }
  })

  it('parses home, grid, inlay, legacy character, canonical character, and unknown routes', () => {
    expect(parseRoute('')).toEqual({ kind: 'home', path: '/' })
    expect(parseRoute('/characters')).toEqual({ kind: 'grid', path: '/characters' })
    expect(parseRoute('/inlays')).toEqual({ kind: 'inlay', path: '/inlays' })
    expect(parseRoute('/character/char%2Fone/chat%20one')).toEqual({
      kind: 'character',
      path: '/character/char%2Fone/chat%20one',
      chaId: 'char/one',
      chatId: 'chat one',
    })
    expect(parseRoute('/characters/char-a/chats/chat-b')).toEqual({
      kind: 'character',
      path: '/characters/char-a/chats/chat-b',
      chaId: 'char-a',
      chatId: 'chat-b',
    })
    expect(parseRoute('/characters/char-a/unknown/chat-b')).toEqual({
      kind: 'character',
      path: '/characters/char-a/unknown/chat-b',
      chaId: 'char-a',
      chatId: undefined,
    })
    expect(parseRoute('/missing')).toEqual({ kind: 'not-found', path: '/missing' })
  })
})

describe('route path planning', () => {
  const baseState: StateRouteInput = {
    currentRouteKind: 'home',
    settingsOpen: false,
    settingsMenuIndex: 1,
    selectedCharID: -1,
    playgroundStore: 0,
  }

  it('applies settings precedence and canonical settings slugs', () => {
    expect(routePathFromState({ ...baseState, settingsOpen: true, settingsMenuIndex: -1 })).toBe('/settings')
    expect(routePathFromState({ ...baseState, settingsOpen: true, settingsMenuIndex: 2 })).toBe('/settings/memory')
    expect(routePathFromState({ ...baseState, settingsOpen: true, settingsMenuIndex: 19 })).toBe(
      '/settings/agent-presets',
    )
    expect(routePathFromState({ ...baseState, settingsOpen: true, settingsMenuIndex: 20 })).toBe(
      '/settings/input-hooks',
    )
    expect(routePathFromState({ ...baseState, settingsOpen: true, settingsMenuIndex: 22 })).toBe(
      '/settings/source-code',
    )
    expect(routePathFromState({ ...baseState, settingsOpen: true, settingsMenuIndex: 23 })).toBe('/settings/bardwiki')
    expect(routePathFromState({ ...baseState, settingsOpen: true, settingsMenuIndex: 24 })).toBe(
      '/settings/interaction',
    )
    expect(routePathFromState({ ...baseState, settingsOpen: true, settingsMenuIndex: 11 })).toBe(
      '/settings/accessibility',
    )
    expect(
      routePathFromState({
        ...baseState,
        settingsOpen: true,
        settingsMenuIndex: 12,
        personaId: 'persona / one',
        selectedCharID: 1,
        characterId: 'ignored',
      }),
    ).toBe('/settings/persona/persona%20%2F%20one')
    expect(routePathFromState({ ...baseState, settingsOpen: true, settingsMenuIndex: 999 })).toBe('/settings/model')
  })

  it('plans character, playground, grid, and home routes by precedence', () => {
    expect(
      routePathFromState({
        ...baseState,
        selectedCharID: 0,
        characterId: 'char / one',
        chatId: 'chat one',
        playgroundStore: 4,
      }),
    ).toBe('/character/char%20%2F%20one/chat%20one')
    expect(routePathFromState({ ...baseState, selectedCharID: 0, characterId: '§playground' })).toBe('/playground/chat')
    expect(routePathFromState({ ...baseState, playgroundStore: 14 })).toBe('/inlay')
    expect(routePathFromState({ ...baseState, playgroundStore: 7 })).toBe('/playground/image-gen')
    expect(routePathFromState({ ...baseState, playgroundStore: 999 })).toBe('/playground')
    expect(routePathFromState({ ...baseState, currentRouteKind: 'grid' })).toBe('/grid')
    expect(routePathFromState(baseState)).toBe('/')
  })

  it('encodes character and persona helper paths', () => {
    expect(characterRoutePath('char / one')).toBe('/character/char%20%2F%20one')
    expect(characterRoutePath('char / one', 'chat one')).toBe('/character/char%20%2F%20one/chat%20one')
    expect(personaSettingsRoutePath()).toBe('/settings/persona')
    expect(personaSettingsRoutePath('   ')).toBe('/settings/persona')
    expect(personaSettingsRoutePath('persona / one')).toBe('/settings/persona/persona%20%2F%20one')
  })
})

describe('route identity', () => {
  it('normalizes paths and derives state-relevant route keys', () => {
    expect(normalizePath('settings/model///?from=menu#top')).toBe('/settings/model')
    expect(normalizePath('/')).toBe('/')

    const cases: Array<[AppRoute, string]> = [
      [{ kind: 'home', path: '/' }, 'home'],
      [
        { kind: 'settings', path: '/settings/persona/p', section: 'persona', index: 12, personaId: 'p' },
        'settings:12:p',
      ],
      [{ kind: 'playground', path: '/playground/chat', tool: 'chat', index: 2 }, 'playground:2'],
      [{ kind: 'character', path: '/character/c', chaId: 'c' }, 'character:c:'],
      [{ kind: 'character', path: '/character/c/a', chaId: 'c', chatId: 'a' }, 'character:c:a'],
      [{ kind: 'not-found', path: '/missing' }, 'not-found'],
    ]

    for (const [route, key] of cases) expect(routeKey(route)).toBe(key)
  })
})
