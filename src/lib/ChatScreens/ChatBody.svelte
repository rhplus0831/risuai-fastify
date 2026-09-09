<script lang="ts">
  import { getContext, onDestroy, untrack } from 'svelte'
  import { language } from 'src/lang'
  import { getModuleAssets } from 'src/ts/process/modules'
  import { disableReaderScriptControls } from './readerPassiveHtml'
  import {
    canUseClientWriteAccess,
    captureClientSessionGeneration,
    clientSessionStore,
    isClientSessionGenerationCurrent,
  } from 'src/ts/clientSession'
  import { sleep } from 'src/ts/util'
  import { alertError } from '../../ts/alert'
  import {
    addMetadataToElement,
    chatHtmlRenderPolicyKey,
    getDistance,
    postTranslationParse,
    trimMarkdown,
    type CbsConditions,
    type simpleCharacterArgument,
  } from '../../ts/parser/parser.svelte'
  import { translateHTML } from '../../ts/translator/translator'
  import { pruneEmptyBilingualPairs } from '../../ts/translator/bilingualInterleave'
  import { createChatBodyRenderMemo } from './ChatBodyRenderMemo'
  import { CHAT_DISPLAY_SCHEDULER, type ChatDisplayScheduler } from './chatDisplayScheduler'
  import { CHAT_DISPLAY_COMMIT_COORDINATOR, type ChatDisplayCommitCoordinator } from './chatDisplayCommitCoordinator'
  import { getFileSrc } from 'src/ts/globalApi.svelte'
  import {
    RegexDisplayReloadPointer,
    RegexDisplayReloadScope,
    regexDisplayReloadTokenForContext,
  } from 'src/ts/process/regexDisplayReload'
  import {
    getChatBodyCachedOnlyLlmDecision,
    getChatBodyCachedOnlyLlmDetectionMode,
    getChatBodyCachedOnlyLlmDetectionKey,
    getChatBodyParseMemoKey,
    memoizedChatBodyParse,
    createChatBodyParseOwnerReaders,
  } from './ChatBodyParseMemo'
  import type { DisplaySourceLayer } from '@risuai/protocol/display-source'
  import type { DisplaySourcePriority } from 'src/ts/server/displaySources'
  import { getChatReadOwnersContext } from './chatReadOwnersContext'

  interface Props {
    character?: simpleCharacterArgument | string | null
    firstMessage?: boolean
    idx?: number
    chatId?: string
    msgDisplay?: string
    name?: string
    messageId?: string
    displayLayer?: DisplaySourceLayer
    streaming?: boolean
    displayPriority?: DisplaySourcePriority
    transcriptRowKey?: string
    parseRevision?: string
    role: string | null
    translated: boolean
    translating: boolean
    retranslate: boolean
    allowClientTranslation?: boolean
    readOnly?: boolean
    bodyRoot?: HTMLElement | null
    modelShortName: string
    onInitialDisplayParseStart?: (registration: symbol) => void
    onInitialDisplayParseSettled?: (registration: symbol) => void
  }

  let {
    character = null,
    idx = 0,
    firstMessage = false,
    chatId,
    msgDisplay,
    name,
    messageId,
    displayLayer = 'original',
    streaming = false,
    displayPriority = 'normal',
    transcriptRowKey = undefined,
    parseRevision = '',
    role,
    translated = $bindable(false),
    translating = $bindable(false),
    retranslate = $bindable(false),
    allowClientTranslation = true,
    readOnly = false,
    bodyRoot,
    modelShortName = '',
    onInitialDisplayParseStart = () => {},
    onInitialDisplayParseSettled = () => {},
  }: Props = $props()
  const effectiveReadOnly = $derived.by(() => {
    void $clientSessionStore
    return readOnly || !canUseClientWriteAccess()
  })
  const parseOwners = createChatBodyParseOwnerReaders(getChatReadOwnersContext())
  const displayScheduler = getContext<ChatDisplayScheduler | undefined>(CHAT_DISPLAY_SCHEDULER)
  const displayCommitCoordinator = getContext<ChatDisplayCommitCoordinator | undefined>(CHAT_DISPLAY_COMMIT_COORDINATOR)
  let queuedDisplay: AbortController | undefined

  let lastParsed = $state('')
  let lastTranslationDetectionKey = ''
  let markParsingRun = 0
  const initialDisplayParseRegistration = Symbol('initial-display-parse')
  let initialDisplayParseStarted = false
  let initialDisplayParseSettled = false
  let regexDisplayReloadToken = $derived(
    regexDisplayReloadTokenForContext($RegexDisplayReloadPointer, $RegexDisplayReloadScope, {
      characterId: typeof character === 'string' ? character : character?.chaId,
    }),
  )

  function beginInitialDisplayParse() {
    if (initialDisplayParseStarted) return
    initialDisplayParseStarted = true
    onInitialDisplayParseStart(initialDisplayParseRegistration)
  }

  function settleInitialDisplayParse() {
    if (!initialDisplayParseStarted || initialDisplayParseSettled) return
    initialDisplayParseSettled = true
    onInitialDisplayParseSettled(initialDisplayParseRegistration)
  }

  function commitParsedBody(html: string, settle: boolean): void {
    const apply = () => {
      lastParsed = html
      if (settle) settleInitialDisplayParse()
    }
    if (displayCommitCoordinator && transcriptRowKey) {
      displayCommitCoordinator.commit(transcriptRowKey, apply, {
        signal: queuedDisplay?.signal,
        // Serialized background parsing can outlast the interaction grace. Its
        // first HTML and placeholder release must still preserve one viewport.
        preserveAnchor: !initialDisplayParseSettled,
      })
    } else {
      apply()
    }
  }

  onDestroy(() => {
    queuedDisplay?.abort()
    markParsingRun += 1
    settleInitialDisplayParse()
  })

  function getCbsCondition() {
    try {
      const cbsConditions: CbsConditions = {
        firstmsg: firstMessage ?? false,
        chatRole: role,
      }
      return cbsConditions
    } catch (e) {
      return {
        firstmsg: firstMessage ?? false,
        chatRole: null,
      }
    }
  }

  function reportParsingError(error: unknown) {
    const parsingError = error instanceof Error ? error : new Error(typeof error === 'string' ? error : String(error))
    alertError(`Error while parsing chat message: ${translated}, ${parsingError.message}, ${parsingError.stack}`)
  }

  const finalizeBody = createChatBodyRenderMemo((html, model) => {
    const body = addMetadataToElement(pruneEmptyBilingualPairs(trimMarkdown(html)), model)
    return effectiveReadOnly ? disableReaderScriptControls(body, language.connectedReaders.writeAccessRequired) : body
  })
  function renderParsedChatBody(html: string): string {
    const policy = `${chatHtmlRenderPolicyKey()}|${effectiveReadOnly}|${language.connectedReaders.writeAccessRequired}`
    const model = modelShortName
    return untrack(() => finalizeBody(html ?? '', model, policy))
  }

  function automaticClientTranslationEnabled(): boolean {
    const chat = parseOwners.activeChatOwner()
    return chat?.autoTranslate === true && !(chat.autoTranslateBotOnly === true && role === 'user')
  }

  async function parseWithRetry(
    parse: () => Promise<string>,
    fallback: string,
  ): Promise<{ ok: true; value: string } | { ok: false; value: string }> {
    let tries = 0

    while (true) {
      try {
        return { ok: true, value: await parse() }
      } catch (error) {
        if (tries > 2) {
          reportParsingError(error)
          return { ok: false, value: fallback }
        }
        tries += 1
      }
    }
  }

  async function translateHTMLOnce(
    html: string,
    charArg: string | simpleCharacterArgument,
    chatID: number,
    regenerate: boolean,
    fallback: string,
    setTranslating: (value: boolean) => void,
    canTranslate: () => boolean,
  ): Promise<{ ok: true; value: string } | { ok: false; value: string }> {
    if (!canTranslate()) return { ok: false, value: fallback }
    setTranslating(true)
    try {
      const value = await translateHTML(html, false, charArg, chatID, regenerate)
      return canTranslate() ? { ok: true, value } : { ok: false, value: fallback }
    } catch (error) {
      if (canTranslate()) reportParsingError(error)
      return { ok: false, value: fallback }
    } finally {
      setTranslating(false)
    }
  }

  const markParsing = async (data: string, charArg: string | simpleCharacterArgument, chatID: number) => {
    const runId = ++markParsingRun
    const sessionGeneration = captureClientSessionGeneration()
    const parseReadOnly = effectiveReadOnly
    const isRunCurrent = () => runId === markParsingRun && isClientSessionGenerationCurrent(sessionGeneration)
    const canTranslateForRun = () => isRunCurrent() && !readOnly && canUseClientWriteAccess() && allowClientTranslation
    const parseForRun = (input: Parameters<typeof memoizedChatBodyParse>[0]) =>
      isRunCurrent() ? memoizedChatBodyParse(input) : Promise.resolve(data)
    const setTranslatingForRun = (value: boolean) => {
      // A retired run may clear only its own busy indicator; a replacement run owns its own state.
      if (runId === markParsingRun && (!value || isRunCurrent())) translating = value
    }
    // track 'translated' and 'retranslate' state
    translated
    retranslate
    let mode = 'notrim' as const
    const cbsConditions = getCbsCondition()

    try {
      const detectTranslation = canTranslateForRun() && !retranslate
      const automaticTranslation = detectTranslation && automaticClientTranslationEnabled()
      const settings = parseOwners.settingsOwner()
      const detectCachedLlm =
        automaticTranslation && settings.autoTranslateCachedOnly && settings.translatorType === 'llm'
      const cachedOnlyDetectionMode = getChatBodyCachedOnlyLlmDetectionMode({ fallbackMode: mode, owners: parseOwners })
      const cachedOnlyParseKey =
        detectCachedLlm && cachedOnlyDetectionMode !== 'raw'
          ? getChatBodyParseMemoKey({
              data,
              charArg,
              owners: parseOwners,
              mode: cachedOnlyDetectionMode,
              chatID,
              cbsConditions,
              chatId,
              displayLayer,
              messageId,
              name,
              streaming,
              displayPriority,
              readOnly: parseReadOnly,
            })
          : undefined
      const detectionKey = detectCachedLlm
        ? getChatBodyCachedOnlyLlmDetectionKey({
            data,
            charArg,
            owners: parseOwners,
            chatID,
            cbsConditions,
            chatId,
            fallbackMode: mode,
            cachedOnlyParseKey,
          })
        : `automatic:${automaticTranslation}`
      if (detectTranslation && detectionKey !== lastTranslationDetectionKey) {
        lastTranslationDetectionKey = detectionKey
        let translateText = false
        try {
          const settings = parseOwners.settingsOwner()
          if (automaticClientTranslationEnabled()) {
            if (settings.autoTranslateCachedOnly && settings.translatorType === 'llm') {
              translateText = await getChatBodyCachedOnlyLlmDecision({
                data,
                charArg,
                owners: parseOwners,
                chatID,
                cbsConditions,
                chatId,
                displayLayer,
                messageId,
                name,
                streaming,
                displayPriority,
                readOnly: parseReadOnly,
                fallbackMode: mode,
                cachedOnlyParseKey,
                detectionKey,
              })
            } else {
              translateText = true
            }
          }

          const lastTranslated = translated

          setTimeout(() => {
            if (canTranslateForRun()) translated = translateText
          }, 10)

          // State change of `translated` triggers markParsing again,
          // causing redundant translation attempts.
          if (lastTranslated !== translateText) {
            return
          }
        } catch (error) {
          console.error(error)
        }
      }

      if (canTranslateForRun() && (retranslate || translated)) {
        const settings = parseOwners.settingsOwner()
        if (settings.showTranslationLoading) {
          commitParsedBody(
            `<div style="display:flex;justify-content:center;align-items:center;height:48px;"><div style="animation: spin 1s linear infinite; border-radius: 50%; height: 32px; width: 32px; border: 2px solid #3b82f6; border-top: 2px solid transparent;"></div></div><style>@keyframes spin { to { transform: rotate(360deg); } }</style>`,
            false,
          )
        }

        if (settings.translatorType === 'llm' && settings.translateBeforeHTMLFormatting) {
          await sleep(100)
          const translatedHtml = await translateHTMLOnce(
            data,
            charArg,
            chatID,
            retranslate,
            data,
            setTranslatingForRun,
            canTranslateForRun,
          )
          if (!translatedHtml.ok) {
            return translatedHtml.value
          }
          const marked = await parseWithRetry(
            () =>
              parseForRun({
                data: translatedHtml.value,
                charArg,
                owners: parseOwners,
                mode,
                chatID,
                cbsConditions,
                chatId,
                displayLayer,
                messageId,
                name,
                streaming,
                displayPriority,
                readOnly: parseReadOnly,
              }),
            data,
          )
          if (!marked.ok) {
            return marked.value
          }
          setTimeout(() => {
            if (isRunCurrent()) {
              retranslate = false
            }
          }, 10)
          return marked.value
        } else if (!settings.legacyTranslation) {
          const marked = await parseWithRetry(
            () =>
              parseForRun({
                data,
                charArg,
                owners: parseOwners,
                mode: 'pretranslate',
                memoKey: cachedOnlyDetectionMode === 'pretranslate' ? cachedOnlyParseKey : undefined,
                chatID,
                cbsConditions,
                chatId,
                displayLayer,
                messageId,
                name,
                streaming,
                displayPriority,
                readOnly: parseReadOnly,
              }),
            data,
          )
          if (!marked.ok) {
            return marked.value
          }
          const translatedHtml = await translateHTMLOnce(
            marked.value,
            charArg,
            chatID,
            retranslate,
            data,
            setTranslatingForRun,
            canTranslateForRun,
          )
          if (!translatedHtml.ok) {
            return translatedHtml.value
          }
          const translated = await parseWithRetry(
            () => Promise.resolve(postTranslationParse(translatedHtml.value)),
            data,
          )
          if (!translated.ok) {
            return translated.value
          }
          setTimeout(() => {
            if (isRunCurrent()) {
              retranslate = false
            }
          }, 10)
          return translated.value
        } else {
          const marked = await parseWithRetry(
            () =>
              parseForRun({
                data,
                charArg,
                owners: parseOwners,
                mode,
                memoKey: cachedOnlyDetectionMode === mode ? cachedOnlyParseKey : undefined,
                chatID,
                cbsConditions,
                chatId,
                displayLayer,
                messageId,
                name,
                streaming,
                displayPriority,
                readOnly: parseReadOnly,
              }),
            data,
          )
          if (!marked.ok) {
            return marked.value
          }
          const translated = await translateHTMLOnce(
            marked.value,
            charArg,
            chatID,
            retranslate,
            data,
            setTranslatingForRun,
            canTranslateForRun,
          )
          if (!translated.ok) {
            return translated.value
          }
          setTimeout(() => {
            if (isRunCurrent()) {
              retranslate = false
            }
          }, 10)
          return translated.value
        }
      } else {
        const marked = await parseWithRetry(
          () =>
            parseForRun({
              data,
              charArg,
              owners: parseOwners,
              mode,
              memoKey: cachedOnlyDetectionMode === mode ? cachedOnlyParseKey : undefined,
              chatID,
              cbsConditions,
              chatId,
              displayLayer,
              messageId,
              name,
              streaming,
              displayPriority,
              readOnly: parseReadOnly,
            }),
          data,
        )
        if (!marked.ok) {
          return marked.value
        }
        return marked.value
      }
    } catch (error) {
      if (isRunCurrent()) {
        settleInitialDisplayParse()
      }
      throw error
    }
  }

  const checkImg = () => {
    if (!parseOwners.settingsOwner().newImageHandlingBeta || !bodyRoot) {
      return
    }
    const imgs = bodyRoot.querySelectorAll(
      'img:not([src^="/api/v1/assets/"]):not([src^="data:"]):not([src^="http:"]):not([src^="https:"]):not([src^="blob:"]):not([src^="file:"]):not([noimage])',
    ) as NodeListOf<HTMLImageElement>

    if (imgs.length > 0) {
      const currentCharacter = parseOwners.activeCharacterOwner()
      if (!currentCharacter) return
      const styl = currentCharacter.prebuiltAssetStyle
      const root = bodyRoot
      const currentChat = parseOwners.activeChatOwner()
      const generation = captureClientSessionGeneration()
      const parseRun = markParsingRun
      const assets = (
        effectiveReadOnly
          ? (parseOwners.moduleOwners?.() ?? []).flatMap((module) => module.assets ?? [])
          : getModuleAssets({ character: currentCharacter, chat: currentChat })
      ).concat(currentCharacter.additionalAssets ?? [])
      const normalizedAssets = assets.map((asset) => {
        return {
          name: asset[0].toLocaleLowerCase(),
          path: asset[1],
        }
      })
      const exactAssets = new Map(normalizedAssets.map((asset) => [asset.name, asset.path]))

      imgs.forEach(async (img) => {
        const name = img.getAttribute('src')?.toLocaleLowerCase() || ''
        const current = () =>
          isClientSessionGenerationCurrent(generation) &&
          parseRun === markParsingRun &&
          root === bodyRoot &&
          img.isConnected &&
          root.contains(img) &&
          parseOwners.activeCharacterOwner() === currentCharacter &&
          parseOwners.activeChatOwner() === currentChat &&
          (img.getAttribute('src')?.toLocaleLowerCase() || '') === name

        if (name.length > 200 || name.includes(':')) {
          img.setAttribute('noimage', 'true')
          return
        }

        const foundAsset = exactAssets.get(name)
        if (foundAsset) {
          const source = await getFileSrc(foundAsset)
          if (!current()) return
          img.classList.add('root-loaded-image')
          img.classList.add('root-loaded-image-' + styl)
          img.src = source
          return
        }

        if (name.length < 3) {
          img.setAttribute('noimage', 'true')
          return
        }
        const prefixLoc = name.lastIndexOf('.')
        const prefix = prefixLoc > 0 ? name.substring(0, prefixLoc) : ''
        let currentDistance = 1000
        let currentFound = ''
        for (const asset of normalizedAssets) {
          if (!asset.name.startsWith(prefix)) {
            continue
          }
          const distance = getDistance(name, asset.name)
          if (distance < currentDistance) {
            currentDistance = distance
            currentFound = asset.path
          }
        }
        if (currentFound) {
          const got = await getFileSrc(currentFound)
          if (!current()) return
          img.setAttribute('src', got)

          if (img.classList.length === 0) {
            img.classList.add('root-loaded-image')
            img.classList.add('root-loaded-image-' + styl)
          }
          img.removeAttribute('noimage')
        } else {
          img.setAttribute('noimage', 'true')
        }
      })
    }
  }

  let previousParseInputs: unknown[] = []
  let previousParse: Promise<string> | undefined
  let markParsingResult = $derived.by(() => {
    void regexDisplayReloadToken
    const parseData = msgDisplay
    const parseCharacter = character
    const parseIndex = idx
    const parseChatId = chatId
    const parseMessageId = messageId
    const parseDisplayLayer = displayLayer
    const parseStreaming = streaming
    const parseDisplayPriority = displayPriority
    const parseName = name

    // These local inputs intentionally restart parsing. Database reads made by
    // the parser are snapshots; their UI activation is controlled by the
    // explicit reload pointers instead of deep subscriptions per chat row.
    const inputs = [
      parseRevision,
      regexDisplayReloadToken,
      parseData,
      parseCharacter,
      parseIndex,
      parseChatId,
      parseMessageId,
      parseDisplayLayer,
      parseStreaming,
      parseDisplayPriority,
      parseName,
      translated,
      retranslate,
      allowClientTranslation,
      effectiveReadOnly,
      firstMessage,
      role,
    ]
    if (previousParse && inputs.every((input, index) => input === previousParseInputs[index])) return previousParse
    previousParseInputs = inputs

    previousParse = untrack(() => {
      queuedDisplay?.abort()
      // Register before background scheduling so the transcript can retain a
      // returning row's measured height while its first body is still queued.
      beginInitialDisplayParse()
      // Invalidate a previous in-flight parse even when its replacement queues.
      markParsingRun += 1
      const controller = new AbortController()
      queuedDisplay = controller
      if (!displayScheduler || parseDisplayPriority !== 'background') {
        return markParsing(parseData, parseCharacter, parseIndex)
      }
      return displayScheduler.run(
        () => markParsing(parseData, parseCharacter, parseIndex),
        controller.signal,
        transcriptRowKey,
      )
    })
    return previousParse
  })

  $effect(() => {
    const result = markParsingResult
    let cancelled = false
    void result.then((html) => {
      if (cancelled || html === undefined) return
      // Translation detection can queue another parse without producing HTML.
      // Keep the initial registration until a body is actually committed.
      commitParsedBody(html, true)
    })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    lastParsed
    checkImg()
  })
</script>

{@html renderParsedChatBody(lastParsed)}
