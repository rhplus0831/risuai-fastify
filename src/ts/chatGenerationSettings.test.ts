import { describe, expect, it } from 'vitest'
import {
  CHAT_GENERATION_SETTINGS_INCOMPLETE_ERROR,
  CHAT_GENERATION_SETTINGS_INCOMPLETE_MESSAGE,
  CHAT_GENERATION_SETTINGS_INCOMPLETE_STATUS,
  applySparseChatGenerationSettingsUpdate,
  createChatGenerationSettingsIncompleteError,
  diffChatGenerationSettings,
  projectSidebarTogglesToGlobalChatVariables,
  resolveChatGenerationControlRequirements,
  resolveDisplayedSidebarToggles,
  resolveChatGenerationSettingsReadiness,
  resolveRequiredSidebarToggles,
  serializeChatGenerationSettingsDigestInput,
  type ChatGenerationPromptPresetReference,
  type ResolveChatGenerationSettingsReadinessInput,
} from './chatGenerationSettings'

const personas = [{ id: 'persona-a' }]
const modelPresets = [{ id: 'model-a' }]

function readinessInput(
  overrides: Partial<ResolveChatGenerationSettingsReadinessInput>,
): ResolveChatGenerationSettingsReadinessInput {
  return {
    personas,
    modelPresets,
    promptPresets: [],
    ...overrides,
  }
}

describe('chat generation settings contract', () => {
  it('projects chat sidebar toggles over legacy global CBS variables without mutating either source', () => {
    const globals = { toggle_title: '0', ordinary: 'global', malformed: 1 }
    const sidebarToggles = { title: '1', note: '', malformed: false }

    expect(projectSidebarTogglesToGlobalChatVariables(globals, sidebarToggles)).toEqual({
      toggle_title: '1',
      toggle_note: '',
      ordinary: 'global',
    })
    expect(globals).toEqual({ toggle_title: '0', ordinary: 'global', malformed: 1 })
    expect(sidebarToggles).toEqual({ title: '1', note: '', malformed: false })
  })

  it('diffs and reapplies scalar, optional, and nested toggle changes', () => {
    const previous = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      agentPresetId: 'agent-a',
      jailbreakToggle: false,
      sidebarToggles: {
        mode: 'warm',
        notes: 'old',
        removed: '1',
      },
    }
    const attempted = {
      ...previous,
      promptPresetId: 'prompt-b',
      jailbreakToggle: true,
      sidebarToggles: {
        mode: 'cold',
        notes: 'old',
        added: '',
      },
    }
    delete (attempted as Partial<typeof attempted>).agentPresetId

    const update = diffChatGenerationSettings(previous, attempted)

    expect(update).toEqual({
      patch: {
        promptPresetId: 'prompt-b',
        jailbreakToggle: true,
        sidebarToggles: {
          mode: 'cold',
          added: '',
        },
      },
      deleteKeys: ['agentPresetId'],
      sidebarToggleDeleteKeys: ['removed'],
    })
    expect(applySparseChatGenerationSettingsUpdate(previous, update!)).toEqual(attempted)
  })

  it('represents whole toggle-map deletion without sending its previous values', () => {
    const previous = {
      jailbreakToggle: false,
      sidebarToggles: { mode: 'warm', notes: 'large text' },
    }
    const attempted = { jailbreakToggle: false }

    expect(diffChatGenerationSettings(previous, attempted)).toEqual({
      patch: {},
      deleteKeys: ['sidebarToggles'],
    })
  })

  it('sends the complete value only when no prior settings exist', () => {
    const attempted = {
      configured: true,
      personaId: 'persona-a',
      jailbreakToggle: false,
      sidebarToggles: {},
    }

    expect(diffChatGenerationSettings(undefined, attempted)).toEqual({ patch: attempted })
    expect(diffChatGenerationSettings(attempted, attempted)).toBeNull()
  })

  it('serializes digest inputs independently of object and toggle insertion order', () => {
    expect(
      serializeChatGenerationSettingsDigestInput({
        sidebarToggles: { z: 'last', a: 'first' },
        jailbreakToggle: false,
        configured: true,
      }),
    ).toBe(
      serializeChatGenerationSettingsDigestInput({
        configured: true,
        jailbreakToggle: false,
        sidebarToggles: { a: 'first', z: 'last' },
      }),
    )
    expect(serializeChatGenerationSettingsDigestInput(null)).not.toBe(serializeChatGenerationSettingsDigestInput({}))
  })

  it('resolves displayed preset toggles from the selected promptPresetId', () => {
    const promptPresets: ChatGenerationPromptPresetReference[] = [
      {
        id: 'preset-a',
        customPromptTemplateToggle: 'tone=Tone=select=warm,formal\ncot=Chain of thought',
      },
      {
        id: 'preset-b',
        customPromptTemplateToggle: 'mood=Mood=text',
      },
    ]

    const toggles = resolveRequiredSidebarToggles({
      modelPresetId: 'model-a',
      promptPresetId: 'preset-b',
      modelPresets,
      promptPresets,
    })

    expect(toggles).toEqual([
      {
        key: 'mood',
        label: 'Mood',
        kind: 'text',
        options: [],
        source: 'preset',
        presetId: 'preset-b',
      },
    ])
  })

  it('resolves active module toggles from global, chat, character, Persona, and namespace links', () => {
    const toggles = resolveRequiredSidebarToggles({
      modelPresetId: 'model-a',
      promptPresetId: 'preset-empty',
      modelPresets,
      promptPresets: [{ id: 'preset-empty', customPromptTemplateToggle: '' }],
      modules: [
        { id: 'enabled-module', customModuleToggle: 'enabled=Enabled module' },
        { id: 'chat-module', customModuleToggle: 'chat=Chat module=select=a,b' },
        { id: 'character-module', customModuleToggle: 'character=Character module=text' },
        { id: 'persona-module', customModuleToggle: 'persona=Persona module' },
        {
          id: 'integrated-module',
          namespace: 'shared-space',
          customModuleToggle: 'integrated=Integrated module=textarea',
        },
        { id: 'inactive-module', customModuleToggle: 'inactive=Inactive module' },
      ],
      enabledModuleIds: ['enabled-module'],
      chatModuleIds: ['chat-module'],
      characterModuleIds: ['character-module'],
      personaModuleIds: ['persona-module'],
      moduleIntegration: ' shared-space ',
    })

    expect(toggles.map((toggle) => [toggle.key, toggle.kind, toggle.source, toggle.moduleId])).toEqual([
      ['enabled', 'boolean', 'module', 'enabled-module'],
      ['chat', 'select', 'module', 'chat-module'],
      ['character', 'text', 'module', 'character-module'],
      ['persona', 'boolean', 'module', 'persona-module'],
      ['integrated', 'textarea', 'module', 'integrated-module'],
    ])
  })

  it('derives required module toggles from the selected Persona links', () => {
    const readiness = resolveChatGenerationSettingsReadiness(
      readinessInput({
        personas: [{ id: 'persona-a', modules: ['persona-module'] }],
        modules: [{ id: 'persona-module', customModuleToggle: 'persona=Persona module' }],
        promptPresets: [{ id: 'prompt-a' }],
        settings: {
          configured: true,
          personaId: 'persona-a',
          modelPresetId: 'model-a',
          promptPresetId: 'prompt-a',
          jailbreakToggle: false,
          sidebarToggles: {},
        },
      }),
    )

    expect(readiness.requirements.sidebarToggles).toEqual([
      expect.objectContaining({ key: 'persona', moduleId: 'persona-module' }),
    ])
    expect(readiness.missing).toContainEqual(
      expect.objectContaining({ code: 'sidebar_toggle_missing', toggleKey: 'persona' }),
    )
  })

  it('adds modules associated with the effective Agent Preset to Prompt module integration', () => {
    const toggles = resolveRequiredSidebarToggles({
      modelPresets,
      promptPresets: [],
      agentPresetId: 'agent-preset-a',
      agentPresets: [
        {
          id: 'agent-preset-a',
          enabled: true,
          moduleIntergration: ' agent-space, exact-agent-module ',
        },
      ],
      modules: [
        {
          id: 'prompt-module',
          namespace: 'prompt-space',
          customModuleToggle: 'prompt=Prompt module',
        },
        {
          id: 'agent-module',
          namespace: 'agent-space',
          customModuleToggle: 'agentModule=Agent module',
        },
        {
          id: 'exact-agent-module',
          customModuleToggle: 'exact=Exact Agent module',
        },
      ],
      moduleIntegration: 'prompt-space',
    })

    expect(toggles.map((toggle) => toggle.key)).toEqual(['prompt', 'agentModule', 'exact'])
  })

  it('does not activate modules associated with a disabled Agent Preset', () => {
    const toggles = resolveRequiredSidebarToggles({
      modelPresets,
      promptPresets: [],
      agentPresetId: 'agent-preset-disabled',
      agentPresets: [
        {
          id: 'agent-preset-disabled',
          enabled: false,
          moduleIntergration: 'agent-space',
        },
      ],
      modules: [
        {
          id: 'agent-module',
          namespace: 'agent-space',
          customModuleToggle: 'agentModule=Agent module',
        },
      ],
    })

    expect(toggles).toEqual([])
  })

  it('namespaces active Agent toggles by stable Agent id and deduplicates repeated uses', () => {
    const toggles = resolveRequiredSidebarToggles({
      modelPresets,
      promptPresets: [],
      agentPresetId: 'agent-preset-a',
      agentPresets: [
        {
          id: 'agent-preset-a',
          enabled: true,
          agentUses: [
            { agentId: 'agent-a', enabled: true },
            { agentId: 'agent-a', enabled: true },
            { agentId: 'agent-b', enabled: true },
          ],
        },
      ],
      agents: [
        {
          id: 'agent-a',
          name: 'Researcher',
          toggles: [{ key: 'tone', label: 'Tone', kind: 'select', options: ['Warm', 'Formal'] }],
        },
        {
          id: 'agent-b',
          name: 'Reviewer',
          toggles: [{ key: 'tone', label: 'Tone', kind: 'boolean', options: [] }],
        },
      ],
    })

    expect(toggles).toEqual([
      {
        key: 'agent:agent-a:tone',
        label: 'Tone',
        kind: 'select',
        options: ['Warm', 'Formal'],
        source: 'agent',
        agentId: 'agent-a',
        agentName: 'Researcher',
        localKey: 'tone',
      },
      {
        key: 'agent:agent-b:tone',
        label: 'Tone',
        kind: 'boolean',
        options: [],
        source: 'agent',
        agentId: 'agent-b',
        agentName: 'Reviewer',
        localKey: 'tone',
      },
    ])
  })

  it('reserves active Agent namespace keys from prompt toggle collisions', () => {
    const toggles = resolveRequiredSidebarToggles({
      modelPresets,
      promptPresetId: 'prompt-a',
      promptPresets: [
        {
          id: 'prompt-a',
          customPromptTemplateToggle: 'agent:agent-a:tone=Prompt collision=text',
        },
      ],
      agentPresetId: 'agent-preset-a',
      agentPresets: [{ id: 'agent-preset-a', agentUses: [{ agentId: 'agent-a', enabled: true }] }],
      agents: [
        {
          id: 'agent-a',
          name: 'Researcher',
          toggles: [{ key: 'tone', label: 'Agent tone', kind: 'boolean', options: [] }],
        },
      ],
    })

    expect(toggles).toEqual([
      expect.objectContaining({
        key: 'agent:agent-a:tone',
        label: 'Agent tone',
        kind: 'boolean',
        source: 'agent',
      }),
    ])
  })

  it('requires toggle values from an effective default Agent Preset', () => {
    const readiness = resolveChatGenerationSettingsReadiness(
      readinessInput({
        effectiveAgentPresetId: 'agent-preset-default',
        agentPresets: [
          {
            id: 'agent-preset-default',
            agentUses: [{ agentId: 'agent-a', enabled: true }],
          },
        ],
        agents: [
          {
            id: 'agent-a',
            toggles: [{ key: 'tone', label: 'Tone', kind: 'boolean', options: [] }],
          },
        ],
        promptPresets: [{ id: 'prompt-a' }],
        settings: {
          configured: true,
          personaId: 'persona-a',
          modelPresetId: 'model-a',
          promptPresetId: 'prompt-a',
          jailbreakToggle: false,
          sidebarToggles: {},
        },
      }),
    )

    expect(readiness.ready).toBe(false)
    expect(readiness.missing).toContainEqual({
      code: 'sidebar_toggle_missing',
      field: 'generationSettings.sidebarToggles.agent:agent-a:tone',
      toggleKey: 'agent:agent-a:tone',
    })
  })

  it('preserves layout-only rows for display without making them required', () => {
    const promptPresets: ChatGenerationPromptPresetReference[] = [
      {
        id: 'preset-a',
        customPromptTemplateToggle:
          '=Preset Group=group\nmode=Mode\n=Group note=caption\n==groupend\n=Outside=divider\noutside=Outside',
      },
    ]

    const input = {
      modelPresetId: 'model-a',
      promptPresetId: 'preset-a',
      modelPresets,
      promptPresets,
    }

    expect(resolveRequiredSidebarToggles(input).map((toggle) => toggle.key)).toEqual(['mode', 'outside'])
    expect(resolveDisplayedSidebarToggles(input).map((toggle) => [toggle.kind, toggle.label])).toEqual([
      ['group', 'Preset Group'],
      ['boolean', 'Mode'],
      ['caption', 'Group note'],
      ['groupEnd', ''],
      ['divider', 'Outside'],
      ['boolean', 'Outside'],
    ])
  })

  it('keeps jailbreak as a required chat-owned control and reports whether it is displayed', () => {
    const withJailbreakTemplate = resolveChatGenerationControlRequirements({
      modelPresetId: 'model-a',
      promptPresetId: 'preset-jailbreak',
      modelPresets,
      promptPresets: [
        {
          id: 'preset-jailbreak',
          promptTemplate: [{ type: 'plain', text: 'Use {{jbtoggled}} here.' }],
        },
      ],
    })
    const withoutJailbreakTemplate = resolveChatGenerationControlRequirements({
      modelPresetId: 'model-a',
      promptPresetId: 'preset-plain',
      modelPresets,
      promptPresets: [{ id: 'preset-plain', jailbreak: '' }],
    })

    expect(withJailbreakTemplate.jailbreakToggle).toEqual({
      field: 'jailbreakToggle',
      required: true,
      displayed: true,
    })
    expect(withoutJailbreakTemplate.jailbreakToggle).toEqual({
      field: 'jailbreakToggle',
      required: true,
      displayed: false,
    })
  })

  it('treats explicit off and empty raw values as configured when keys are present', () => {
    const readiness = resolveChatGenerationSettingsReadiness(
      readinessInput({
        agentPresets: [{ id: 'agent-preset-a' }],
        promptPresets: [
          {
            id: 'preset-a',
            customPromptTemplateToggle: 'mode=Mode\nnotes=Notes=text',
            jailbreak: 'Jailbreak text',
          },
        ],
        settings: {
          configured: true,
          personaId: 'persona-a',
          modelPresetId: 'model-a',
          promptPresetId: 'preset-a',
          agentPresetId: '',
          jailbreakToggle: false,
          sidebarToggles: {
            mode: '0',
            notes: '',
          },
        },
      }),
    )

    expect(readiness.ready).toBe(true)
    expect(readiness.missing).toEqual([])
  })

  it('keeps absent Agent Preset selection ready and reports non-empty stale references', () => {
    const ready = resolveChatGenerationSettingsReadiness(
      readinessInput({
        agentPresets: [],
        promptPresets: [{ id: 'preset-a' }],
        settings: {
          configured: true,
          personaId: 'persona-a',
          modelPresetId: 'model-a',
          promptPresetId: 'preset-a',
          jailbreakToggle: false,
          sidebarToggles: {},
        },
      }),
    )
    const stale = resolveChatGenerationSettingsReadiness(
      readinessInput({
        agentPresets: [{ id: 'agent-preset-a' }],
        promptPresets: [{ id: 'preset-a' }],
        settings: {
          configured: true,
          personaId: 'persona-a',
          modelPresetId: 'model-a',
          promptPresetId: 'preset-a',
          agentPresetId: 'deleted-agent-preset',
          jailbreakToggle: false,
          sidebarToggles: {},
        },
      }),
    )

    expect(ready.ready).toBe(true)
    expect(ready.missing).toEqual([])
    expect(stale.ready).toBe(false)
    expect(stale.missing).toEqual([
      {
        code: 'agent_preset_missing',
        field: 'generationSettings.agentPresetId',
        agentPresetId: 'deleted-agent-preset',
      },
    ])
  })

  it('returns missing reason codes for absent required values', () => {
    const readiness = resolveChatGenerationSettingsReadiness(
      readinessInput({
        promptPresets: [{ id: 'preset-a', customPromptTemplateToggle: 'mode=Mode\nmood=Mood' }],
        settings: {
          configured: true,
          personaId: 'persona-a',
          modelPresetId: 'model-a',
          promptPresetId: 'preset-a',
          sidebarToggles: {
            mode: '1',
          },
        },
      }),
    )

    expect(readiness.ready).toBe(false)
    expect(readiness.missing.map((reason) => reason.code)).toEqual([
      'jailbreak_toggle_missing',
      'sidebar_toggle_missing',
    ])
    expect(readiness.missing[1]).toMatchObject({
      field: 'generationSettings.sidebarToggles.mood',
      toggleKey: 'mood',
    })
  })

  it('reports deleted preset and persona references without retargeting to available rows', () => {
    const settings = {
      configured: true,
      personaId: 'deleted-persona',
      modelPresetId: 'deleted-model',
      promptPresetId: 'deleted-preset',
      jailbreakToggle: false,
      sidebarToggles: {},
    }

    const readiness = resolveChatGenerationSettingsReadiness(
      readinessInput({
        personas: [{ id: 'persona-a' }],
        modelPresets,
        promptPresets: [{ id: 'preset-a', customPromptTemplateToggle: 'mode=Mode' }],
        settings,
      }),
    )

    expect(readiness.ready).toBe(false)
    expect(readiness.requirements.promptPreset).toBeUndefined()
    expect(readiness.requirements.promptPresetFound).toBe(false)
    expect(readiness.requirements.sidebarToggles).toEqual([])
    expect(readiness.missing).toEqual([
      {
        code: 'persona_missing',
        field: 'generationSettings.personaId',
        personaId: 'deleted-persona',
      },
      {
        code: 'model_preset_missing',
        field: 'generationSettings.modelPresetId',
        modelPresetId: 'deleted-model',
      },
      {
        code: 'prompt_preset_missing',
        field: 'generationSettings.promptPresetId',
        promptPresetId: 'deleted-preset',
      },
    ])
    expect(settings).toMatchObject({
      personaId: 'deleted-persona',
      modelPresetId: 'deleted-model',
      promptPresetId: 'deleted-preset',
    })
  })

  it('ignores stale sidebar toggle keys for readiness and reports them for pruning', () => {
    const readiness = resolveChatGenerationSettingsReadiness(
      readinessInput({
        promptPresets: [{ id: 'preset-a', customPromptTemplateToggle: 'mode=Mode' }],
        settings: {
          configured: true,
          personaId: 'persona-a',
          modelPresetId: 'model-a',
          promptPresetId: 'preset-a',
          jailbreakToggle: true,
          sidebarToggles: {
            mode: '1',
            deleted: '1',
          },
        },
      }),
    )

    expect(readiness.ready).toBe(true)
    expect(readiness.staleSidebarToggleKeys).toEqual(['deleted'])
  })

  it('uses a stable incomplete-chat error body', () => {
    const readiness = resolveChatGenerationSettingsReadiness(
      readinessInput({
        settings: {
          configured: true,
          personaId: 'missing-persona',
          modelPresetId: 'missing-model',
          promptPresetId: 'missing-preset',
          jailbreakToggle: false,
          sidebarToggles: {},
        },
        promptPresets: [],
      }),
    )

    expect(createChatGenerationSettingsIncompleteError(readiness, 'chat-a')).toEqual({
      statusCode: CHAT_GENERATION_SETTINGS_INCOMPLETE_STATUS,
      error: CHAT_GENERATION_SETTINGS_INCOMPLETE_ERROR,
      message: CHAT_GENERATION_SETTINGS_INCOMPLETE_MESSAGE,
      chatId: 'chat-a',
      missing: [
        {
          code: 'persona_missing',
          field: 'generationSettings.personaId',
          personaId: 'missing-persona',
        },
        {
          code: 'model_preset_missing',
          field: 'generationSettings.modelPresetId',
          modelPresetId: 'missing-model',
        },
        {
          code: 'prompt_preset_missing',
          field: 'generationSettings.promptPresetId',
          promptPresetId: 'missing-preset',
        },
      ],
      staleSidebarToggleKeys: [],
    })
  })
})
