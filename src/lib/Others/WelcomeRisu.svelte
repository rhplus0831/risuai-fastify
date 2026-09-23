<script lang="ts">
  import { Send } from '@lucide/svelte'
  import { cancelLanguageChange, changeLanguage, language } from 'src/lang'
  import { getPersonaOwnerStateSnapshot, settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import Chat from '../ChatScreens/Chat.svelte'
  import { updateTextThemeAndCSS } from 'src/ts/gui/colorscheme'
  import { alertError, alertNormal } from 'src/ts/alert'
  import Airisu from '../../etc/Airisu.webp'
  import { onDestroy } from 'svelte'
  import {
    applyOnboardingServerBackedSettings,
    persistServerBackedSettingsPatchWithSettlement,
    type ServerBackedSettingsPersistenceReceipt,
  } from 'src/ts/server/settingsOwner.svelte'
  import { updateSelectedPersonaFieldWithOutcome } from 'src/ts/persona'

  const airisuStyle = `background: url("${Airisu}");background-size: cover;`
  let step = $state(0)
  let provider = $state('')
  let input = $state('')
  let chatLang = $state(0)
  let chatMemorySelection = $state(0)
  let setupApplied = false
  let setupCompletionPending = $state(false)
  let mounted = true
  let setupRunId = 0
  let usernamePersistencePending = $state(false)
  let languagePersistencePending = $state(false)
  let apiKeyPersistencePending = $state(false)
  let onboardingPersistenceError = $state<PersistenceErrorOwner | null>(null)
  let languageAttemptId = 0
  let apiKeyAttemptId = 0
  let activeLanguageAttempt: LanguagePersistenceAttempt | null = null
  let pendingLanguageLoad: Promise<boolean> | null = null
  let activeApiKeyAttempt: ApiKeyPersistenceAttempt | null = null
  const queuedSettlementSubscriptions = new Set<QueuedSettlementSubscription>()

  function activeUsername(): string {
    const owner = getPersonaOwnerStateSnapshot()
    const persona = owner?.personas.find((candidate) => candidate.id === owner.selectedPersonaId)
    return persona?.name ?? owner?.username ?? 'User'
  }

  const SETUP_COMPLETION_PENDING_STEP = 9
  const SETUP_COMPLETE_STEP = 10

  type PersistenceAttemptKind = 'language' | 'apiKey'
  type ApiKeySettingsField = 'openAIKey' | 'openrouterKey' | 'claudeAPIKey'

  type PersistenceErrorOwner = {
    kind: PersistenceAttemptKind
    attemptId: number
  }

  type LanguagePersistenceAttempt = {
    attemptId: number
    language: string
    originStep: number
  }

  type ApiKeyPersistenceAttempt = {
    attemptId: number
    field: ApiKeySettingsField
    keyText: string
    originStep: number
    provider: string
  }

  type QueuedSettlementSubscription = {
    stop: () => void
  }

  type SetupChoicesSnapshot = {
    chatLang: number
    chatMemorySelection: number
    originStep: number
    provider: string
    runId: number
  }

  function invalidatePendingSetupRun(): void {
    setupRunId += 1
    setupCompletionPending = false
  }

  function isCurrentSetupRun(snapshot: SetupChoicesSnapshot): boolean {
    return (
      mounted &&
      snapshot.runId === setupRunId &&
      setupCompletionPending &&
      !setupApplied &&
      step === SETUP_COMPLETION_PENDING_STEP &&
      provider === snapshot.provider &&
      chatLang === snapshot.chatLang &&
      chatMemorySelection === snapshot.chatMemorySelection
    )
  }

  function clearMatchingPersistenceError(kind: PersistenceAttemptKind, attemptId?: number): void {
    if (onboardingPersistenceError?.kind !== kind) return
    if (attemptId !== undefined && onboardingPersistenceError.attemptId !== attemptId) return
    onboardingPersistenceError = null
  }

  function observeQueuedSettlement(
    receipt: Extract<ServerBackedSettingsPersistenceReceipt, { status: 'queued' }>,
    owner: PersistenceErrorOwner,
    isRelevant: () => boolean,
  ): void {
    const subscription: QueuedSettlementSubscription = { stop: () => {} }
    queuedSettlementSubscriptions.add(subscription)
    subscription.stop = receipt.subscribeSettlement((settlement) => {
      queuedSettlementSubscriptions.delete(subscription)
      if (!mounted || !isRelevant()) return
      if (settlement === 'failed') {
        onboardingPersistenceError = owner
      } else {
        clearMatchingPersistenceError(owner.kind, owner.attemptId)
      }
    })
  }

  async function completeOnboardingSetup(): Promise<void> {
    if (!mounted || setupApplied || setupCompletionPending || settingsResourceState.value.didFirstSetup === true) return

    const snapshot: SetupChoicesSnapshot = {
      chatLang,
      chatMemorySelection,
      originStep: step,
      provider,
      runId: setupRunId + 1,
    }
    setupRunId = snapshot.runId
    setupCompletionPending = true
    step = SETUP_COMPLETION_PENDING_STEP

    const persisted = await applyOnboardingServerBackedSettings({
      chatMemorySelection: snapshot.chatMemorySelection,
      provider: snapshot.provider,
      chatLang: snapshot.chatLang,
    })

    if (!isCurrentSetupRun(snapshot)) return
    setupCompletionPending = false
    if (!persisted) {
      step = snapshot.originStep
      return
    }

    setupApplied = true
    updateTextThemeAndCSS()
    step = SETUP_COMPLETE_STEP
  }

  onDestroy(() => {
    mounted = false
    if (pendingLanguageLoad) cancelLanguageChange(pendingLanguageLoad)
    invalidatePendingSetupRun()
    languageAttemptId += 1
    apiKeyAttemptId += 1
    activeLanguageAttempt = null
    activeApiKeyAttempt = null
    for (const subscription of queuedSettlementSubscriptions) subscription.stop()
    queuedSettlementSubscriptions.clear()
  })

  function isCurrentLanguageAttempt(attempt: LanguagePersistenceAttempt): boolean {
    return (
      mounted &&
      languagePersistencePending &&
      languageAttemptId === attempt.attemptId &&
      activeLanguageAttempt?.attemptId === attempt.attemptId &&
      activeLanguageAttempt.language === attempt.language &&
      step === attempt.originStep
    )
  }

  async function selectLanguage(lang: string): Promise<void> {
    if (!mounted || languagePersistencePending || step !== 0) return

    const attempt: LanguagePersistenceAttempt = {
      attemptId: languageAttemptId + 1,
      language: lang,
      originStep: step,
    }
    languageAttemptId = attempt.attemptId
    activeLanguageAttempt = attempt
    languagePersistencePending = true
    clearMatchingPersistenceError('language')
    const languageLoad = changeLanguage(attempt.language)
    pendingLanguageLoad = languageLoad
    let receipt: ServerBackedSettingsPersistenceReceipt
    try {
      const applied = await languageLoad
      if (pendingLanguageLoad === languageLoad) pendingLanguageLoad = null
      if (!isCurrentLanguageAttempt(attempt)) return
      if (!applied) {
        languagePersistencePending = false
        return
      }
      receipt = await persistServerBackedSettingsPatchWithSettlement({ language: attempt.language })
    } catch {
      if (pendingLanguageLoad === languageLoad) pendingLanguageLoad = null
      if (!isCurrentLanguageAttempt(attempt)) return
      languagePersistencePending = false
      onboardingPersistenceError = { kind: 'language', attemptId: attempt.attemptId }
      void changeLanguage(settingsResourceState.value.language)
      return
    }

    if (!isCurrentLanguageAttempt(attempt)) return
    languagePersistencePending = false
    if (receipt.status === 'failed') {
      onboardingPersistenceError = { kind: 'language', attemptId: attempt.attemptId }
      void changeLanguage(settingsResourceState.value.language)
      return
    }

    clearMatchingPersistenceError('language', attempt.attemptId)
    step = 1
    if (receipt.status === 'queued') {
      observeQueuedSettlement(receipt, { kind: 'language', attemptId: attempt.attemptId }, () => {
        return languageAttemptId === attempt.attemptId && activeLanguageAttempt?.language === attempt.language
      })
    }
  }

  function resolveBrowserLanguage(browserLanguage: string): string | null {
    const parts = browserLanguage.replace('_', '-').split('-')
    const base = parts[0]?.toLowerCase()
    if (base === 'zh') {
      const subtags = parts.slice(1).map((part) => part.toLowerCase())
      return subtags.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part)) ? 'zh-Hant' : 'cn'
    }

    if (base && ['cn', 'de', 'en', 'es', 'ko', 'vi'].includes(base)) {
      return base
    }
    return null
  }

  {
    const browserLanguage = resolveBrowserLanguage(navigator.language)
    if (browserLanguage) {
      void selectLanguage(browserLanguage)
    }
  }
  let start = $state(false)

  async function persistOnboardingUsername(): Promise<void> {
    if (usernamePersistencePending || input.length === 0) return
    const attemptedName = input
    usernamePersistencePending = true
    try {
      const status = await updateSelectedPersonaFieldWithOutcome('username', attemptedName)
      if (!mounted) return
      if (status === 'failed') {
        alertError(language.personaMutationFailed)
        return
      }
      if (status === 'queued') alertNormal(language.personaMutationQueued)
      step = 2
      input = ''
    } catch {
      if (mounted) alertError(language.personaMutationFailed)
    } finally {
      if (mounted) usernamePersistencePending = false
    }
  }

  function apiKeyFieldForProvider(attemptedProvider: string): ApiKeySettingsField | null {
    if (attemptedProvider === 'openai') return 'openAIKey'
    if (attemptedProvider === 'openrouter') return 'openrouterKey'
    if (attemptedProvider === 'claude') return 'claudeAPIKey'
    return null
  }

  function isCurrentApiKeyAttempt(attempt: ApiKeyPersistenceAttempt): boolean {
    return (
      mounted &&
      apiKeyPersistencePending &&
      apiKeyAttemptId === attempt.attemptId &&
      activeApiKeyAttempt?.attemptId === attempt.attemptId &&
      activeApiKeyAttempt.field === attempt.field &&
      activeApiKeyAttempt.keyText === attempt.keyText &&
      step === attempt.originStep &&
      provider === attempt.provider
    )
  }

  async function persistOnboardingApiKey(): Promise<void> {
    if (!mounted || apiKeyPersistencePending || step !== 4 || input.length === 0) return
    if (!input.startsWith('sk-')) {
      alertError('Invalid API key')
      return
    }

    const attemptedProvider = provider
    const attemptedKeyText = input
    const attemptedField = apiKeyFieldForProvider(attemptedProvider)
    if (!attemptedField) return
    const attempt: ApiKeyPersistenceAttempt = {
      attemptId: apiKeyAttemptId + 1,
      field: attemptedField,
      keyText: attemptedKeyText,
      originStep: step,
      provider: attemptedProvider,
    }
    apiKeyAttemptId = attempt.attemptId
    activeApiKeyAttempt = attempt
    apiKeyPersistencePending = true
    clearMatchingPersistenceError('apiKey')

    let receipt: ServerBackedSettingsPersistenceReceipt
    try {
      receipt = await persistServerBackedSettingsPatchWithSettlement({ [attempt.field]: attempt.keyText })
    } catch {
      if (!isCurrentApiKeyAttempt(attempt)) return
      apiKeyPersistencePending = false
      onboardingPersistenceError = { kind: 'apiKey', attemptId: attempt.attemptId }
      return
    }

    if (!isCurrentApiKeyAttempt(attempt)) return
    apiKeyPersistencePending = false
    if (receipt.status === 'failed') {
      onboardingPersistenceError = { kind: 'apiKey', attemptId: attempt.attemptId }
      return
    }

    clearMatchingPersistenceError('apiKey', attempt.attemptId)
    if (step === attempt.originStep && provider === attempt.provider && input === attempt.keyText) {
      step = 5
      input = ''
    }
    if (receipt.status === 'queued') {
      observeQueuedSettlement(receipt, { kind: 'apiKey', attemptId: attempt.attemptId }, () => {
        return (
          apiKeyAttemptId === attempt.attemptId &&
          activeApiKeyAttempt?.field === attempt.field &&
          activeApiKeyAttempt.provider === attempt.provider
        )
      })
    }
  }

  function send() {
    switch (step) {
      case 1: {
        void persistOnboardingUsername()
        break
      }
      case 2: {
        if (['openai', 'openrouter', 'horde', 'later'].includes(input.toLocaleLowerCase())) {
          provider = input.toLocaleLowerCase()
          step = 3
          input = ''
        }
        break
      }
      case 4: {
        void persistOnboardingApiKey()
        break
      }
    }
  }
</script>

<div class="w-full h-full flex justify-center welcome-bg text-textcolor relative bg-gray-900">
  <div
    class="w-2xl overflow-x-hidden max-w-full min-h-full h-full flex flex-col overflow-y-hidden"
    class:justify-center={!start}>
    {#if !start}
      <div
        class="w-full justify-center flex mt-8 logo-animation"
        onanimationend={() => {
          start = true
        }}>
        <img src="/logo_typo_trans.png" alt="logo" class="w-full max-w-(--breakpoint-sm) mb-0" />
      </div>
    {:else}
      <div
        class="relative w-full flex-col bg-darkbg grow mt-5 max-w-full p-5 rounded-t-lg overflow-x-hidden flex border-gray-800 border chat-animation overflow-y-auto">
        {#if step === 0}
          <h2 class="animate-bounce">Choose your language</h2>
          <div class="flex flex-col items-start ml-2">
            <button
              disabled={languagePersistencePending}
              class="hover:text-green-500 transition-colors"
              onclick={() => {
                void selectLanguage('de')
              }}>• Deutsch</button>
            <button
              disabled={languagePersistencePending}
              class="hover:text-green-500 transition-colors"
              onclick={() => {
                void selectLanguage('en')
              }}>• English</button>
            <button
              disabled={languagePersistencePending}
              class="hover:text-green-500 transition-colors"
              onclick={() => {
                void selectLanguage('ko')
              }}>• 한국어</button>
            <button
              disabled={languagePersistencePending}
              class="hover:text-green-500 transition-colors"
              onclick={() => {
                void selectLanguage('cn')
              }}>• 中文</button>
            <button
              disabled={languagePersistencePending}
              class="hover:text-green-500 transition-colors"
              onclick={() => {
                void selectLanguage('zh-Hant')
              }}>• 中文(繁體)</button>
            <button
              disabled={languagePersistencePending}
              class="hover:text-green-500 transition-colors"
              onclick={() => {
                void selectLanguage('vi')
              }}>• Tiếng Việt</button>
          </div>
        {:else}
          <Chat name="Airisu" img={airisuStyle} message={language.setup.welcome} isLastMemory={false} />
          {#if step >= 2}
            <Chat name={activeUsername()} message={activeUsername()} isLastMemory={false} />
            <Chat
              name="Airisu"
              img={airisuStyle}
              message={language.setup.setupLaterMessage.replace('{username}', activeUsername())}
              isLastMemory={false} />
          {/if}
          {#if step === 2}
            <div class="grid grid-cols-2 gap-4 md:grid-cols-3">
              <button
                class="border-l-blue-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1 col-span-2"
                onclick={() => {
                  step = 3
                }}>
                <h1 class="text-2xl font-bold text-start">{language.setup.setupMessageOption1}</h1>
                <span class="mt-2 text-textcolor2 text-start">{language.setup.setupMessageOption1Desc}</span>
              </button>
              <button
                class="border-l-gray-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  provider = 'later'
                  void completeOnboardingSetup()
                }}>
                <h1 class="font-bold text-start text-gray-500">
                  {language.setup.setupMessageOption2}
                </h1>
              </button>
            </div>
          {/if}
          {#if step >= 3}
            <Chat name={activeUsername()} message={language.setup.setupMessageOption1} isLastMemory={false} />
            <Chat
              name="Airisu"
              img={airisuStyle}
              message={language.setup.welcome2.replace('{username}', activeUsername())}
              isLastMemory={false} />
          {/if}
          {#if step === 3}
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              <button
                class="border-l-gray-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  provider = 'claude'
                  step = 4
                }}>
                <h1 class="text-2xl font-bold text-start">
                  Claude <span class="text-sm p-1 rounded-sm bg-blue-500 text-white">{language.recommended}</span>
                </h1>
                <span class="mt-2 text-textcolor2 text-start">{language.setup.claudeDesc}</span>
              </button>
              <button
                class="border-l-blue-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  provider = 'openai'
                  step = 4
                }}>
                <h1 class="text-2xl font-bold text-start">OpenAI</h1>
                <span class="mt-2 text-textcolor2 text-start">{language.setup.openAIDesc}</span>
              </button>
              <button
                class="border-l-red-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  provider = 'horde'
                  void completeOnboardingSetup()
                }}>
                <h1 class="text-2xl font-bold text-start">Horde</h1>
                <span class="mt-2 text-textcolor2 text-start">{language.setup.hordeProvider}</span>
              </button>
              <button
                class="border-l-green-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  provider = 'openrouter'
                  step = 4
                }}>
                <h1 class="text-2xl font-bold text-start">OpenRouter</h1>
                <span class="mt-2 text-textcolor2 text-start">{language.setup.openRouterProvider}</span>
              </button>
            </div>
          {/if}
          {#if step >= 4}
            <Chat name={activeUsername()} message={provider} isLastMemory={false} />
            {#if provider === 'openai'}
              <Chat name="Airisu" img={airisuStyle} message={language.setup.setupOpenAI} isLastMemory={false} />
            {/if}
            {#if provider === 'openrouter'}
              <Chat name="Airisu" img={airisuStyle} message={language.setup.setupOpenRouter} isLastMemory={false} />
            {/if}
            {#if provider === 'claude'}
              {#each language.setup.setupClaudeSteps as step, i}
                <Chat
                  name="Airisu"
                  img={airisuStyle}
                  message={`![alt text](/welcome/claude/ant_${i}.webp)\n\n${i === 0 ? 'https://console.anthropic.com/login?returnTo=%2F%3F\n\n' : ''}` +
                    step}
                  isLastMemory={false} />
              {/each}
            {/if}
          {/if}
          {#if step >= 5}
            <Chat name={activeUsername()} message="<HIDDEN>" isLastMemory={false} />
            <Chat name="Airisu" img={airisuStyle} message={language.setup.chooseChatType} isLastMemory={false} />
          {/if}
          {#if step === 5}
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              <button
                class="border-l-blue-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatLang = 0
                  step = 6
                }}>
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseChatTypeOption1}
                </h1>
                <span class="mt-2 text-textcolor2 text-start">{language.setup.chooseChatTypeOption1Desc}</span>
              </button>
              <button
                class="border-l-green-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatLang = 1
                  step = 6
                }}>
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseChatTypeOption2}
                </h1>
                <span class="mt-2 text-textcolor2 text-start">{language.setup.chooseChatTypeOption2Desc}</span>
              </button>
              <button
                class="border-l-red-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatLang = 2
                  step = 6
                }}>
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseChatTypeOption3}
                </h1>
                <span class="mt-2 text-textcolor2 text-start">{language.setup.chooseChatTypeOption3Desc}</span>
              </button>
            </div>
          {/if}
          {#if step >= 6}
            <Chat
              name={activeUsername()}
              message={language.setup[`chooseChatTypeOption${chatLang + 1}`]}
              isLastMemory={false} />
            <Chat name="Airisu" img={airisuStyle} message={language.setup.chooseCheapOrMemory} isLastMemory={false} />
          {/if}
          {#if step === 6}
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              <button
                class="border-l-red-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatMemorySelection = 2
                  void completeOnboardingSetup()
                }}>
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseCheapOrMemoryOption3}
                  <span class="text-sm p-1 rounded-sm bg-blue-500 text-white">{language.recommended}</span>
                </h1>
                <span class="mt-2 text-textcolor2 text-start">{language.setup.chooseCheapOrMemoryOption3Desc}</span>
              </button>
              <button
                class="border-l-blue-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatMemorySelection = 0
                  void completeOnboardingSetup()
                }}>
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseCheapOrMemoryOption1}
                </h1>
                <span class="mt-2 text-textcolor2 text-start">{language.setup.chooseCheapOrMemoryOption1Desc}</span>
              </button>
              <button
                class="border-l-green-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatMemorySelection = 1
                  void completeOnboardingSetup()
                }}>
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseCheapOrMemoryOption2}
                </h1>
                <span class="mt-2 text-textcolor2 text-start">{language.setup.chooseCheapOrMemoryOption2Desc}</span>
              </button>
              <button
                class="border-l-yellow-500 border-l-4 p-6 flex flex-col transition-shadow hover:ring-1"
                onclick={() => {
                  chatMemorySelection = 3
                  void completeOnboardingSetup()
                }}>
                <h1 class="text-2xl font-bold text-start">
                  {language.setup.chooseCheapOrMemoryOption4}
                </h1>
                <span class="mt-2 text-textcolor2 text-start">{language.setup.chooseCheapOrMemoryOption4Desc}</span>
              </button>
            </div>
          {/if}
          {#if step === SETUP_COMPLETE_STEP}
            <Chat name="Airisu" img={airisuStyle} message={language.setup.allDone} isLastMemory={false} />
          {/if}
          <div class="flex items-stretch mb-2 w-full mt-auto">
            {#if step === 4 && ['openai', 'openrouter', 'claude'].includes(provider)}
              <input
                type="password"
                autocomplete="new-password"
                aria-label={`${provider === 'openai' ? 'OpenAI' : provider === 'openrouter' ? 'OpenRouter' : 'Claude'} ${language.apiKey}`}
                class="peer focus:border-textcolor transition-colors outline-hidden text-textcolor p-2 min-w-0 border border-r-0 bg-transparent rounded-md rounded-r-none input-text text-xl grow ml-4 border-darkborderc overflow-hidden max-w-full"
                bind:value={input}
                onkeydown={(e) => {
                  if (e.key.toLocaleLowerCase() === 'enter' && !e.isComposing) {
                    e.preventDefault()
                    send()
                  }
                }}
                style:height={'44px'} />
            {:else}
              <textarea
                class="peer focus:border-textcolor transition-colors outline-hidden text-textcolor p-2 min-w-0 border border-r-0 bg-transparent rounded-md rounded-r-none input-text text-xl grow ml-4 border-darkborderc resize-none overflow-y-hidden overflow-x-hidden max-w-full"
                bind:value={input}
                onkeydown={(e) => {
                  if (e.key.toLocaleLowerCase() === 'enter' && !e.shiftKey && !e.isComposing) {
                    e.preventDefault()
                    send()
                  }
                }}
                style:height={'44px'}></textarea>
            {/if}
            <button
              disabled={(step === 1 && usernamePersistencePending) || (step === 4 && apiKeyPersistencePending)}
              aria-busy={(step === 1 && usernamePersistencePending) || (step === 4 && apiKeyPersistencePending)}
              aria-label={language.hotkeyDesc.send}
              onclick={send}
              class="flex justify-center border-y border-r rounded-r-md border-darkborderc items-center text-textcolor p-2 peer-focus:border-textcolor hover:bg-blue-500 hover:text-white transition-colors">
              <Send />
            </button>
          </div>
        {/if}
        {#if onboardingPersistenceError}
          <p role="alert" class="mx-4 mb-2 text-red-500">{language.errors.settingsSaveFailed}</p>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .welcome-bg {
    background-size: cover;
    position: relative;
  }

  @keyframes darkness {
    from {
      opacity: 0;
    }
    50% {
      opacity: 0.2;
    }
    to {
      opacity: 0;
    }
  }

  .logo-animation {
    animation: logo-animation 3s ease-in-out;
    opacity: 0;
  }
  @keyframes logo-animation {
    from {
      opacity: 0;
    }
    80% {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
  }

  .chat-animation {
    animation: chat-animation 3s ease-in-out;
  }
  @keyframes chat-animation {
    from {
      top: 100vh;
    }
    to {
      top: 0;
    }
  }
</style>
