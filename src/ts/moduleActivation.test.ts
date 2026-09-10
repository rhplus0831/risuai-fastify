import { describe, expect, it } from 'vitest'
import type { Chat, Database, character } from './storage/database.svelte'
import { resolveActiveModuleStates } from './moduleActivation'

function database(overrides: Partial<Database> = {}): Database {
  return {
    modules: [],
    enabledModules: [],
    moduleIntergration: '',
    promptPresets: [],
    agentPresets: [],
    personas: [],
    selectedPersona: -1,
    ...overrides,
  } as unknown as Database
}

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    message: [],
    note: '',
    name: 'Chat',
    localLore: [],
    ...overrides,
  } as Chat
}

describe('resolveActiveModuleStates', () => {
  it('activates the Codex namespace from the current chat GPT Prompt Preset', () => {
    const codexModule = { id: 'codex-module', name: 'Codex Module', description: '', namespace: 'Codex' }
    const db = database({
      modules: [codexModule],
      promptPresets: [{ id: 'gpt-preset', name: 'GPT', moduleIntergration: 'Codex' }],
      moduleIntergration: 'stale-global-space',
    })
    const currentChat = chat({ generationSettings: { promptPresetId: 'gpt-preset' } })

    expect(resolveActiveModuleStates(db, undefined, currentChat)).toEqual([
      { module: codexModule, sources: ['promptPresetIntegration'] },
    ])
  })

  it('combines direct, Persona, Prompt Preset, and effective Agent Preset sources', () => {
    const sharedModule = { id: 'shared-module', name: 'Shared', description: '', namespace: 'shared-space' }
    const db = database({
      modules: [sharedModule],
      enabledModules: ['shared-module'],
      personas: [{ id: 'persona-a', name: 'Persona', icon: '', personaPrompt: '', modules: ['shared-module'] }],
      promptPresets: [{ id: 'prompt-a', name: 'Prompt', moduleIntergration: 'shared-space' }],
      agentPresetDefaultId: 'agent-a',
      agentPresets: [
        {
          id: 'agent-a',
          name: 'Agent',
          enabled: true,
          version: 1,
          moduleIntergration: 'shared-space',
          steps: [],
        },
      ],
    })
    const currentCharacter = { modules: ['shared-module'] } as character
    const currentChat = chat({
      modules: ['shared-module'],
      generationSettings: { personaId: 'persona-a', promptPresetId: 'prompt-a' },
    })

    expect(resolveActiveModuleStates(db, currentCharacter, currentChat)).toEqual([
      {
        module: sharedModule,
        sources: ['global', 'chat', 'character', 'persona', 'promptPresetIntegration', 'agentPresetIntegration'],
      },
    ])
  })

  it('uses legacy integration only when the chat has no selected Prompt Preset', () => {
    const legacyModule = { id: 'legacy-module', name: 'Legacy', description: '', namespace: 'legacy-space' }
    const db = database({
      modules: [legacyModule],
      moduleIntergration: 'legacy-space',
      promptPresets: [{ id: 'plain-preset', name: 'Plain' }],
    })

    expect(resolveActiveModuleStates(db, undefined, chat())).toEqual([
      { module: legacyModule, sources: ['legacyIntegration'] },
    ])
    expect(
      resolveActiveModuleStates(db, undefined, chat({ generationSettings: { promptPresetId: 'plain-preset' } })),
    ).toEqual([])
  })

  it.each(['missing', 'duplicate'])('fails closed for a %s selected Prompt Preset owner', (kind) => {
    const linkedModule = { id: 'linked-module', namespace: 'prompt-space' } as never
    const promptPresets =
      kind === 'missing'
        ? [{ id: 'other', moduleIntergration: 'prompt-space' }]
        : [
            { id: 'prompt-a', moduleIntergration: 'prompt-space' },
            { id: 'prompt-a', moduleIntergration: 'prompt-space' },
          ]
    const db = database({ modules: [linkedModule], promptPresets })

    expect(
      resolveActiveModuleStates(db, undefined, chat({ generationSettings: { promptPresetId: 'prompt-a' } })),
    ).toEqual([])
  })
})
