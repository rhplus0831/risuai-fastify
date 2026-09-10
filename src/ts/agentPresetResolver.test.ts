import { describe, expect, it } from 'vitest'
import {
  normalizeAgentConfiguration,
  type AgentPresetRecord,
  type AgentPresetStepRecord,
  type ReadonlyAgentRecord,
  type ReadonlyAgentPresetRecord,
} from './agentPresetRecords'
import { diagnoseAgentPresetOutputReferences, planAgentPreset, resolveAgentPresetForChat } from './agentPresetResolver'
import { resolveModelProfile } from './model/modelProfileResolver'
import type { Database } from './storage/database.svelte'

function db(overrides: Partial<Database> = {}): Database {
  return {
    aiModel: 'debug-echo',
    subModel: 'debug-echo',
    modelRoles: {},
    modelProfiles: [],
    modelRoleProfiles: {},
    modelRuntimeDefaults: {},
    agentPresets: [],
    customModels: [],
    modelTools: [],
    temperature: 50,
    frequencyPenalty: -1000,
    PresensePenalty: -1000,
    maxContext: 8192,
    maxResponse: 512,
    useStreaming: true,
    genTime: 1,
    extractJson: '',
    OaiCompAPIKeys: {},
    openrouterProvider: { order: [], only: [], ignore: [] },
    ...overrides,
  } as unknown as Database
}

function step(patch: Partial<AgentPresetStepRecord> = {}): AgentPresetStepRecord {
  return {
    id: 'aps_context',
    name: 'Context',
    enabled: true,
    phase: 'beforeMain',
    dependencies: [],
    instruction: 'Collect context.',
    model: { mode: 'inheritMain' },
    runtime: {
      temperature: 50,
      maxInputChars: 20_000,
      maxOutputChars: 1_200,
      timeoutMs: 30_000,
    },
    inputScopes: ['currentUserMessage', 'recentChatTail'],
    outputKey: 'context',
    outputFormat: 'text',
    destination: 'promptOutput',
    failurePolicy: { mode: 'required' },
    ...patch,
  }
}

function preset(patch: Partial<AgentPresetRecord> = {}): AgentPresetRecord {
  return {
    id: 'ap_default',
    name: 'Default Agent Preset',
    enabled: true,
    version: 1,
    maxConcurrency: 2,
    steps: [step()],
    ...patch,
  }
}

function deepFreezeInput<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreezeInput)
    Object.freeze(value)
  }
  return value
}

describe('agent preset resolver', () => {
  it('plans frozen modular defaults in dependency order and preserves borrowed preset selection identity', () => {
    const configuration = normalizeAgentConfiguration(undefined, [
      preset({
        steps: [
          step({ id: 'first', outputKey: 'first' }),
          step({ id: 'parallel', outputKey: 'parallel' }),
          step({
            id: 'dependent',
            outputKey: 'dependent',
            dependencies: ['first', 'parallel'],
            instruction: '{{agent::first}}',
          }),
          step({
            id: 'after',
            outputKey: 'after',
            phase: 'afterMain',
            inputScopes: ['mainDraft', 'previousAgentOutputs'],
          }),
        ],
      }),
    ])
    const agentPresets: readonly ReadonlyAgentPresetRecord[] = deepFreezeInput(configuration.agentPresets)
    const agents: readonly ReadonlyAgentRecord[] = deepFreezeInput(configuration.agents)
    const database = Object.freeze({
      agentPresets,
      agents,
      modelProfiles: Object.freeze([]),
      agentPresetDefaultId: 'ap_default',
    })
    const before = JSON.stringify(database)
    const result = resolveAgentPresetForChat({ database, generationSettings: Object.freeze({}) })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('expected frozen inputs to be ready')
    expect(result.preset).toBe(agentPresets[0])
    expect(result.plan.beforeMain.dependencyLevels).toEqual([
      { level: 0, stepIds: ['first', 'parallel'] },
      { level: 1, stepIds: ['dependent'] },
    ])
    expect(result.plan.stableSteps.map(({ step }) => step.id)).toEqual(['first', 'parallel', 'dependent', 'after'])
    expect(result.plan.namedOutputRegistry.map(({ key }) => key)).toEqual(['first', 'parallel', 'dependent', 'after'])
    expect(result.plan.afterMain.steps[0].preparedInputs.map(({ scope }) => scope)).toEqual([
      'previousAgentOutputs',
      'mainDraft',
    ])
    expect(result.summary).toMatchObject({
      beforeMainStepCount: 3,
      afterMainStepCount: 1,
      estimatedMaxCallsPerGeneration: 4,
    })
    result.plan.stableSteps[0].step.inputScopes.push('memoryContext')
    result.plan.stableSteps[2].step.dependencies.push('other')
    expect(JSON.stringify(database)).toBe(before)
    expect(
      resolveAgentPresetForChat({ database, generationSettings: Object.freeze({ agentPresetId: '' }) }),
    ).toMatchObject({ status: 'none' })
    expect(
      resolveAgentPresetForChat({
        database,
        currentChat: Object.freeze({ generationSettings: Object.freeze({ agentPresetId: 'missing' }) }),
      }),
    ).toMatchObject({ status: 'missing', selectedPresetId: 'missing' })
  })

  it('resolves absent, missing, and disabled selections without executing steps', () => {
    expect(resolveAgentPresetForChat({ database: db(), generationSettings: {} })).toMatchObject({
      status: 'none',
      ready: true,
      summary: { estimatedMaxCallsPerGeneration: 0 },
    })

    expect(
      resolveAgentPresetForChat({
        database: db(),
        generationSettings: { agentPresetId: 'missing-agent' },
      }),
    ).toMatchObject({
      status: 'missing',
      ready: false,
      selectedPresetId: 'missing-agent',
    })

    expect(
      resolveAgentPresetForChat({
        database: db({ agentPresets: [preset({ enabled: false })] }),
        generationSettings: { agentPresetId: 'ap_default' },
      }),
    ).toMatchObject({
      status: 'disabled',
      ready: true,
      summary: {
        enabled: false,
        beforeMainStepCount: 0,
        estimatedMaxCallsPerGeneration: 0,
      },
    })
  })

  it('falls back to the global default unless the chat explicitly opts out', () => {
    const database = db({
      agentPresetDefaultId: 'ap_default',
      agentPresets: [preset()],
    })

    expect(resolveAgentPresetForChat({ database, generationSettings: {} })).toMatchObject({
      status: 'ready',
      ready: true,
      selectedPresetId: 'ap_default',
    })
    expect(resolveAgentPresetForChat({ database, generationSettings: { agentPresetId: '' } })).toMatchObject({
      status: 'none',
      ready: true,
    })
  })

  it('builds stable dependency levels and named output registry for parallel phase execution', () => {
    const result = resolveAgentPresetForChat({
      database: db({
        agentPresets: [
          preset({
            maxConcurrency: 3,
            steps: [
              step({ id: 'aps_a', name: 'A', outputKey: 'a' }),
              step({ id: 'aps_b', name: 'B', outputKey: 'b' }),
              step({ id: 'aps_c', name: 'C', outputKey: 'c', dependencies: ['aps_a', 'aps_b'] }),
              step({ id: 'aps_after', name: 'After', phase: 'afterMain', outputKey: 'after' }),
            ],
          }),
        ],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('expected ready result')

    expect(result.plan.maxConcurrency).toBe(3)
    expect(result.plan.beforeMain.dependencyLevels).toEqual([
      { level: 0, stepIds: ['aps_a', 'aps_b'] },
      { level: 1, stepIds: ['aps_c'] },
    ])
    expect(result.plan.afterMain.dependencyLevels).toEqual([{ level: 0, stepIds: ['aps_after'] }])
    expect(result.plan.namedOutputRegistry.map((entry) => [entry.key, entry.phase, entry.stepId])).toEqual([
      ['a', 'beforeMain', 'aps_a'],
      ['b', 'beforeMain', 'aps_b'],
      ['c', 'beforeMain', 'aps_c'],
      ['after', 'afterMain', 'aps_after'],
    ])
    expect(result.summary).toMatchObject({
      beforeMainStepCount: 3,
      afterMainStepCount: 1,
      estimatedMaxCallsPerGeneration: 4,
    })
  })

  it('plans a before-main user-input modifier separately from the final-output modifier', () => {
    const result = resolveAgentPresetForChat({
      database: db({
        agentPresets: [
          preset({
            steps: [
              step({ id: 'aps_context', outputKey: 'context' }),
              step({ id: 'aps_input', outputKey: 'input', destination: 'userInput' }),
              step({
                id: 'aps_final',
                phase: 'afterMain',
                outputKey: 'final',
                destination: 'finalOutput',
              }),
            ],
          }),
        ],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('expected ready modifier plan')
    expect(result.plan.userInputModifierStepId).toBe('aps_input')
    expect(result.plan.finalOutputModifierStepId).toBe('aps_final')
  })

  it('rejects invalid DAGs, duplicate output keys, and final-output modifier ordering', () => {
    const cyclic = resolveAgentPresetForChat({
      database: db({
        agentPresets: [
          preset({
            steps: [
              step({ id: 'aps_a', outputKey: 'a', dependencies: ['aps_b'] }),
              step({ id: 'aps_b', outputKey: 'b', dependencies: ['aps_a'] }),
            ],
          }),
        ],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })

    expect(cyclic.status).toBe('invalid')
    if (cyclic.status !== 'invalid') throw new Error('expected invalid result')
    expect(cyclic.issues.map((issue) => issue.code)).toContain('cyclic_dependency')
    expect(cyclic.summary.invalidDependencyCount).toBeGreaterThan(0)

    const duplicateOutput = resolveAgentPresetForChat({
      database: db({
        agentPresets: [
          preset({
            steps: [step({ id: 'aps_a', outputKey: 'dupe' }), step({ id: 'aps_b', outputKey: 'dupe' })],
          }),
        ],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })

    expect(duplicateOutput.status).toBe('invalid')
    if (duplicateOutput.status !== 'invalid') throw new Error('expected invalid duplicate output result')
    expect(duplicateOutput.issues.map((issue) => issue.code)).toContain('duplicate_output_key')

    const crossPhaseDuplicate = resolveAgentPresetForChat({
      database: db({
        agentPresets: [
          preset({
            steps: [
              step({ id: 'aps_before', phase: 'beforeMain', outputKey: 'shared' }),
              step({ id: 'aps_after', phase: 'afterMain', outputKey: 'shared' }),
            ],
          }),
        ],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })
    expect(crossPhaseDuplicate.status).toBe('invalid')
    if (crossPhaseDuplicate.status !== 'invalid') throw new Error('expected invalid cross-phase duplicate result')
    expect(crossPhaseDuplicate.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate_output_key', path: 'agentPreset.steps[1].outputKey' }),
      ]),
    )

    const modifierOrdering = resolveAgentPresetForChat({
      database: db({
        agentPresets: [
          preset({
            steps: [
              step({
                id: 'aps_modifier',
                phase: 'afterMain',
                outputKey: 'modifier',
                destination: 'finalOutput',
              }),
              step({ id: 'aps_advisory', phase: 'afterMain', outputKey: 'advisory' }),
            ],
          }),
        ],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })

    expect(modifierOrdering.status).toBe('invalid')
    if (modifierOrdering.status !== 'invalid') throw new Error('expected invalid modifier result')
    expect(modifierOrdering.summary.directModifierStatus).toBe('not_last')
    expect(modifierOrdering.issues.map((issue) => issue.code)).toContain('invalid_after_main_modifier')
  })

  it('treats cross-phase dependencies as invalid during planning', () => {
    const result = planAgentPreset({
      database: db(),
      preset: preset({
        steps: [
          step({ id: 'aps_before', outputKey: 'before' }),
          step({ id: 'aps_after', phase: 'afterMain', outputKey: 'after', dependencies: ['aps_before'] }),
        ],
      }),
    })

    expect(result.plan).toBeUndefined()
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_dependency',
          message: 'Agent Preset step dependencies must stay within the same execution phase',
        }),
      ]),
    )
  })

  it('reports inherit-main and selected-profile readiness using model profile resolver semantics', () => {
    const database = db({
      modelProfiles: [
        {
          id: 'ready-echo',
          name: 'Ready Echo',
          providerId: 'debug-echo',
          modelId: 'debug-echo',
          providerOptions: { baseUrl: 'debug://base', requestModel: 'debug-wire' },
        },
        {
          id: 'incomplete-openai',
          name: 'Incomplete OpenAI',
          providerId: 'openai',
          modelId: 'gpt-5',
        },
        {
          id: 'unsupported-provider',
          name: 'Unsupported Provider',
          providerId: 'mistral',
          modelId: 'mistral-large',
        },
      ],
      agentPresets: [
        preset({
          steps: [
            step({ id: 'aps_inherit', outputKey: 'inherited' }),
            step({
              id: 'aps_ready',
              outputKey: 'ready',
              model: { mode: 'modelProfile', profileId: 'ready-echo' },
            }),
            step({
              id: 'aps_missing',
              outputKey: 'missing',
              model: { mode: 'modelProfile', profileId: 'missing-profile' },
            }),
            step({
              id: 'aps_incomplete',
              outputKey: 'incomplete',
              model: { mode: 'modelProfile', profileId: 'incomplete-openai' },
            }),
            step({
              id: 'aps_unsupported',
              outputKey: 'unsupported',
              model: { mode: 'modelProfile', profileId: 'unsupported-provider' },
            }),
          ],
        }),
      ],
    })

    const result = resolveAgentPresetForChat({
      database,
      generationSettings: { agentPresetId: 'ap_default' },
      resolvedMainProfile: resolveModelProfile({ database }),
    })

    expect(result.status).toBe('model_not_ready')
    if (result.status !== 'model_not_ready') throw new Error('expected model readiness failure')

    expect(result.modelReadiness.map((readiness) => [readiness.stepId, readiness.kind, readiness.ready])).toEqual([
      ['aps_inherit', 'inheritMainIncomplete', false],
      ['aps_ready', 'selectedProfileReady', true],
      ['aps_missing', 'selectedProfileMissing', false],
      ['aps_incomplete', 'selectedProfileIncomplete', false],
      ['aps_unsupported', 'selectedProfileUnsupported', false],
    ])
    expect(result.summary.modelReadiness).toHaveLength(5)
  })

  it('plans prepared input scopes in deterministic order with per-step max input caps', () => {
    const result = resolveAgentPresetForChat({
      database: db({
        agentPresets: [
          preset({
            steps: [
              step({
                id: 'aps_inputs',
                phase: 'afterMain',
                outputKey: 'inputs',
                runtime: {
                  maxInputChars: 500,
                  maxOutputChars: 1_200,
                  timeoutMs: 30_000,
                },
                inputScopes: ['mainDraft', 'currentUserMessage', 'recentChatTail', 'previousAgentOutputs'],
              }),
            ],
          }),
        ],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('expected ready input plan')

    const inputPlan = result.plan.afterMain.steps[0].preparedInputs
    expect(inputPlan.map((scope) => scope.scope)).toEqual([
      'recentChatTail',
      'currentUserMessage',
      'previousAgentOutputs',
      'mainDraft',
    ])
    expect(inputPlan.every((scope) => scope.maxChars <= 500)).toBe(true)
    expect(inputPlan).toContainEqual({
      scope: 'mainDraft',
      source: 'postEditOutputDraft',
      available: true,
      maxChars: 500,
    })
    expect(inputPlan).toContainEqual({
      scope: 'previousAgentOutputs',
      source: 'completedAgentOutputs',
      includePhases: ['beforeMain', 'afterMain'],
      maxChars: 500,
    })
  })

  it('marks unavailable agent CBS references as incomplete during planning', () => {
    const forwardReference = resolveAgentPresetForChat({
      database: db({
        agentPresets: [
          preset({
            steps: [
              step({ id: 'aps_a', name: 'A', outputKey: 'a', instruction: 'Use {{agent::b}}.' }),
              step({ id: 'aps_b', name: 'B', outputKey: 'b', dependencies: ['aps_a'] }),
            ],
          }),
        ],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })

    expect(forwardReference.status).toBe('incomplete')
    if (forwardReference.status !== 'incomplete') throw new Error('expected incomplete forward reference')
    expect(forwardReference.issues).toContainEqual(
      expect.objectContaining({
        code: 'unavailable_agent_output',
        message: expect.stringContaining('{{agent::b}}'),
      }),
    )

    const sameLevelReference = resolveAgentPresetForChat({
      database: db({
        agentPresets: [
          preset({
            steps: [
              step({ id: 'aps_a', name: 'A', outputKey: 'a' }),
              step({ id: 'aps_b', name: 'B', outputKey: 'b', instruction: 'Use {{agent::a}}.' }),
            ],
          }),
        ],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })

    expect(sameLevelReference.status).toBe('incomplete')
    if (sameLevelReference.status !== 'incomplete') throw new Error('expected incomplete same-level reference')
    expect(sameLevelReference.issues[0]?.message).toContain('same-level step')

    const missingReference = resolveAgentPresetForChat({
      database: db({
        agentPresets: [preset({ steps: [step({ instruction: 'Use {{agent::missing}}.' })] })],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })

    expect(missingReference.status).toBe('incomplete')
    if (missingReference.status !== 'incomplete') throw new Error('expected incomplete missing reference')
    expect(missingReference.issues[0]?.message).toContain('no enabled Agent Preset output key')

    const missingFinalOutputReference = resolveAgentPresetForChat({
      database: db({
        agentPresets: [
          preset({
            finalOutputTemplate: '{{slot::mainOutput}}\n{{agent::missing}}',
          }),
        ],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })

    expect(missingFinalOutputReference.status).toBe('incomplete')
    if (missingFinalOutputReference.status !== 'incomplete') {
      throw new Error('expected incomplete final output reference')
    }
    expect(missingFinalOutputReference.issues).toContainEqual(
      expect.objectContaining({
        path: 'agentPreset.finalOutputTemplate',
        message: expect.stringContaining('{{agent::missing}}'),
      }),
    )
  })

  it('returns structured output-reference diagnostics from resolved steps and the current plan', () => {
    const target = preset({
      finalOutputTemplate: '{{agent::disabled}} {{agent::missing}}',
      steps: [
        step({ id: 'aps_a', outputKey: 'a', instruction: '{{agent::a}} {{agent::later}}' }),
        step({ id: 'aps_later', outputKey: 'later' }),
        step({ id: 'aps_disabled', outputKey: 'disabled', enabled: false }),
      ],
    })
    const planning = planAgentPreset({ database: db({ agentPresets: [target] }), preset: target })
    expect(planning.plan).toBeDefined()

    expect(diagnoseAgentPresetOutputReferences(target.steps, planning.plan!, target.finalOutputTemplate)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          token: '{{agent::a}}',
          reason: 'self_reference',
          consumerStepId: 'aps_a',
          producerStepIds: ['aps_a'],
        }),
        expect.objectContaining({ token: '{{agent::later}}', reason: 'same_dependency_level' }),
        expect.objectContaining({
          token: '{{agent::disabled}}',
          path: 'agentPreset.finalOutputTemplate',
          reason: 'disabled_output',
          producerStepIds: ['aps_disabled'],
        }),
        expect.objectContaining({ token: '{{agent::missing}}', reason: 'missing_output', producerStepIds: [] }),
      ]),
    )
  })

  it('allows agent CBS references when the output is already completed by phase order', () => {
    const result = resolveAgentPresetForChat({
      database: db({
        agentPresets: [
          preset({
            steps: [
              step({ id: 'aps_a', name: 'A', outputKey: 'a' }),
              step({ id: 'aps_b', name: 'B', outputKey: 'b', dependencies: ['aps_a'], instruction: '{{agent::a}}' }),
              step({
                id: 'aps_after',
                name: 'After',
                phase: 'afterMain',
                outputKey: 'after',
                instruction: '{{agent::a}}',
              }),
            ],
          }),
        ],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('expected ready references')

    const beforeMainFuture = resolveAgentPresetForChat({
      database: db({
        agentPresets: [
          preset({
            steps: [
              step({ id: 'aps_before', outputKey: 'before', instruction: '{{agent::after}}' }),
              step({ id: 'aps_after', phase: 'afterMain', outputKey: 'after' }),
            ],
          }),
        ],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })

    expect(beforeMainFuture.status).toBe('incomplete')
    if (beforeMainFuture.status !== 'incomplete') throw new Error('expected incomplete cross-phase reference')
    expect(beforeMainFuture.issues[0]?.message).toContain('after the main response')
  })

  it('summarizes missing and invalid output keys for UI status surfaces', () => {
    const result = resolveAgentPresetForChat({
      database: db({
        agentPresets: [
          preset({
            steps: [step({ id: 'aps_blank', outputKey: '' }), step({ id: 'aps_bad', outputKey: 'bad-key' })],
          }),
        ],
      }),
      generationSettings: { agentPresetId: 'ap_default' },
    })

    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') throw new Error('expected invalid output key result')
    expect(result.summary.missingOutputKeyCount).toBe(1)
    expect(result.summary.invalidOutputKeyCount).toBe(2)
  })
})
