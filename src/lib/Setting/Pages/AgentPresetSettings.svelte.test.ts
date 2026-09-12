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
  deleteAgentPreset: vi.fn(async () => ({
    status: 'accepted',
    result: { status: 'ok', clearedDefault: false, clearedChatCount: 0, clearedLoadoutCount: 0 },
  })),
  getAgentPresetDeleteImpact: vi.fn((presetId: string): any => ({
    status: 'ready',
    presetId,
    presetName: 'Research Preset',
    globalDefault: { affected: false, postDeleteSelection: { source: 'none' } },
    chats: [],
    loadouts: [],
  })),
  reorderAgentPresets: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  setAgentPresetDefault: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  currentPendingAgentPresetGeneratedProjectionLatch: vi.fn(() => null),
  isAgentPresetGeneratedProjectionResolved: vi.fn(() => false),
  mergePendingAgentPresetSettingsResource: vi.fn((value) => value),
  mergePendingAgentPresetLoadoutsResource: vi.fn((value) => value),
  mergePendingAgentPresetCharactersResource: vi.fn((value) => value),
}))

const agentSpies = vi.hoisted(() => ({
  createAgent: vi.fn(async (_snapshot?: unknown) => ({
    status: 'accepted',
    result: { status: 'ok', agentId: 'ag_created' },
  })),
  updateAgent: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  duplicateAgent: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  deleteAgent: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  reorderAgents: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
  addAgentToPreset: vi.fn(async (_presetId?: string, use?: { agentId?: string }) => ({
    status: 'accepted',
    result: { status: 'ok', useId: 'apu_added', agentId: use?.agentId },
  })),
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

function seed(agents: AgentRecord[] = [agent], presets: AgentPresetRecord[] = [preset], modules: unknown[] = []): void {
  setDatabaseLite({
    agents,
    agentPresets: presets,
    agentPresetDefaultId: presets[0]?.id,
    modelProfiles: [],
    modules,
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
  presetSpies.getAgentPresetDeleteImpact.mockImplementation((presetId: string) => ({
    status: 'ready',
    presetId,
    presetName: preset.name,
    globalDefault: { affected: false, postDeleteSelection: { source: 'none' } },
    chats: [],
    loadouts: [],
  }))
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
    const agentRow = target.querySelector('[data-risu-agent-row]')
    expect(agentRow?.textContent).toContain(agent.name)
    expect(agentRow?.classList).toContain('sm:items-center')
    expect(agentRow?.querySelector(':scope > [data-risu-agent-actions]')).not.toBeNull()
    expect(target.querySelector('[data-risu-agent-preset-row]')?.textContent).toContain(preset.name)
    expect(target.querySelector('[data-risu-agent-preset-row]')?.textContent).toContain(
      language.agentPresets.stepCount(1),
    )
    const details = target.querySelector<HTMLDetailsElement>('[data-risu-agent-preset-technical-details]')!
    expect(details.open).toBe(false)
    expect(details.textContent).toContain(preset.id)
  })

  it('gives reviewed compact actions complete target names and touch-sized controls', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    const expectedAgentActions = [
      language.agentPresets.moveAgentUp(agent.name),
      language.agentPresets.moveAgentDown(agent.name),
      language.agentPresets.editAgentNamed(agent.name),
      language.agentPresets.duplicateAgentNamed(agent.name),
      language.agentPresets.deleteAgentBlocked(agent.name, 1),
    ]
    for (const name of expectedAgentActions) {
      const action = target.querySelector<HTMLButtonElement>(`[data-risu-agent-row] button[aria-label="${name}"]`)
      expect(action, name).not.toBeNull()
      expect(action?.classList).toContain('min-h-11')
    }

    const expectedPresetActions = [
      language.agentPresets.movePresetUp(preset.name),
      language.agentPresets.movePresetDown(preset.name),
      language.agentPresets.editPresetNamed(preset.name),
      language.agentPresets.duplicatePresetNamed(preset.name),
      language.agentPresets.deletePresetAccessibleName(preset.name),
    ]
    for (const name of expectedPresetActions) {
      const action = target.querySelector<HTMLButtonElement>(
        `[data-risu-agent-preset-row] button[aria-label="${name}"]`,
      )
      expect(action, name).not.toBeNull()
      expect(action?.classList).toContain('min-h-11')
    }

    target
      .querySelector<HTMLButtonElement>(
        `[data-risu-agent-row] button[aria-label="${language.agentPresets.editAgentNamed(agent.name)}"]`,
      )!
      .click()
    await tick()
    const agentClose = target.querySelector<HTMLButtonElement>(
      `[data-risu-agent-editor] button[aria-label="${language.close}"]`,
    )!
    expect(agentClose.classList).toContain('min-h-11')
    expect(agentClose.classList).toContain('min-w-11')
    agentClose.click()
    await tick()

    target
      .querySelector<HTMLButtonElement>(
        `[data-risu-agent-preset-row] button[aria-label="${language.agentPresets.editPresetNamed(preset.name)}"]`,
      )!
      .click()
    await tick()
    const presetEditor = target.querySelector<HTMLElement>('[data-risu-agent-preset-editor]')!
    const presetClose = presetEditor.querySelector<HTMLButtonElement>(`button[aria-label="${language.close}"]`)!
    expect(presetClose.classList).toContain('min-h-11')
    expect(presetClose.classList).toContain('min-w-11')
    for (const name of [
      language.agentPresets.moveAgentUseUp(agent.name),
      language.agentPresets.moveAgentUseDown(agent.name),
      language.agentPresets.editAgentUse(agent.name),
      language.agentPresets.duplicateAgentUse(agent.name),
      language.agentPresets.removeAgentUse(agent.name),
    ]) {
      const action = presetEditor.querySelector<HTMLButtonElement>(
        `[data-risu-agent-preset-step] button[aria-label="${name}"]`,
      )
      expect(action, name).not.toBeNull()
      expect(action?.classList).toContain('min-h-11')
    }
  })

  it('renders Empty only for a valid no-op while retaining blocked status precedence', async () => {
    const variants: AgentPresetRecord[] = [
      preset,
      { ...preset, id: 'ap_empty', name: 'Empty preset', agentUses: [] },
      { ...preset, id: 'ap_disabled', name: 'Disabled preset', enabled: false, agentUses: [] },
      {
        ...preset,
        id: 'ap_invalid',
        name: 'Invalid preset',
        agentUses: [{ ...preset.agentUses![0], id: 'use_invalid', agentId: 'missing_agent' }],
      },
      {
        ...preset,
        id: 'ap_incomplete',
        name: 'Incomplete preset',
        finalOutputTemplate: '{{agent::missing_output}}',
      },
      {
        ...preset,
        id: 'ap_model',
        name: 'Model preset',
        agentUses: [
          {
            ...preset.agentUses![0],
            id: 'use_model',
            modelOverride: { mode: 'modelProfile', profileId: 'missing_profile' },
          },
        ],
      },
    ]
    seed([agent], variants)
    component = mount(AgentPresetSettings, { target })
    await tick()

    const statusByName = (name: string) =>
      Array.from(target.querySelectorAll('[data-risu-agent-preset-row]')).find((row) => row.textContent?.includes(name))
        ?.textContent
    expect(statusByName('Research Preset')).toContain(language.agentPresets.statusReady)
    expect(statusByName('Empty preset')).toContain(language.agentPresets.statusEmpty)
    expect(statusByName('Disabled preset')).toContain(language.agentPresets.statusDisabled)
    expect(statusByName('Invalid preset')).toContain(language.agentPresets.statusInvalid)
    expect(statusByName('Incomplete preset')).toContain(language.agentPresets.statusIncomplete)
    expect(statusByName('Model preset')).toContain(language.agentPresets.statusModelNotReady)
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
    expect(editor.querySelector('[data-risu-agent-save-reason]')?.textContent).toContain(
      language.agentPresets.saveFixIssues(1),
    )
  })

  it('surfaces prepared-input mismatches and repairs them at the instruction caret', async () => {
    seed([{ ...agent, instruction: 'Research this request.' }])
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()
    const editor = target.querySelector<HTMLElement>('[data-risu-agent-editor]')!
    const issue = editor.querySelector<HTMLElement>('[data-risu-agent-issue="warning"]')!
    expect(issue.textContent).toContain('{{currentUserMessage}}')
    clickButtonContaining(issue, language.agentPresets.insertToken)
    await tick()

    const instruction = editor.querySelectorAll<HTMLTextAreaElement>('textarea')[1]
    expect(instruction.value).toBe('Research this request.{{currentUserMessage}}')
    expect(document.activeElement).toBe(instruction)
    expect(editor.querySelector('[data-risu-agent-issue="warning"]')).toBeNull()
  })

  it('links undefined local references to the blocking field while legal guidance stays nonblocking', async () => {
    seed([{ ...agent, instruction: '{{agentToggle::missing}}' }])
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()
    const editor = target.querySelector<HTMLElement>('[data-risu-agent-editor]')!
    const error = editor.querySelector<HTMLElement>('[data-risu-agent-issue="error"]')!
    expect(error.textContent).toContain(language.agentPresets.issueInvalidToggleDefinition)
    error.querySelector<HTMLButtonElement>('button')!.click()
    await tick()

    expect(document.activeElement).toBe(editor.querySelector('[data-risu-agent-field="toggles"]'))
    expect(
      [...editor.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent?.includes(language.agentPresets.save),
      )?.disabled,
    ).toBe(true)
    expect(editor.querySelector('[data-risu-agent-save-reason]')?.textContent).toContain(
      language.agentPresets.saveFixIssues(1),
    )

    editor.querySelector<HTMLButtonElement>('button')!.click()
    await tick()
    clickButtonContaining(target.querySelector('[data-risu-agent-settings]')!, language.agentPresets.createAgent)
    await tick()
    const createEditor = target.querySelector<HTMLElement>('[data-risu-agent-editor]')!
    expect(createEditor.querySelectorAll('[data-risu-agent-issue="warning"]').length).toBeGreaterThan(0)
    expect(
      [...createEditor.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent?.includes(language.agentPresets.save),
      )?.disabled,
    ).toBe(false)
  })

  it('explains that an unchanged Agent has no changes to save', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()

    expect(target.querySelector('[data-risu-agent-save-reason]')?.textContent).toContain(
      language.agentPresets.saveNoChanges,
    )
  })

  it('keeps a newer Agent issue open when an older Save resolves', async () => {
    let resolveSave: ((value: { status: 'accepted'; result: { status: 'ok' } }) => void) | undefined
    agentSpies.updateAgent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        }),
    )
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()
    const editor = target.querySelector<HTMLElement>('[data-risu-agent-editor]')!
    const instruction = editor.querySelectorAll<HTMLTextAreaElement>('textarea')[1]
    instruction.value = 'First submitted change {{currentUserMessage}}'
    instruction.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    clickButtonContaining(editor, language.agentPresets.save)
    await flush()
    expect(editor.querySelector('[data-risu-agent-save-reason]')?.textContent).toContain(
      language.agentPresets.saveWaiting,
    )

    const name = editor.querySelector<HTMLInputElement>('[data-risu-agent-field="name"] input')!
    name.value = ''
    name.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    resolveSave?.({ status: 'accepted', result: { status: 'ok' } })
    await flush()

    expect(target.querySelector('[data-risu-agent-editor]')).toBe(editor)
    expect(editor.querySelector('[data-risu-agent-save-reason]')?.textContent).toContain(
      language.agentPresets.saveFixIssues(1),
    )
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

  it('organizes Agent authoring, inserts available values at the caret, and explains runtime limits', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()
    const editor = target.querySelector<HTMLElement>('[data-risu-agent-editor]')!
    const sectionNames = [...editor.querySelectorAll<HTMLElement>('[data-risu-agent-section]')].map(
      (section) => section.dataset.risuAgentSection,
    )
    expect(sectionNames).toEqual(['basics', 'instructions', 'context', 'model-limits', 'advanced'])
    expect(editor.querySelector<HTMLDetailsElement>('[data-risu-agent-section="advanced"]')?.open).toBe(false)

    const instruction = editor.querySelectorAll<HTMLTextAreaElement>('textarea')[1]
    instruction.focus()
    instruction.setSelectionRange(9, 9)
    editor
      .querySelector<HTMLButtonElement>('[data-risu-agent-insert-token][data-token="{{currentUserMessage}}"]')!
      .click()
    await tick()
    expect(instruction.value).toBe('Research {{currentUserMessage}}{{currentUserMessage}}.')
    expect(instruction.selectionStart).toBe(31)

    const modelSection = editor.querySelector('[data-risu-agent-section="model-limits"]')!
    expect(modelSection.textContent).toContain(language.agentPresets.runtimeRange(250, 300_000))
    expect(modelSection.textContent).toContain(language.agentPresets.timeoutEffect(30))
    expect(editor.querySelector('[data-risu-agent-technical-details]')?.textContent).toContain(agent.id)
  })

  it('previews valid ChatML as ordered role rows without exposing hidden thought text', async () => {
    seed([
      {
        ...agent,
        useChatML: true,
        instruction:
          '<|im_start|>system\nSystem context<|im_end|><|im_start|>user\nVisible <Thoughts>private chain</Thoughts><|im_end|>',
      },
    ])
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()
    const preview = target.querySelector('[data-risu-agent-chatml-preview]')!
    expect(preview.querySelectorAll('[data-risu-chatml-role]')).toHaveLength(2)
    expect(preview.textContent).toContain(language.agentPresets.chatMLRole('system', 1))
    expect(preview.textContent).toContain(language.agentPresets.chatMLThoughtCount(1))
    expect(preview.textContent).not.toContain('private chain')
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

  it('chooses the phase before add, uses a phase-valid destination, and returns to the new use', async () => {
    const emptyPreset = { ...preset, agentUses: [] }
    agentSpies.addAgentToPreset.mockImplementationOnce(async (_presetId, use) => {
      settingsResourceState.value.agentPresets = [
        { ...emptyPreset, agentUses: [{ ...use, id: 'apu_added' }] as never[] },
      ]
      return {
        status: 'accepted',
        result: { status: 'ok', useId: 'apu_added', agentId: use?.agentId },
      }
    })
    seed([agent], [emptyPreset])
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    const editor = target.querySelector<HTMLElement>('[data-risu-agent-preset-editor]')!
    const phase = editor.querySelector<HTMLSelectElement>('[data-risu-agent-add-phase] select')!
    phase.value = 'afterMain'
    phase.dispatchEvent(new Event('input', { bubbles: true }))
    phase.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    clickButtonContaining(editor, language.agentPresets.addAgent)
    await flush()

    expect(agentSpies.addAgentToPreset).toHaveBeenCalledWith(
      preset.id,
      expect.objectContaining({ agentId: agent.id, phase: 'afterMain', destination: 'intermediate' }),
    )
    const useForm = editor.querySelector<HTMLElement>('[data-risu-agent-preset-use-form]')!
    expect(useForm).not.toBeNull()
    expect(document.activeElement).toBe(useForm)
    expect(editor.querySelector('[data-risu-agent-use-position-announcement]')?.textContent).toContain(
      language.agentPresets.agentAddedPosition(agent.name, language.agentPresets.afterMain, 1, 1),
    )
  })

  it('announces stable keyboard reorder positions and keeps raw use metadata in details', async () => {
    const secondUse = {
      ...preset.agentUses![0],
      id: 'apu_second',
      outputKey: 'second',
    }
    seed([agent], [{ ...preset, agentUses: [preset.agentUses![0], secondUse] }])
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    const editor = target.querySelector<HTMLElement>('[data-risu-agent-preset-editor]')!
    const first = editor.querySelector<HTMLElement>('[data-step-id="apu_research"]')!
    expect(first.textContent).toContain(language.agentPresets.agentUsePosition(1, 2))
    expect(first.querySelector('[data-risu-agent-use-technical-details]')?.textContent).toContain(agent.id)

    first
      .querySelector<HTMLButtonElement>(`[aria-label="${language.agentPresets.moveAgentUseDown(agent.name)}"]`)!
      .click()
    await flush()
    expect(agentSpies.reorderAgentPresetUses).toHaveBeenCalledWith(preset.id, ['apu_second', 'apu_research'])
    expect(editor.querySelector('[data-risu-agent-use-position-announcement]')?.textContent).toContain(
      language.agentPresets.agentMovedPosition(agent.name, language.agentPresets.beforeMain, 2, 2),
    )
  })

  it('creates an Agent inside an empty preset without losing the preset draft', async () => {
    const emptyPreset = { ...preset, agentUses: [] }
    const createdAgent = { ...agent, id: 'ag_created', name: 'Nested Critic' }
    agentSpies.createAgent.mockImplementationOnce(async () => {
      settingsResourceState.value.agents = [createdAgent]
      return { status: 'accepted', result: { status: 'ok', agentId: createdAgent.id } }
    })
    seed([], [emptyPreset])
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    const presetEditor = target.querySelector<HTMLElement>('[data-risu-agent-preset-editor]')!
    const presetName = presetEditor.querySelector<HTMLInputElement>('[data-risu-agent-preset-name-input] input')!
    presetName.value = 'Draft preserved'
    presetName.dispatchEvent(new Event('input', { bubbles: true }))
    clickButtonContaining(presetEditor, language.agentPresets.createAgent)
    await tick()

    const agentEditor = target.querySelector<HTMLElement>('[data-risu-agent-editor]')!
    const agentName = agentEditor.querySelector<HTMLInputElement>('input[type="text"]')!
    agentName.value = createdAgent.name
    agentName.dispatchEvent(new Event('input', { bubbles: true }))
    clickButtonContaining(agentEditor, language.agentPresets.save)
    await flush()

    expect(target.querySelector('[data-risu-agent-editor]')).toBeNull()
    expect(target.querySelector<HTMLInputElement>('[data-risu-agent-preset-name-input] input')?.value).toBe(
      'Draft preserved',
    )
    const select = Array.from(presetEditor.querySelectorAll<HTMLLabelElement>('label'))
      .find((label) => label.textContent?.includes(language.agentPresets.selectAgent))
      ?.querySelector<HTMLSelectElement>('select')
    expect(select?.value).toBe(createdAgent.id)
    expect(document.activeElement?.textContent).toContain(language.agentPresets.createAnotherAgent)

    clickButtonContaining(presetEditor, language.agentPresets.addAgent)
    await flush()
    expect(agentSpies.addAgentToPreset).toHaveBeenCalledWith(
      emptyPreset.id,
      expect.objectContaining({ agentId: createdAgent.id }),
    )
  })

  it('refreshes the nested Agent picker when a queued create later reconciles', async () => {
    const emptyPreset = { ...preset, agentUses: [] }
    const createdAgent = { ...agent, id: 'ag_queued', name: 'Queued Critic' }
    agentSpies.createAgent.mockResolvedValueOnce({
      status: 'queued',
      result: { status: 'unavailable' },
      mutationId: 'mutation-agent-create',
    } as never)
    seed([], [emptyPreset])
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    const presetEditor = target.querySelector<HTMLElement>('[data-risu-agent-preset-editor]')!
    clickButtonContaining(presetEditor, language.agentPresets.createAgent)
    await tick()
    const agentEditor = target.querySelector<HTMLElement>('[data-risu-agent-editor]')!
    const name = agentEditor.querySelector<HTMLInputElement>('input[type="text"]')!
    name.value = createdAgent.name
    name.dispatchEvent(new Event('input', { bubbles: true }))
    clickButtonContaining(agentEditor, language.agentPresets.save)
    await flush()

    expect(presetEditor.querySelector('[data-risu-agent-created-notice]')?.textContent).toContain(
      language.agentPresets.commandQueued,
    )
    settingsResourceState.value.agents = [createdAgent]
    await tick()
    const select = Array.from(presetEditor.querySelectorAll<HTMLLabelElement>('label'))
      .find((label) => label.textContent?.includes(language.agentPresets.selectAgent))
      ?.querySelector<HTMLSelectElement>('select')
    expect(select?.value).toBe(createdAgent.id)
    expect(presetEditor.querySelector('[data-risu-agent-created-notice]')?.textContent).toContain(createdAgent.name)
  })

  it('keeps a newer Preset issue open when an older Save resolves', async () => {
    let resolveSave: ((value: { status: 'accepted'; result: { status: 'ok' } }) => void) | undefined
    presetSpies.updateAgentPreset.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        }),
    )
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    const editor = target.querySelector<HTMLElement>('[data-risu-agent-preset-editor]')!
    const description = editor.querySelector<HTMLTextAreaElement>('[data-risu-agent-preset-description-input]')!
    description.value = 'First submitted change'
    description.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    clickButtonContaining(editor, language.agentPresets.save)
    await flush()
    expect(presetSpies.updateAgentPreset).toHaveBeenCalled()
    expect(editor.querySelector('[data-risu-agent-preset-save-reason]')?.textContent).toContain(
      language.agentPresets.saveWaiting,
    )

    const name = editor.querySelector<HTMLInputElement>('[data-risu-agent-preset-name-input] input')!
    name.value = ''
    name.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    resolveSave?.({ status: 'accepted', result: { status: 'ok' } })
    await flush()

    expect(target.querySelector('[data-risu-agent-preset-editor]')).toBe(editor)
    expect(editor.querySelector('[data-risu-agent-preset-save-reason]')?.textContent).toContain(
      language.agentPresets.saveFixIssues(1),
    )
  })

  it('explains unchanged and invalid Preset Save states', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    const editor = target.querySelector<HTMLElement>('[data-risu-agent-preset-editor]')!
    expect(editor.querySelector('[data-risu-agent-preset-save-reason]')?.textContent).toContain(
      language.agentPresets.saveNoChanges,
    )
    const name = editor.querySelector<HTMLInputElement>('[data-risu-agent-preset-name-input] input')!
    name.value = ''
    name.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(editor.querySelector('[data-risu-agent-preset-save-reason]')?.textContent).toContain(
      language.agentPresets.saveFixIssues(1),
    )
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

  it('inserts final-output values at the caret and previews explicit samples locally', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    const composer = target.querySelector<HTMLElement>('[data-risu-agent-preset-final-output]')!
    const template = composer.querySelector<HTMLTextAreaElement>('textarea')!
    template.value = 'AB'
    template.dispatchEvent(new Event('input', { bubbles: true }))
    template.focus()
    template.setSelectionRange(1, 1)
    composer.querySelector<HTMLButtonElement>('[data-risu-agent-preset-insert-output="research"]')!.click()
    await tick()
    expect(template.value).toBe('A{{agent::research}}B')
    expect(template.selectionStart).toBe(20)

    const preview = composer.querySelector<HTMLDetailsElement>('[data-risu-agent-preset-final-output-preview]')!
    preview.open = true
    await tick()
    const sample = preview.querySelectorAll<HTMLInputElement>('input')[1]
    sample.value = 'Reviewed research'
    sample.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(preview.querySelector('[data-risu-agent-preset-final-output-preview-value]')?.textContent).toBe(
      'AReviewed researchB',
    )
    expect(preview.textContent).toContain(language.agentPresets.finalOutputPreviewDescription)
  })

  it('explains and repairs missing or disabled final-output references', async () => {
    seed([agent], [{ ...preset, finalOutputTemplate: '{{agent::missing}}' }])
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    let diagnostics = target.querySelector<HTMLElement>('[data-risu-agent-preset-final-output-diagnostics]')!
    expect(diagnostics.textContent).toContain(
      language.agentPresets.finalOutputReferenceMissing('{{agent::missing}}', 'missing'),
    )
    clickButtonContaining(diagnostics, language.agentPresets.removeReference)
    await tick()
    expect(target.querySelector('[data-risu-agent-preset-final-output-diagnostics]')).toBeNull()

    unmount(component!)
    component = undefined
    target.replaceChildren()
    seed(
      [agent],
      [
        {
          ...preset,
          finalOutputTemplate: '{{agent::research}}',
          agentUses: [{ ...preset.agentUses![0], enabled: false }],
        },
      ],
    )
    component = mount(AgentPresetSettings, { target })
    await tick()
    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    diagnostics = target.querySelector<HTMLElement>('[data-risu-agent-preset-final-output-diagnostics]')!
    expect(diagnostics.textContent).toContain(
      language.agentPresets.finalOutputReferenceDisabled('{{agent::research}}', 'research'),
    )
    clickButtonContaining(diagnostics, language.agentPresets.editProducer)
    await tick()
    expect(target.querySelector('[data-risu-agent-preset-use-form]')).not.toBeNull()
  })

  it('saves module IDs and namespaces as Agent Preset metadata', async () => {
    seed(
      [agent],
      [{ ...preset, moduleIntergration: 'old-space, old-space' }],
      [{ id: 'module-id', name: 'Research tools', namespace: 'research-tools' }],
    )
    component = mount(AgentPresetSettings, { target })
    await tick()

    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    const editor = target.querySelector('[data-risu-agent-preset-editor]')!
    const integration = editor.querySelector<HTMLInputElement>('#agent-preset-module-value')!
    expect(editor.querySelectorAll(`[aria-label="${language.agentPresets.moduleIntegrationLabel}"] > li`)).toHaveLength(
      1,
    )
    expect(editor.querySelector('[data-risu-agent-preset-module-warnings]')?.textContent).toContain('old-space')

    editor
      .querySelector<HTMLButtonElement>(`[aria-label="${language.agentPresets.removeModuleIntegration('old-space')}"]`)!
      .click()
    for (const value of ['research-tools', 'module-id', 'research-tools']) {
      integration.value = value
      integration.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
      clickButtonContaining(editor, language.agentPresets.addModuleIntegration)
    }
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
    expect(deleteButton.getAttribute('aria-label')).toContain(agent.name)
  })

  it('identifies every Preset blocking Agent deletion and opens the selected dependency', async () => {
    const secondPreset = {
      ...preset,
      id: 'ap_second',
      name: 'Second Preset',
      agentUses: [{ ...preset.agentUses![0], id: 'apu_second' }],
    }
    seed([agent], [preset, secondPreset])
    component = mount(AgentPresetSettings, { target })
    await tick()

    const dependencies = target.querySelector<HTMLDetailsElement>('[data-risu-agent-dependencies]')!
    expect(dependencies.textContent).toContain(language.agentPresets.usedByPresets(2))
    expect(dependencies.textContent).toContain(language.agentPresets.presetUseCount(preset.name, 1))
    expect(dependencies.textContent).toContain(language.agentPresets.presetUseCount(secondPreset.name, 1))
    dependencies.open = true
    await tick()
    clickButtonContaining(dependencies, language.agentPresets.openBlockingPreset(secondPreset.name))
    await tick()

    expect(target.querySelector<HTMLInputElement>('[data-risu-agent-preset-name-input] input')?.value).toBe(
      secondPreset.name,
    )
  })

  it('previews bounded Preset deletion impact and restores focus when cancelled', async () => {
    presetSpies.getAgentPresetDeleteImpact.mockReturnValue({
      status: 'ready',
      presetId: preset.id,
      presetName: preset.name,
      globalDefault: {
        affected: false,
        beforePresetId: 'ap_default',
        beforePresetName: 'Everyday',
        postDeleteSelection: { source: 'globalDefault', presetId: 'ap_default', presetName: 'Everyday' },
      },
      chats: Array.from({ length: 6 }, (_, index) => ({
        characterId: `character-${index}`,
        characterName: `Character ${index}`,
        chatId: `chat-${index}`,
        chatName: `Chat ${index}`,
        postDeleteSelection: { source: 'globalDefault' as const, presetId: 'ap_default', presetName: 'Everyday' },
      })),
      loadouts: [
        {
          loadoutId: 'loadout-a',
          loadoutName: 'Research setup',
          postDeleteSelection: { source: 'none' as const },
        },
      ],
    })
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    const trigger = target.querySelector<HTMLButtonElement>('[data-risu-agent-preset-delete] button')!
    trigger.click()
    await tick()
    const dialog = target.querySelector<HTMLElement>('[data-risu-agent-preset-delete-dialog]')!
    expect(dialog.textContent).toContain(preset.name)
    expect(dialog.textContent).toContain('Character 4 / Chat 4')
    expect(dialog.textContent).not.toContain('Character 5 / Chat 5')
    expect(dialog.textContent).toContain(language.agentPresets.deleteImpactMore(1))
    expect(dialog.textContent).toContain('Research setup')
    expect(dialog.textContent).toContain(language.agentPresets.deleteImpactFallbackGlobal('Everyday'))

    clickButtonContaining(dialog, language.agentPresets.cancel)
    await tick()
    expect(presetSpies.deleteAgentPreset).not.toHaveBeenCalled()
    expect(target.querySelector('[data-risu-agent-preset-delete-dialog]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('blocks Preset deletion until unavailable impact owners can be read', async () => {
    presetSpies.getAgentPresetDeleteImpact
      .mockReturnValueOnce({ status: 'unavailable', owner: 'characters', reason: 'loading' })
      .mockReturnValueOnce({
        status: 'ready',
        presetId: preset.id,
        presetName: preset.name,
        globalDefault: { affected: true, postDeleteSelection: { source: 'none' } },
        chats: [],
        loadouts: [],
      })
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelector<HTMLButtonElement>('[data-risu-agent-preset-delete] button')!.click()
    await tick()
    const dialog = target.querySelector<HTMLElement>('[data-risu-agent-preset-delete-dialog]')!
    expect(
      [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent?.includes(language.agentPresets.deletePermanently),
      )?.disabled,
    ).toBe(true)
    expect(dialog.textContent).toContain(language.agentPresets.deleteImpactOwnerChats)
    expect(presetSpies.deleteAgentPreset).not.toHaveBeenCalled()
    clickButtonContaining(dialog, language.agentPresets.deleteImpactRetry)
    await tick()
    expect(dialog.querySelector('[data-risu-agent-preset-delete-default]')).not.toBeNull()
  })

  it('announces accepted Preset cleanup counts only after server acceptance', async () => {
    presetSpies.deleteAgentPreset.mockResolvedValueOnce({
      status: 'accepted',
      result: { status: 'ok', clearedDefault: true, clearedChatCount: 2, clearedLoadoutCount: 1 },
    })
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelector<HTMLButtonElement>('[data-risu-agent-preset-delete] button')!.click()
    await tick()
    target
      .querySelector<HTMLButtonElement>(
        `button[aria-label="${language.agentPresets.confirmDeletePreset(preset.name)}"]`,
      )!
      .click()
    await flush()

    expect(presetSpies.deleteAgentPreset).toHaveBeenCalledWith(preset.id)
    expect(target.querySelector('[role="status"]')?.textContent).toContain(
      language.agentPresets.deleteAccepted(preset.name, true, 2, 1),
    )
  })

  it('labels a queued Preset deletion as pending sync rather than server success', async () => {
    presetSpies.deleteAgentPreset.mockResolvedValueOnce({
      status: 'queued',
      result: { status: 'unavailable', clearedDefault: false, clearedChatCount: 0, clearedLoadoutCount: 0 },
    } as never)
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelector<HTMLButtonElement>('[data-risu-agent-preset-delete] button')!.click()
    await tick()
    target
      .querySelector<HTMLButtonElement>(
        `button[aria-label="${language.agentPresets.confirmDeletePreset(preset.name)}"]`,
      )!
      .click()
    await flush()

    const status = target.querySelector('[role="status"]')?.textContent ?? ''
    expect(status).toContain(language.agentPresets.deleteQueued(preset.name))
    expect(status).not.toContain('Deleted')
  })

  it('requires another review when Preset deletion impact changes before submission', async () => {
    const originalImpact = {
      status: 'ready' as const,
      presetId: preset.id,
      presetName: preset.name,
      globalDefault: { affected: false, postDeleteSelection: { source: 'none' as const } },
      chats: [],
      loadouts: [],
    }
    presetSpies.getAgentPresetDeleteImpact.mockReturnValueOnce(originalImpact).mockReturnValueOnce({
      ...originalImpact,
      chats: [
        {
          characterId: 'character-new',
          characterName: 'New owner',
          chatId: 'chat-new',
          chatName: 'New chat',
          postDeleteSelection: { source: 'none' as const },
        },
      ],
    })
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelector<HTMLButtonElement>('[data-risu-agent-preset-delete] button')!.click()
    await tick()
    target
      .querySelector<HTMLButtonElement>(
        `button[aria-label="${language.agentPresets.confirmDeletePreset(preset.name)}"]`,
      )!
      .click()
    await tick()

    const dialog = target.querySelector<HTMLElement>('[data-risu-agent-preset-delete-dialog]')!
    expect(presetSpies.deleteAgentPreset).not.toHaveBeenCalled()
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(language.agentPresets.deleteImpactChanged)
    expect(dialog.textContent).toContain('New owner / New chat')
  })

  it('keeps a failed Preset deletion recoverable in the impact dialog', async () => {
    presetSpies.deleteAgentPreset.mockResolvedValueOnce({
      status: 'failed',
      result: { status: 'error', error: 'Server rejected deletion' },
    } as never)
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelector<HTMLButtonElement>('[data-risu-agent-preset-delete] button')!.click()
    await tick()
    target
      .querySelector<HTMLButtonElement>(
        `button[aria-label="${language.agentPresets.confirmDeletePreset(preset.name)}"]`,
      )!
      .click()
    await flush()

    expect(target.querySelector('[data-risu-agent-preset-delete-dialog]')).not.toBeNull()
    expect(target.querySelector('[data-risu-agent-preset-delete-dialog] [role="alert"]')?.textContent).toContain(
      'Server rejected deletion',
    )
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

  it('keeps Agent and Preset actions outside their scrolling drawer bodies', async () => {
    seed()
    component = mount(AgentPresetSettings, { target })
    await tick()

    target.querySelectorAll<HTMLButtonElement>('[data-risu-agent-row] button')[2].click()
    await tick()
    const agentDrawer = target.querySelector('[data-risu-agent-editor]')!
    const agentBody = agentDrawer.querySelector('[data-risu-agent-editor-scroll-body]')!
    const agentFooter = agentDrawer.querySelector('[data-risu-agent-editor-footer]')!
    expect(agentBody.contains(agentFooter)).toBe(false)
    expect(agentBody.parentElement).toBe(agentFooter.parentElement)

    agentDrawer.querySelector<HTMLButtonElement>('button')!.click()
    await tick()
    clickButtonContaining(target.querySelector('[data-risu-agent-preset-row]')!, language.agentPresets.edit)
    await tick()
    const presetDrawer = target.querySelector('[data-risu-agent-preset-editor]')!
    const presetBody = presetDrawer.querySelector('[data-risu-agent-preset-editor-scroll-body]')!
    const presetFooter = presetDrawer.querySelector('[data-risu-agent-preset-editor-footer]')!
    expect(presetBody.contains(presetFooter)).toBe(false)
    expect(presetBody.parentElement).toBe(presetFooter.parentElement)
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
