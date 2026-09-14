import { afterEach, describe, expect, it, vi } from 'vitest'

function cloneWithFunctions<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneWithFunctions(item)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneWithFunctions(item)])) as T
  }
  return value
}

function leafPaths(value: unknown, prefix = ''): string[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, item]) => leafPaths(item, prefix ? `${prefix}.${key}` : key))
  }

  return [prefix]
}

async function loadLanguageModule() {
  vi.resetModules()

  const cloneSpy = vi.fn(cloneWithFunctions)
  vi.stubGlobal('safeStructuredClone', cloneSpy)
  const langModule = await import('./index')
  const { languageEnglish } = await import('./en')
  const { languageKorean } = await import('./ko')
  const { languageGerman } = await import('./de')
  const { languageChinese } = await import('./cn')
  const { languageChineseTraditional } = await import('./zh-Hant')
  const { languageSpanish } = await import('./es')
  const { languageVietnamese } = await import('./vi')

  return {
    cloneSpy,
    langModule,
    languageEnglish,
    languageGerman,
    languageChinese,
    languageChineseTraditional,
    languageKorean,
    languageSpanish,
    languageVietnamese,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('changeLanguage same-code cache', () => {
  it('uses the requested chat-entry loading copy', async () => {
    const { languageEnglish } = await loadLanguageModule()

    expect(languageEnglish.loadingChat).toBe('Loading chat…')
  })

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

  it('switching between languages rebuilds language objects and merged strings', async () => {
    const { cloneSpy, langModule, languageKorean, languageSpanish } = await loadLanguageModule()

    await langModule.changeLanguage('ko')
    const koreanLanguage = langModule.language

    expect(koreanLanguage.formating.main).toBe(languageKorean.formating.main)

    await langModule.changeLanguage('es')
    const spanishLanguage = langModule.language

    expect(spanishLanguage).not.toBe(koreanLanguage)
    expect(spanishLanguage.formating.main).toBe(languageSpanish.formating.main)
    expect(spanishLanguage.errors.toomuchtoken).toBe(languageSpanish.errors.toomuchtoken)
    expect(cloneSpy).toHaveBeenCalledTimes(2)
  })

  it('switching back to English changes identity once and then reuses the English object', async () => {
    const { cloneSpy, langModule, languageEnglish } = await loadLanguageModule()

    await langModule.changeLanguage('ko')
    const koreanLanguage = langModule.language

    await langModule.changeLanguage('en')
    const englishLanguage = langModule.language

    expect(englishLanguage).toBe(await langModule.getLanguageForCode('en'))
    expect(englishLanguage).not.toBe(koreanLanguage)
    expect(englishLanguage.formating.main).toBe(languageEnglish.formating.main)
    expect(cloneSpy).toHaveBeenCalledTimes(1)

    await langModule.changeLanguage('en')

    expect(langModule.language).toBe(englishLanguage)
    expect(cloneSpy).toHaveBeenCalledTimes(1)
  })

  it('unknown language codes resolve to English and share the English cache key', async () => {
    const { cloneSpy, langModule, languageEnglish } = await loadLanguageModule()

    await langModule.changeLanguage('unknown-language')
    const firstFallbackLanguage = langModule.language

    expect(firstFallbackLanguage).toBe(await langModule.getLanguageForCode('en'))
    expect(firstFallbackLanguage.formating.main).toBe(languageEnglish.formating.main)
    expect(cloneSpy).toHaveBeenCalledTimes(0)

    await langModule.changeLanguage('en')
    await langModule.changeLanguage('still-unknown')

    expect(langModule.language).toBe(firstFallbackLanguage)
    expect(cloneSpy).toHaveBeenCalledTimes(0)

    await langModule.changeLanguage('ko')
    const koreanLanguage = langModule.language

    await langModule.changeLanguage('not-a-supported-language')
    const fallbackAfterSwitch = langModule.language

    expect(fallbackAfterSwitch).toBe(await langModule.getLanguageForCode('en'))
    expect(fallbackAfterSwitch).not.toBe(koreanLanguage)
    expect(cloneSpy).toHaveBeenCalledTimes(1)

    await langModule.changeLanguage('another-unknown-language')
    await langModule.changeLanguage('en')

    expect(langModule.language).toBe(fallbackAfterSwitch)
    expect(cloneSpy).toHaveBeenCalledTimes(1)
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

  it('defines every English translation path directly in Korean', async () => {
    const { languageEnglish, languageKorean } = await loadLanguageModule()
    const koreanPaths = new Set(leafPaths(languageKorean))

    expect(leafPaths(languageEnglish).filter((path) => !koreanPaths.has(path))).toEqual([])
  })

  it('defines every generation finalization state in every language pack', async () => {
    const {
      languageChinese,
      languageChineseTraditional,
      languageEnglish,
      languageGerman,
      languageKorean,
      languageSpanish,
      languageVietnamese,
    } = await loadLanguageModule()
    const keys = [
      'generationPersistenceQueued',
      'generationPersistenceStalled',
      'generationPersistenceTerminal',
      'generationPersistenceStalledLegacy',
    ] as const

    for (const pack of [
      languageEnglish,
      languageGerman,
      languageSpanish,
      languageVietnamese,
      languageChinese,
      languageChineseTraditional,
      languageKorean,
    ]) {
      for (const key of keys) expect(pack[key]).toEqual(expect.any(String))
    }
  })

  it('defines the acknowledged Stop lifecycle copy in every language pack', async () => {
    const {
      languageChinese,
      languageChineseTraditional,
      languageEnglish,
      languageGerman,
      languageKorean,
      languageSpanish,
      languageVietnamese,
    } = await loadLanguageModule()

    for (const pack of [
      languageEnglish,
      languageGerman,
      languageSpanish,
      languageVietnamese,
      languageChinese,
      languageChineseTraditional,
      languageKorean,
    ]) {
      expect(pack.generationStop).toMatchObject({
        stopping: expect.any(String),
        failed: expect.any(String),
        retry: expect.any(String),
        savingStoppedPartial: expect.any(String),
      })
    }
  })

  it('defines every chat occupancy state, action, and feedback string in every language pack', async () => {
    const {
      languageChinese,
      languageChineseTraditional,
      languageEnglish,
      languageGerman,
      languageKorean,
      languageSpanish,
      languageVietnamese,
    } = await loadLanguageModule()
    const englishKeys = Object.keys(languageEnglish.connectedReaders.chatOccupancy).sort()

    for (const pack of [
      languageEnglish,
      languageGerman,
      languageSpanish,
      languageVietnamese,
      languageChinese,
      languageChineseTraditional,
      languageKorean,
    ]) {
      const occupancy = pack.connectedReaders?.chatOccupancy
      expect(occupancy).toBeDefined()
      expect(Object.keys(occupancy ?? {}).sort()).toEqual(englishKeys)
      for (const key of englishKeys) {
        expect((occupancy as Record<string, unknown>)[key]).toEqual(expect.any(String))
      }
    }
  })

  it('describes retained chat-only submissions as uncertain rather than rejected', async () => {
    const { languageEnglish } = await loadLanguageModule()
    const occupancy = languageEnglish.connectedReaders.chatOccupancy

    expect(occupancy.sendQueued).toContain('not yet confirmed')
    expect(occupancy.rerollRetained).toContain('not yet confirmed')
    expect(occupancy.sendQueued).not.toContain('has not been accepted')
    expect(occupancy.rerollRetained).not.toContain('has not been accepted')
  })

  it('defines generation recovery action copy in every language pack', async () => {
    const {
      languageChinese,
      languageChineseTraditional,
      languageEnglish,
      languageGerman,
      languageKorean,
      languageSpanish,
      languageVietnamese,
    } = await loadLanguageModule()

    for (const pack of [
      languageEnglish,
      languageGerman,
      languageSpanish,
      languageVietnamese,
      languageChinese,
      languageChineseTraditional,
      languageKorean,
    ]) {
      expect(pack.generationRecovery).toMatchObject({
        failed: expect.any(String),
        retry: expect.any(String),
        retrying: expect.any(String),
        discard: expect.any(String),
        discarding: expect.any(String),
      })
    }
  })

  it('renders Vietnamese inlay counts without a stray template-literal dollar sign', async () => {
    const { languageVietnamese } = await loadLanguageModule()

    expect(languageVietnamese.playground.inlayDeleteMultipleConfirm.replace('{count}', '3')).toContain('3 tài sản')
    expect(languageVietnamese.playground.inlayTotalAssets.replace('{count}', '3')).toBe('Tổng cộng 3 tài sản')
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
  const cloneSpy = vi.fn(cloneWithFunctions)
  vi.stubGlobal('safeStructuredClone', cloneSpy)
  return { load, cloneSpy, lang: await import('./index') }
}

describe('selected language loading', () => {
  afterEach(() => vi.doUnmock('./loadLanguagePack'))

  it('has an immediate English fallback without requesting a deferred pack', async () => {
    const { lang, load, cloneSpy } = await controlledLanguageModule()
    expect(lang.language.showHelp).toBe('Show Help')
    await lang.changeLanguage('unknown')
    expect(load).not.toHaveBeenCalled()
    expect(cloneSpy).not.toHaveBeenCalled()
  })

  it('memoizes concurrent requests and merges partial nested packs over English once', async () => {
    const { lang, load, cloneSpy } = await controlledLanguageModule()
    const korean = deferred<Record<string, unknown>>()
    load.mockReturnValue(korean.promise)
    const first = lang.getLanguageForCode('ko')
    const second = lang.getLanguageForCode('ko')
    const selecting = lang.changeLanguage('ko')
    expect(first).toBe(second)
    expect(load).toHaveBeenCalledExactlyOnceWith('ko')
    expect(lang.language.showHelp).toBe('Show Help')
    korean.resolve({ showHelp: 'Korean help', errors: { toomuchtoken: 'Korean token' } })
    await selecting
    expect(lang.language.showHelp).toBe('Korean help')
    expect(lang.language.errors.toomuchtoken).toBe('Korean token')
    expect(lang.language.errors.networkFetch).toEqual(expect.any(String))
    expect(lang.language.errors.imageGenerationFailed(502)).toContain('502')
    expect(cloneSpy).toHaveBeenCalledTimes(1)
    expect(await lang.getLanguageForCode('ko')).toBe(await first)
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
