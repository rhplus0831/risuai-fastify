import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeStructuredClone } from '../ts/safeStructuredClone'

async function loadLanguageModule() {
  vi.resetModules()

  const cloneSpy = vi.fn(safeStructuredClone)
  vi.stubGlobal('safeStructuredClone', cloneSpy)
  const langModule = await import('./index')
  const { languageEnglish } = await import('./en')
  const { languageKorean } = await import('./ko')
  const { languageSpanish } = await import('./es')

  return {
    cloneSpy,
    langModule,
    languageEnglish,
    languageKorean,
    languageSpanish,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('language selection and translations', () => {
  it('repeated same-code changeLanguage calls reuse the applied language object without clone work', async () => {
    const { cloneSpy, langModule, languageKorean } = await loadLanguageModule()

    await langModule.changeLanguage('ko')
    const firstKoreanLanguage = langModule.language

    expect(firstKoreanLanguage.formating.main).toBe(languageKorean.formating.main)
    expect(cloneSpy).toHaveBeenCalledTimes(1)

    await langModule.changeLanguage('ko')
    await langModule.changeLanguage('ko')

    expect(langModule.language).toBe(firstKoreanLanguage)
    expect(langModule.language.formating.main).toBe(languageKorean.formating.main)
    expect(cloneSpy).toHaveBeenCalledTimes(1)
  })

  it('switching between languages applies their translated strings', async () => {
    const { langModule, languageKorean, languageSpanish } = await loadLanguageModule()

    await langModule.changeLanguage('ko')
    const koreanLanguage = langModule.language

    expect(koreanLanguage.formating.main).toBe(languageKorean.formating.main)

    await langModule.changeLanguage('es')
    const spanishLanguage = langModule.language

    expect(spanishLanguage.formating.main).toBe(languageSpanish.formating.main)
    expect(spanishLanguage.errors.toomuchtoken).toBe(languageSpanish.errors.toomuchtoken)
  })

  it('switching back to English restores English strings', async () => {
    const { langModule, languageEnglish } = await loadLanguageModule()

    await langModule.changeLanguage('ko')

    await langModule.changeLanguage('en')
    const englishLanguage = langModule.language

    expect(englishLanguage.formating.main).toBe(languageEnglish.formating.main)

    await langModule.changeLanguage('en')

    expect(langModule.language.formating.main).toBe(languageEnglish.formating.main)
  })

  it('unknown language codes resolve to English before and after switching locales', async () => {
    const { langModule, languageEnglish } = await loadLanguageModule()

    await langModule.changeLanguage('unknown-language')
    const firstFallbackLanguage = langModule.language

    expect(firstFallbackLanguage.formating.main).toBe(languageEnglish.formating.main)

    await langModule.changeLanguage('en')
    await langModule.changeLanguage('still-unknown')

    expect(langModule.language.formating.main).toBe(languageEnglish.formating.main)

    await langModule.changeLanguage('ko')

    await langModule.changeLanguage('not-a-supported-language')
    const fallbackAfterSwitch = langModule.language

    expect(fallbackAfterSwitch.formating.main).toBe(languageEnglish.formating.main)

    await langModule.changeLanguage('another-unknown-language')
    await langModule.changeLanguage('en')

    expect(langModule.language.formating.main).toBe(languageEnglish.formating.main)
  })

  it('Korean uses translated model profile shell strings', async () => {
    const { langModule, languageEnglish, languageKorean } = await loadLanguageModule()

    await langModule.changeLanguage('ko')

    expect(langModule.language.modelProfiles.settingsTitle).toBe(languageKorean.modelProfiles.settingsTitle)
    expect(langModule.language.modelProfiles.settingsTitle).not.toBe(languageEnglish.modelProfiles.settingsTitle)
    expect(langModule.language.modelProfiles.rolesTab).toBe(languageKorean.modelProfiles.rolesTab)
    expect(langModule.language.modelProfiles.bindingModes.profile).toBe(
      languageKorean.modelProfiles.bindingModes.profile,
    )
    expect(langModule.language.modelProfiles.providerNames['custom-api']).toBe(
      languageKorean.modelProfiles.providerNames['custom-api'],
    )
    expect(langModule.language.modelProfiles.providerNames['debug-echo']).toBe(
      languageKorean.modelProfiles.providerNames['debug-echo'],
    )
    expect(langModule.language.modelProfiles.statusReasons['profile-model-missing']).toBe(
      languageKorean.modelProfiles.statusReasons['profile-model-missing'],
    )
    expect(langModule.language.modelProfiles.runtimeFields.maxContext).toBe(
      languageKorean.modelProfiles.runtimeFields.maxContext,
    )
  })

  it('Korean uses translated provider operation strings and formatters', async () => {
    const { langModule, languageEnglish, languageKorean } = await loadLanguageModule()

    await langModule.changeLanguage('ko')

    expect(langModule.language.errors.imageGenerationResponseMalformed).toBe(
      languageKorean.errors.imageGenerationResponseMalformed,
    )
    expect(langModule.language.errors.imageGenerationResponseMalformed).not.toBe(
      languageEnglish.errors.imageGenerationResponseMalformed,
    )
    expect(langModule.language.errors.imageGenerationFailed(502)).toBe(languageKorean.errors.imageGenerationFailed(502))
    expect(langModule.language.waveSpeedCatalogModelsLoaded(3)).toBe(languageKorean.waveSpeedCatalogModelsLoaded(3))
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function controlledLanguageModule() {
  vi.resetModules()
  const load = vi.fn<(code: string) => Promise<Record<string, unknown>>>()
  vi.doMock('./loadLanguagePack', () => ({ loadLanguagePack: load }))
  const cloneSpy = vi.fn(safeStructuredClone)
  vi.stubGlobal('safeStructuredClone', cloneSpy)
  return { load, cloneSpy, lang: await import('./index') }
}

describe('selected language loading', () => {
  afterEach(() => vi.doUnmock('./loadLanguagePack'))

  it('keeps English and other locales unchanged when merging a partial pack', async () => {
    const { lang, load } = await controlledLanguageModule()
    const { languageEnglish } = await import('./en')
    const originalToken = languageEnglish.errors.toomuchtoken
    const originalFormatter = languageEnglish.errors.imageGenerationFailed(502)
    load
      .mockResolvedValueOnce({ errors: { toomuchtoken: 'Korean token' } })
      .mockResolvedValueOnce({ showHelp: 'Spanish help' })

    await lang.changeLanguage('ko')
    expect(lang.language.errors.toomuchtoken).toBe('Korean token')
    expect(languageEnglish.errors.toomuchtoken).toBe(originalToken)
    await lang.changeLanguage('es')
    expect(lang.language.errors.toomuchtoken).toBe(originalToken)
    expect(lang.language.errors.imageGenerationFailed(502)).toBe(originalFormatter)
    await lang.changeLanguage('en')
    expect(lang.language.errors.toomuchtoken).toBe(originalToken)
    expect(lang.language.errors.imageGenerationFailed(502)).toBe(originalFormatter)
  })

  it('applies English and cached locales synchronously without loading them again', async () => {
    const { lang, load } = await controlledLanguageModule()
    const englishHelp = lang.language.showHelp
    load.mockResolvedValueOnce({ showHelp: 'Korean help' }).mockResolvedValueOnce({ showHelp: 'Spanish help' })
    await lang.changeLanguage('ko')
    await lang.changeLanguage('es')
    expect(lang.language.showHelp).toBe('Spanish help')

    const korean = lang.changeLanguage('ko')
    expect(lang.language.showHelp).toBe('Korean help')
    await korean
    const english = lang.changeLanguage('en')
    expect(lang.language.showHelp).toBe(englishHelp)
    await english
    expect(load.mock.calls).toEqual([['ko'], ['es']])
  })

  it('notifies subscribers only for applied changes and stops after unsubscribe', async () => {
    const { lang, load } = await controlledLanguageModule()
    const englishHelp = lang.language.showHelp
    const korean = deferred<Record<string, unknown>>()
    load.mockReturnValueOnce(korean.promise).mockResolvedValueOnce({ showHelp: 'Spanish help' })
    const listener = vi.fn(() => lang.language.showHelp)
    const unsubscribe = lang.subscribeLanguageChanges(listener)

    const obsolete = lang.changeLanguage('ko')
    expect(listener).not.toHaveBeenCalled()
    await lang.changeLanguage('es')
    expect(listener).toHaveReturnedWith('Spanish help')
    expect(listener).toHaveBeenCalledTimes(1)
    korean.resolve({ showHelp: 'Korean help' })
    await obsolete
    await lang.changeLanguage('es')
    expect(listener).toHaveBeenCalledTimes(1)

    await lang.changeLanguage('en')
    expect(listener).toHaveLastReturnedWith(englishHelp)
    expect(listener).toHaveBeenCalledTimes(2)
    await lang.changeLanguage('unknown')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    await lang.changeLanguage('ko')
    expect(lang.language.showHelp).toBe('Korean help')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('tracks language reads for both the English fallback and a loaded pack', async () => {
    const { lang, load } = await controlledLanguageModule()
    const track = vi.fn()
    lang.observeLanguageReads(track)
    void lang.language.showHelp
    expect(track).toHaveBeenCalled()

    load.mockResolvedValueOnce({ showHelp: 'Korean help' })
    await lang.changeLanguage('ko')
    track.mockClear()
    expect(lang.language.showHelp).toBe('Korean help')
    expect(track).toHaveBeenCalled()
  })

  it('has an immediate English fallback without requesting a deferred pack', async () => {
    const { lang, load } = await controlledLanguageModule()
    expect(lang.language.showHelp).toBe('Show Help')
    await lang.changeLanguage('unknown')
    expect(load).not.toHaveBeenCalled()
  })

  it('shares concurrent loading and merges partial nested packs over English', async () => {
    const { lang, load } = await controlledLanguageModule()
    const korean = deferred<Record<string, unknown>>()
    load.mockReturnValue(korean.promise)
    const first = lang.getLanguageForCode('ko')
    const second = lang.getLanguageForCode('ko')
    const selecting = lang.changeLanguage('ko')
    expect(load).toHaveBeenCalledExactlyOnceWith('ko')
    expect(lang.language.showHelp).toBe('Show Help')
    korean.resolve({ showHelp: 'Korean help', errors: { toomuchtoken: 'Korean token' } })
    await selecting
    expect(lang.language.showHelp).toBe('Korean help')
    expect(lang.language.errors.toomuchtoken).toBe('Korean token')
    expect(lang.language.errors.networkFetch).toEqual(expect.any(String))
    expect(lang.language.errors.imageGenerationFailed(502)).toContain('502')
    for (const result of await Promise.all([first, second, lang.getLanguageForCode('ko')])) {
      expect(result.showHelp).toBe('Korean help')
      expect(result.errors.toomuchtoken).toBe('Korean token')
    }
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not apply an older pack that finishes after the latest selected pack', async () => {
    const { lang, load } = await controlledLanguageModule()
    const korean = deferred<Record<string, unknown>>()
    const spanish = deferred<Record<string, unknown>>()
    load.mockImplementation((code) => (code === 'ko' ? korean.promise : spanish.promise))
    const first = lang.changeLanguage('ko')
    const latest = lang.changeLanguage('es')
    spanish.resolve({ showHelp: 'Spanish' })
    expect(await latest).toBe(true)
    korean.resolve({ showHelp: 'Korean' })
    expect(await first).toBe(false)
    expect(lang.language.showHelp).toBe('Spanish')
  })

  it('fences A to B to A even when A is already applied and B is pending', async () => {
    const { lang, load } = await controlledLanguageModule()
    const korean = deferred<Record<string, unknown>>()
    load.mockReturnValue(korean.promise)
    const first = lang.changeLanguage('ko')
    await lang.changeLanguage('en')
    korean.resolve({ showHelp: 'Korean' })
    expect(await first).toBe(false)
    expect(lang.language.showHelp).toBe('Show Help')
    await lang.changeLanguage('ko')
    expect(lang.language.showHelp).toBe('Korean')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('applies only the latest same-code pending selection', async () => {
    const { lang, load } = await controlledLanguageModule()
    const korean = deferred<Record<string, unknown>>()
    load.mockReturnValue(korean.promise)
    const first = lang.changeLanguage('ko')
    const second = lang.changeLanguage('ko')
    korean.resolve({ showHelp: 'Korean' })
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it.each(['replace', 'cancel'])('does not surface a failed obsolete selection after %s', async (action) => {
    const { lang, load } = await controlledLanguageModule()
    const korean = deferred<Record<string, unknown>>()
    load.mockReturnValue(korean.promise)
    const obsolete = lang.changeLanguage('ko')
    if (action === 'replace') await lang.changeLanguage('en')
    else lang.cancelLanguageChange(obsolete)
    korean.reject(new Error('obsolete chunk failure'))
    expect(await obsolete).toBe(false)
    await lang.awaitLanguageReady()
    expect(lang.language.showHelp).toBe('Show Help')
  })

  it('retries a failed import without claiming that its locale was applied', async () => {
    const { lang, load } = await controlledLanguageModule()
    load.mockRejectedValueOnce(new Error('chunk unavailable')).mockResolvedValueOnce({ showHelp: 'Korean' })
    const selection = lang.changeLanguage('ko')
    await expect(selection).rejects.toThrow('chunk unavailable')
    await expect(lang.awaitLanguageReady()).rejects.toThrow('chunk unavailable')
    expect(lang.language.showHelp).toBe('Show Help')
    expect(await lang.changeLanguage('ko')).toBe(true)
    await lang.awaitLanguageReady()
    expect(lang.language.showHelp).toBe('Korean')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('releases readiness for a replacement without waiting for an abandoned chunk', async () => {
    const { lang, load } = await controlledLanguageModule()
    const korean = deferred<Record<string, unknown>>()
    load.mockReturnValue(korean.promise)
    void lang.changeLanguage('ko')
    const ready = lang.awaitLanguageReady()
    await lang.changeLanguage('en')
    await ready
    expect(lang.language.showHelp).toBe('Show Help')
    korean.reject(new Error('obsolete failure'))
    await lang.awaitLanguageReady()
  })

  it('cancels only a surface-owned current pending selection', async () => {
    const { lang, load } = await controlledLanguageModule()
    const korean = deferred<Record<string, unknown>>()
    load.mockReturnValue(korean.promise)
    const first = lang.changeLanguage('ko')
    lang.cancelLanguageChange(first)
    await lang.awaitLanguageReady()
    const latest = lang.changeLanguage('ko')
    lang.cancelLanguageChange(first)
    korean.resolve({ showHelp: 'Korean' })
    expect(await first).toBe(false)
    expect(await latest).toBe(true)
    expect(lang.language.showHelp).toBe('Korean')
  })
})
