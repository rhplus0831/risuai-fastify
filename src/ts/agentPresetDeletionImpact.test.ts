import { describe, expect, it } from 'vitest'
import { projectAgentPresetDeleteImpact } from './agentPresetDeletionImpact'

describe('Agent Preset deletion impact projection', () => {
  it('separates owners and predicts chat fallback to another global default', () => {
    expect(
      projectAgentPresetDeleteImpact({
        presetId: 'target',
        presets: [
          { id: 'target', name: 'Research' },
          { id: 'fallback', name: 'Everyday' },
        ],
        defaultPresetId: 'fallback',
        characters: [
          {
            chaId: 'character-a',
            name: 'Aster',
            chats: [
              {
                id: 'chat-a',
                name: 'Planning',
                generationSettings: { agentPresetId: 'target' },
                message: [{ role: 'user', data: 'must not be inspected' }],
              },
              { id: 'chat-b', name: 'Other', generationSettings: { agentPresetId: 'fallback' } },
            ],
          },
        ],
        loadouts: [{ id: 'loadout-a', name: 'Research setup', agentPresetId: 'target' }],
      }),
    ).toEqual({
      status: 'ready',
      presetId: 'target',
      presetName: 'Research',
      globalDefault: {
        affected: false,
        beforePresetId: 'fallback',
        beforePresetName: 'Everyday',
        postDeleteSelection: { source: 'globalDefault', presetId: 'fallback', presetName: 'Everyday' },
      },
      chats: [
        {
          characterId: 'character-a',
          characterName: 'Aster',
          chatId: 'chat-a',
          chatName: 'Planning',
          postDeleteSelection: { source: 'globalDefault', presetId: 'fallback', presetName: 'Everyday' },
        },
      ],
      loadouts: [
        {
          loadoutId: 'loadout-a',
          loadoutName: 'Research setup',
          postDeleteSelection: { source: 'none' },
        },
      ],
    })
  })

  it('clears the selected global default and predicts no fallback', () => {
    const result = projectAgentPresetDeleteImpact({
      presetId: 'target',
      presets: [{ id: 'target', name: 'Research' }],
      defaultPresetId: 'target',
      characters: [{ chaId: 'character-a', chats: [] }],
      loadouts: [],
    })
    expect(result).toMatchObject({
      status: 'ready',
      globalDefault: { affected: true, postDeleteSelection: { source: 'none' } },
    })
  })

  it.each([
    {
      name: 'unknown default',
      expectedOwner: 'settings',
      input: { defaultPresetId: 'missing' },
    },
    {
      name: 'duplicate chats',
      expectedOwner: 'characters',
      input: {
        characters: [
          {
            chaId: 'character-a',
            chats: [
              { id: 'chat-a', generationSettings: { agentPresetId: 'target' } },
              { id: 'chat-a', generationSettings: {} },
            ],
          },
        ],
      },
    },
    {
      name: 'duplicate loadouts',
      expectedOwner: 'loadouts',
      input: {
        loadouts: [
          { id: 'loadout-a', agentPresetId: 'target' },
          { id: 'loadout-a', agentPresetId: 'target' },
        ],
      },
    },
  ])('fails closed for $name', ({ expectedOwner, input }) => {
    expect(
      projectAgentPresetDeleteImpact({
        presetId: 'target',
        presets: [{ id: 'target', name: 'Research' }],
        characters: [{ chaId: 'character-a', chats: [] }],
        loadouts: [],
        ...input,
      }),
    ).toEqual({ status: 'unavailable', owner: expectedOwner, reason: 'invalid' })
  })
})
