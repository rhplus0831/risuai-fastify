import { setupBootstrapTests, bootstrapMocks } from './bootstrap.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { loadWebInitialDatabase } from './bootstrap'
import { language } from 'src/lang'
import { peekAppliedServerResourceRevision } from './server/commands'
import {
  applyCollectionsResource,
  applySettingsResource,
  applySettingsGroupResource,
  captureCollectionProjectionEpoch,
  captureSettingsGroupProjectionEpoch,
  captureSettingsProjectionEpoch,
  collectionsResourceState,
  hasCollectionProjectionEpochChanged,
  hasSettingsGroupProjectionEpochChanged,
  markCollectionAcknowledgementTainted,
  markSettingsAcknowledgementTainted,
  markSettingsGroupAcknowledgementTainted,
  settingsResourceState,
} from './server/resourceState.svelte'
import { getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

const { resourceApi, commandApi, eventApi, promptTemplateApi } = bootstrapMocks

setupBootstrapTests()

describe('API-backed client bootstrap', () => {
  it('acknowledges contiguous legacy/model preset reorders without collection or settings reads', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          botPresets: [
            { id: 'preset-a', name: 'Newer A' },
            { id: 'preset-b', name: 'Newer B' },
          ] as never,
        },
      },
      'botPresets',
    )
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          modelPresets: [
            { id: 'model-a', name: 'Newer A' },
            { id: 'model-b', name: 'Newer B' },
            { id: 'model-c', name: 'Newer C' },
          ] as never,
        },
      },
      'modelPresets',
    )
    applySettingsResource({ revision: 5, settings: { botPresetsId: 0, modelPresetsId: 0 } })
    const legacyCollectionEpoch = captureCollectionProjectionEpoch('botPresets')
    const modelCollectionEpoch = captureCollectionProjectionEpoch('modelPresets')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    withTestDatabaseWrite(() => {
      getDatabase().botPresets = [getDatabase().botPresets[1], getDatabase().botPresets[0]]
      getDatabase().botPresetsId = 1
      getDatabase().modelPresets = [
        getDatabase().modelPresets[0],
        getDatabase().modelPresets[2],
        getDatabase().modelPresets[1],
      ]
      getDatabase().modelPresetsId = 0
    })
    const legacyEvent = {
      type: 'preset.reordered',
      revision: 6,
      resource: 'presetCollectionWithPointer',
    }
    const modelEvent = { type: 'modelPreset.reordered', revision: 7, resource: 'modelPreset' }

    await commandApi.reconciler?.(
      modelEvent,
      [legacyEvent, modelEvent],
      new Map([
        [
          6,
          {
            kind: 'presetReorder',
            presetKind: 'legacy',
            collectionProjectionEpoch: legacyCollectionEpoch,
            settingsProjectionEpoch,
            presetIds: ['preset-b', 'preset-a'],
            selectedPresetId: 'preset-a',
            settingsWritten: true,
          },
        ],
        [
          7,
          {
            kind: 'presetReorder',
            presetKind: 'model',
            collectionProjectionEpoch: modelCollectionEpoch,
            settingsProjectionEpoch,
            presetIds: ['model-a', 'model-c', 'model-b'],
            selectedPresetId: 'model-a',
            settingsWritten: false,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-b', 'preset-a'])
    expect(getDatabase().modelPresets.map((preset) => preset.id)).toEqual(['model-a', 'model-c', 'model-b'])
    expect(collectionsResourceState.revisions.botPresets).toBe(6)
    expect(collectionsResourceState.revisions.modelPresets).toBe(7)
    expect(settingsResourceState.fullRevision).toBe(6)
    expect(hasCollectionProjectionEpochChanged('botPresets', legacyCollectionEpoch)).toBe(false)
    expect(hasCollectionProjectionEpochChanged('modelPresets', modelCollectionEpoch)).toBe(false)
    expect(captureSettingsProjectionEpoch()).toBe(settingsProjectionEpoch)
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('ignores unrelated full-settings staleness for a collection-only model preset reorder', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          modelPresets: [
            { id: 'model-a', name: 'A' },
            { id: 'model-b', name: 'B' },
            { id: 'model-c', name: 'C' },
          ] as never,
        },
      },
      'modelPresets',
    )
    applySettingsResource({ revision: 5, settings: { modelPresetsId: 1 } })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('modelPresets')
    const staleSettingsProjectionEpoch = captureSettingsProjectionEpoch()
    applySettingsResource({ revision: 5, settings: { modelPresetsId: 1 } })
    markSettingsAcknowledgementTainted()
    withTestDatabaseWrite(() => {
      getDatabase().modelPresets = [
        getDatabase().modelPresets[2],
        getDatabase().modelPresets[1],
        getDatabase().modelPresets[0],
      ]
    })
    const event = { type: 'modelPreset.reordered', revision: 6, resource: 'modelPreset' }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'presetReorder',
            presetKind: 'model',
            collectionProjectionEpoch,
            settingsProjectionEpoch: staleSettingsProjectionEpoch,
            presetIds: ['model-c', 'model-b', 'model-a'],
            selectedPresetId: 'model-b',
            settingsWritten: false,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(collectionsResourceState.revisions.modelPresets).toBe(6)
    expect(settingsResourceState.fullRevision).toBe(5)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it.each([
    'collection epoch',
    'collection taint',
    'settings epoch',
    'settings taint',
    'selection mismatch',
    'noncanonical pointer',
    'event resource',
  ])('falls back to authoritative reconciliation for a preset reorder with a stale %s proof', async (failure) => {
    await loadWebInitialDatabase()
    const presets = [
      { id: 'preset-b', name: 'B' },
      { id: 'preset-a', name: 'A' },
    ]
    applyCollectionsResource({ revision: 5, collections: { botPresets: presets as never } }, 'botPresets')
    applySettingsResource({ revision: 5, settings: { botPresetsId: 1 } })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('botPresets')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    let selectedPresetId: string | null = 'preset-a'
    let resource = 'presetCollectionWithPointer'
    if (failure === 'collection epoch') {
      applyCollectionsResource({ revision: 5, collections: { botPresets: presets as never } }, 'botPresets')
    } else if (failure === 'collection taint') {
      markCollectionAcknowledgementTainted('botPresets')
    } else if (failure === 'settings epoch') {
      applySettingsResource({ revision: 5, settings: { botPresetsId: 1 } })
    } else if (failure === 'settings taint') {
      markSettingsAcknowledgementTainted()
    } else if (failure === 'selection mismatch') {
      withTestDatabaseWrite(() => {
        getDatabase().botPresetsId = 0
      })
    } else if (failure === 'noncanonical pointer') {
      selectedPresetId = null
      withTestDatabaseWrite(() => {
        getDatabase().botPresetsId = -1
      })
    } else {
      resource = 'presetCollection'
    }
    const event = { type: 'preset.reordered', revision: 6, resource }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'presetReorder',
            presetKind: 'legacy',
            collectionProjectionEpoch,
            settingsProjectionEpoch,
            presetIds: ['preset-b', 'preset-a'],
            selectedPresetId,
            settingsWritten: true,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges a contiguous selected model preset PATCH field-wise without collection or settings reads', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          modelPresets: [{ id: 'model-a', name: 'Model A', temperature: 0.4 }] as never,
          promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }] as never,
        },
      },
      'modelPresets',
    )
    applyCollectionsResource(
      { revision: 5, collections: { promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }] as never } },
      'promptPresets',
    )
    withTestDatabaseWrite(() => {
      getDatabase().modelPresetsId = 0
      getDatabase().promptPresetsId = 0
      getDatabase().modelPresets[0].temperature = 0.6
      getDatabase().temperature = 0.6
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('modelPresets')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    const event = {
      type: 'modelPreset.updated',
      revision: 6,
      resource: 'modelPreset',
      id: 'model-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'splitPresetPatch',
            presetKind: 'model',
            presetId: 'model-a',
            attemptedPatch: { temperature: 0.6 },
            preset: { temperature: 0.5 },
            attemptedSettings: { temperature: 0.6 },
            settings: { temperature: 0.5 },
            selectedProjectionApplied: true,
            ownerProjectionApplied: false,
            collectionProjectionEpoch,
            settingsProjectionEpoch,
            selectedPresetId: 'model-a',
            selectedPromptPresetId: 'prompt-a',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().modelPresets[0].temperature).toBe(0.5)
    expect(getDatabase().temperature).toBe(0.5)
    expect(collectionsResourceState.revisions.modelPresets).toBe(6)
    expect(hasCollectionProjectionEpochChanged('modelPresets', collectionProjectionEpoch)).toBe(false)
    expect(captureSettingsProjectionEpoch()).toBe(settingsProjectionEpoch)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges a contiguous legacy preset PATCH field-wise without re-reading the row', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          botPresets: [
            {
              id: 'preset-a',
              name: 'Optimistic',
              temperature: 0.6,
              agentPresetDefaultId: 'missing-agent',
            },
          ] as never,
        },
      },
      'botPresets',
    )
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('botPresets')
    withTestDatabaseWrite(() => {
      getDatabase().botPresets[0].name = 'Newer local edit'
    })
    const event = {
      type: 'preset.updated',
      revision: 6,
      resource: 'presetRow',
      id: 'preset-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'legacyPresetPatch',
            presetId: 'preset-a',
            collectionProjectionEpoch,
            fields: {
              name: {
                attempted: { present: true, value: 'Optimistic' },
                canonical: { present: true, value: 'Canonical' },
              },
              temperature: {
                attempted: { present: true, value: 0.6 },
                canonical: { present: true, value: 0.5 },
              },
              agentPresetDefaultId: {
                attempted: { present: true, value: 'missing-agent' },
                canonical: { present: false },
              },
            },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().botPresets[0]).toMatchObject({
      id: 'preset-a',
      name: 'Newer local edit',
      temperature: 0.5,
    })
    expect(getDatabase().botPresets[0].agentPresetDefaultId).toBeUndefined()
    expect(collectionsResourceState.revisions.botPresets).toBe(6)
    expect(hasCollectionProjectionEpochChanged('botPresets', collectionProjectionEpoch)).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it.each(['changed epoch', 'tainted projection'])('%s forces a legacy preset PATCH fallback', async (failure) => {
    await loadWebInitialDatabase()
    const preset = { id: 'preset-a', name: 'Optimistic' }
    applyCollectionsResource({ revision: 5, collections: { botPresets: [preset] as never } }, 'botPresets')
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('botPresets')
    if (failure === 'changed epoch') {
      applyCollectionsResource({ revision: 5, collections: { botPresets: [preset] as never } }, 'botPresets')
    } else {
      markCollectionAcknowledgementTainted('botPresets')
    }
    const event = {
      type: 'preset.updated',
      revision: 6,
      resource: 'presetRow',
      id: 'preset-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'legacyPresetPatch',
            presetId: 'preset-a',
            collectionProjectionEpoch,
            fields: {
              name: {
                attempted: { present: true, value: 'Optimistic' },
                canonical: { present: true, value: 'Canonical' },
              },
            },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges a contiguous translator preset PATCH without collection/language reads or apply-epoch bumps', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          translatorPresets: [
            { id: 'translator-a', name: 'A', prompt: 'a prompt', maxResponse: 100 },
            { id: 'translator-b', name: 'B', prompt: 'attempted prompt', maxResponse: 200 },
          ] as never,
        },
      },
      'translatorPresets',
    )
    withTestDatabaseWrite(() => {
      getDatabase().translatorPresetId = 'translator-a'
      getDatabase().translatorPrompt = 'a prompt'
      getDatabase().translatorMaxResponse = 100
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('translatorPresets')
    const languageSettingsProjectionEpoch = captureSettingsGroupProjectionEpoch('language')
    withTestDatabaseWrite(() => {
      getDatabase().translatorPresets[1].prompt = 'newer local prompt'
    })
    const event = {
      type: 'translatorPreset.updated',
      revision: 6,
      resource: 'translatorPreset',
      id: 'translator-b',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'translatorPresetPatch',
            presetId: 'translator-b',
            collectionProjectionEpoch,
            languageSettingsProjectionEpoch,
            selectedPresetId: 'translator-a',
            attemptedPatch: { prompt: 'attempted prompt' },
            attemptedPreset: {
              id: 'translator-b',
              name: 'B',
              prompt: 'attempted prompt',
              maxResponse: 200,
            },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().translatorPresets[1].prompt).toBe('newer local prompt')
    expect(collectionsResourceState.revisions.translatorPresets).toBe(6)
    expect(settingsResourceState.groupRevisions.language).toBe(6)
    expect(hasCollectionProjectionEpochChanged('translatorPresets', collectionProjectionEpoch)).toBe(false)
    expect(hasSettingsGroupProjectionEpochChanged('language', languageSettingsProjectionEpoch)).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it.each([
    'collection epoch',
    'language epoch',
    'collection taint',
    'language taint',
    'global settings taint',
    'selection mismatch',
    'collection unready',
    'language unready',
  ])('%s forces a translator preset PATCH authoritative fallback', async (failure) => {
    await loadWebInitialDatabase()
    const presets = [
      { id: 'translator-a', name: 'A', prompt: 'a prompt', maxResponse: 100 },
      { id: 'translator-b', name: 'B', prompt: 'attempted prompt', maxResponse: 200 },
    ]
    applyCollectionsResource({ revision: 5, collections: { translatorPresets: presets as never } }, 'translatorPresets')
    withTestDatabaseWrite(() => {
      getDatabase().translatorPresetId = 'translator-a'
      getDatabase().translatorPrompt = 'a prompt'
      getDatabase().translatorMaxResponse = 100
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('translatorPresets')
    const languageSettingsProjectionEpoch = captureSettingsGroupProjectionEpoch('language')
    if (failure === 'collection epoch') {
      applyCollectionsResource(
        { revision: 5, collections: { translatorPresets: presets as never } },
        'translatorPresets',
      )
    } else if (failure === 'language epoch') {
      applySettingsGroupResource(
        {
          revision: 5,
          group: 'language',
          settings: {
            translatorPresetId: 'translator-a',
            translatorPrompt: 'a prompt',
            translatorMaxResponse: 100,
          },
        },
        ['translatorPresetId', 'translatorPrompt', 'translatorMaxResponse'],
      )
    } else if (failure === 'collection taint') {
      markCollectionAcknowledgementTainted('translatorPresets')
    } else if (failure === 'language taint') {
      markSettingsGroupAcknowledgementTainted('language')
    } else if (failure === 'global settings taint') {
      markSettingsAcknowledgementTainted()
    } else if (failure === 'selection mismatch') {
      withTestDatabaseWrite(() => {
        getDatabase().translatorPresetId = 'translator-b'
        getDatabase().translatorPrompt = 'attempted prompt'
        getDatabase().translatorMaxResponse = 200
      })
    } else if (failure === 'collection unready') {
      collectionsResourceState.statuses.translatorPresets = 'idle'
    } else {
      settingsResourceState.status = 'idle'
    }
    const event = {
      type: 'translatorPreset.updated',
      revision: 6,
      resource: 'translatorPreset',
      id: 'translator-b',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'translatorPresetPatch',
            presetId: 'translator-b',
            collectionProjectionEpoch,
            languageSettingsProjectionEpoch,
            selectedPresetId: 'translator-a',
            attemptedPatch: { prompt: 'attempted prompt' },
            attemptedPreset: presets[1],
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges metadata-only prompt preset PATCHes without owner hydration or settings reads', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      { revision: 5, collections: { promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }] as never } },
      'promptPresets',
    )
    withTestDatabaseWrite(() => {
      getDatabase().promptPresetsId = 0
      getDatabase().promptPresets[0].name = 'Prompt renamed'
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('promptPresets')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    const event = {
      type: 'promptPreset.updated',
      revision: 6,
      resource: 'promptPreset',
      id: 'prompt-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'splitPresetPatch',
            presetKind: 'prompt',
            presetId: 'prompt-a',
            attemptedPatch: { name: 'Prompt renamed' },
            preset: { name: 'Prompt renamed' },
            attemptedSettings: {},
            settings: {},
            selectedProjectionApplied: false,
            ownerProjectionApplied: false,
            collectionProjectionEpoch,
            settingsProjectionEpoch,
            selectedPresetId: 'prompt-a',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(promptTemplateApi.isHydrated).not.toHaveBeenCalled()
    expect(promptTemplateApi.markProjectionApplied).not.toHaveBeenCalled()
    expect(getDatabase().promptPresets[0].name).toBe('Prompt renamed')
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('canonicalizes the prompt owner without rewriting its compatibility projection', async () => {
    await loadWebInitialDatabase()
    const attemptedTemplate = [{ type: 'plain', text: 'Optimistic' }]
    const canonicalTemplate = [{ id: 'item-a', type: 'plain', text: 'Optimistic' }]
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          promptPresets: [{ id: 'prompt-a', name: 'Prompt A', promptTemplate: attemptedTemplate }] as never,
        },
      },
      'promptPresets',
    )
    applyCollectionsResource(
      { revision: 5, collections: { promptTemplate: attemptedTemplate as never } },
      'promptTemplate',
    )
    withTestDatabaseWrite(() => {
      getDatabase().promptPresetsId = 0
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('promptPresets')
    const event = {
      type: 'promptPreset.updated',
      revision: 6,
      resource: 'promptPreset',
      id: 'prompt-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'splitPresetPatch',
            presetKind: 'prompt',
            presetId: 'prompt-a',
            attemptedPatch: { promptTemplate: attemptedTemplate },
            preset: { promptTemplate: canonicalTemplate },
            attemptedSettings: {},
            settings: {},
            selectedProjectionApplied: false,
            ownerProjectionApplied: true,
            collectionProjectionEpoch,
            settingsProjectionEpoch: captureSettingsProjectionEpoch(),
            selectedPresetId: 'prompt-a',
            promptOwnerProjectionEpoch: 19,
            promptOwnerRevision: 5,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().promptPresets[0].promptTemplate).toEqual(canonicalTemplate)
    expect(getDatabase().promptTemplate).toEqual(attemptedTemplate)
    expect(promptTemplateApi.markProjectionApplied).toHaveBeenCalledWith('prompt-a', 6, {
      advanceProjectionEpoch: false,
    })
  })

  it('falls back when a split-preset PATCH collection proof is tainted', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      { revision: 5, collections: { modelPresets: [{ id: 'model-a', name: 'Model A' }] as never } },
      'modelPresets',
    )
    withTestDatabaseWrite(() => {
      getDatabase().modelPresetsId = 0
      getDatabase().modelPresets[0].name = 'Model renamed'
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('modelPresets')
    markCollectionAcknowledgementTainted('modelPresets')
    const event = {
      type: 'modelPreset.updated',
      revision: 6,
      resource: 'modelPreset',
      id: 'model-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'splitPresetPatch',
            presetKind: 'model',
            presetId: 'model-a',
            attemptedPatch: { name: 'Model renamed' },
            preset: { name: 'Model renamed' },
            attemptedSettings: {},
            settings: {},
            selectedProjectionApplied: false,
            ownerProjectionApplied: false,
            collectionProjectionEpoch,
            settingsProjectionEpoch: captureSettingsProjectionEpoch(),
            selectedPresetId: 'model-a',
            selectedPromptPresetId: null,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges a contiguous exact preset-owned prompt item without fetching its owner', async () => {
    await loadWebInitialDatabase()
    const ownerItems = [{ id: 'prompt-item-a', type: 'plain', text: 'optimistic' }]
    withTestDatabaseWrite(() => {
      getDatabase().promptPresets = [{ id: 'prompt-preset-a', name: 'A', promptTemplate: ownerItems }] as never
      getDatabase().promptTemplate = ownerItems as never
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('promptPresets')
    const event = {
      type: 'prompt.item.created',
      revision: 6,
      resource: 'promptItem',
      id: 'prompt-item-a',
      parentId: 'prompt-preset-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'promptItemMutation',
            operation: 'create',
            promptPresetId: 'prompt-preset-a',
            itemId: 'prompt-item-a',
            collectionProjectionEpoch,
            ownerProjectionEpoch: 19,
            ownerState: { enabled: true, items: ownerItems },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().promptPresets[0].promptTemplate).toEqual(ownerItems)
    expect(collectionsResourceState.revisions.promptPresets).toBe(6)
    expect(hasCollectionProjectionEpochChanged('promptPresets', collectionProjectionEpoch)).toBe(false)
    expect(promptTemplateApi.markProjectionApplied).toHaveBeenCalledWith('prompt-preset-a', 6, {
      advanceProjectionEpoch: false,
    })
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges overlapping accepted prompt updates against the final live row without fetching', async () => {
    await loadWebInitialDatabase()
    const firstOwnerItems = [{ id: 'prompt-item-a', type: 'plain', text: 'first accepted edit', role: 'system' }]
    const finalOwnerItems = [{ ...firstOwnerItems[0], role: 'user' }]
    withTestDatabaseWrite(() => {
      getDatabase().promptPresets = [{ id: 'prompt-preset-a', name: 'A', promptTemplate: finalOwnerItems }] as never
      getDatabase().promptTemplate = finalOwnerItems as never
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('promptPresets')
    const firstEvent = {
      type: 'prompt.item.updated',
      revision: 6,
      resource: 'promptItem',
      id: 'prompt-item-a',
      parentId: 'prompt-preset-a',
    }
    const secondEvent = { ...firstEvent, revision: 7 }

    await commandApi.reconciler?.(
      secondEvent,
      [firstEvent, secondEvent],
      new Map([
        [
          6,
          {
            kind: 'promptItemMutation',
            operation: 'update',
            promptPresetId: 'prompt-preset-a',
            itemId: 'prompt-item-a',
            collectionProjectionEpoch,
            ownerProjectionEpoch: 19,
            ownerState: { enabled: true, items: firstOwnerItems },
          },
        ],
        [
          7,
          {
            kind: 'promptItemMutation',
            operation: 'update',
            promptPresetId: 'prompt-preset-a',
            itemId: 'prompt-item-a',
            collectionProjectionEpoch,
            ownerProjectionEpoch: 19,
            ownerState: { enabled: true, items: finalOwnerItems },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().promptPresets[0].promptTemplate).toEqual(finalOwnerItems)
    expect(collectionsResourceState.revisions.promptPresets).toBe(7)
    expect(promptTemplateApi.markProjectionApplied).toHaveBeenNthCalledWith(1, 'prompt-preset-a', 6, {
      advanceProjectionEpoch: false,
    })
    expect(promptTemplateApi.markProjectionApplied).toHaveBeenNthCalledWith(2, 'prompt-preset-a', 7, {
      advanceProjectionEpoch: false,
    })
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it.each([
    'collection epoch',
    'owner epoch',
    'unhydrated owner',
    'tainted owner',
    'missing owner revision',
    'item mismatch',
    'foreign owner',
  ])('falls back for a prompt acknowledgement with an invalid %s', async (failure) => {
    await loadWebInitialDatabase()
    const ownerItems = [{ id: 'prompt-item-a', type: 'plain', text: 'optimistic' }]
    withTestDatabaseWrite(() => {
      getDatabase().promptPresets = [{ id: 'prompt-preset-a', name: 'A', promptTemplate: ownerItems }] as never
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('promptPresets')
    if (failure === 'collection epoch') {
      applyCollectionsResource(
        {
          revision: 5,
          collections: {
            promptPresets: [{ id: 'prompt-preset-a', name: 'A', promptTemplate: ownerItems }] as never,
          },
        },
        'promptPresets',
      )
    } else if (failure === 'owner epoch') {
      promptTemplateApi.hasOwnerEpochChanged.mockReturnValue(true)
    } else if (failure === 'unhydrated owner') {
      promptTemplateApi.isHydrated.mockReturnValue(false)
    } else if (failure === 'tainted owner') {
      promptTemplateApi.isTainted.mockReturnValue(true)
    } else if (failure === 'missing owner revision') {
      promptTemplateApi.peekOwnerRevision.mockReturnValue(null)
    }
    const event = {
      type: 'prompt.item.updated',
      revision: 6,
      resource: 'promptItem',
      id: failure === 'item mismatch' ? 'wrong-item' : 'prompt-item-a',
      parentId: failure === 'foreign owner' ? 'prompt-preset-b' : 'prompt-preset-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'promptItemMutation',
            operation: 'update',
            promptPresetId: 'prompt-preset-a',
            itemId: 'prompt-item-a',
            collectionProjectionEpoch,
            ownerProjectionEpoch: 19,
            ownerState: { enabled: true, items: ownerItems },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
    expect(promptTemplateApi.markProjectionApplied).not.toHaveBeenCalled()
  })

  it('keeps gapped and foreign prompt events on authoritative owner reconciliation', async () => {
    await loadWebInitialDatabase()
    const ownerItems = [{ id: 'prompt-item-a', type: 'plain', text: 'optimistic' }]
    withTestDatabaseWrite(() => {
      getDatabase().promptTemplate = ownerItems as never
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('promptTemplate')
    const gappedEvent = {
      type: 'prompt.item.updated',
      revision: 7,
      resource: 'promptItem',
      id: 'prompt-item-a',
    }

    await commandApi.reconciler?.(
      gappedEvent,
      [gappedEvent],
      new Map([
        [
          7,
          {
            kind: 'promptItemMutation',
            operation: 'update',
            promptPresetId: null,
            itemId: 'prompt-item-a',
            collectionProjectionEpoch,
            ownerProjectionEpoch: 3,
            ownerState: { enabled: true, items: ownerItems },
          },
        ],
      ]),
    )
    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([gappedEvent], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })

    const foreignEvent = { ...gappedEvent, revision: 8 }
    eventApi.subscriptions[0].onCommandEvent(foreignEvent)
    await vi.waitFor(() => expect(resourceApi.refreshInvalidated).toHaveBeenCalledTimes(2))
    expect(resourceApi.refreshInvalidated).toHaveBeenLastCalledWith([foreignEvent], {
      appliedRevision: 7,
      hooks: resourceApi.hooks,
    })
  })
})
