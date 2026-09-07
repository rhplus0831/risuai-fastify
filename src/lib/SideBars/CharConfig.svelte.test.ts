import {
  beginWriterDraftCaptureTest,
  capturedWriterDrafts,
  endWriterDraftCaptureTest,
} from 'src/ts/__tests__/writerDraftCapture'
import { demoteClientSession } from 'src/ts/clientSession'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockSelectedFile = { name: string; data: Uint8Array }
type MockSingleFileRead = {
  selected: MockSelectedFile | null
  result: Promise<MockSelectedFile | null> | MockSelectedFile | null
}
type MockMultipleFileRead = {
  selected: MockSelectedFile[]
  result: Promise<MockSelectedFile[] | null> | MockSelectedFile[] | null
}

const chatCommandMocks = vi.hoisted(() => ({
  setCurrentChatGreetingIndex: vi.fn(),
}))

const selectedFileState = vi.hoisted(() => ({
  singleQueue: [] as Array<Promise<MockSelectedFile | null> | MockSingleFileRead | MockSelectedFile | null>,
  multipleQueue: [] as Array<Promise<MockSelectedFile[] | null> | MockMultipleFileRead | MockSelectedFile[] | null>,
}))

const transformerMocks = vi.hoisted(() => ({
  registerOnnxModelFromFileCalls: [] as Array<{
    file: MockSelectedFile
    options: { shouldContinue?: () => boolean } | undefined
  }>,
  registerOnnxModelFromFileQueue: [] as Array<Promise<unknown> | unknown>,
}))

const assetMocks = vi.hoisted(() => ({
  saveAsset: vi.fn(),
}))

const characterMediaMocks = vi.hoisted(() => ({
  selectCharacterAvatarImage: vi.fn(),
}))

const ttsCatalogMocks = vi.hoisted(() => ({
  getElevenTTSVoices: vi.fn(),
  getFishSpeechModels: vi.fn(),
}))

const serverCommandState = vi.hoisted(() => ({
  enabled: false,
  updateCharacterCalls: [] as Record<string, unknown>[],
  alternateGreetingCalls: [] as Record<string, unknown>[],
}))

const alternateGreetingMutationState = vi.hoisted(() => ({
  outcomes: [] as Array<'accepted' | 'queued' | 'failed' | Promise<'accepted' | 'queued' | 'failed'>>,
  settleQueued: [] as Array<(settlement: 'accepted' | 'discarded') => void>,
}))

const regexImportMocks = vi.hoisted(() => ({
  importRegexRows: vi.fn(),
}))

vi.mock('src/ts/server/commands', () => {
  const command =
    (kind: string) =>
    async (args: Record<string, unknown> = {}) => ({
      kind,
      ...args,
    })

  return {
    appendMessageCommand: command('appendMessage'),
    canUseServerCommands: () => serverCommandState.enabled,
    createAndSelectCharacterCommand: command('createAndSelectCharacter'),
    createCharacterCommand: command('createCharacter'),
    createChatCommand: command('createChat'),
    createChatFolderCommand: command('createChatFolder'),
    deleteCharacterCommand: command('deleteCharacter'),
    deleteChatCommand: command('deleteChat'),
    deleteChatFolderCommand: command('deleteChatFolder'),
    deleteMessageCommand: command('deleteMessage'),
    forkChatCommand: command('forkChat'),
    patchChatScriptstateCommand: command('patchChatScriptstate'),
    reorderCharacterFoldersCommand: command('reorderCharacterFolders'),
    reorderCharactersCommand: command('reorderCharacters'),
    reorderChatFoldersCommand: command('reorderChatFolders'),
    reorderChatsCommand: command('reorderChats'),
    replaceCharacterScriptsCommand: command('replaceCharacterScripts'),
    replaceCharacterTriggersCommand: command('replaceCharacterTriggers'),
    replaceMessagesCommand: command('replaceMessages'),
    replaceModuleScriptsCommand: command('replaceModuleScripts'),
    replaceModuleTriggersCommand: command('replaceModuleTriggers'),
    replaceTailMessagesCommand: command('replaceTailMessages'),
    mutateAlternateGreetingsCommand: vi.fn(async (args: Record<string, unknown> = {}) => {
      serverCommandState.alternateGreetingCalls.push(structuredClone(args))
      return { status: 'ok', kind: 'mutateAlternateGreetings', ...args }
    }),
    runServerCommand: vi.fn(async ({ command: buildCommand }: { command?: (baseRevision: number) => unknown }) => {
      if (buildCommand) await buildCommand(1)
      return { status: 'ok', revision: 1 }
    }),
    saveChatGenerationSettingsCommand: command('saveChatGenerationSettings'),
    selectCharacterCommand: command('selectCharacter'),
    subscribeServerCommandLocalEffectApplied: vi.fn(() => () => {}),
    truncateMessagesCommand: command('truncateMessages'),
    updateCharacterCommand: vi.fn(async (args: Record<string, unknown> = {}) => {
      serverCommandState.updateCharacterCalls.push(structuredClone(args))
      return { kind: 'updateCharacter', ...args }
    }),
    updateChatCommand: command('updateChat'),
    updateChatFolderCommand: command('updateChatFolder'),
    updateMessageCommand: command('updateMessage'),
  }
})

vi.mock('src/ts/alternateGreetingCommands', () => ({
  dispatchDurableAlternateGreetingMutation: vi.fn(
    async (input: {
      characterId: string
      alternateGreetings: string[]
      operation: Record<string, unknown>
      chatGreetingIndices: Array<{ chatId: string; fmIndex: number }>
      applyOptimistic: () => void
      rollback: () => void
      onFinalSettlement?: (settlement: 'accepted' | 'discarded') => void
    }) => {
      serverCommandState.alternateGreetingCalls.push(
        structuredClone({
          characterId: input.characterId,
          alternateGreetings: input.alternateGreetings,
          operation: input.operation,
          chatGreetingIndices: input.chatGreetingIndices,
        }),
      )
      input.applyOptimistic()
      const result = await (alternateGreetingMutationState.outcomes.shift() ?? 'accepted')
      if (result === 'failed') input.rollback()
      if (result === 'queued') {
        alternateGreetingMutationState.settleQueued.push((settlement) => {
          if (settlement === 'discarded') input.rollback()
          input.onFinalSettlement?.(settlement)
        })
      }
      return result
    },
  ),
}))

vi.mock('src/ts/chatCommands', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/chatCommands')>()

  return {
    ...actual,
    setCurrentChatGreetingIndex: (
      ...args: Parameters<typeof actual.setCurrentChatGreetingIndex>
    ): ReturnType<typeof actual.setCurrentChatGreetingIndex> => {
      chatCommandMocks.setCurrentChatGreetingIndex(...args)
      return actual.setCurrentChatGreetingIndex(...args)
    },
  }
})

vi.mock('src/ts/tokenizer', () => ({
  tokenizeAccurate: vi.fn(async () => 0),
}))

vi.mock('../../ts/characters', async () => {
  const { writable } = await import('svelte/store')

  return {
    addCharEmotion: vi.fn(),
    addingEmotion: writable(false),
    changeCharImage: vi.fn(),
    createBlankChar: vi.fn(() => ({ name: 'Blank' })),
    getCharImage: vi.fn(async (location: string, type: string) =>
      type === 'plain' ? location : `background: url("${location}");`,
    ),
    removeChar: vi.fn(),
    rmCharEmotion: vi.fn(),
    selectCharacterAvatarImage: characterMediaMocks.selectCharacterAvatarImage,
    selectCharImg: vi.fn(),
  }
})

vi.mock('../../ts/filePicker', () => {
  return {
    selectMultipleFile: vi.fn(
      async (_extensions: string[], options: { onFilesSelected?: (files: File[]) => void } = {}) => {
        const queued = selectedFileState.multipleQueue.shift()
        if (queued && typeof queued === 'object' && 'selected' in queued && 'result' in queued) {
          if (queued.selected.length > 0) {
            options.onFilesSelected?.(queued.selected as unknown as File[])
          }
          return queued.result ? await queued.result : queued.result
        }

        const selected = queued ? await queued : queued
        if (Array.isArray(selected) && selected.length > 0) {
          options.onFilesSelected?.(selected as unknown as File[])
        }
        return selected
      },
    ),
    selectSingleFile: vi.fn(async (_extensions: string[], options: { onFileSelected?: (file: File) => void } = {}) => {
      const queued = selectedFileState.singleQueue.shift()
      if (queued && typeof queued === 'object' && 'selected' in queued && 'result' in queued) {
        if (queued.selected) {
          options.onFileSelected?.(queued.selected as unknown as File)
        }
        return queued.result ? await queued.result : queued.result
      }

      const selected = queued ? await queued : queued
      if (selected) {
        options.onFileSelected?.(selected as unknown as File)
      }
      return selected
    }),
  }
})

vi.mock('src/ts/characterCards', () => ({
  exportChar: vi.fn(),
  hubURL: 'https://example.test',
}))

vi.mock('src/ts/globalApi.svelte', () => ({
  aiWatermarkingLawApplies: false,
  downloadFile: vi.fn(),
  getFileSrc: vi.fn(async () => ''),
  globalFetch: vi.fn(async () => new Response('{}')),
  saveAsset: assetMocks.saveAsset,
}))

vi.mock('src/ts/process/inlayScreen', () => ({
  updateInlayScreen: vi.fn((character: unknown) => character),
}))

vi.mock('src/ts/process/modules', () => ({
  applyModule: vi.fn(),
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModules: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))

vi.mock('src/ts/process/scripts', () => ({
  exportRegex: vi.fn(),
  importRegexRows: regexImportMocks.importRegexRows,
  resetScriptCache: vi.fn(),
}))

vi.mock('src/ts/process/transformers', () => ({
  registerOnnxModelFromFile: vi.fn(async (file, options) => {
    transformerMocks.registerOnnxModelFromFileCalls.push({ file, options })
    const next = transformerMocks.registerOnnxModelFromFileQueue.shift()
    return next ? await next : null
  }),
}))

vi.mock('src/ts/process/tts', () => ({
  getElevenTTSVoices: ttsCatalogMocks.getElevenTTSVoices,
  getFishSpeechModels: ttsCatalogMocks.getFishSpeechModels,
  getNovelAIVoices: vi.fn(() => []),
  getVOICEVOXVoices: vi.fn(() => []),
  getWebSpeechTTSVoices: vi.fn((synthesis?: Pick<SpeechSynthesis, 'getVoices'>) =>
    (synthesis?.getVoices() ?? []).map((voice) => voice.name),
  ),
  oaiVoices: [],
}))

vi.mock('../Others/Help.svelte', async () => {
  const mock = await import('./CharConfig.testHelp.svelte')
  return { default: mock.default }
})

vi.mock('../UI/GUI/TextAreaInput.svelte', async () => {
  const mock = await import('./CharConfig.testTextAreaInput.svelte')
  return { default: mock.default }
})

vi.mock('../UI/GUI/MultiLangInput.svelte', async () => {
  const mock = await import('./CharConfig.testMultiLangInput.svelte')
  return { default: mock.default }
})

vi.mock('./Scripts/RegexList.svelte', async () => {
  const mock = await import('./CharConfig.testRegexList.svelte')
  return { default: mock.default }
})

vi.mock('./Scripts/TriggerList.svelte', async () => {
  const mock = await import('./CharConfig.testTriggerList.svelte')
  return { default: mock.default }
})

import CharConfig from './CharConfig.svelte'
import { CharConfigSubMenu, MobileGUI, selectedCharID } from 'src/ts/stores.svelte'
import { setDatabaseLite, type character } from 'src/ts/storage/database.svelte'
import {
  applyChatMetadataOwnerPatch,
  charactersResourceState,
  settingsResourceState,
} from 'src/ts/server/resourceState.svelte'
import { language } from 'src/lang'
import { CHARACTER_SCRIPT_DEFINITION_SAVE_DELAY_MS } from 'src/ts/server/scriptDefinitionOwner.svelte'
import { getDatabase, getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

let target: HTMLElement
let component: MountedComponent | undefined

function makeCharacter(fields: Partial<character> = {}): character {
  return {
    type: 'character',
    chaId: 'char-1',
    name: 'Character A',
    displayName: '',
    image: '',
    firstMessage: 'Hello',
    desc: 'Description',
    notes: '',
    chats: [
      {
        id: 'chat-1',
        name: 'Chat',
        message: [],
        fmIndex: 2,
      },
    ],
    chatFolders: [],
    chatPage: 0,
    viewScreen: 'none',
    bias: [],
    emotionImages: [],
    globalLore: [],
    sdData: [],
    newGenData: {
      prompt: '',
      negative: '',
      instructions: '',
      emotionInstructions: '',
    },
    customscript: [],
    triggerscript: [],
    utilityBot: false,
    exampleMessage: '',
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    tags: [],
    creator: '',
    characterVersion: '',
    personality: '',
    scenario: '',
    firstMsgIndex: 0,
    replaceGlobalNote: '',
    additionalText: '',
    additionalData: {
      creator: '',
      character_version: '',
    },
    depth_prompt: {
      depth: 4,
      prompt: '',
    },
    defaultVariables: '',
    translatorNote: '',
    lowLevelAccess: false,
    ...fields,
  } as character
}

async function settleComponent(): Promise<void> {
  await tick()
  await Promise.resolve()
  await tick()
}

async function mountCharConfig(
  subMenu: number,
  characterFields: Partial<character> = {},
  initialSubMenu = 0,
): Promise<void> {
  setDatabaseLite({
    characters: [makeCharacter(characterFields)],
    currentChar: 0,
    fishSpeechKey: '',
    hypaV3: false,
    newImageHandlingBeta: false,
    showDeprecatedTriggerV1: false,
    showUnrecommended: false,
    useAdditionalAssetsPreview: false,
  } as never)
  selectedCharID.set(0)
  CharConfigSubMenu.set(initialSubMenu)
  MobileGUI.set(true)

  target = document.createElement('div')
  document.body.appendChild(target)
  component = mount(CharConfig, { target })
  await settleComponent()

  if (initialSubMenu !== subMenu) {
    CharConfigSubMenu.set(subMenu)
    await settleComponent()
  }
}

function buttons(): HTMLButtonElement[] {
  return Array.from(target.querySelectorAll('button'))
}

function buttonByText(text: string): HTMLButtonElement {
  const button = buttons().find((candidate) => candidate.textContent?.trim() === text)
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

function buttonByAccessibleName(name: string): HTMLButtonElement {
  const button = buttons().find((candidate) => candidate.getAttribute('aria-label') === name)
  expect(button, `button named ${name}`).toBeTruthy()
  return button as HTMLButtonElement
}

function selectedFile(name: string, data = new Uint8Array([1, 2, 3])): MockSelectedFile {
  return { name, data }
}

function notificationImageAddButton(): HTMLButtonElement {
  const tile = target.querySelector('div.h-20.w-20.border-dashed')
  const button = tile?.closest('button')
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

function notificationImageClearButton(): HTMLButtonElement {
  const card = notificationImageAddButton().closest('div.p-2.border-darkborderc')
  const button = card?.querySelector('button.text-textcolor2')
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

function avatarAddButton(): HTMLButtonElement {
  const tile = target.querySelector('div.h-24.w-24.border-dashed')
  const button = tile?.closest('button')
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

async function showCharacterViewScreen(): Promise<void> {
  buttons()[1].click()
  await settleComponent()
}

function emotionAddButton(): HTMLButtonElement {
  const button = target.querySelector('svg.lucide-plus')?.closest('button')
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  chatCommandMocks.setCurrentChatGreetingIndex.mockClear()
  selectedFileState.singleQueue.length = 0
  selectedFileState.multipleQueue.length = 0
  transformerMocks.registerOnnxModelFromFileCalls.length = 0
  transformerMocks.registerOnnxModelFromFileQueue.length = 0
  characterMediaMocks.selectCharacterAvatarImage.mockReset().mockResolvedValue(undefined)
  ttsCatalogMocks.getElevenTTSVoices.mockReset().mockResolvedValue([])
  ttsCatalogMocks.getFishSpeechModels.mockReset().mockResolvedValue([])
  serverCommandState.enabled = false
  serverCommandState.updateCharacterCalls.length = 0
  serverCommandState.alternateGreetingCalls.length = 0
  alternateGreetingMutationState.outcomes.length = 0
  alternateGreetingMutationState.settleQueued.length = 0
  regexImportMocks.importRegexRows.mockReset().mockResolvedValue(null)
  assetMocks.saveAsset.mockReset().mockResolvedValue('asset-id')
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(performance.now()), 0)
  })
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target?.remove()
  document.body.innerHTML = ''
  selectedCharID.set(-1)
  serverCommandState.enabled = false
  CharConfigSubMenu.set(0)
  MobileGUI.set(false)
  setDatabaseLite({} as never)
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('CharConfig desktop section navigation', () => {
  it('names every section and exposes the selected section', async () => {
    await mountCharConfig(0)
    MobileGUI.set(false)
    await settleComponent()

    const expectedNames = {
      profile: language.character,
      display: language.characterDisplay,
      lorebook: language.loreBook,
      tts: 'TTS',
      scripts: language.scripts,
      advanced: language.advancedSettings,
      manage: `${language.exportCharacter} / ${language.removeCharacter}`,
    }
    const sectionButtons = Array.from(target.querySelectorAll<HTMLButtonElement>('[data-char-config-section]'))
    expect(sectionButtons).toHaveLength(7)
    for (const button of sectionButtons) {
      const section = button.dataset.charConfigSection as keyof typeof expectedNames
      expect(button.getAttribute('aria-label')).toBe(expectedNames[section])
      expect(button.title).toBe(expectedNames[section])
      expect(button.getAttribute('aria-pressed')).toBe(section === 'profile' ? 'true' : 'false')
    }

    target.querySelector<HTMLButtonElement>('[data-char-config-section="scripts"]')?.click()
    await settleComponent()
    expect(target.querySelector('[data-char-config-section="profile"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(target.querySelector('[data-char-config-section="scripts"]')?.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('CharConfig initial draft rendering', () => {
  it('mounts directly on Advanced when the selected character has no bias array', async () => {
    await mountCharConfig(2, { bias: undefined }, 2)

    expect(target.textContent).toContain(language.noBias)
    expect(buttonByAccessibleName(`${language.add}: Bias`)).toBeTruthy()
  })

  it('seeds ordinary editor reads from the ready owner when the aggregate row is stale', async () => {
    setDatabaseLite({
      characters: [makeCharacter({ name: 'Aggregate stale' })],
      currentChar: 0,
      fishSpeechKey: '',
      hypaV3: false,
      newImageHandlingBeta: false,
      showDeprecatedTriggerV1: false,
      showUnrecommended: false,
      useAdditionalAssetsPreview: false,
    } as never)
    const staleAggregate = getResourceDatabase().characters
    charactersResourceState.characters = [makeCharacter({ name: 'Owner current' })]
    selectedCharID.set(0)
    CharConfigSubMenu.set(0)
    MobileGUI.set(true)

    target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(CharConfig, { target })
    await settleComponent()

    expect(staleAggregate[0].name).toBe('Aggregate stale')
    expect((target.querySelector('input[aria-label="Character Name"]') as HTMLInputElement)?.value).toBe(
      'Owner current',
    )
  })

  it('hides editable controls when the ready owner selection is ambiguous', async () => {
    setDatabaseLite({
      characters: [makeCharacter({ name: 'Aggregate fallback' })],
      currentChar: 0,
      fishSpeechKey: '',
      hypaV3: false,
      newImageHandlingBeta: false,
      showDeprecatedTriggerV1: false,
      showUnrecommended: false,
      useAdditionalAssetsPreview: false,
    } as never)
    charactersResourceState.characters = [makeCharacter(), makeCharacter({ name: 'Duplicate' })]
    selectedCharID.set(0)
    CharConfigSubMenu.set(0)
    MobileGUI.set(false)

    target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(CharConfig, { target })
    await settleComponent()

    expect(target.querySelector('[data-char-config-section="tts"]')).toBeNull()
    expect(target.querySelector('[data-char-config-section="manage"]')).toBeNull()
  })

  it('does not revive the aggregate character row after the owner reports an error', async () => {
    setDatabaseLite({
      characters: [makeCharacter({ name: 'Aggregate fallback' })],
      currentChar: 0,
    } as never)
    charactersResourceState.status = 'error'
    charactersResourceState.error = 'owner unavailable'
    selectedCharID.set(0)
    CharConfigSubMenu.set(0)
    MobileGUI.set(false)

    target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(CharConfig, { target })
    await settleComponent()

    expect(target.querySelector('[data-char-config-section="tts"]')).toBeNull()
    expect(target.querySelector('[data-char-config-section="manage"]')).toBeNull()
  })
})

describe('CharConfig settings owners', () => {
  it('reacts to exact advanced and memory owner values', async () => {
    await mountCharConfig(2, { virtualscript: '', personality: '', scenario: '' })

    expect(target.querySelector(`textarea[aria-label="${language.personality}"]`)).toBeNull()
    expect(target.querySelector(`textarea[aria-label="${language.scenario}"]`)).toBeNull()
    expect(buttons().some((button) => button.textContent?.trim() === language.hypaMemoryV3Modal)).toBe(false)

    settingsResourceState.value.showUnrecommended = true
    settingsResourceState.value.hypaV3 = true
    await settleComponent()

    expect(target.querySelector(`textarea[aria-label="${language.personality}"]`)).toBeTruthy()
    expect(target.querySelector(`textarea[aria-label="${language.scenario}"]`)).toBeTruthy()
    expect(buttonByText(language.hypaMemoryV3Modal)).toBeTruthy()
  })

  it('reacts to the display and media owners in the additional-assets editor', async () => {
    await mountCharConfig(1, { additionalAssets: [['portrait', 'asset-1', 'png']] })
    buttonByText(language.additionalAssets).click()
    await settleComponent()

    expect(target.querySelector(`input[aria-label="${language.insertAssetPrompt}"]`)).toBeNull()
    expect(buttons().some((button) => button.getAttribute('aria-label') === `${language.image}: portrait`)).toBe(false)

    settingsResourceState.value.newImageHandlingBeta = true
    settingsResourceState.value.useAdditionalAssetsPreview = true
    await settleComponent()

    expect(target.querySelector(`input[aria-label="${language.insertAssetPrompt}"]`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.image}: portrait`)).toBeTruthy()
  })

  it('fails closed instead of rendering a stale setting after its owner errors', async () => {
    await mountCharConfig(2, { personality: '' })
    settingsResourceState.value.showUnrecommended = true
    settingsResourceState.groupStatuses.advanced = 'error'
    await settleComponent()

    expect(target.querySelector(`textarea[aria-label="${language.personality}"]`)).toBeNull()
  })
})

describe('CharConfig retired additional description', () => {
  it('preserves imported data while replacing the editor with an unsupported notice', async () => {
    await mountCharConfig(2, { additionalText: 'Imported private appendix' })

    expect(target.querySelector(`textarea[aria-label="${language.additionalText}"]`)).toBeNull()
    expect(target.querySelector('[data-risu-additional-text-unsupported="true"]')?.textContent).toContain(
      language.additionalTextUnsupported,
    )
    expect(getDatabase().characters[0].additionalText).toBe('Imported private appendix')
  })

  it('hides the retired surface when no imported data exists', async () => {
    await mountCharConfig(2, { additionalText: '' })

    expect(target.querySelector('[data-risu-additional-text-unsupported="true"]')).toBeNull()
    expect(target.querySelector(`textarea[aria-label="${language.additionalText}"]`)).toBeNull()
  })
})

describe('CharConfig editor action accessibility', () => {
  it('names media actions and exposes display and removal toggle state', async () => {
    await mountCharConfig(1, {
      image: 'primary-avatar',
      ccAssets: [{ type: 'icon', name: 'alternate', uri: 'alternate-avatar', ext: 'png' }],
      notificationImage: 'notification-image',
      additionalAssets: [['portrait', 'asset-1', 'png']],
    })

    const iconTab = buttonByText(language.charIcon)
    const viewTab = buttonByText(language.viewScreen)
    const assetsTab = buttonByText(language.additionalAssets)
    expect(iconTab.getAttribute('aria-pressed')).toBe('true')
    expect(viewTab.getAttribute('aria-pressed')).toBe('false')
    expect(assetsTab.getAttribute('aria-pressed')).toBe('false')

    expect(buttonByAccessibleName(`${language.select}: ${language.charIcon}`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.select}: ${language.charIcon} 2`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.add}: ${language.charIcon}`)).toBe(avatarAddButton())
    expect(buttonByAccessibleName(`${language.remove}: ${language.notificationImage}`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.edit}: ${language.notificationImage}`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.add}: ${language.notificationImage}`)).toBeTruthy()

    const removeMode = buttonByAccessibleName(`${language.remove}: ${language.charIcon}`)
    expect(removeMode.getAttribute('aria-pressed')).toBe('false')
    removeMode.click()
    await settleComponent()
    expect(removeMode.getAttribute('aria-pressed')).toBe('true')
    expect(buttonByAccessibleName(`${language.remove}: ${language.charIcon}`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.remove}: ${language.charIcon} 2`)).toBeTruthy()

    assetsTab.click()
    await settleComponent()
    expect(iconTab.getAttribute('aria-pressed')).toBe('false')
    expect(assetsTab.getAttribute('aria-pressed')).toBe('true')
    expect(buttonByAccessibleName(`${language.add}: ${language.additionalAssets}`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.remove}: portrait`)).toBeTruthy()
  })

  it('identifies repeated bias and alternate greeting actions by row', async () => {
    await mountCharConfig(2, {
      bias: [['token', 1]],
      alternateGreetings: ['First alternate', 'Second alternate'],
    })

    expect(buttonByAccessibleName(`${language.add}: Bias`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.remove}: Bias 1`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.add}: ${language.altGreet}`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.moveUp}: ${language.altGreet} 1`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.moveDown}: ${language.altGreet} 1`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.remove}: ${language.altGreet} 1`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.moveUp}: ${language.altGreet} 2`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.moveDown}: ${language.altGreet} 2`)).toBeTruthy()
    expect(buttonByAccessibleName(`${language.remove}: ${language.altGreet} 2`)).toBeTruthy()
  })
})

describe('CharConfig character media callback freshness contracts', () => {
  it('updates compact navigation icon sizing when the viewport crosses 360px', async () => {
    await mountCharConfig(0)
    MobileGUI.set(false)
    await settleComponent()

    const navigationUserIcon = () => target.querySelector<SVGElement>('svg.lucide-user')
    expect(navigationUserIcon()?.getAttribute('width')).toBe('24')

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 350 })
    window.dispatchEvent(new Event('resize'))
    await settleComponent()
    expect(navigationUserIcon()?.getAttribute('width')).toBe('20')

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 })
    window.dispatchEvent(new Event('resize'))
    await settleComponent()
    expect(navigationUserIcon()?.getAttribute('width')).toBe('24')
  })

  it('keeps an older delayed VITS picker read from superseding a newer selection', async () => {
    const olderFile = selectedFile('older.zip', new Uint8Array([1]))
    const newerFile = selectedFile('newer.zip', new Uint8Array([2]))
    const olderRead = deferred<MockSelectedFile | null>()
    const newerRegistration = deferred<unknown>()
    selectedFileState.singleQueue.push({ selected: olderFile, result: olderRead.promise }, newerFile)
    transformerMocks.registerOnnxModelFromFileQueue.push(newerRegistration.promise)

    await mountCharConfig(5, {
      ttsMode: 'vits',
      vits: undefined,
    })

    buttonByText('Select Model').click()
    await settleComponent()
    expect(transformerMocks.registerOnnxModelFromFileCalls).toHaveLength(0)

    buttonByText('Select Model').click()
    await settleComponent()
    expect(transformerMocks.registerOnnxModelFromFileCalls).toHaveLength(1)
    expect(transformerMocks.registerOnnxModelFromFileCalls[0].file.name).toBe('newer.zip')

    olderRead.resolve(olderFile)
    await settleComponent()
    expect(transformerMocks.registerOnnxModelFromFileCalls).toHaveLength(1)

    newerRegistration.resolve({
      files: { 'model.onnx': 'newer-model-asset' },
      id: 'newer-model-id',
      name: 'newer-model',
    })
    await settleComponent()

    expect(getDatabase().characters[0].vits).toEqual({
      files: { 'model.onnx': 'newer-model-asset' },
      id: 'newer-model-id',
      name: 'newer-model',
    })
  })

  it('keeps an older delayed notification-image read from superseding a newer selection', async () => {
    const olderFile = selectedFile('older.png', new Uint8Array([1]))
    const newerFile = selectedFile('newer.png', new Uint8Array([2]))
    const olderRead = deferred<MockSelectedFile | null>()
    selectedFileState.singleQueue.push({ selected: olderFile, result: olderRead.promise }, newerFile)
    assetMocks.saveAsset.mockResolvedValueOnce('newer-notification-asset')

    await mountCharConfig(1, { notificationImage: 'original-notification-asset' })

    notificationImageAddButton().click()
    await settleComponent()
    expect(assetMocks.saveAsset).not.toHaveBeenCalled()

    notificationImageAddButton().click()
    await settleComponent()

    expect(assetMocks.saveAsset).toHaveBeenCalledTimes(1)
    expect(assetMocks.saveAsset).toHaveBeenCalledWith(newerFile.data, '', newerFile.name)
    expect(getDatabase().characters[0].notificationImage).toBe('newer-notification-asset')

    olderRead.resolve(olderFile)
    await settleComponent()

    expect(assetMocks.saveAsset).toHaveBeenCalledTimes(1)
    expect(getDatabase().characters[0].notificationImage).toBe('newer-notification-asset')
  })

  it('keeps a clear made while an older notification-image upload is pending', async () => {
    const olderFile = selectedFile('older.png', new Uint8Array([3]))
    const olderUpload = deferred<string>()
    selectedFileState.singleQueue.push(olderFile)
    assetMocks.saveAsset.mockReturnValueOnce(olderUpload.promise)

    await mountCharConfig(1, { notificationImage: 'original-notification-asset' })

    notificationImageAddButton().click()
    await settleComponent()

    expect(assetMocks.saveAsset).toHaveBeenCalledWith(olderFile.data, '', olderFile.name)

    notificationImageClearButton().click()
    await settleComponent()
    expect(getDatabase().characters[0].notificationImage).toBe('')

    olderUpload.resolve('older-notification-asset')
    await settleComponent()

    expect(getDatabase().characters[0].notificationImage).toBe('')
  })
})

describe('CharConfig Web Speech voice catalog', () => {
  it('renders and selects a voice that arrives after voiceschanged, then removes the listener', async () => {
    let voices: SpeechSynthesisVoice[] = []
    const synthesis = new EventTarget() as EventTarget & Pick<SpeechSynthesis, 'getVoices'>
    Object.defineProperty(synthesis, 'getVoices', {
      configurable: true,
      value: vi.fn(() => voices),
    })
    const addEventListener = vi.spyOn(synthesis, 'addEventListener')
    const removeEventListener = vi.spyOn(synthesis, 'removeEventListener')
    vi.stubGlobal('speechSynthesis', synthesis)

    await mountCharConfig(5, {
      ttsMode: 'webspeech',
      ttsSpeech: '',
    })

    expect(target.querySelector('option[value="Delayed Browser Voice"]')).toBeNull()
    expect(addEventListener).toHaveBeenCalledWith('voiceschanged', expect.any(Function))

    voices = [{ name: 'Delayed Browser Voice' } as SpeechSynthesisVoice]
    synthesis.dispatchEvent(new Event('voiceschanged'))
    await settleComponent()

    const delayedVoice = target.querySelector<HTMLOptionElement>('option[value="Delayed Browser Voice"]')
    expect(delayedVoice?.textContent).toBe('Delayed Browser Voice')

    const voiceSelect = delayedVoice?.closest('select') as HTMLSelectElement
    voiceSelect.value = 'Delayed Browser Voice'
    expect(delayedVoice?.disabled).toBe(false)
    expect(voiceSelect.value).toBe('Delayed Browser Voice')

    unmount(component as MountedComponent)
    component = undefined
    expect(removeEventListener).toHaveBeenCalledWith('voiceschanged', expect.any(Function))
  })
})

describe('CharConfig remote TTS catalogs', () => {
  it.each([
    { mode: 'elevenlab', load: () => ttsCatalogMocks.getElevenTTSVoices },
    { mode: 'fishspeech', load: () => ttsCatalogMocks.getFishSpeechModels },
  ])('contains a $mode catalog failure instead of rejecting the settings view', async ({ mode, load }) => {
    load().mockRejectedValueOnce(new Error('provider unavailable'))

    await mountCharConfig(5, { ttsMode: mode })

    expect(target.textContent).toContain('Unable to load the TTS voice catalog.')
  })

  it('keeps the TTS editor usable when an imported VOICEVOX speaker catalog is malformed', async () => {
    await mountCharConfig(5, {
      ttsMode: 'VOICEVOX',
      ttsSpeech: '',
      voicevoxConfig: {
        speaker: 'not-json',
        SPEED_SCALE: 1,
        PITCH_SCALE: 0,
        VOLUME_SCALE: 1,
        INTONATION_SCALE: 1,
      },
    })

    expect(target.querySelector('select[aria-label="Speaker"]')).toBeTruthy()
    expect(target.querySelector('select[aria-label="Style"]')).toBeTruthy()
    expect(target.querySelectorAll('select[aria-label="Style"] option')).toHaveLength(0)
  })
})

describe('CharConfig TTS control accessible names', () => {
  it('names the character identity fields from their visible settings', async () => {
    await mountCharConfig(0)

    const names = Array.from(target.querySelectorAll<HTMLElement>('input, textarea, [role="textbox"]'), (control) =>
      control.getAttribute('aria-label'),
    )

    expect(names).toEqual(
      expect.arrayContaining([
        'Character Name',
        language.displayName,
        language.description,
        language.firstMessage,
        language.customNotificationMessage,
      ]),
    )
  })

  it.each([
    { mode: 'novelai', name: language.ttsCustomVoiceSeed },
    { mode: 'openai', name: language.ttsAdvancedEndpoint },
    { mode: 'fishspeech', name: language.ttsNormalize },
  ])('names the $mode option checkbox from its visible setting', async ({ mode, name }) => {
    await mountCharConfig(5, { ttsMode: mode })

    const checkbox = Array.from(target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
      (input) => input.getAttribute('aria-label') === name,
    )

    expect(checkbox, `checkbox named ${name}`).toBeTruthy()
    expect(target.textContent).toContain(name)
  })

  it('names every GPT-SoVITS range and option checkbox from its visible setting', async () => {
    await mountCharConfig(5, { ttsMode: 'gptsovits' })

    const sliderNames = Array.from(target.querySelectorAll<HTMLElement>('[role="slider"]'), (slider) =>
      slider.getAttribute('aria-label'),
    )
    const expectedSliderNames = [
      language.ttsVolume,
      language.modelProfiles.runtimeFields.topP,
      language.temperature,
      language.ttsSpeed,
      language.modelProfiles.runtimeFields.topK,
    ]
    expect(sliderNames).toEqual(expectedSliderNames)

    const checkboxNames = Array.from(target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'), (checkbox) =>
      checkbox.getAttribute('aria-label'),
    )
    for (const name of [language.ttsUseAutoPath, language.ttsUseLongAudio, language.ttsUseReferenceAudioScript]) {
      expect(checkboxNames).toContain(name)
      expect(target.textContent).toContain(name)
    }
  })
})

describe('CharConfig draft-backed avatar and emotion controls', () => {
  it('renders an alternate avatar rotation immediately and emits one debounced character patch', async () => {
    serverCommandState.enabled = true
    await mountCharConfig(1, {
      image: 'primary-avatar',
      ccAssets: [{ type: 'icon', name: 'alternate', uri: 'alternate-avatar', ext: 'png' }],
    })

    const alternateTile = Array.from(target.querySelectorAll<HTMLElement>('div.h-24.w-24.shadow-lg')).find((tile) =>
      tile.getAttribute('style')?.includes('alternate-avatar'),
    )
    expect(alternateTile).toBeTruthy()
    ;(alternateTile?.closest('button') as HTMLButtonElement).click()
    await settleComponent()

    const renderedAvatars = Array.from(target.querySelectorAll<HTMLElement>('div.h-24.w-24.shadow-lg')).map((tile) =>
      tile.getAttribute('style'),
    )
    expect(renderedAvatars[0]).toContain('alternate-avatar')
    expect(renderedAvatars[1]).toContain('primary-avatar')
    expect(getDatabase().characters[0]).toMatchObject({
      image: 'alternate-avatar',
      ccAssets: [{ type: 'icon', name: 'iconx', uri: 'primary-avatar', ext: 'png' }],
    })
    expect(serverCommandState.updateCharacterCalls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(301)
    await settleComponent()

    expect(serverCommandState.updateCharacterCalls).toHaveLength(1)
    expect(serverCommandState.updateCharacterCalls[0]).toMatchObject({
      characterId: 'char-1',
      patch: {
        image: 'alternate-avatar',
        ccAssets: [{ type: 'icon', name: 'iconx', uri: 'primary-avatar', ext: 'png' }],
      },
    })
  })

  it('applies a guarded avatar selection to the draft, including PNG metadata', async () => {
    characterMediaMocks.selectCharacterAvatarImage.mockImplementationOnce(async (_index, onSelected) => {
      onSelected({
        image: 'uploaded-avatar',
        pngExif: { Description: 'uploaded metadata' },
      })
    })

    await mountCharConfig(1, {
      image: 'primary-avatar',
      ccAssets: [{ type: 'icon', name: 'prior', uri: 'prior-avatar', ext: 'png' }],
      extentions: { pngExif: { Title: 'existing metadata' } },
    })

    avatarAddButton().click()
    await settleComponent()

    expect(characterMediaMocks.selectCharacterAvatarImage).toHaveBeenCalledTimes(1)
    expect(getDatabase().characters[0]).toMatchObject({
      image: 'uploaded-avatar',
      ccAssets: [
        { type: 'icon', name: 'prior', uri: 'prior-avatar', ext: 'png' },
        { type: 'icon', name: 'iconx', uri: 'primary-avatar', ext: 'png' },
      ],
      extentions: {
        pngExif: {
          Title: 'existing metadata',
          Description: 'uploaded metadata',
        },
      },
    })
    expect(
      Array.from(target.querySelectorAll<HTMLElement>('div.h-24.w-24.shadow-lg'))[0].getAttribute('style'),
    ).toContain('uploaded-avatar')
  })

  it('renders emotion additions and deletions from the character draft immediately', async () => {
    selectedFileState.multipleQueue.push([selectedFile('happy.webp')])
    assetMocks.saveAsset.mockResolvedValueOnce('happy-upload')
    await mountCharConfig(1, { viewScreen: 'emotion' })
    await showCharacterViewScreen()

    emotionAddButton().click()
    await settleComponent()

    expect(assetMocks.saveAsset).toHaveBeenCalledWith(expect.any(Uint8Array), '', 'happy.webp')
    expect(target.querySelector('img[src="happy-upload"]')).toBeTruthy()
    expect(
      Array.from(target.querySelectorAll<HTMLInputElement>('input')).some((input) => input.value === 'happy'),
    ).toBe(true)
    expect(getDatabase().characters[0].emotionImages).toEqual([['happy', 'happy-upload']])

    const emotionRow = target.querySelector('img[src="happy-upload"]')?.closest('tr')
    ;(emotionRow?.querySelector('button') as HTMLButtonElement).click()
    await settleComponent()

    expect(target.querySelector('img[src="happy-upload"]')).toBeNull()
    expect(getDatabase().characters[0].emotionImages).toEqual([])
  })

  it('does not restore an emotion upload after the draft list changes while saving', async () => {
    const pendingUpload = deferred<string>()
    selectedFileState.multipleQueue.push([selectedFile('stale.gif')])
    assetMocks.saveAsset.mockReturnValueOnce(pendingUpload.promise)
    await mountCharConfig(1, {
      viewScreen: 'emotion',
      emotionImages: [['existing', 'existing-emotion']],
    })
    await showCharacterViewScreen()

    emotionAddButton().click()
    await settleComponent()
    expect(assetMocks.saveAsset).toHaveBeenCalledTimes(1)

    const existingRow = target.querySelector('img[src="existing-emotion"]')?.closest('tr')
    ;(existingRow?.querySelector('button') as HTMLButtonElement).click()
    await settleComponent()
    expect(getDatabase().characters[0].emotionImages).toEqual([])

    pendingUpload.resolve('stale-upload')
    await settleComponent()

    expect(target.querySelector('img[src="stale-upload"]')).toBeNull()
    expect(getDatabase().characters[0].emotionImages).toEqual([])
  })
})

describe('CharConfig draft-type-less character actions', () => {
  it('removes an additional asset without changing the active chat greeting', async () => {
    await mountCharConfig(1, {
      additionalAssets: [
        ['portrait', 'asset-1', 'png'],
        ['sticker', 'asset-2', 'png'],
      ],
    })

    buttonByText(language.additionalAssets).click()
    await settleComponent()
    buttonByAccessibleName(`${language.remove}: portrait`).click()
    await settleComponent()

    expect(chatCommandMocks.setCurrentChatGreetingIndex).not.toHaveBeenCalled()
    expect(getDatabase().characters[0].chats[0].fmIndex).toBe(2)
    expect(getDatabase().characters[0].additionalAssets).toEqual([['sticker', 'asset-2', 'png']])
  })

  it('adds a bias row when the live selected row is a real character', async () => {
    await mountCharConfig(2)

    expect(getDatabase().characters[0].bias).toEqual([])

    buttons()[0].click()
    await settleComponent()

    expect(getDatabase().characters[0].bias).toEqual([['', 0]])
  })

  it('adds and deletes alternate greetings using the validated selected index', async () => {
    await mountCharConfig(2, {
      alternateGreetings: ['Hello again'],
    })

    buttons()[1].click()
    await settleComponent()

    expect(getDatabase().characters[0].alternateGreetings).toEqual(['Hello again', ''])

    buttons()[4].click()
    await settleComponent()

    expect(chatCommandMocks.setCurrentChatGreetingIndex).not.toHaveBeenCalled()
    expect(getDatabase().characters[0].chats[0].fmIndex).toBe(-1)
    expect(getDatabase().characters[0].alternateGreetings).toEqual([''])
  })

  it('cascades a deleted alternate greeting through every chat in one server command', async () => {
    serverCommandState.enabled = true
    await mountCharConfig(2, {
      alternateGreetings: ['Zero', 'One', 'Two'],
      chats: [
        { id: 'chat-before', name: 'Before', message: [], note: '', localLore: [], fmIndex: 0 },
        { id: 'chat-deleted', name: 'Deleted', message: [], note: '', localLore: [], fmIndex: 1 },
        { id: 'chat-after', name: 'After', message: [], note: '', localLore: [], fmIndex: 2 },
      ],
    })

    buttonByAccessibleName(`${language.remove}: ${language.altGreet} 2`).click()
    await settleComponent()

    expect(getDatabase().characters[0].alternateGreetings).toEqual(['Zero', 'Two'])
    expect(getDatabase().characters[0].chats.map((chat) => chat.fmIndex)).toEqual([0, -1, 1])
    expect(serverCommandState.alternateGreetingCalls).toEqual([
      expect.objectContaining({
        characterId: 'char-1',
        alternateGreetings: ['Zero', 'Two'],
        operation: { type: 'delete', index: 1 },
        chatGreetingIndices: [
          { chatId: 'chat-before', fmIndex: 0 },
          { chatId: 'chat-deleted', fmIndex: -1 },
          { chatId: 'chat-after', fmIndex: 1 },
        ],
      }),
    ])
  })

  it('updates the ready character and chat owners without mutating a stale aggregate row', async () => {
    serverCommandState.enabled = true
    setDatabaseLite({
      characters: [
        makeCharacter({
          name: 'Aggregate stale',
          alternateGreetings: ['Aggregate zero', 'Aggregate one'],
          chats: [{ id: 'aggregate-chat', name: 'Aggregate', message: [], note: '', localLore: [], fmIndex: 1 }],
        }),
      ],
      currentChar: 0,
      hypaV3: false,
      newImageHandlingBeta: false,
      showUnrecommended: false,
      useAdditionalAssetsPreview: false,
    } as never)
    const staleAggregate = getResourceDatabase().characters
    charactersResourceState.characters = [
      makeCharacter({
        name: 'Owner current',
        alternateGreetings: ['Owner zero', 'Owner one'],
        chats: [
          { id: 'owner-chat-zero', name: 'Zero', message: [], note: '', localLore: [], fmIndex: 0 },
          { id: 'owner-chat-one', name: 'One', message: [], note: '', localLore: [], fmIndex: 1 },
        ],
      }),
    ]
    selectedCharID.set(0)
    CharConfigSubMenu.set(2)
    MobileGUI.set(true)

    target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(CharConfig, { target })
    await settleComponent()

    buttonByAccessibleName(`${language.remove}: ${language.altGreet} 1`).click()
    await settleComponent()

    expect(staleAggregate[0].alternateGreetings).toEqual(['Aggregate zero', 'Aggregate one'])
    expect(staleAggregate[0].chats[0].fmIndex).toBe(1)
    expect(charactersResourceState.characters[0].alternateGreetings).toEqual(['Owner one'])
    expect(charactersResourceState.characters[0].chats.map((chat) => chat.fmIndex)).toEqual([-1, 0])
    expect(serverCommandState.alternateGreetingCalls).toEqual([
      expect.objectContaining({
        characterId: 'char-1',
        alternateGreetings: ['Owner one'],
        chatGreetingIndices: [
          { chatId: 'owner-chat-zero', fmIndex: -1 },
          { chatId: 'owner-chat-one', fmIndex: 0 },
        ],
      }),
    ])
  })

  it('rejects a structural greeting mutation when chat ids are ambiguous', async () => {
    serverCommandState.enabled = true
    await mountCharConfig(2, {
      alternateGreetings: ['Zero', 'One'],
      chats: [
        { id: 'duplicate-chat', name: 'First', message: [], note: '', localLore: [], fmIndex: 0 },
        { id: 'duplicate-chat', name: 'Second', message: [], note: '', localLore: [], fmIndex: 1 },
      ],
    })

    buttonByAccessibleName(`${language.remove}: ${language.altGreet} 1`).click()
    await settleComponent()

    expect(charactersResourceState.characters[0].alternateGreetings).toEqual(['Zero', 'One'])
    expect(charactersResourceState.characters[0].chats.map((chat) => chat.fmIndex)).toEqual([0, 1])
    expect(serverCommandState.alternateGreetingCalls).toHaveLength(0)
  })

  it('keeps a retained alternate greeting cascade without rendering queued status text', async () => {
    serverCommandState.enabled = true
    alternateGreetingMutationState.outcomes.push('queued')
    await mountCharConfig(2, {
      alternateGreetings: ['Zero', 'One'],
      chats: [
        { id: 'chat-zero', name: 'Zero', message: [], note: '', localLore: [], fmIndex: 0 },
        { id: 'chat-one', name: 'One', message: [], note: '', localLore: [], fmIndex: 1 },
      ],
    })

    buttonByAccessibleName(`${language.moveUp}: ${language.altGreet} 2`).click()
    await settleComponent()

    expect(getDatabase().characters[0].alternateGreetings).toEqual(['One', 'Zero'])
    expect(getDatabase().characters[0].chats.map((chat) => chat.fmIndex)).toEqual([1, 0])
    expect(target.querySelector('[role="status"]')).toBeNull()

    alternateGreetingMutationState.settleQueued[0]?.('accepted')
    await settleComponent()
    expect(target.querySelector('[role="status"]')).toBeNull()
  })

  it('rolls back a terminal alternate greeting rejection and reports the failure', async () => {
    serverCommandState.enabled = true
    alternateGreetingMutationState.outcomes.push('failed')
    await mountCharConfig(2, {
      alternateGreetings: ['Zero', 'One'],
      chats: [
        { id: 'chat-zero', name: 'Zero', message: [], note: '', localLore: [], fmIndex: 0 },
        { id: 'chat-one', name: 'One', message: [], note: '', localLore: [], fmIndex: 1 },
      ],
    })

    buttonByAccessibleName(`${language.remove}: ${language.altGreet} 1`).click()
    await settleComponent()

    expect(getDatabase().characters[0].alternateGreetings).toEqual(['Zero', 'One'])
    expect(getDatabase().characters[0].chats.map((chat) => chat.fmIndex)).toEqual([0, 1])
    expect(target.querySelector('[role="alert"]')?.textContent).toBe(language.alternateGreetingMutationFailed)
  })

  it('does not roll a discarded queued mutation over newer chat-owner metadata', async () => {
    serverCommandState.enabled = true
    alternateGreetingMutationState.outcomes.push('queued')
    await mountCharConfig(2, {
      alternateGreetings: ['Zero', 'One'],
      chats: [
        { id: 'chat-zero', name: 'Zero', message: [], note: '', localLore: [], fmIndex: 0 },
        { id: 'chat-one', name: 'One', message: [], note: '', localLore: [], fmIndex: 1 },
      ],
    })

    buttonByAccessibleName(`${language.moveUp}: ${language.altGreet} 2`).click()
    await settleComponent()
    expect(charactersResourceState.characters[0].chats.map((chat) => chat.fmIndex)).toEqual([1, 0])

    expect(applyChatMetadataOwnerPatch('char-1', 'chat-zero', { fmIndex: 7 })).toBe(true)
    alternateGreetingMutationState.settleQueued[0]?.('discarded')
    await settleComponent()

    expect(charactersResourceState.characters[0].alternateGreetings).toEqual(['Zero', 'One'])
    expect(charactersResourceState.characters[0].chats.map((chat) => chat.fmIndex)).toEqual([7, 1])
    expect(target.querySelector('[role="alert"]')?.textContent).toBe(language.alternateGreetingMutationFailed)
  })

  it('disables structural greeting actions while their durable outcome is pending', async () => {
    serverCommandState.enabled = true
    const outcome = deferred<'accepted' | 'queued' | 'failed'>()
    alternateGreetingMutationState.outcomes.push(outcome.promise)
    await mountCharConfig(2, { alternateGreetings: ['Zero', 'One'] })

    buttonByAccessibleName(`${language.moveUp}: ${language.altGreet} 2`).click()
    await settleComponent()

    expect(buttonByAccessibleName(`${language.remove}: ${language.altGreet} 1`).disabled).toBe(true)
    expect(buttonByAccessibleName(`${language.moveDown}: ${language.altGreet} 1`).disabled).toBe(true)
    expect(serverCommandState.alternateGreetingCalls).toHaveLength(1)

    outcome.resolve('accepted')
    await settleComponent()
    expect(buttonByAccessibleName(`${language.remove}: ${language.altGreet} 1`).disabled).toBe(false)
  })

  it('adds a regex script row when the script draft still targets the selected character', async () => {
    await mountCharConfig(4)

    expect(target.querySelector('[data-testid="regex-count"]')?.textContent).toBe('0')

    buttons()[0].click()
    await settleComponent()

    expect(target.querySelector('[data-testid="regex-count"]')?.textContent).toBe('1')
    await vi.advanceTimersByTimeAsync(CHARACTER_SCRIPT_DEFINITION_SAVE_DELAY_MS)
    await settleComponent()
    expect(getDatabase().characters[0].customscript).toHaveLength(1)
    expect(getDatabase().characters[0].customscript[0]).toMatchObject({
      comment: '',
      in: '',
      out: '',
      type: 'editinput',
    })
  })

  it('merges imported regex rows into edits made while the picker is open', async () => {
    const pendingImport = deferred<unknown[] | null>()
    regexImportMocks.importRegexRows.mockReturnValue(pendingImport.promise)
    await mountCharConfig(4)

    buttonByAccessibleName(`${language.import}: ${language.regexScript}`).click()
    expect(regexImportMocks.importRegexRows).toHaveBeenCalledOnce()
    buttonByAccessibleName(`${language.add}: ${language.regexScript}`).click()
    await settleComponent()

    pendingImport.resolve([{ id: 'imported-script', comment: 'Imported', in: 'hello', out: 'hi', type: 'editinput' }])
    await settleComponent()
    await vi.advanceTimersByTimeAsync(CHARACTER_SCRIPT_DEFINITION_SAVE_DELAY_MS)
    await settleComponent()

    expect(getDatabase().characters[0].customscript).toHaveLength(2)
    expect(getDatabase().characters[0].customscript[0]).toMatchObject({ comment: '', type: 'editinput' })
    expect(getDatabase().characters[0].customscript[1]).toMatchObject({
      id: 'imported-script',
      comment: 'Imported',
    })
  })

  it('discards a regex import when character ownership changes while the picker is open', async () => {
    const pendingImport = deferred<unknown[] | null>()
    regexImportMocks.importRegexRows.mockReturnValue(pendingImport.promise)
    await mountCharConfig(4)

    buttonByAccessibleName(`${language.import}: ${language.regexScript}`).click()
    expect(regexImportMocks.importRegexRows).toHaveBeenCalledOnce()
    getDatabase().characters.push(makeCharacter({ chaId: 'char-2', name: 'Character B' }))
    selectedCharID.set(1)
    await settleComponent()

    pendingImport.resolve([{ id: 'stale-import', comment: 'Wrong owner', in: 'hello', out: 'hi', type: 'editinput' }])
    await settleComponent()

    expect(getDatabase().characters[0].customscript).toEqual([])
    expect(getDatabase().characters[1].customscript).toEqual([])
  })

  it('shows background, regex, and trigger scripts for a typeless real character row', async () => {
    await mountCharConfig(4, {
      type: undefined,
      backgroundHTML: '<style>.chattext .name { color: red; }</style>',
      lowLevelAccess: true,
      customscript: [{ id: 'script-1', comment: 'Regex', in: 'hello', out: 'hi', type: 'editinput' }],
      triggerscript: [
        {
          id: 'trigger-1',
          comment: 'Lua/V2 trigger',
          type: 'start',
          conditions: [],
          effect: [],
        } as never,
      ],
    })

    expect(target.querySelector('[data-testid="regex-count"]')?.textContent).toBe('1')
    const triggerCount = target.querySelector('[data-testid="trigger-count"]')
    expect(triggerCount?.textContent).toBe('1')
    expect(triggerCount?.getAttribute('data-low-level')).toBe('true')
    expect(Array.from(target.querySelectorAll('textarea')).some((input) => input.value.includes('.chattext'))).toBe(
      true,
    )

    buttons()[0].click()
    await settleComponent()

    expect(target.querySelector('[data-testid="regex-count"]')?.textContent).toBe('2')
    await vi.advanceTimersByTimeAsync(CHARACTER_SCRIPT_DEFINITION_SAVE_DELAY_MS)
    await settleComponent()
    expect(getDatabase().characters[0].customscript).toHaveLength(2)
  })
})

it('captures the newest character typing synchronously before demotion unmounts its owner', async () => {
  await beginWriterDraftCaptureTest()
  try {
    await mountCharConfig(0)
    const input = target.querySelector<HTMLInputElement>('input[aria-label="Character Name"]')!
    const original = input.value
    input.value = 'Newest character draft'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(capturedWriterDrafts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'character:char-1',
          data: expect.objectContaining({ name: 'Newest character draft' }),
          baseline: expect.objectContaining({ name: original }),
        }),
      ]),
    )
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})

it('captures character script edits retained after the script section is collapsed', async () => {
  await beginWriterDraftCaptureTest()
  try {
    await mountCharConfig(4)
    buttonByAccessibleName(`${language.add}: ${language.regexScript}`).click()
    await settleComponent()
    CharConfigSubMenu.set(0)
    await settleComponent()
    demoteClientSession()
    const saved = capturedWriterDrafts().find((draft) => draft.key === 'character-scripts:char-1')
    expect(saved?.data).toMatchObject({ scripts: [expect.objectContaining({ out: '', type: 'editinput' })] })
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})
