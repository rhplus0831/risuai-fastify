import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const welcomeMocks = vi.hoisted(() => ({
  applyOnboardingServerBackedSettings: vi.fn(),
  persistServerBackedSettingsPatchWithSettlement: vi.fn(),
  updateSelectedPersonaFieldWithOutcome: vi.fn(),
  changeLanguage: vi.fn(async () => true),
  cancelLanguageChange: vi.fn(),
  alertError: vi.fn(),
  alertNormal: vi.fn(),
  updateTextThemeAndCSS: vi.fn(),
}))

vi.mock('../ChatScreens/Chat.svelte', async () => {
  const mock = await import('../ChatScreens/DefaultChatScreen.testChat.svelte')
  return { default: mock.default }
})

vi.mock('src/lang', () => ({
  changeLanguage: welcomeMocks.changeLanguage,
  cancelLanguageChange: welcomeMocks.cancelLanguageChange,
  language: {
    apiKey: 'API Key',
    hotkeyDesc: {
      send: 'Send',
    },
    recommended: 'Recommended',
    personaMutationFailed: 'Persona save failed',
    personaMutationQueued: 'Persona save queued',
    errors: {
      settingsSaveFailed: 'Settings save failed',
    },
    setup: {
      allDone: 'All done',
      chooseChatType: 'Choose chat type',
      chooseChatTypeOption1: 'General chat',
      chooseChatTypeOption1Desc: 'General chat description',
      chooseChatTypeOption2: 'Creative chat',
      chooseChatTypeOption2Desc: 'Creative chat description',
      chooseChatTypeOption3: 'Strict chat',
      chooseChatTypeOption3Desc: 'Strict chat description',
      chooseCheapOrMemory: 'Choose memory mode',
      chooseCheapOrMemoryOption1: 'Cheap mode',
      chooseCheapOrMemoryOption1Desc: 'Cheap mode description',
      chooseCheapOrMemoryOption2: 'Memory mode',
      chooseCheapOrMemoryOption2Desc: 'Memory mode description',
      chooseCheapOrMemoryOption3: 'Balanced mode',
      chooseCheapOrMemoryOption3Desc: 'Balanced mode description',
      chooseCheapOrMemoryOption4: 'Long memory',
      chooseCheapOrMemoryOption4Desc: 'Long memory description',
      claudeDesc: 'Claude description',
      hordeProvider: 'Horde description',
      openAIDesc: 'OpenAI description',
      openRouterProvider: 'OpenRouter description',
      setupClaudeSteps: ['Claude step'],
      setupLaterMessage: 'Setup later {username}',
      setupMessageOption1: 'Set up now',
      setupMessageOption1Desc: 'Set up now description',
      setupMessageOption2: 'Set up later',
      setupOpenAI: 'Enter OpenAI key',
      setupOpenRouter: 'Enter OpenRouter key',
      welcome: 'Welcome',
      welcome2: 'Welcome back {username}',
    },
  },
}))

vi.mock('src/ts/gui/colorscheme', () => ({
  updateTextThemeAndCSS: welcomeMocks.updateTextThemeAndCSS,
}))

vi.mock('src/ts/alert', () => ({
  alertError: welcomeMocks.alertError,
  alertNormal: welcomeMocks.alertNormal,
}))

vi.mock('src/ts/persona', () => ({
  updateSelectedPersonaFieldWithOutcome: welcomeMocks.updateSelectedPersonaFieldWithOutcome,
}))

vi.mock('src/ts/server/settingsOwner.svelte', () => ({
  applyOnboardingServerBackedSettings: welcomeMocks.applyOnboardingServerBackedSettings,
  persistServerBackedSettingsPatchWithSettlement: welcomeMocks.persistServerBackedSettingsPatchWithSettlement,
}))

import WelcomeRisu from './WelcomeRisu.svelte'
import { language } from 'src/lang'
import { replaceResourceDatabase as setDatabaseLite } from 'src/ts/server/resourceState.svelte'
import { getResourceDatabase as getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

type SettingsFinalSettlement = 'accepted' | 'failed'

type SettingsPersistenceReceipt =
  | { status: SettingsFinalSettlement }
  | {
      status: 'queued'
      mutationId: string
      settlement: Promise<SettingsFinalSettlement>
      subscribeSettlement: (listener: (settlement: SettingsFinalSettlement) => void) => () => void
    }

let target: HTMLElement
let component: MountedComponent | undefined

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function createQueuedSettingsReceipt(mutationId: string) {
  const settlement = createDeferred<SettingsFinalSettlement>()
  const listeners = new Set<(result: SettingsFinalSettlement) => void>()
  let settled: SettingsFinalSettlement | null = null
  let unsubscribeCalls = 0
  const receipt: SettingsPersistenceReceipt = {
    status: 'queued',
    mutationId,
    settlement: settlement.promise,
    subscribeSettlement(listener) {
      if (settled) {
        listener(settled)
        return () => {}
      }
      listeners.add(listener)
      return () => {
        unsubscribeCalls += 1
        listeners.delete(listener)
      }
    },
  }
  return {
    listenerCount: () => listeners.size,
    receipt,
    settle(result: SettingsFinalSettlement) {
      settled = result
      for (const listener of [...listeners]) listener(result)
      listeners.clear()
      settlement.resolve(result)
    },
    unsubscribeCalls: () => unsubscribeCalls,
  }
}

function buttons(): HTMLButtonElement[] {
  return Array.from(target.querySelectorAll('button'))
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = buttons().find((candidate) => candidate.textContent?.includes(text))
  if (!button) {
    throw new Error(`Button not found: ${text}\n${target.textContent ?? ''}`)
  }
  return button
}

function sendButton(): HTMLButtonElement {
  const button = target.querySelector<HTMLButtonElement>(`button[aria-label="${language.hotkeyDesc.send}"]`)
  if (!button) {
    throw new Error('Send button not found')
  }
  return button
}

function textInput(): HTMLInputElement | HTMLTextAreaElement {
  const input = target.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  if (!input) {
    throw new Error('Welcome input not found')
  }
  return input
}

async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await tick()
}

async function revealWelcomeChat(): Promise<void> {
  const logo = target.querySelector<HTMLElement>('.logo-animation')
  if (!logo) {
    throw new Error('Welcome logo animation element not found')
  }
  logo.dispatchEvent(new Event('animationend'))
  await tick()
}

async function setInputAndSend(value: string): Promise<void> {
  const input = textInput()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  sendButton().click()
  await tick()
}

async function clickChoice(text: string): Promise<void> {
  buttonWithText(text).click()
  await tick()
}

async function mountWelcome(): Promise<void> {
  component = mount(WelcomeRisu, { target })
  await tick()
  await revealWelcomeChat()
}

async function prepareOpenAiSetup(): Promise<void> {
  await mountWelcome()
  await setInputAndSend('Ada')
  await clickChoice('Set up now')
  await clickChoice('OpenAI')
  await setInputAndSend(['sk', 'fixture'].join('-'))
  await clickChoice('Creative chat')
}

async function prepareProviderCredentialStep(providerName: 'Claude' | 'OpenAI' | 'OpenRouter'): Promise<void> {
  await mountWelcome()
  await setInputAndSend('Ada')
  await clickChoice('Set up now')
  await clickChoice(providerName)
}

async function completeOpenAiSetup(): Promise<void> {
  await prepareOpenAiSetup()
  await clickChoice('Long memory')
  await flushAsync()
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(navigator, 'language', {
    configurable: true,
    value: 'en-US',
  })
  setDatabaseLite({
    didFirstSetup: false,
    language: 'en',
    username: '',
    userIcon: '',
    personaPrompt: '',
    userNote: '',
    selectedPersonaId: 'default-persona',
    selectedPersona: 0,
    personas: [{ id: 'default-persona', name: 'User', icon: '', personaPrompt: '', note: '' }],
  } as never)
  welcomeMocks.applyOnboardingServerBackedSettings.mockReset()
  welcomeMocks.applyOnboardingServerBackedSettings.mockResolvedValue(true)
  welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mockReset()
  welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mockImplementation(
    async (patch: Record<string, unknown>) => {
      Object.assign(getDatabase(), patch)
      return { status: 'accepted' }
    },
  )
  welcomeMocks.updateSelectedPersonaFieldWithOutcome.mockReset()
  welcomeMocks.updateSelectedPersonaFieldWithOutcome.mockImplementation(async (_field: string, value: string) => {
    getDatabase().username = value
    getDatabase().personas[0].name = value
    return 'accepted'
  })
  welcomeMocks.alertError.mockReset()
  welcomeMocks.alertNormal.mockReset()
  welcomeMocks.changeLanguage.mockReset().mockResolvedValue(true)
  welcomeMocks.cancelLanguageChange.mockReset()
  welcomeMocks.updateTextThemeAndCSS.mockReset()
  target = document.createElement('div')
  document.body.appendChild(target)
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  vi.clearAllTimers()
  vi.useRealTimers()
  target.remove()
  setDatabaseLite({} as never)
})

describe('WelcomeRisu onboarding setup completion', () => {
  it('names the icon-only send action', async () => {
    await mountWelcome()
    expect(sendButton().getAttribute('aria-label')).toBe('Send')
  })

  it('masks and names provider credentials', async () => {
    await mountWelcome()
    await setInputAndSend('Ada')
    await clickChoice('Set up now')
    await clickChoice('OpenAI')

    const credential = target.querySelector<HTMLInputElement>('input[type="password"]')
    expect(credential).toBeTruthy()
    expect(credential?.getAttribute('aria-label')).toBe('OpenAI API Key')
    expect(credential?.autocomplete).toBe('new-password')
    expect(target.querySelector('textarea')).toBeNull()
  })

  it('keeps the username field editable but ignores a second Enter while persistence is pending', async () => {
    const persistence = createDeferred<'accepted' | 'queued' | 'failed'>()
    welcomeMocks.updateSelectedPersonaFieldWithOutcome.mockReturnValueOnce(persistence.promise)
    await mountWelcome()

    const input = textInput()
    input.value = 'Ada'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    sendButton().click()
    await tick()

    expect(textInput().disabled).toBe(false)
    input.value = 'Grace'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await tick()

    expect(welcomeMocks.updateSelectedPersonaFieldWithOutcome).toHaveBeenCalledOnce()
    expect(welcomeMocks.updateSelectedPersonaFieldWithOutcome).toHaveBeenCalledWith('username', 'Ada')
    expect(sendButton().disabled).toBe(true)
    expect(target.textContent).not.toContain('Set up now')

    persistence.resolve('accepted')
    await flushAsync()

    expect(target.textContent).toContain('Set up now')
  })

  it('keeps the name step retryable when persona persistence fails', async () => {
    welcomeMocks.updateSelectedPersonaFieldWithOutcome.mockResolvedValueOnce('failed')
    await mountWelcome()
    await setInputAndSend('Ada')
    await flushAsync()

    expect(target.textContent).not.toContain('Set up now')
    expect(textInput().value).toBe('Ada')
    expect(welcomeMocks.alertError).toHaveBeenCalledWith('Persona save failed')
  })

  it('waits for the selected locale before persisting or advancing onboarding', async () => {
    const loading = createDeferred<boolean>()
    welcomeMocks.changeLanguage.mockReturnValueOnce(loading.promise)
    await mountWelcome()
    expect(welcomeMocks.persistServerBackedSettingsPatchWithSettlement).not.toHaveBeenCalled()
    expect(target.textContent).toContain('Choose your language')
    loading.resolve(true)
    await flushAsync()
    expect(welcomeMocks.persistServerBackedSettingsPatchWithSettlement).toHaveBeenCalledWith({ language: 'en' })
    expect(target.textContent).toContain('Welcome')
  })

  it('keeps a failed locale load retryable without persisting the unavailable choice', async () => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'fr-FR' })
    welcomeMocks.changeLanguage.mockRejectedValueOnce(new Error('chunk unavailable'))
    await mountWelcome()
    await clickChoice('Deutsch')
    await flushAsync()
    expect(welcomeMocks.persistServerBackedSettingsPatchWithSettlement).not.toHaveBeenCalled()
    expect(buttonWithText('Deutsch').disabled).toBe(false)
    expect(target.querySelector('[role="alert"]')?.textContent).toBe('Settings save failed')
    await clickChoice('Deutsch')
    await flushAsync()
    expect(welcomeMocks.persistServerBackedSettingsPatchWithSettlement).toHaveBeenCalledWith({ language: 'de' })
    expect(target.textContent).toContain('Welcome')
  })

  it('cancels its own pending locale on unmount and ignores its later completion', async () => {
    const loading = createDeferred<boolean>()
    welcomeMocks.changeLanguage.mockReturnValueOnce(loading.promise)
    await mountWelcome()
    unmount(component!)
    component = undefined
    expect(welcomeMocks.cancelLanguageChange).toHaveBeenCalledExactlyOnceWith(loading.promise)
    loading.resolve(true)
    await flushAsync()
    expect(welcomeMocks.persistServerBackedSettingsPatchWithSettlement).not.toHaveBeenCalled()
  })

  it('does not advance browser-language auto-selection before an accepted receipt', async () => {
    const persistence = createDeferred<SettingsPersistenceReceipt>()
    welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mockReturnValueOnce(persistence.promise)

    await mountWelcome()

    expect(welcomeMocks.changeLanguage).toHaveBeenCalledWith('en')
    expect(welcomeMocks.persistServerBackedSettingsPatchWithSettlement).toHaveBeenCalledWith({ language: 'en' })
    expect(target.textContent).toContain('Choose your language')
    expect(buttonWithText('English').disabled).toBe(true)

    persistence.resolve({ status: 'accepted' })
    await flushAsync()

    expect(target.textContent).toContain('Welcome')
    expect(target.textContent).not.toContain('Choose your language')
  })

  it.each([
    ['zh-CN', 'cn'],
    ['zh-Hans-SG', 'cn'],
    ['zh-TW', 'zh-Hant'],
    ['zh-Hant-HK', 'zh-Hant'],
    ['es-MX', 'es'],
  ])('maps browser locale %s to supported language %s', async (browserLocale, expectedLanguage) => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: browserLocale,
    })

    component = mount(WelcomeRisu, { target })
    await flushAsync()

    expect(welcomeMocks.changeLanguage).toHaveBeenCalledWith(expectedLanguage)
    expect(welcomeMocks.persistServerBackedSettingsPatchWithSettlement).toHaveBeenCalledWith({
      language: expectedLanguage,
    })
  })

  it('advances a clicked language only after it is durably queued and reports a later failure without rewinding', async () => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'fr-FR',
    })
    const persistence = createDeferred<SettingsPersistenceReceipt>()
    const queued = createQueuedSettingsReceipt('language-queued')
    welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mockReturnValueOnce(persistence.promise)
    await mountWelcome()

    buttonWithText('Deutsch').click()
    buttonWithText('English').click()
    await tick()

    expect(welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mock.calls.length).toBe(1)
    expect(target.textContent).toContain('Choose your language')
    expect(target.querySelector('[role="alert"]')).toBeNull()

    persistence.resolve(queued.receipt)
    await flushAsync()

    expect(target.textContent).toContain('Welcome')
    expect(target.textContent).not.toMatch(/queued/i)
    expect(welcomeMocks.alertNormal).not.toHaveBeenCalled()

    queued.settle('failed')
    await flushAsync()

    expect(target.querySelector('[role="alert"]')?.textContent).toBe('Settings save failed')
    expect(target.textContent).toContain('Welcome')
  })

  it('keeps an immediately failed language choice retryable and restores the rolled-back rendered language', async () => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'fr-FR',
    })
    welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mockResolvedValueOnce({ status: 'failed' })
    await mountWelcome()

    await clickChoice('Deutsch')
    await flushAsync()

    expect(target.textContent).toContain('Choose your language')
    expect(buttonWithText('Deutsch').disabled).toBe(false)
    expect(target.querySelector('[role="alert"]')?.textContent).toBe('Settings save failed')
    expect(welcomeMocks.changeLanguage).toHaveBeenNthCalledWith(1, 'de')
    expect(welcomeMocks.changeLanguage).toHaveBeenNthCalledWith(2, 'en')

    await clickChoice('English')
    await flushAsync()

    expect(target.textContent).toContain('Welcome')
    expect(target.querySelector('[role="alert"]')).toBeNull()
  })

  it('invalidates a late language receipt after unmount', async () => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'fr-FR',
    })
    const persistence = createDeferred<SettingsPersistenceReceipt>()
    welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mockReturnValueOnce(persistence.promise)
    await mountWelcome()
    await clickChoice('Deutsch')

    unmount(component!)
    component = undefined
    persistence.resolve({ status: 'failed' })
    await flushAsync()

    expect(welcomeMocks.changeLanguage).toHaveBeenCalledTimes(1)
    expect(welcomeMocks.changeLanguage).toHaveBeenCalledWith('de')
  })

  it('unsubscribes a queued language settlement when onboarding unmounts', async () => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'fr-FR',
    })
    const queued = createQueuedSettingsReceipt('language-unmount')
    welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mockResolvedValueOnce(queued.receipt)
    await mountWelcome()
    await clickChoice('Deutsch')
    await flushAsync()

    expect(queued.listenerCount()).toBe(1)
    unmount(component!)
    component = undefined

    expect(queued.listenerCount()).toBe(0)
    expect(queued.unsubscribeCalls()).toBe(1)
    queued.settle('failed')
    await flushAsync()
  })

  it('captures the API provider field and submitted text, ignores duplicates, and preserves a newer edit', async () => {
    await prepareProviderCredentialStep('OpenRouter')
    welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mockClear()
    const firstPersistence = createDeferred<SettingsPersistenceReceipt>()
    const secondPersistence = createDeferred<SettingsPersistenceReceipt>()
    const firstQueued = createQueuedSettingsReceipt('api-key-stale')
    welcomeMocks.persistServerBackedSettingsPatchWithSettlement
      .mockReturnValueOnce(firstPersistence.promise)
      .mockReturnValueOnce(secondPersistence.promise)
    const submittedKey = ['sk', 'submitted'].join('-')
    const newerKey = ['sk', 'newer'].join('-')

    const credential = textInput()
    credential.value = submittedKey
    credential.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    sendButton().click()
    sendButton().click()
    credential.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await tick()

    expect(welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mock.calls.length).toBe(1)
    const firstPatch = welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >
    expect(Object.keys(firstPatch)).toEqual(['openrouterKey'])
    expect(firstPatch.openrouterKey === submittedKey).toBe(true)
    expect(textInput().disabled).toBe(false)
    expect(sendButton().disabled).toBe(true)
    expect(sendButton().getAttribute('aria-busy')).toBe('true')

    credential.value = newerKey
    credential.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    firstPersistence.resolve(firstQueued.receipt)
    await flushAsync()

    expect(textInput().value === newerKey).toBe(true)
    expect(target.textContent).not.toContain('Choose chat type')
    expect(target.textContent?.includes(submittedKey)).toBe(false)

    sendButton().click()
    await tick()
    expect(welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mock.calls.length).toBe(2)

    firstQueued.settle('failed')
    await flushAsync()
    expect(target.querySelector('[role="alert"]')).toBeNull()

    secondPersistence.resolve({ status: 'accepted' })
    await flushAsync()

    expect(target.textContent).toContain('Choose chat type')
  })

  it('preserves the API input and step after an immediate persistence failure', async () => {
    await prepareProviderCredentialStep('OpenAI')
    welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mockResolvedValueOnce({ status: 'failed' })
    const submittedKey = ['sk', 'retry'].join('-')

    await setInputAndSend(submittedKey)
    await flushAsync()

    expect(target.textContent).not.toContain('Choose chat type')
    expect(textInput().value === submittedKey).toBe(true)
    expect(sendButton().disabled).toBe(false)
    expect(target.querySelector('[role="alert"]')?.textContent).toBe('Settings save failed')
    expect(target.querySelector('[role="alert"]')?.textContent?.includes(submittedKey)).toBe(false)
  })

  it('reports a queued API-key terminal failure without a queued row, toast, secret, or step rewind', async () => {
    await prepareProviderCredentialStep('Claude')
    const queued = createQueuedSettingsReceipt('api-key-failure')
    welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mockResolvedValueOnce(queued.receipt)
    const submittedKey = ['sk', 'queued'].join('-')

    await setInputAndSend(submittedKey)
    await flushAsync()

    expect(target.textContent).toContain('Choose chat type')
    expect(target.textContent).not.toMatch(/queued/i)
    expect(welcomeMocks.alertNormal).not.toHaveBeenCalled()
    expect(target.querySelector('[role="alert"]')).toBeNull()

    queued.settle('failed')
    await flushAsync()

    expect(target.textContent).toContain('Choose chat type')
    expect(target.querySelector('[role="alert"]')?.textContent).toBe('Settings save failed')
    expect(target.textContent?.includes(submittedKey)).toBe(false)
  })

  it('keeps a queued API-key accepted settlement silent', async () => {
    await prepareProviderCredentialStep('OpenAI')
    const queued = createQueuedSettingsReceipt('api-key-accepted')
    welcomeMocks.persistServerBackedSettingsPatchWithSettlement.mockResolvedValueOnce(queued.receipt)

    await setInputAndSend(['sk', 'accepted'].join('-'))
    await flushAsync()
    queued.settle('accepted')
    await flushAsync()

    expect(target.textContent).toContain('Choose chat type')
    expect(target.querySelector('[role="alert"]')).toBeNull()
    expect(welcomeMocks.alertNormal).not.toHaveBeenCalled()
  })

  it('shows completion only after the captured final choices persist successfully', async () => {
    const persistence = createDeferred<boolean>()
    welcomeMocks.applyOnboardingServerBackedSettings.mockReturnValueOnce(persistence.promise)
    await prepareOpenAiSetup()

    const finalChoice = buttonWithText('Long memory')
    finalChoice.click()
    expect(welcomeMocks.applyOnboardingServerBackedSettings).toHaveBeenCalledTimes(1)
    finalChoice.click()
    await flushAsync()

    expect(welcomeMocks.applyOnboardingServerBackedSettings).toHaveBeenCalledTimes(1)
    expect(welcomeMocks.applyOnboardingServerBackedSettings).toHaveBeenCalledWith({
      chatLang: 1,
      chatMemorySelection: 3,
      provider: 'openai',
    })
    expect(target.textContent).not.toContain('All done')
    expect(welcomeMocks.updateTextThemeAndCSS).not.toHaveBeenCalled()

    persistence.resolve(true)
    await flushAsync()

    expect(target.textContent).toContain('All done')
    expect(welcomeMocks.applyOnboardingServerBackedSettings).toHaveBeenCalledTimes(1)
    expect(welcomeMocks.updateTextThemeAndCSS).toHaveBeenCalledTimes(1)
  })

  it('keeps an in-flight final save alive while invalidating UI completion after unmount', async () => {
    const persistence = createDeferred<boolean>()
    welcomeMocks.applyOnboardingServerBackedSettings.mockReturnValueOnce(persistence.promise)
    await prepareOpenAiSetup()
    await clickChoice('Long memory')

    unmount(component!)
    component = undefined
    persistence.resolve(true)
    await flushAsync()

    expect(welcomeMocks.applyOnboardingServerBackedSettings).toHaveBeenCalledTimes(1)
    expect(welcomeMocks.updateTextThemeAndCSS).not.toHaveBeenCalled()
  })

  it('restores the final choice step after a failed save and permits one retry', async () => {
    welcomeMocks.applyOnboardingServerBackedSettings.mockResolvedValueOnce(false)
    await completeOpenAiSetup()

    expect(target.textContent).not.toContain('All done')
    expect(welcomeMocks.updateTextThemeAndCSS).not.toHaveBeenCalled()
    expect(buttonWithText('Long memory')).toBeTruthy()

    await clickChoice('Long memory')
    await flushAsync()

    expect(welcomeMocks.applyOnboardingServerBackedSettings).toHaveBeenCalledTimes(2)
    expect(target.textContent).toContain('All done')
    expect(welcomeMocks.updateTextThemeAndCSS).toHaveBeenCalledTimes(1)
  })

  it('does not start final setup after onboarding has already completed elsewhere', async () => {
    await prepareOpenAiSetup()
    getDatabase().didFirstSetup = true
    await clickChoice('Long memory')

    expect(welcomeMocks.applyOnboardingServerBackedSettings).not.toHaveBeenCalled()
    expect(target.textContent).not.toContain('All done')
  })
})
