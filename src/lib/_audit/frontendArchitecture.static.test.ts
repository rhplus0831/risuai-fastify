import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

function sourceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle)
  const end = source.indexOf(endNeedle, start + startNeedle.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

function exportedFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = source.indexOf('\nexport function ', start + 1)
  return source.slice(start, next === -1 ? source.length : next)
}

function localFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, next === -1 ? source.length : next)
}

describe('static architecture gate: explicit resource owners', () => {
  it('does not expose the aggregate database facade or its write guard', () => {
    const storage = readSource('src/ts/storage/database.svelte.ts')
    const resources = readSource('src/ts/server/resourceState.svelte.ts')
    const bootstrap = readSource('src/ts/bootstrap.ts')

    expect(storage).not.toContain('export function getDatabase')
    expect(resources).not.toContain('export function getResourceDatabase')
    expect(resources).not.toContain('withResourceDatabaseWrite')
    expect(bootstrap).not.toContain('setResourceWriteGuardEnabled')
    expect(existsSync(resolve(process.cwd(), 'src/ts/server/resourceWriteGuard.svelte.ts'))).toBe(false)
    expect(existsSync(resolve(process.cwd(), 'src/ts/server/pendingBridgeFlushRegistry.ts'))).toBe(false)
    expect(existsSync(resolve(process.cwd(), 'src/ts/server/bridgeFlush.ts'))).toBe(false)
  })

  it('flushes loaded owner mutations without importing feature owners into bootstrap', () => {
    const lifecycle = readSource('src/ts/server/ownerMutationLifecycle.ts')
    expect(lifecycle).toContain('flushRegisteredPendingOwnerMutations(options)')
    expect(lifecycle).not.toContain("from './settingsOwner.svelte'")
    expect(lifecycle).not.toContain("from './characterDraft.svelte'")
    expect(lifecycle).not.toContain("from './lorebookOwner.svelte'")
    expect(lifecycle).not.toContain("from './promptTemplateMutations.svelte'")
    expect(lifecycle).not.toContain("from './scriptDefinitionOwner.svelte'")

    for (const file of [
      'src/ts/server/settingsOwner.svelte.ts',
      'src/ts/server/characterDraft.svelte.ts',
      'src/ts/server/lorebookOwner.svelte.ts',
      'src/ts/server/promptTemplateMutations.svelte.ts',
      'src/ts/server/scriptDefinitionOwner.svelte.ts',
    ]) {
      expect(readSource(file)).toContain('registerPendingOwnerMutationFlusher(')
    }
  })
})

describe('static architecture gate: responsive partial-edit dialogs', () => {
  it('caps every dialog to the padded viewport instead of enforcing a 400px mobile minimum', () => {
    const componentSource = readSource('src/lib/ChatScreens/PartialEditController.svelte')
    const declarationsFor = (selector: string): string => {
      const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const matches = Array.from(componentSource.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`, 'g')))
      const responsiveDeclarations = matches
        .map((match) => match[1])
        .find((declarations) => declarations.includes('min-width'))
      expect(responsiveDeclarations, `${selector} responsive CSS rule`).toBeTruthy()
      return responsiveDeclarations!
    }

    for (const [selector, desktopMinimum] of new Map([
      ['.partial-match-failed-modal', '320px'],
      ['.partial-delete-modal', '400px'],
      ['.partial-edit-modal', '400px'],
      ['.partial-match-selection-modal', '400px'],
    ])) {
      const declarations = declarationsFor(selector)
      expect(declarations).toContain(`min-width: min(${desktopMinimum}, calc(100vw - 24px));`)
      expect(declarations).toMatch(/max-width: min\([^;]+calc\(100vw - 24px\)\);/)
      expect(declarations).toContain('box-sizing: border-box;')
    }
  })
})

describe('static architecture gate: media picker token timing', () => {
  it.each([
    {
      file: 'src/lib/Setting/Pages/Module/ModuleMenu.svelte',
      start: 'async function uploadModuleAssets()',
      end: 'function addLorebook()',
      picker: 'selectMultipleFile(MODULE_ASSET_EXTENSIONS, {',
      callback: 'onFilesSelected: () => {',
      begin: 'operation = beginModuleAssetUpload(target)',
      guard: 'if (!files || files.length === 0 || !operation) return',
    },
    {
      file: 'src/lib/Setting/Pages/OtherBotSettings.svelte',
      start: 'async function uploadSettingsMediaAsset(',
      end: 'async function uploadNaiCharacterReferenceImage()',
      picker: "selectSingleFile(['jpg', 'jpeg', 'png', 'webp'], {",
      callback: 'onFileSelected: () => {',
      begin: 'operation = beginSettingsMediaAssetUpload(target)',
      guard: 'if (!img || !operation) return',
    },
    {
      file: 'src/lib/Setting/Pages/BotSettings.svelte',
      start: 'async function uploadSelectedPromptPresetIcon()',
      end: 'function snapshotJson(',
      picker: "selectSingleFile(['png', 'jpg', 'jpeg', 'webp'], {",
      callback: 'onFileSelected: () => {',
      begin: 'operation = beginPromptPresetIconUpload(target)',
      guard: 'if (!selected || !operation) return',
    },
  ])(
    'issues the latest-operation token from the picker callback in $file',
    ({ file, start, end, picker, callback, begin, guard }) => {
      const body = sourceBetween(readSource(file), start, end)
      expect(body).toContain(picker)
      expect(body).toContain(callback)
      expect(body).toContain(begin)
      expect(body.indexOf(begin)).toBeLessThan(body.indexOf(guard))
    },
  )
})

describe('static architecture gate: CharConfig boundaries', () => {
  const file = 'src/lib/SideBars/CharConfig.svelte'

  it('routes VITS and GPT-SoVITS media buttons through guarded helper functions', () => {
    const source = readSource(file)
    expect(source).toContain("from 'src/ts/server/characterTtsAssetUpload'")
    expect(source).toContain("import { registerOnnxModelFromFile } from 'src/ts/process/transformers'")
    expect(source).toContain('async function registerVitsModelFromEditor()')
    expect(source).toContain('async function uploadGptSoVitsReferenceAudioFromEditor()')
    expect(source).toContain('onclick={registerVitsModelFromEditor}')
    expect(source).toContain('onclick={uploadGptSoVitsReferenceAudioFromEditor}')
    expect(source).not.toContain('onclick={async () => {\n          const model = await registerOnnxModel()')
    expect(source).not.toContain("import { registerOnnxModel } from 'src/ts/process/transformers'")
  })

  it('issues additional asset upload tokens from the multi-file picker callback', () => {
    const body = sourceBetween(
      readSource(file),
      'async function uploadCharacterAdditionalAssetsFromEditor()',
      'function currentEditorTtsAssetUploadTarget(',
    )
    expect(body).toContain('const files = await selectMultipleFile(CHARACTER_ADDITIONAL_ASSET_EXTENSIONS, {')
    expect(body).toContain('onFilesSelected: () => {')
    expect(body).toContain('operation = beginCharacterAdditionalAssetUpload(target)')
    expect(body.indexOf('operation = beginCharacterAdditionalAssetUpload(target)')).toBeLessThan(
      body.indexOf('if (!files || files.length === 0 || !operation) return'),
    )
    expect(body).toContain('clearCharacterAdditionalAssetUpload(operation)')
  })

  it('issues notification-image tokens from the picker callback and guards the target fields', () => {
    const body = sourceBetween(
      readSource(file),
      'function currentEditorNotificationImageUploadTarget()',
      'function currentEditorTtsAssetUploadTarget(',
    )
    expect(body).toContain('rowNotificationImage: target.character.notificationImage')
    expect(body).toContain('draftNotificationImage: characterDraft.value.notificationImage')
    expect(body).toContain('const selected = (await selectSingleFile(NOTIFICATION_IMAGE_EXTENSIONS, {')
    expect(body).toContain('onFileSelected: () => {')
    expect(body).toContain('operation = beginCharacterNotificationImageUpload(target)')
    expect(body.indexOf('operation = beginCharacterNotificationImageUpload(target)')).toBeLessThan(
      body.indexOf('if (!selected || !operation) return'),
    )
    expect(body).toContain('if (!isCurrentEditorNotificationImageUpload(activeOperation)) return')
    expect(body).toContain('applyFreshCharacterNotificationImageUpload({')
    expect(body).toContain('clearCharacterNotificationImageUpload(operation)')
  })

  it('issues VITS tokens from the picker callback and guards registration before apply', () => {
    const body = sourceBetween(
      readSource(file),
      'async function registerVitsModelFromEditor()',
      'async function uploadGptSoVitsReferenceAudioFromEditor()',
    )
    expect(body).toContain("const selected = (await selectSingleFile(['zip'], {")
    expect(body).toContain('onFileSelected: () => {')
    expect(body).toContain('operation = beginCharacterTtsAssetUpload(target)')
    expect(body.indexOf('operation = beginCharacterTtsAssetUpload(target)')).toBeLessThan(
      body.indexOf('if (!selected || !operation) return'),
    )
    expect(body).toContain('if (!isCurrentEditorTtsAssetUpload(activeOperation)) return')
    expect(body).toContain('const model = await registerOnnxModelFromFile(selected, {')
    expect(body).toContain('shouldContinue: () => isCurrentEditorTtsAssetUpload(activeOperation)')
    expect(body).toContain('applyFreshCharacterVitsModelRegistration({')
    expect(body).toContain('character.vits = nextModel')
    expect(body).toContain('clearCharacterTtsAssetUpload(operation)')
    expect(body).not.toContain('character.vits = model')
  })

  it('issues GPT-SoVITS tokens from the picker callback and guards saveAsset before apply', () => {
    const body = sourceBetween(
      readSource(file),
      'async function uploadGptSoVitsReferenceAudioFromEditor()',
      'function clearOrRotateCharacterImage()',
    )
    expect(body).toContain("const audio = (await selectSingleFile(['wav', 'ogg', 'aac', 'mp3'], {")
    expect(body).toContain('onFileSelected: () => {')
    expect(body).toContain('operation = beginCharacterTtsAssetUpload(target)')
    expect(body.indexOf('operation = beginCharacterTtsAssetUpload(target)')).toBeLessThan(
      body.indexOf('if (!audio || !operation) return'),
    )
    expect(body).toContain('if (!isCurrentEditorTtsAssetUpload(activeOperation)) return')
    expect(body).toContain("const saveId = await saveAsset(audio.data, '', audio.name)")
    expect(body).toContain('applyFreshCharacterGptSoVitsReferenceAudioUpload({')
    expect(body).toContain('character.gptSoVitsConfig.ref_audio_data = nextRefAudioData')
    expect(body).toContain('clearCharacterTtsAssetUpload(operation)')
    expect(body).not.toContain('character.gptSoVitsConfig.ref_audio_data = {\n              fileName: audio.name')
  })

  it('keeps every direct shared form control named for its visible setting', () => {
    const source = readSource(file)
    for (const componentName of ['TextInput', 'TextAreaInput', 'NumberInput', 'SelectInput', 'SecretInput']) {
      const tags: string[] =
        source.match(new RegExp(`<${componentName}\\b[\\s\\S]*?(?:\\/>|</${componentName}>)`, 'g')) ?? []
      expect(tags.length, componentName).toBeGreaterThan(0)
      expect(
        tags.filter((tag) => !tag.includes('ariaLabel=')),
        `${componentName} controls without names`,
      ).toEqual([])
    }
  })

  it('does not gate persistent character actions on the profile draft type field', () => {
    const source = readSource(file)
    expect(source).not.toContain('characterDraft.value.type')
    expect(source).toContain('function currentRealCharacterDraftTarget()')
    expect(source).toContain('isServerCharacterShell(selectedCharacter)')
    expect(source).toContain("selectedCharacter.type && selectedCharacter.type !== 'character'")
    expect(source).toContain('characterDraft.characterId !== selectedCharacter.chaId')
    expect(source).not.toContain('changeCharImage($selectedCharID')
    expect(source).not.toContain('rmCharEmotion($selectedCharID')
    expect(source).not.toContain('addCharEmotion($selectedCharID')
  })

  it('keeps script definitions outside the profile draft and validates the add target', () => {
    const source = readSource(file)
    const draftSeed = sourceBetween(
      source,
      'const characterDraft = createCharacterOwnerDraft([',
      '  let characterScriptsDraft = $state<customscript[]>([])',
    )
    const scriptAddHandler = sourceBetween(
      source,
      '<span class="text-textcolor mt-4">{language.regexScript}',
      '<span class="text-textcolor mt-4">{language.triggerScript}',
    )
    expect(draftSeed).not.toContain("'type'")
    expect(draftSeed).not.toContain("'customscript'")
    expect(draftSeed).not.toContain("'triggerscript'")
    expect(scriptAddHandler).toContain('const target = currentRealCharacterDraftTarget()')
    expect(scriptAddHandler).toContain('scriptDraftCharacterId === target.character.chaId')
  })
})

describe('static architecture gate: lorebook owner boundaries', () => {
  it('uses dirty projection merge instead of blind LoreBookData replacement', () => {
    const source = readSource('src/lib/SideBars/LoreBook/LoreBookData.svelte')
    expect(source).toContain('dirtyDraftFields')
    expect(source).toContain('changedLorebookEntryDraftFields')
    expect(source).toContain('clearDirtyLorebookEntryFieldsMatchingProjection')
    expect(source).toContain('mergeLorebookEntryProjectionDraft')
    expect(source).toContain('subscribeLorebookEntryDraftRollbacks')
    expect(source).toContain('applyLorebookEntryDraftRollback')
    expect(source).toContain('entryDraftScopeKey')
  })

  it('clears matching LoreBookData dirty fields before the value/draft mismatch branch', () => {
    const source = readSource('src/lib/SideBars/LoreBook/LoreBookData.svelte')
    const valueChangedIndex = source.indexOf('if (valueSnapshot !== previousValueSnapshot)')
    const draftMismatchIndex = source.indexOf('if (valueSnapshot !== draftSnapshot)', valueChangedIndex)
    const clearIndex = source.indexOf('clearDirtyLorebookEntryFieldsMatchingProjection', valueChangedIndex)
    const preMismatchSource = source.slice(valueChangedIndex, draftMismatchIndex)
    expect(valueChangedIndex).toBeGreaterThanOrEqual(0)
    expect(draftMismatchIndex).toBeGreaterThan(valueChangedIndex)
    expect(clearIndex).toBeGreaterThan(valueChangedIndex)
    expect(clearIndex).toBeLessThan(draftMismatchIndex)
    expect(preMismatchSource).toContain('!targetChanged')
  })

  it('routes global rollback dispatchers through explicit owner helpers', () => {
    const source = readSource('src/ts/server/lorebookOwner.svelte.ts')
    expect(source).not.toContain('getResourceDatabase')
    expect(source).not.toContain('withTrustedResourceWrite')
    expect(source).not.toContain('withSuppressedLorebookWatcher')
    expect(source).toContain('collectionsResourceState.values.loreBook')
    const createDispatcher = exportedFunctionSource(source, 'dispatchCreateGlobalLorebook')
    expect(createDispatcher).toContain("hasCollectionProjectionEpochChanged('loreBook', collectionProjectionEpoch)")
    expect(createDispatcher).toContain('rollbackGlobalLorebookListEntry(rollbackEntry)')
    const deleteDispatcher = exportedFunctionSource(source, 'dispatchDeleteGlobalLorebook')
    expect(deleteDispatcher).toContain('restoreRow: !hasCollectionProjectionEpochChanged')
    expect(deleteDispatcher).toContain('restoreSelection: !hasLorebookPageProjectionEpochChanged')
    expect(deleteDispatcher).toContain('rollbackDeletedGlobalLorebook(rollbackEntry, selectionRollback')
    expect(source).not.toContain('export function dispatchSelectGlobalLorebook')
    expect(source).not.toContain('export function selectGlobalLorebook')
    expect(readSource('src/lib/Setting/lorepreset.svelte')).not.toContain('selectGlobalLorebook')
    const updateDispatcher = exportedFunctionSource(source, 'dispatchUpdateGlobalLorebook')
    expect(updateDispatcher).toContain("hasCollectionProjectionEpochChanged('loreBook', collectionProjectionEpoch)")
    expect(updateDispatcher).toContain('rollbackGlobalLorebookName(rollback)')
    const reorderDispatcher = exportedFunctionSource(source, 'dispatchReorderGlobalLorebooks')
    expect(reorderDispatcher).toContain('rollbackGlobalLorebookOrder(rollback)')
    expect(reorderDispatcher).toContain('rollbackGlobalLorebookSelection(selectionRollback)')

    const globalCreateRollback = localFunctionSource(source, 'rollbackGlobalLorebookListEntry')
    expect(globalCreateRollback).toContain('canApplyGlobalLorebookListRollback(rollbackEntry)')
    expect(globalCreateRollback).toContain('applyAttemptedKeyedListRollback')
    const globalNameRollback = localFunctionSource(source, 'rollbackGlobalLorebookName')
    expect(globalNameRollback).toContain('canApplyGlobalLorebookNameRollback(rollback)')
    expect(globalNameRollback).toContain('applyAttemptedFieldRollback')
    expect(localFunctionSource(source, 'rollbackGlobalLorebookOrder')).toContain(
      'sameStringArray(liveIds, rollback.attemptedIds)',
    )
  })

  it('routes lorepreset create, rename, and delete writes through owner helpers', () => {
    const source = readSource('src/lib/Setting/lorepreset.svelte')
    expect(source).not.toContain('withTrustedResourceWrite')
    expect(source).not.toContain('currentGlobalLorebookStateSnapshot')
    expect(source).not.toContain('dispatchCreateGlobalLorebook')
    expect(source).not.toContain('dispatchDeleteGlobalLorebook')
    expect(source).not.toContain('getResourceDatabase')
    expect(source).toContain('createGlobalLorebook()')
    expect(source).toContain('renameGlobalLorebookById(lorebookId, value)')
    expect(source).toContain('deleteGlobalLorebookByIdWithOutcome(targetLorebookId)')
  })

  it('wires external ModuleMenu LoreBookList typing through draft handlers', () => {
    const source = readSource('src/lib/Setting/Pages/Module/ModuleMenu.svelte')
    const lorebookList = source.slice(
      source.indexOf('<LoreBookList'),
      source.indexOf('<div class="text-textcolor2 mt-2 flex">'),
    )
    expect(source).toContain("applyLorebookEntryDraftEdit({ kind: 'module', moduleId }, index, value)")
    expect(source).toContain("flushPendingLorebookEntryDraftEdit({ kind: 'module', moduleId })")
    expect(source).toContain('replaceModuleLorebookCollectionDraft(moduleId, currentModule, entries)')
    expect(source).not.toContain('withTrustedResourceWrite')
    expect(source).not.toContain('currentLorebookCollectionScopedSnapshot')
    expect(source).not.toContain('dispatchReplaceModuleLorebooks')
    expect(lorebookList).toContain('onEntryChange={updateModuleLorebookValue}')
    expect(lorebookList).toContain('onEntrySettled={flushModuleLorebookValue}')
    expect(lorebookList).toContain('onCollectionChange={updateModuleLorebookCollection}')
  })

  it('routes lorebook component collection writes through owner helpers', () => {
    const setting = readSource('src/lib/SideBars/LoreBook/LoreBookSetting.svelte')
    const list = readSource('src/lib/SideBars/LoreBook/LoreBookList.svelte')
    for (const source of [setting, list]) {
      expect(source).not.toContain('withTrustedResourceWrite')
      expect(source).not.toContain('currentLorebookCollectionScopedSnapshot')
      expect(source).not.toContain('dispatchReplaceCharacterLorebooks')
      expect(source).not.toContain('dispatchReplaceChatLorebooks')
      expect(source).not.toContain('dispatchReplaceGlobalLorebookEntries')
    }
    expect(setting).not.toContain('getDatabase')
    expect(list).not.toContain('getDatabase')
    expect(setting).toContain('charactersResourceState')
    expect(list).toContain('collectionsResourceState')
    expect(setting).toContain('replaceCharacterLorebookCollection')
    expect(setting).toContain('replaceChatLorebookCollection')
    expect(list).toContain('replaceGlobalLorebookEntryCollection')
  })

  it('delegates LoreBookData local activation to the owner helper', () => {
    const source = readSource('src/lib/SideBars/LoreBook/LoreBookData.svelte')
    expect(source).not.toContain('withTrustedResourceWrite')
    expect(source).not.toContain('currentLorebookCollectionScopedSnapshot')
    expect(source).not.toContain('dispatchReplaceChatLorebooks')
    expect(source).not.toContain('getCurrentCharacter')
    expect(source).not.toContain('getCurrentChat')
    expect(source).not.toContain('getDatabase')
    expect(source).toContain('charactersResourceState')
    expect(source).toContain('settingsResourceState')
    expect(source).toContain('setActiveChatLorebookLocalActivation')
  })

  it('does not normalize ids from the global lorebook modal mount', () => {
    const source = readSource('src/lib/Setting/lorepreset.svelte')
    const mountEffect = source.slice(source.indexOf('$effect'), source.indexOf('</script>'))
    expect(mountEffect).not.toContain('ensureGlobalLorebookListIds')
    expect(mountEffect).not.toContain('ensureAllClientLorebookIds')
  })
})

describe('static architecture gate: prompt-template dispatch boundaries', () => {
  it('routes normal prompt-template reads through the unique owner policy', () => {
    const promptSettings = readSource('src/lib/Setting/Pages/PromptSettings.svelte')
    const botSettings = readSource('src/lib/Setting/Pages/BotSettings.svelte')
    const otherBotSettings = readSource('src/lib/Setting/Pages/OtherBotSettings.svelte')
    const devTool = readSource('src/lib/SideBars/DevTool.svelte')

    expect(promptSettings).toContain('resolveUniquePromptPreset(')
    expect(botSettings).toContain('function selectedPromptPresetOwner()')
    expect(botSettings).toContain('const preset = selectedPromptPresetOwner()')
    expect(otherBotSettings).toContain('resolveEffectivePromptTemplate(database)')
    expect(devTool).toContain("collectionsResourceState.statuses.promptPresets === 'ready'")
    expect(devTool).toContain("settingsResourceState.standaloneStatuses.promptPresetsId === 'ready'")
    expect(devTool).toContain("collectionsResourceState.statuses.promptTemplate === 'ready'")
    expect(devTool).not.toContain('getDatabase')
  })

  it('routes PromptSettings fields through owner-backed drafts without aggregate projection writes', () => {
    const source = readSource('src/lib/Setting/Pages/PromptSettings.svelte')
    expect(source).toContain('createServerBackedSettingDraft(key, fallback)')
    expect(source).toContain('createPromptPresetModelOverrideDraft(key, fallback)')
    expect(source).toContain('settingsResourceState.value.showUnrecommended')
    expect(source).toContain('collectionsResourceState.values.promptPresets')
    expect(source).not.toContain('getResourceDatabase')
    expect(source).not.toContain('getDatabase')
    expect(source).not.toContain('getServerResourceApplyEpoch')
    expect(source).not.toContain('withTrustedResourceWrite')
  })

  it('does not redispatch prompt preset model overrides after accepting projection changes', () => {
    const source = readSource('src/ts/promptPresetModelOverrides.svelte.ts')
    expect(source).toContain('let previousDraftDispatchSnapshot = snapshotJson(initialValue)')
    expect(source).toContain('previousDraftDispatchSnapshot = serverSnapshot')
    expect(source).toContain('if (snapshot === previousDraftDispatchSnapshot) return')
  })

  it('does not mirror prompt item edits through whole-preset commands', () => {
    expect(readSource('src/ts/server/promptTemplateMutations.svelte.ts')).not.toContain(
      "mirrorTopLevelPresetField('promptTemplate'",
    )
  })

  it('keeps PromptSettings row edits on item commands after template-id repair', () => {
    const source = readSource('src/lib/Setting/Pages/PromptSettings.svelte')
    expect(source).toContain('queuePromptPresetTemplateIdServerSync(ownerId)')
    expect(source).toContain('applyPromptItemProjectionWrite(promptTemplateDraft.value, itemId, ownerId)')
    expect(source).toContain('queueRowPatch(projectionFence, null)')
    expect(source).toContain('armPendingPromptItemProjectionUpdate(')
    expect(source).toContain('queuePromptItemProjectionUpdate(')
    expect(source).toContain('writePromptTemplateOwnerDraft(templates, ownerId)')
    expect(source).toContain('collectionsResourceState.values.promptTemplate = nextTemplate')
    expect(source).toContain('promptPresetId: promptTemplateOwnerCommandId(ownerId)')
    expect(source).toContain('markPromptTemplateOwnerAcknowledgementTainted(ownerId)')
    expect(source).toContain('ensurePromptTemplateDraftIds(currentPromptTemplateOwnerId())')
  })
})

describe('static architecture gate: script-definition owner boundaries', () => {
  it('routes CharConfig script draft writes through the owner helper', () => {
    const source = readSource('src/lib/SideBars/CharConfig.svelte')
    const start = source.indexOf('let characterScriptsDraft')
    const end = source.indexOf('let lasttokens', start)
    const scriptDraftSource = source.slice(start, end)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(scriptDraftSource).not.toContain('withTrustedResourceWrite')
    expect(source).toContain('scheduleCharacterScriptDefinitionDraft(')
    expect(source).toContain('captureCharacterRowProjectionEpoch')
    expect(source).toContain('hasCharacterRowProjectionEpochChanged')
    expect(source).not.toContain('getServerResourceApplyEpoch')
    expect(source).toContain('markDirtyScriptDefinitionRowFields')
    expect(source).toContain('subscribeServerCommandLocalEffectApplied')
    expect(source).toContain('clearDirtyScriptDefinitionFieldsMatchingAttempt')
    expect(source).toContain('mergeScriptDefinitionProjectionRows')
    expect(source).toContain('clearScriptDraftDirtyState()')
  })

  it('does not settle script dirty fields from a broad resource apply', () => {
    const source = readSource('src/lib/SideBars/CharConfig.svelte')
    const projectionChangedIndex = source.indexOf('const ownerProjectionChanged')
    const mismatchBranchIndex = source.indexOf(
      'if (targetChanged || snapshot !== scriptDraftSnapshot)',
      projectionChangedIndex,
    )
    const preMismatchSource = source.slice(projectionChangedIndex, mismatchBranchIndex)
    expect(projectionChangedIndex).toBeGreaterThanOrEqual(0)
    expect(mismatchBranchIndex).toBeGreaterThan(projectionChangedIndex)
    expect(preMismatchSource).toContain('ownerProjectionChanged')
    expect(preMismatchSource).not.toContain('clearDirtyScriptDefinitionFieldsMatchingAttempt')
  })

  it('wires ModuleMenu regex and trigger drafts through the script owner', () => {
    const source = readSource('src/lib/Setting/Pages/Module/ModuleMenu.svelte')
    expect(source).toContain('applyModuleScriptDefinitionDraft')
    expect(source).toContain('snapshotModuleScriptDraft')
    expect(source).toContain('currentModule?.regex ?? []')
    expect(source).toContain('currentModule?.trigger ?? []')
  })
})

describe('static architecture gate: settings owner boundaries', () => {
  it('keeps WelcomeRisu free of direct trusted projection writes', () => {
    const source = readSource('src/lib/Others/WelcomeRisu.svelte')
    expect(source).toContain('applyOnboardingServerBackedSettings')
    expect(source).not.toContain('withTrustedResourceWrite')
  })

  it('settles BotSettings prompt drafts through owner-aware receipts', () => {
    const source = readSource('src/lib/Setting/Pages/BotSettings.svelte')
    const start = source.indexOf('function createPromptFieldDraft')
    const end = source.indexOf('function promptFieldOwnerSignature', start)
    const promptDraftSource = source.slice(start, end)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(promptDraftSource).toContain('subscribeServerCommandLocalEffectApplied')
    expect(promptDraftSource).toContain('appliedLocalEffectAcknowledgesSettingDraft')
    expect(promptDraftSource).toContain("splitPresetProjection: 'presetRow'")
    expect(promptDraftSource).toContain('currentPromptFieldValue(key, fallback)')
  })
})
