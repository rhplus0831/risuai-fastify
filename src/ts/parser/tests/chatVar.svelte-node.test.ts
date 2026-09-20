import fc from 'fast-check'
import { writable } from 'svelte/store'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  charactersResourceState,
  collectionsResourceState,
  resetServerResourceState,
  settingsResourceState,
} from '../../server/resourceState.svelte'
import { getChatVar, getGlobalChatVar, setChatVar } from '../chatVar.svelte'

//#region module mocks

const chatVarMocks = vi.hoisted(() => ({
  dispatchPatchChatScriptstateScoped: vi.fn(),
}))

vi.mock(import('../../chatCommands'), () => ({
  dispatchPatchChatScriptstateScoped: chatVarMocks.dispatchPatchChatScriptstateScoped,
}))

vi.mock(import('../../globalApi.svelte'), () => ({
  aiWatermarkingLawApplies: () => false,
  getFileSrc: () => Promise.resolve(''),
}))

vi.mock(import('../../stores.svelte'), () => {
  return {
    selIdState: {
      selId: 0,
    },
    selectedCharID: writable(0),
  } as typeof import('../../stores.svelte')
})

//#endregion

const anyValidDefaultVarKey = fc.string({ minLength: 1, unit: 'grapheme' }).filter((s) => !/[=\n]/.test(s))
const anyValidDefaultVarValue = fc
  .anything()
  .map(JSON.stringify)
  .filter((s) => s !== undefined && !/[=\n]/.test(s))

function selectedCharacter() {
  return charactersResourceState.characters[0]!
}

function selectedChat() {
  return selectedCharacter().chats[0]!
}

function markCharacterOwnersReady(): void {
  charactersResourceState.status = 'ready'
  charactersResourceState.currentChar = 0
}

function markPromptOwnerReady(templateDefaultVariables: string): void {
  collectionsResourceState.values.promptPresets = [
    {
      id: 'prompt-owner',
      templateDefaultVariables,
    },
  ] as never
  collectionsResourceState.statuses.promptPresets = 'ready'
  ;(settingsResourceState.value as Record<string, unknown>).promptPresetsId = 0
  settingsResourceState.standaloneStatuses.promptPresetsId = 'ready'
}

function setPromptOwnerDefaults(templateDefaultVariables: string): void {
  const preset = collectionsResourceState.values.promptPresets?.[0]
  if (preset) preset.templateDefaultVariables = templateDefaultVariables
}

beforeEach(() => {
  vi.resetAllMocks()
  resetServerResourceState()
  charactersResourceState.characters = [
    {
      chaId: 'compat-character',
      chatPage: 0,
      chats: [
        {
          id: 'compat-chat',
          scriptstate: {},
        },
      ],
      defaultVariables: '',
    },
  ] as never
  charactersResourceState.currentChar = 0
  settingsResourceState.value = {
    globalChatVariables: {},
  }
  markCharacterOwnersReady()
  markPromptOwnerReady('')
})

test('can get a character default variable', () => {
  fc.assert(
    fc.property(anyValidDefaultVarKey, anyValidDefaultVarValue, (key, value) => {
      selectedCharacter().defaultVariables = `${key}=${value}`
      expect(getChatVar(key)).toBe(value)
    }),
  )
})

test('can get a template default variable', () => {
  fc.assert(
    fc.property(anyValidDefaultVarKey, anyValidDefaultVarValue, (key, value) => {
      setPromptOwnerDefaults(`${key}=${value}`)
      expect(getChatVar(key)).toBe(value)
    }),
  )
})

test('can set and get a chat variable', () => {
  fc.assert(
    fc.property(
      fc.string({ unit: 'grapheme' }),
      fc
        .anything()
        .filter((v) => v !== undefined)
        .map(JSON.stringify),
      (key, value) => {
        setChatVar(key, value)
        expect(getChatVar(key)).toBe(value)
      },
    ),
  )
})

test('can set a chat variable over its default value', () => {
  selectedCharacter().defaultVariables = 'char=default'
  setPromptOwnerDefaults('template=default')

  setChatVar('char', 'overridden')
  setChatVar('template', 'overridden')

  expect(getChatVar('char')).toBe('overridden')
  expect(getChatVar('template')).toBe('overridden')
})

test('reports whether a chat variable write changed stored state', () => {
  expect(setChatVar('status', 'ready')).toBe(true)
  expect(setChatVar('status', 'ready')).toBe(false)
  expect(getChatVar('status')).toBe('ready')
})

test('can get a global chat variable', () => {
  fc.assert(
    fc.property(
      fc.string({ unit: 'grapheme' }),
      fc
        .anything()
        .filter((v) => v !== undefined)
        .map(JSON.stringify),
      (key, value) => {
        const variables = (settingsResourceState.value as Record<string, unknown>).globalChatVariables as Record<
          string,
          string
        >
        variables[`toggle_${key}`] = value

        expect(getGlobalChatVar(`toggle_${key}`)).toBe(value)
      },
    ),
  )
})

test('projects active-chat sidebar toggles over legacy global toggle variables', () => {
  selectedChat().generationSettings = {
    sidebarToggles: {
      title: '1',
    },
  }
  ;(settingsResourceState.value as Record<string, unknown>).globalChatVariables = {
    toggle_title: '0',
    ordinary: 'global',
  }

  expect(getGlobalChatVar('toggle_title')).toBe('1')
  expect(getGlobalChatVar('ordinary')).toBe('global')
  expect((settingsResourceState.value.globalChatVariables as Record<string, string>).toggle_title).toBe('0')
})

test('writes the ready active chat through its stable-id scriptstate owner and durable command path', () => {
  selectedCharacter().chaId = 'owner-character'
  selectedChat().id = 'owner-chat'
  markCharacterOwnersReady()

  expect(setChatVar('status', 'ready')).toBe(true)
  expect(selectedChat().scriptstate).toEqual({ $status: 'ready' })
  expect(chatVarMocks.dispatchPatchChatScriptstateScoped).toHaveBeenCalledWith('owner-chat', { $status: 'ready' }, [], {
    characterId: 'owner-character',
    chatId: 'owner-chat',
    selectedCharID: 0,
    scriptstate: {},
  })
})

test('uses the selected prompt preset owner for ready template defaults', () => {
  markCharacterOwnersReady()
  ;(settingsResourceState.value as Record<string, unknown>).templateDefaultVariables = 'source=compatibility'
  markPromptOwnerReady('source=owner')

  expect(getChatVar('source')).toBe('owner')
})

test('fails closed for duplicate ready character or chat stable ids', () => {
  markCharacterOwnersReady()
  charactersResourceState.characters.push({
    chaId: 'compat-character',
    chatPage: 0,
    defaultVariables: '',
    chats: [{ id: 'other-chat', scriptstate: { $status: 'duplicate-character' } }],
  } as never)

  expect(getChatVar('status')).toBe('null')
  expect(setChatVar('status', 'blocked')).toBe(false)

  charactersResourceState.characters[1]!.chaId = 'other-character'
  charactersResourceState.characters[1]!.chats = [
    { id: 'compat-chat', scriptstate: { $status: 'duplicate-chat' } },
  ] as never

  expect(getChatVar('status')).toBe('null')
  expect(setChatVar('status', 'blocked')).toBe(false)
  expect(chatVarMocks.dispatchPatchChatScriptstateScoped).not.toHaveBeenCalled()
})

test('fails closed before character owners are ready', () => {
  charactersResourceState.status = 'loading'
  charactersResourceState.characters.push({
    chaId: 'compat-character',
    chatPage: 0,
    defaultVariables: '',
    chats: [{ id: 'other-chat', scriptstate: {} }],
  } as never)

  expect(getChatVar('compatibility')).toBe('null')
  expect(setChatVar('compatibility', 'blocked')).toBe(false)
  expect(selectedChat().scriptstate).toEqual({})
  expect(chatVarMocks.dispatchPatchChatScriptstateScoped).not.toHaveBeenCalled()
})

test('does not reuse compatibility rows after the character owner fails', () => {
  charactersResourceState.status = 'error'

  expect(getChatVar('status')).toBe('null')
  expect(setChatVar('status', 'blocked')).toBe(false)
  expect(selectedChat().scriptstate).toEqual({})
  expect(chatVarMocks.dispatchPatchChatScriptstateScoped).not.toHaveBeenCalled()
})

test('returns "null" for undefined variables', () => {
  fc.assert(
    fc.property(fc.string({ unit: 'grapheme' }), (key) => {
      expect(getChatVar(key)).toBe('null')
      expect(getGlobalChatVar(`toggle_${key}`)).toBe('null')
    }),
  )
})
