// DOM-first toggle coverage: assert grouped controls paint structurally and
// sidebar/jailbreak checkboxes flip optimistically.
// The settle half (flip survives command + refreeze) is the Tier-2 journey in
// server/fastify/browser-smoke/visibleStateRecovery.spec.ts.
//
// Family: optimistic paint/rollback (taxonomy §5). Tier 1.
//
// Drive: mount the real Toggles.svelte, click the real jailbreak checkbox while
// the save command is still in flight (deferred fetch), and assert the rendered
// `data-risu-selected` flips immediately — the optimistic paint must not wait
// for the server. Classify against resource state only after a DOM check.

import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('src/ts/storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'phase0-toggle-paint-token',
}))

vi.mock('src/ts/process/modules', () => ({
  exportModule: vi.fn(),
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleMcps: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModuleToggles: vi.fn(() => ''),
  getModuleTriggers: vi.fn(() => []),
  getModules: vi.fn(() => []),
  importModule: vi.fn(),
  moduleUpdate: vi.fn(),
  readModule: vi.fn(),
  refreshModules: vi.fn(),
}))

vi.mock('src/ts/process/scripts', () => ({ resetScriptCache: vi.fn() }))
vi.mock('src/ts/characterCommands', () => ({ setCharacterSupaMemory: vi.fn() }))
vi.mock('src/ts/setting/utils', () => ({ getFullSettingsData: () => [] }))

import Toggles from '../SideBars/Toggles.svelte'
import { selectedCharID } from 'src/ts/stores.svelte'
import { replaceResourceDatabase } from 'src/ts/server/resourceState.svelte'
import { resolveActiveChatGenerationSettings } from 'src/ts/activeChatGenerationSettings'
import { clearCachedServerCommandRevision } from 'src/ts/server/commands'
import { waitForPendingChatGenerationSettingsSave } from 'src/ts/chatCommands'
import { readJailbreakSelected, readToggleGroupLabels, readToggleSelected } from './domStateOracle'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

interface CapturedCommandRequest {
  url: string
  method: string
  body: unknown
}

interface DeferredCommandTransport {
  calls: CapturedCommandRequest[]
  invoked: Promise<void>
  release: () => void
}

let target: HTMLElement
let component: MountedComponent | undefined
let activeCommandTransport: DeferredCommandTransport | undefined

const GROUP_TEMPLATE = '=Preset Group=group\nmood=Mood=select=Calm,Spicy\nflag=Flag\n==groupend\nnote=Note=text'

// Hold the save response until the optimistic assertions have run, then let
// the test deliberately fail the command and drain its fire-and-forget queue.
function stubDeferredCommandFetch(): DeferredCommandTransport {
  let resolveCommand!: (response: Response) => void
  const commandResponse = new Promise<Response>((resolve) => {
    resolveCommand = resolve
  })
  let markInvoked!: () => void
  const invoked = new Promise<void>((resolve) => {
    markInvoked = resolve
  })
  const calls: CapturedCommandRequest[] = []
  let invokedMarked = false
  let released = false

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      if (url === '/api/v1/bootstrap') {
        return jsonResponse({ revision: 400 })
      }
      if (url === '/api/v1/commands/chats/chat-a/generation-settings') {
        calls.push({
          url,
          method: init.method ?? 'GET',
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        if (!invokedMarked) {
          invokedMarked = true
          markInvoked()
        }
        return commandResponse
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )

  activeCommandTransport = {
    calls,
    invoked,
    release: () => {
      if (released) return
      released = true
      resolveCommand(jsonResponse({ error: 'deferred optimistic-paint test release' }, 503))
    },
  }
  return activeCommandTransport
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function releaseAndDrainCommandTransport(): Promise<void> {
  const transport = activeCommandTransport
  if (!transport) return
  transport.release()
  await waitForPendingChatGenerationSettingsSave('chat-a')
  if (activeCommandTransport === transport) activeCommandTransport = undefined
}

function seedOptimisticDb(): void {
  selectedCharID.set(0)
  replaceResourceDatabase({
    currentChar: 0,
    username: 'User',
    selectedPersona: 0,
    selectedPersonaId: 'persona-a',
    personaPrompt: '',
    userIcon: '',
    userNote: '',
    botPresetsId: 0,
    modelPresetsId: 0,
    promptPresetsId: 0,
    jailbreakToggle: true,
    customPromptTemplateToggle: '',
    customSidebarItems: [],
    hypaV3: false,
    personas: [{ id: 'persona-a', name: 'Persona A', personaPrompt: '', icon: '', note: '' }],
    botPresets: [],
    modelPresets: [
      {
        id: 'model-a',
        name: 'Model A',
      },
    ],
    promptPresets: [
      {
        id: 'prompt-a',
        name: 'Prompt A',
        jailbreak: 'Jailbreak',
        customPromptTemplateToggle: 'flag=Flag',
      },
    ],
    modules: [],
    enabledModules: [],
    characters: [
      {
        chaId: 'char-a',
        name: 'Character A',
        chatPage: 0,
        chats: [
          {
            id: 'chat-a',
            name: 'Chat A',
            note: '',
            message: [],
            localLore: [],
            generationSettings: {
              configured: true,
              personaId: 'persona-a',
              modelPresetId: 'model-a',
              promptPresetId: 'prompt-a',
              jailbreakToggle: true,
              sidebarToggles: { flag: '1' },
            },
          },
        ],
      },
    ],
  } as never)
}

function seedGroupedDb(): void {
  replaceResourceDatabase({
    currentChar: 0,
    username: 'User',
    selectedPersona: 0,
    selectedPersonaId: 'persona-a',
    personaPrompt: '',
    userIcon: '',
    userNote: '',
    botPresetsId: 0,
    modelPresetsId: 0,
    promptPresetsId: 0,
    jailbreakToggle: false,
    customPromptTemplateToggle: '',
    customSidebarItems: [],
    hypaV3: false,
    personas: [{ id: 'persona-a', name: 'Persona A', personaPrompt: '', icon: '', note: '' }],
    botPresets: [],
    modelPresets: [{ id: 'model-a', name: 'Model A' }],
    promptPresets: [
      {
        id: 'prompt-a',
        name: 'Prompt A',
        jailbreak: '',
        customPromptTemplateToggle: GROUP_TEMPLATE,
      },
    ],
    modules: [],
    enabledModules: [],
    characters: [
      {
        chaId: 'char-a',
        name: 'Character A',
        chatPage: 0,
        chats: [
          {
            id: 'chat-a',
            name: 'Chat A',
            note: '',
            message: [],
            localLore: [],
            generationSettings: {
              configured: true,
              personaId: 'persona-a',
              modelPresetId: 'model-a',
              promptPresetId: 'prompt-a',
              jailbreakToggle: false,
              sidebarToggles: { mood: '1', flag: '1', note: 'n' },
            },
          },
        ],
      },
    ],
  } as never)
}

function storeGroupLabels(): string[] {
  return resolveActiveChatGenerationSettings()
    .displayedSidebarToggles.filter((toggle) => toggle.kind === 'group')
    .map((toggle) => toggle.label)
}

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  clearCachedServerCommandRevision()
  seedOptimisticDb()
})

afterEach(async () => {
  // Keep the stub installed and the resource projection intact until every
  // queued command has settled, including when a test assertion throws.
  await releaseAndDrainCommandTransport()
  if (component) {
    await unmount(component)
    component = undefined
  }
  target.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  selectedCharID.set(-1)
  replaceResourceDatabase({} as never)
})

describe('optimistic toggle paint (DOM oracle)', () => {
  it('flips the rendered jailbreak checkbox immediately, before the save resolves', async () => {
    const transport = stubDeferredCommandFetch()
    component = mount(Toggles, {
      target,
      props: { chara: getResourceDatabase().characters[0], noContainer: true },
    })
    await tick()

    expect(readJailbreakSelected(target)).toBe(true)

    const checkbox = target.querySelector<HTMLInputElement>(
      '[data-risu-generation-jailbreak-control] input[type="checkbox"]',
    )
    expect(checkbox, 'jailbreak checkbox').toBeTruthy()
    checkbox!.click()
    await tick()

    // DOM oracle: the painted checkbox must already be off, with the command
    // still pending (no server confirmation yet).
    const domSelected = readJailbreakSelected(target)
    expect(domSelected).toBe(false)
    await transport.invoked
    expect(transport.calls).toEqual([
      {
        url: '/api/v1/commands/chats/chat-a/generation-settings',
        method: 'PUT',
        body: expect.objectContaining({
          baseRevision: 400,
          patch: { jailbreakToggle: false },
        }),
      },
    ])

    const storeSelected = resolveActiveChatGenerationSettings().settings?.jailbreakToggle
    expect(storeSelected).toBe(false)

    await releaseAndDrainCommandTransport()
  })

  it('flips a rendered sidebar checkbox toggle immediately on click', async () => {
    const transport = stubDeferredCommandFetch()
    component = mount(Toggles, {
      target,
      props: { chara: getResourceDatabase().characters[0], noContainer: true },
    })
    await tick()

    expect(readToggleSelected(target, 'flag')).toBe(true)

    const flagCheckbox = target.querySelector<HTMLInputElement>(
      '[data-risu-generation-toggle-control][data-risu-toggle-key="flag"] input[type="checkbox"]',
    )
    expect(flagCheckbox, 'flag checkbox').toBeTruthy()
    flagCheckbox!.click()
    await tick()

    const domSelected = readToggleSelected(target, 'flag')
    expect(domSelected).toBe(false)
    await transport.invoked
    expect(transport.calls).toEqual([
      {
        url: '/api/v1/commands/chats/chat-a/generation-settings',
        method: 'PUT',
        body: expect.objectContaining({
          baseRevision: 400,
          patch: { sidebarToggles: { flag: '0' } },
        }),
      },
    ])
    const storeValue = resolveActiveChatGenerationSettings().settings?.sidebarToggles?.flag
    expect(storeValue).toBe('0')

    await releaseAndDrainCommandTransport()
  })
})

describe('grouped toggle rendering (DOM oracle)', () => {
  it('paints the preset toggle group as an accordion container in the DOM', async () => {
    seedGroupedDb()
    component = mount(Toggles, {
      target,
      props: { chara: getResourceDatabase().characters[0], noContainer: true },
    })
    await tick()

    const domGroupLabels = readToggleGroupLabels(target)
    expect(domGroupLabels).toEqual(['Preset Group'])
    expect(storeGroupLabels()).toEqual(['Preset Group'])

    const group = target.querySelector<HTMLElement>(
      '[data-risu-generation-toggle-group][data-risu-toggle-label="Preset Group"]',
    )
    expect(group, 'preset toggle group container').toBeTruthy()
  })
})
