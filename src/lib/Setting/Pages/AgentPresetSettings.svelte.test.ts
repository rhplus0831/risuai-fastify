import { demoteClientSession } from 'src/ts/clientSession'
import {
  beginWriterDraftCaptureTest,
  endWriterDraftCaptureTest,
  capturedWriterDrafts,
} from 'src/ts/__tests__/writerDraftCapture'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const presetSpies = vi.hoisted(() => ({
  createAgentPreset: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  updateAgentPreset: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  duplicateAgentPreset: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  deleteAgentPreset: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  reorderAgentPresets: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  setAgentPresetDefault: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  currentPendingAgentPresetGeneratedProjectionLatch: vi.fn(() => null),
  isAgentPresetGeneratedProjectionResolved: vi.fn(() => false),
  mergePendingAgentPresetSettingsResource: vi.fn((value) => value),
  mergePendingAgentPresetLoadoutsResource: vi.fn((value) => value),
  mergePendingAgentPresetCharactersResource: vi.fn((value) => value),
}))

const agentSpies = vi.hoisted(() => ({
  createAgent: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  updateAgent: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  duplicateAgent: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  deleteAgent: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  reorderAgents: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  addAgentToPreset: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  updateAgentPresetUse: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  removeAgentFromPreset: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  reorderAgentPresetUses: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  agentUsageCount: vi.fn(() => 1),
  defaultAgentPresetUse: vi.fn((agent: { id: string; name: string }) => ({
    agentId: agent.id,
    enabled: true,
    phase: 'beforeMain',
    dependencies: [],
    outputKey: agent.name.toLowerCase().replaceAll(' ', '_'),
    destination: 'promptOutput',
    failurePolicy: { mode: 'required' },
  })),
}))

vi.mock('src/ts/agentPresets', () => presetSpies)
vi.mock('src/ts/agents', () => agentSpies)
vi.mock('src/ts/process/modules', () => ({
  applyModule: vi.fn(),
  exportModule: vi.fn(),
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModules: vi.fn(() => []),
  importModule: vi.fn(),
  moduleUpdate: vi.fn(),
  readModule: vi.fn(),
  refreshModules: vi.fn(),
}))

import AgentPresetSettings from './AgentPresetSettings.svelte'
import AgentPresetEditorDrawer from './AgentPresetEditorDrawer.svelte'
import { language } from 'src/lang'
import { setDatabaseLite } from 'src/ts/storage/database.svelte'
import type { AgentPresetRecord, AgentRecord } from 'src/ts/agentPresetRecords'
import { resetServerResourceState, settingsResourceState } from 'src/ts/server/resourceState.svelte'
import { getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

let target: HTMLElement
let component: Parameters<typeof unmount>[0] | undefined

const agent: AgentRecord = {
  id: 'ag_shared',
  name: 'Shared Researcher',
  description: 'Reusable research behavior.',
  version: 1,
  instruction: 'Research {{currentUserMessage}}.',
  modelDefaults: { mode: 'inheritMain' },
  runtimeDefaults: { timeoutMs: 30_000 },
  inputScopes: ['currentUserMessage'],
  outputFormat: 'text',
}

const preset: AgentPresetRecord = {
  id: 'ap_research',
  name: 'Research Preset',
  enabled: true,
  version: 1,
  steps: [],
  agentUses: [
    {
      id: 'apu_research',
      agentId: agent.id,
      enabled: true,
      phase: 'beforeMain',
      dependencies: [],
      outputKey: 'research',
      destination: 'promptOutput',
      failurePolicy: { mode: 'required' },
    },
  ],
}

function seed(agents: AgentRecord[] = [agent], presets: AgentPresetRecord[] = [preset]): void {
  setDatabaseLite({
    agents,
    agentPresets: presets,
    agentPresetDefaultId: presets[0]?.id,
    modelProfiles: [],
    characters: [],
    loadouts: [],
  } as never)
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await tick()
}

function clickButtonContaining(scope: ParentNode, text: string): void {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  )
  expect(button, text).toBeTruthy()
  button!.click()
}

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  for (const spy of [...Object.values(presetSpies), ...Object.values(agentSpies)]) spy.mockClear()
  agentSpies.agentUsageCount.mockReturnValue(1)
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  )
})

afterEach(() => {
  if (component) unmount(component)
  component = undefined
  target.remove()
  setDatabaseLite({} as never)
  vi.unstubAllGlobals()
})

describe('modular Agent Preset settings', () => {
  it('renders the standalone Agent library and preset composition summary', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    const presetsHeader = target.querySelector('[data-risu-agent-presets-header]')
    expect(presetsHeader?.textContent).toContain(language.agentPresets.presetsSectionDescription)
    expect(presetsHeader?.querySelector('[data-risu-agent-preset-create]')).not.toBeNull()
    expect(target.querySelector('[data-risu-agent-settings]')?.textContent).toContain(language.agentPresets.agentsTitle)
    expect(target.querySelector('[data-risu-agent-row]')?.textContent).toContain(agent.name)
    expect(target.querySelector('[data-risu-agent-preset-row]')?.textContent).toContain(preset.name)
    expect(target.querySelector('[data-risu-agent-preset-row]')?.textContent).toContain(
      language.agentPresets.stepCount(1),
    )
  })

  it('creates a standalone Agent through the Agent command helper', async () => {
    seed([], [])
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-settings]')!, language.agentPresets.createAgent)
    await tick()
    const nameInput = target.querySelector<HTMLInputElement>('[data-risu-agent-editor] input[type="text"]')!
    nameInput.value = 'Reusable Critic'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    clickButtonContaining(target.querySelector('[data-risu-agent-editor]')!, language.agentPresets.save)
    await flush()

    expect(agentSpies.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Reusable Critic', instruction: expect.any(String) }),
    )
  })

  it('edits Agent behavior independently from preset orchestration', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    const row = target.querySelector('[data-risu-agent-row]')!
    const editButtons = row.querySelectorAll<HTMLButtonElement>('button')
    editButtons[2].click()
    await tick()
    const instruction = target.querySelectorAll<HTMLTextAreaElement>('[data-risu-agent-editor] textarea')[1]
    instruction.value = 'Updated shared behavior.'
    instruction.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    clickButtonContaining(target.querySelector('[data-risu-agent-editor]')!, language.agentPresets.save)
    await flush()

    expect(agentSpies.updateAgent).toHaveBeenCalledWith(agent.id, { instruction: 'Updated shared behavior.' })
    expect(agentSpies.updateAgentPresetUse).not.toHaveBeenCalled()
  })

  it('shows a profile divider without allowing it to replace an Agent model selection', async () => {
    seed([{ ...agent, modelDefaults: { mode: 'modelProfile', profileId: 'profile-a' } }])
    getDatabase().modelProfiles = [
      { id: 'profile-a', name: 'Profile A' },
      { id: 'profile-b', name: 'Profile B' },
    ]
    getDatabase().modelProfileOrder = [
      { kind: 'profile', profileId: 'profile-a' },
      { kind: 'divider', id: 'divider-a' },
      { kind: 'profile', profileId: 'profile-b' },
    ]
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()
    const editor = target.querySelector<HTMLElement>('[data-risu-agent-editor]')!
    const labeledSelect = (label: string) =>
      Array.from(editor.querySelectorAll<HTMLLabelElement>('label'))
        .find((candidate) => candidate.querySelector('span')?.textContent?.includes(label))
        ?.querySelector<HTMLSelectElement>('select')
    const profileSelect = labeledSelect(language.agentPresets.modelProfileLabel)
    if (!profileSelect) throw new Error('Agent profile select not found')
    expect(Array.from(profileSelect.options).map((option) => option.textContent)).toEqual([
      language.agentPresets.noModelProfiles,
      'Profile A',
      '---',
      'Profile B',
    ])
    const divider = profileSelect.querySelector<HTMLOptionElement>('[data-model-profile-divider="true"]')!
    profileSelect.value = divider.value
    profileSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()

    expect(labeledSelect(language.agentPresets.modelProfileLabel)?.value).toBe('profile-a')
    expect(agentSpies.updateAgent).not.toHaveBeenCalled()
  })

  it('keeps the Agent drawer open when a text-selection drag ends on the backdrop', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()

    const editor = target.querySelector<HTMLElement>('[data-risu-agent-editor]')!
    const backdrop = editor.parentElement!
    const instruction = editor.querySelectorAll<HTMLTextAreaElement>('textarea')[1]
    const pointerOptions: PointerEventInit = {
      bubbles: true,
      button: 0,
      isPrimary: true,
      pointerId: 1,
    }

    instruction.dispatchEvent(new PointerEvent('pointerdown', pointerOptions))
    backdrop.dispatchEvent(new PointerEvent('pointerup', pointerOptions))
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }))
    await tick()

    expect(target.querySelector('[data-risu-agent-editor]')).toBe(editor)
    expect(vi.mocked(window.confirm)).not.toHaveBeenCalled()

    backdrop.dispatchEvent(new PointerEvent('pointerdown', pointerOptions))
    backdrop.dispatchEvent(new PointerEvent('pointerup', pointerOptions))
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }))
    await tick()

    expect(target.querySelector('[data-risu-agent-editor]')).toBeNull()
  })

  it('saves ChatML request mode as reusable Agent behavior', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()
    const editor = target.querySelector('[data-risu-agent-editor]')!
    const instruction = editor.querySelectorAll<HTMLTextAreaElement>('textarea')[1]
    const chatMLInstruction = '<|im_start|>user\nResearch {{currentUserMessage}}.<|im_end|>'
    instruction.value = chatMLInstruction
    instruction.dispatchEvent(new Event('input', { bubbles: true }))
    editor.querySelector<HTMLInputElement>(`input[aria-label="${language.agentPresets.useChatMLLabel}"]`)!.click()
    await tick()

    expect(editor.querySelector('[data-risu-agent-use-chatml]')?.textContent).not.toContain(
      language.agentPresets.invalidChatMLInstruction,
    )
    clickButtonContaining(editor, language.agentPresets.save)
    await flush()

    expect(agentSpies.updateAgent).toHaveBeenCalledWith(agent.id, {
      instruction: chatMLInstruction,
      useChatML: true,
    })
  })

  it('blocks saving an enabled ChatML Agent until its instruction starts with ChatML', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()
    const editor = target.querySelector('[data-risu-agent-editor]')!
    editor.querySelector<HTMLInputElement>(`input[aria-label="${language.agentPresets.useChatMLLabel}"]`)!.click()
    await tick()

    expect(editor.querySelector('[data-risu-agent-use-chatml]')?.textContent).toContain(
      language.agentPresets.invalidChatMLInstruction,
    )
    const save = [...editor.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes(language.agentPresets.save),
    )
    expect(save?.disabled).toBe(true)
  })

  it('shows only the CBS variables for currently selected prepared inputs below the instruction', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()
    const editor = target.querySelector('[data-risu-agent-editor]')!

    let placeholders = editor.querySelector('[data-risu-agent-instruction-placeholders]')
    expect(placeholders?.textContent).toContain('{{currentUserMessage}}')
    expect(placeholders?.textContent).not.toContain('{{memoryContext}}')
    expect(placeholders?.textContent).not.toContain('{{recentChatTail}}')

    editor
      .querySelector<HTMLInputElement>(`input[aria-label="${language.agentPresets.inputScopeLabels.memoryContext}"]`)!
      .click()
    await tick()
    placeholders = editor.querySelector('[data-risu-agent-instruction-placeholders]')
    expect(placeholders?.textContent).toContain('{{currentUserMessage}}')
    expect(placeholders?.textContent).toContain('{{memoryContext}}')

    editor
      .querySelector<HTMLInputElement>(
        `input[aria-label="${language.agentPresets.inputScopeLabels.currentUserMessage}"]`,
      )!
      .click()
    await tick()
    placeholders = editor.querySelector('[data-risu-agent-instruction-placeholders]')
    expect(placeholders?.textContent).not.toContain('{{currentUserMessage}}')
    expect(placeholders?.textContent).toContain('{{memoryContext}}')

    editor
      .querySelector<HTMLInputElement>(`input[aria-label="${language.agentPresets.inputScopeLabels.memoryContext}"]`)!
      .click()
    await tick()
    expect(editor.querySelector('[data-risu-agent-instruction-placeholders]')).toBeNull()
  })

  it('saves Agent-local toggles and required lorebook input aliases', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()
    const editor = target.querySelector('[data-risu-agent-editor]')!
    const instruction = editor.querySelectorAll<HTMLTextAreaElement>('textarea')[1]
    instruction.value = 'Tone: {{agentToggle::tone}}\nReference: {{agentInput::reference}}'
    instruction.dispatchEvent(new Event('input', { bubbles: true }))

    clickButtonContaining(editor, language.agentPresets.addToggle)
    clickButtonContaining(editor, language.agentPresets.addLorebookInput)
    await tick()

    const toggleInputs = editor.querySelectorAll<HTMLInputElement>('[data-risu-agent-toggle] input[type="text"]')
    toggleInputs[0].value = 'tone'
    toggleInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    toggleInputs[1].value = 'Tone'
    toggleInputs[1].dispatchEvent(new Event('input', { bubbles: true }))

    const lorebookInputs = editor.querySelectorAll<HTMLInputElement>(
      '[data-risu-agent-lorebook-input] input[type="text"]',
    )
    lorebookInputs[0].value = 'reference'
    lorebookInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    lorebookInputs[1].value = 'Reference Notes'
    lorebookInputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    clickButtonContaining(editor, language.agentPresets.save)
    await flush()

    expect(agentSpies.updateAgent).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({
        instruction: 'Tone: {{agentToggle::tone}}\nReference: {{agentInput::reference}}',
        toggles: [{ key: 'tone', label: 'Tone', kind: 'boolean', options: [] }],
        lorebookInputs: [{ key: 'reference', displayName: 'Reference Notes', required: true }],
      }),
    )
  })

  it('adds an existing Agent to a preset by reference', async () => {
    seed([agent], [{ ...preset, agentUses: [] }])
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    clickButtonContaining(target.querySelector('[data-risu-agent-preset-editor]')!, language.agentPresets.addAgent)
    await flush()

    expect(agentSpies.addAgentToPreset).toHaveBeenCalledWith(
      preset.id,
      expect.objectContaining({ agentId: agent.id, phase: 'beforeMain' }),
    )
    expect(agentSpies.createAgent).not.toHaveBeenCalled()
  })

  it('updates only invocation-owned fields in the preset composer', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    clickButtonContaining(target.querySelector('[data-risu-agent-preset-step]')!, language.agentPresets.edit)
    await tick()
    const output = target.querySelector<HTMLInputElement>('[data-risu-agent-preset-use-form] input[type="text"]')!
    output.value = 'shared_research'
    output.dispatchEvent(new Event('input', { bubbles: true }))
    clickButtonContaining(
      target.querySelector('[data-risu-agent-preset-use-form]')!,
      language.agentPresets.saveInvocation,
    )
    await flush()

    expect(agentSpies.updateAgentPresetUse).toHaveBeenCalledWith(
      preset.id,
      'apu_research',
      expect.objectContaining({ outputKey: 'shared_research', phase: 'beforeMain' }),
    )
    expect(agentSpies.updateAgent).not.toHaveBeenCalled()
  })

  it('saves final output CBS metadata and shows the available Agent output keys', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    const editor = target.querySelector('[data-risu-agent-preset-editor]')!
    const composer = editor.querySelector('[data-risu-agent-preset-final-output]')!
    expect(composer.querySelector('[data-risu-agent-preset-final-output-variables]')?.textContent).toContain(
      '{{slot::mainOutput}}',
    )
    expect(composer.querySelector('[data-risu-agent-preset-final-output-variables]')?.textContent).toContain(
      '{{agent::research}}',
    )

    const template = composer.querySelector<HTMLTextAreaElement>('textarea')!
    template.value = '{{slot::mainOutput}}\nStatus: {{agent::research}}'
    template.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    clickButtonContaining(editor, language.agentPresets.save)
    await flush()

    expect(presetSpies.updateAgentPreset).toHaveBeenCalledWith(preset.id, {
      finalOutputTemplate: '{{slot::mainOutput}}\nStatus: {{agent::research}}',
    })
  })

  it('saves module IDs and namespaces as Agent Preset metadata', async () => {
    seed([agent], [{ ...preset, moduleIntergration: 'old-space' }])
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    const editor = target.querySelector('[data-risu-agent-preset-editor]')!
    const integration = editor.querySelector<HTMLTextAreaElement>(
      '[data-risu-agent-preset-module-integration] textarea',
    )!
    integration.value = ' research-tools, module-id '
    integration.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    clickButtonContaining(editor, language.agentPresets.save)
    await flush()

    expect(presetSpies.updateAgentPreset).toHaveBeenCalledWith(preset.id, {
      moduleIntergration: 'research-tools, module-id',
    })
  })

  it('disables deletion for Agents still referenced by presets', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    const deleteButton = target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[4]
    expect(deleteButton.disabled).toBe(true)
  })

  it('fails closed when settings owners contain duplicate stable IDs', async () => {
    seed([agent, { ...agent, name: 'Ambiguous Researcher' }], [preset, { ...preset, name: 'Ambiguous Preset' }])
    component = mount(AgentPresetSettings, { target })
    await tick()

    expect(target.querySelectorAll('[data-risu-agent-row]')).toHaveLength(0)
    expect(target.querySelectorAll('[data-risu-agent-preset-row]')).toHaveLength(0)
    expect(target.querySelector('[data-risu-agent-preset-empty]')?.textContent).toContain(
      language.agentPresets.emptyState,
    )
  })

  it('uses the initial preset only while the Agent settings owner is pre-ready', async () => {
    resetServerResourceState()
    settingsResourceState.value.agents = [agent]
    component = mount(AgentPresetEditorDrawer, {
      target,
      props: { mode: 'edit', preset, onSave: vi.fn(), onCancel: vi.fn() },
    })
    await tick()

    expect(target.querySelectorAll('[data-risu-agent-preset-step]')).toHaveLength(1)
  })

  it('fails closed when the ready Agent settings owner does not contain the preset', async () => {
    resetServerResourceState()
    settingsResourceState.value.agents = [agent]
    settingsResourceState.groupStatuses.agents = 'ready'
    component = mount(AgentPresetEditorDrawer, {
      target,
      props: { mode: 'edit', preset, onSave: vi.fn(), onCancel: vi.fn() },
    })
    await tick()

    expect(target.querySelectorAll('[data-risu-agent-preset-step]')).toHaveLength(0)
  })
})

it('captures an Agent instruction before Save', async () => {
  await beginWriterDraftCaptureTest()
  try {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()
    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()
    const input = target.querySelectorAll<HTMLTextAreaElement>('[data-risu-agent-editor] textarea')[1]
    input.value = 'Unsubmitted Agent instruction'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(capturedWriterDrafts().find((draft) => draft.key === `agent:${agent.id}`)?.data).toMatchObject({
      instruction: 'Unsubmitted Agent instruction',
    })
    expect(agentSpies.updateAgent).not.toHaveBeenCalled()
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})

it('captures Agent Preset metadata and a nested use draft together', async () => {
  await beginWriterDraftCaptureTest()
  try {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()
    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    const editor = target.querySelector('[data-risu-agent-preset-editor]')!
    const name = editor.querySelector<HTMLInputElement>('input[type="text"]')!
    name.value = 'Unsubmitted orchestration'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    clickButtonContaining(target.querySelector('[data-risu-agent-preset-step]')!, language.agentPresets.edit)
    await tick()
    const output = editor.querySelector<HTMLInputElement>('[data-risu-agent-preset-use-form] input[type="text"]')
    if (!output) throw new Error('Use output key input missing')
    output.value = 'unfinished_output'
    output.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(capturedWriterDrafts().find((draft) => draft.key === `agent-preset:${preset.id}`)?.data).toMatchObject({
      metadata: { name: 'Unsubmitted orchestration' },
      use: { useOutputKey: 'unfinished_output' },
    })
    expect(agentSpies.updateAgentPresetUse).not.toHaveBeenCalled()
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})

it('does not capture an untouched Agent Preset with its default Agent selection', async () => {
  await beginWriterDraftCaptureTest()
  try {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()
    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    demoteClientSession()
    expect(capturedWriterDrafts()).toEqual([])
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})
