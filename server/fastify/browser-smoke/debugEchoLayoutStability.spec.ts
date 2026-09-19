import { expect, test, type Page } from '@playwright/test'
import {
  closeFastBootstrapHarness,
  startFastBootstrapHarness,
  type FastBootstrapHarness,
} from './fastBootstrapHarness.js'

const CHARACTER_ID = 'debug-echo-layout-character'
const CHAT_ID = 'debug-echo-layout-chat'
const PROFILE_ID = 'debug-echo-layout-profile'
const PERSONA_ID = 'debug-echo-layout-persona'
const MODEL_PRESET_ID = 'debug-echo-layout-model-preset'
const PROMPT_PRESET_ID = 'debug-echo-layout-prompt-preset'
const DEBUG_BASE_URL = 'debug://layout-stability-smoke'
const DEBUG_REQUEST_MODEL = 'layout-stability-model'
const SENT_MESSAGE = 'Measure the real delayed Debug Echo send.'
const EXPECTED_RESPONSE = SENT_MESSAGE

interface HorizontalRectSnapshot {
  left: number
  right: number
  width: number
}

interface ChatSendLayoutSample {
  at: number
  control: string | null
  controlInstance: number | null
  controlFocused: boolean
  controlOpacity: string | null
  composerRow: HorizontalRectSnapshot | null
  composer: HorizontalRectSnapshot | null
  projectedRow: HorizontalRectSnapshot | null
  projectedRowInstance: number | null
  projectedSurface: HorizontalRectSnapshot | null
  loading: HorizontalRectSnapshot | null
  loadingInstance: number | null
  loadingCompact: boolean
}

let harness: FastBootstrapHarness

test.beforeAll(async () => {
  harness = await startFastBootstrapHarness(debugEchoLayoutFixture(), {
    temporaryDirectoryPrefix: 'risu-debug-echo-layout-smoke-',
  })
})

test.afterAll(async () => {
  await closeFastBootstrapHarness(harness)
})

test('debug echo send stays visually stable through the first-token wait and foreground recovery', async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${harness.baseUrl}/character/${CHARACTER_ID}/${CHAT_ID}`)
  await waitForBrowserSmokeLoaded(page)
  await expect(page.locator('.default-chat-screen')).toBeVisible()
  await configureChatGeneration(page)

  const composer = page.getByTestId('default-chat-composer')
  const sendButton = page.getByTestId('default-chat-send-button')
  await expect(composer).toBeVisible()
  await composer.fill(SENT_MESSAGE)
  await waitForStableComposerGeometry(page)
  await startChatSendLayoutSampler(page)

  const sendStartedAt = Date.now()
  await sendButton.click()
  const projectedRow = page.locator('.chat-message-container[data-generation-display-projection="send"]')
  await expect(projectedRow).toHaveCount(1)
  await expect(projectedRow.locator('.chat-generation-loading')).toContainText('Waiting for first token…')

  let bootstrapRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/bootstrap') bootstrapRequests += 1
  })
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => bootstrapRequests).toBeGreaterThan(0)
  await expect(projectedRow.locator('.chat-generation-loading')).toContainText('Waiting for first token…')

  await expect.poll(() => latestResponseMatches(page), { timeout: 20_000 }).toBe(true)
  const responseReceivedAt = Date.now()
  const samples = await stopChatSendLayoutSampler(page)
  await testInfo.attach('debug-echo-layout-samples', {
    body: Buffer.from(JSON.stringify(samples, null, 2)),
    contentType: 'application/json',
  })

  const visibleMessages = page.locator('.chat-message-container')
  await expect(visibleMessages.filter({ hasText: SENT_MESSAGE })).toHaveCount(2)
  expect(responseReceivedAt - sendStartedAt).toBeGreaterThanOrEqual(9_500)
  expect(responseReceivedAt - sendStartedAt).toBeLessThan(20_000)

  const controls = new Set(samples.map((sample) => sample.control))
  for (const control of ['default-chat-send-button', 'default-chat-preparing-button', 'default-chat-cancel-button']) {
    expect(controls.has(control)).toBe(true)
  }

  const activeControlSamples = samples.filter(
    (sample) => sample.control !== null && sample.composerRow && sample.composer,
  )
  expect(new Set(activeControlSamples.map((sample) => sample.controlInstance).filter(Number.isFinite)).size).toBe(1)
  expect(activeControlSamples.every((sample) => sample.controlOpacity === '1')).toBe(true)
  expect(
    activeControlSamples
      .filter((sample) => sample.control !== 'default-chat-send-button')
      .every((sample) => sample.controlFocused),
  ).toBe(true)
  expect(horizontalSpread(activeControlSamples, (sample) => sample.composerRow?.left)).toBeLessThanOrEqual(1)
  expect(horizontalSpread(activeControlSamples, (sample) => sample.composerRow?.width)).toBeLessThanOrEqual(1)
  expect(horizontalSpread(activeControlSamples, (sample) => sample.composer?.left)).toBeLessThanOrEqual(1)
  expect(horizontalSpread(activeControlSamples, (sample) => sample.composer?.right)).toBeLessThanOrEqual(1)
  expect(horizontalSpread(activeControlSamples, (sample) => sample.composer?.width)).toBeLessThanOrEqual(1)

  const projectedSamples = samples.filter((sample) => sample.projectedRow && sample.projectedSurface && sample.loading)
  expect(projectedSamples.length).toBeGreaterThan(30)
  expect(new Set(projectedSamples.map((sample) => sample.projectedRowInstance).filter(Number.isFinite)).size).toBe(1)
  const fullLoadingSamples = projectedSamples.filter((sample) => !sample.loadingCompact)
  const compactLoadingSamples = projectedSamples.filter((sample) => sample.loadingCompact)
  expect(new Set(fullLoadingSamples.map((sample) => sample.loadingInstance).filter(Number.isFinite)).size).toBe(1)
  expect(
    new Set(compactLoadingSamples.map((sample) => sample.loadingInstance).filter(Number.isFinite)).size,
  ).toBeLessThanOrEqual(1)
  expect(horizontalSpread(projectedSamples, (sample) => sample.projectedRow?.left)).toBeLessThanOrEqual(1)
  expect(horizontalSpread(projectedSamples, (sample) => sample.projectedRow?.width)).toBeLessThanOrEqual(1)
  expect(horizontalSpread(projectedSamples, (sample) => sample.projectedSurface?.left)).toBeLessThanOrEqual(1)
  expect(horizontalSpread(projectedSamples, (sample) => sample.loading?.left)).toBeLessThanOrEqual(1)
  expect(horizontalSpread(projectedSamples, (sample) => sample.loading?.width)).toBeLessThanOrEqual(1)
})

function horizontalSpread(
  samples: ChatSendLayoutSample[],
  select: (sample: ChatSendLayoutSample) => number | undefined,
): number {
  const values = samples.map(select).filter((value): value is number => Number.isFinite(value))
  expect(values.length).toBeGreaterThan(0)
  return Math.max(...values) - Math.min(...values)
}

async function waitForStableComposerGeometry(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let previous: DOMRect | null = null
        let stableFrames = 0
        const sample = () => {
          const row = document.querySelector('[data-default-chat-composer-row]')
          const current = row?.getBoundingClientRect() ?? null
          if (
            current &&
            previous &&
            Math.abs(current.left - previous.left) <= 0.25 &&
            Math.abs(current.width - previous.width) <= 0.25
          ) {
            stableFrames += 1
          } else {
            stableFrames = 0
          }
          previous = current
          if (stableFrames >= 3) resolve()
          else requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }),
  )
}

async function waitForBrowserSmokeLoaded(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__?.isLoaded() ?? false), { timeout: 15_000 })
    .toBe(true)
}

async function configureChatGeneration(page: Page): Promise<void> {
  const result = await page.evaluate(async (chatId) => {
    const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
    const bootstrap = await fetch('/api/v1/bootstrap', { headers })
    const bootstrapBody = (await bootstrap.json()) as { revision?: unknown }
    let baseRevision = bootstrapBody.revision
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`/api/v1/commands/chats/${encodeURIComponent(chatId)}/generation-settings`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          baseRevision,
          generationSettings: {
            configured: true,
            personaId: 'debug-echo-layout-persona',
            modelPresetId: 'debug-echo-layout-model-preset',
            promptPresetId: 'debug-echo-layout-prompt-preset',
            jailbreakToggle: false,
            sidebarToggles: {},
          },
        }),
      })
      const body = (await response.json()) as { error?: unknown; currentRevision?: unknown }
      if (
        response.status !== 409 ||
        body.error !== 'revision_conflict' ||
        typeof body.currentRevision !== 'number' ||
        attempt === 4
      ) {
        return { status: response.status, body }
      }
      baseRevision = body.currentRevision
    }
    throw new Error('generation-settings revision retry loop exhausted')
  }, CHAT_ID)
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  await expect
    .poll(() =>
      page.evaluate((chatId) => {
        const database = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
        return database.characters.flatMap((character) => character.chats ?? []).find((chat) => chat.id === chatId)
          ?.generationSettings?.configured
      }, CHAT_ID),
    )
    .toBe(true)
}

async function latestResponseMatches(page: Page): Promise<boolean> {
  return page.evaluate(
    ({ chatId, expected }) => {
      const database = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
      const chat = database.characters
        .flatMap((character) => character.chats ?? [])
        .find((candidate) => candidate.id === chatId)
      const latest = (chat?.message ?? []).at(-1) as { role?: unknown; data?: unknown } | undefined
      return latest?.role === 'char' && latest.data === expected
    },
    { chatId: CHAT_ID, expected: EXPECTED_RESPONSE },
  )
}

async function startChatSendLayoutSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const elementIds = new WeakMap<Element, number>()
    let nextElementId = 0
    const elementId = (element: Element | null): number | null => {
      if (!element) return null
      const existing = elementIds.get(element)
      if (existing !== undefined) return existing
      const id = ++nextElementId
      elementIds.set(element, id)
      return id
    }
    const rect = (element: Element | null): HorizontalRectSnapshot | null => {
      if (!element) return null
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right, width: bounds.width }
    }
    const state: {
      samples: ChatSendLayoutSample[]
      stopped: boolean
      frame: number
      observer: MutationObserver | null
    } = {
      samples: [],
      stopped: false,
      frame: 0,
      observer: null,
    }
    const capture = () => {
      const control = document.querySelector<HTMLElement>(
        '[data-testid="default-chat-send-button"], [data-testid="default-chat-preparing-button"], [data-testid="default-chat-cancel-button"]',
      )
      const projectedRow = document.querySelector<HTMLElement>(
        '.chat-message-container[data-generation-display-projection="send"]',
      )
      const loading = projectedRow?.querySelector<HTMLElement>('.chat-generation-loading') ?? null
      state.samples.push({
        at: performance.now(),
        control: control?.dataset.testid ?? null,
        controlInstance: elementId(control),
        controlFocused: control === document.activeElement,
        controlOpacity: control ? getComputedStyle(control).opacity : null,
        composerRow: rect(document.querySelector('[data-default-chat-composer-row]')),
        composer: rect(document.querySelector('[data-testid="default-chat-composer"]')),
        projectedRow: rect(projectedRow),
        projectedRowInstance: elementId(projectedRow),
        projectedSurface: rect(projectedRow?.querySelector('.risu-chat') ?? null),
        loading: rect(loading),
        loadingInstance: elementId(loading),
        loadingCompact: loading?.classList.contains('chat-generation-loading-compact') ?? false,
      })
    }
    const sampleFrame = () => {
      capture()
      if (!state.stopped) state.frame = requestAnimationFrame(sampleFrame)
    }
    state.observer = new MutationObserver(capture)
    state.observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-generation-display-projection', 'data-testid', 'style'],
      childList: true,
      subtree: true,
    })
    capture()
    state.frame = requestAnimationFrame(sampleFrame)
    Reflect.set(window, '__RISU_CHAT_SEND_LAYOUT_SAMPLER__', state)
  })
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

async function stopChatSendLayoutSampler(page: Page): Promise<ChatSendLayoutSample[]> {
  return page.evaluate(() => {
    const state = Reflect.get(window, '__RISU_CHAT_SEND_LAYOUT_SAMPLER__') as
      | {
          samples: ChatSendLayoutSample[]
          stopped: boolean
          frame: number
          observer: MutationObserver | null
        }
      | undefined
    if (!state) return []
    state.stopped = true
    cancelAnimationFrame(state.frame)
    state.observer?.disconnect()
    Reflect.deleteProperty(window, '__RISU_CHAT_SEND_LAYOUT_SAMPLER__')
    return state.samples
  })
}

function debugEchoLayoutFixture(): Record<string, unknown> {
  return {
    version: 1,
    didFirstSetup: true,
    formatversion: 5,
    currentChar: 0,
    selectedCharID: 0,
    characterOrder: [CHARACTER_ID],
    characters: [
      {
        chaId: CHARACTER_ID,
        type: 'character',
        name: 'Debug Echo Layout Character',
        desc: 'A deterministic delayed-response browser-smoke character.',
        chats: [{ id: CHAT_ID, name: 'Debug Echo Layout Chat', note: '', localLore: [], message: [] }],
        chatPage: 0,
        customscript: [],
        firstMessage: '',
        globalLore: [],
        viewScreen: 'none',
        emotionImages: [],
      },
    ],
    botPresets: [],
    modelPresets: [{ id: MODEL_PRESET_ID, name: 'Debug Echo Layout Model Preset' }],
    promptPresets: [
      {
        id: PROMPT_PRESET_ID,
        name: 'Debug Echo Layout Prompt Preset',
        promptTemplate: [{ type: 'chat', rangeStart: 0, rangeEnd: 'end' }],
      },
    ],
    modelProfiles: [
      {
        id: PROFILE_ID,
        name: 'Debug Echo Layout Profile',
        providerId: 'debug-echo',
        modelId: 'debug-echo',
        providerOptions: { baseUrl: DEBUG_BASE_URL, requestModel: DEBUG_REQUEST_MODEL },
      },
    ],
    modelProfileOrder: [{ kind: 'profile', profileId: PROFILE_ID }],
    modelRoleProfiles: { chatMain: { mode: 'profile', profileId: PROFILE_ID } },
    modelRuntimeDefaults: {},
    providerCredentials: [],
    personas: [
      {
        id: PERSONA_ID,
        name: 'Debug Echo Layout User',
        icon: '',
        largePortrait: false,
        personaPrompt: '',
      },
    ],
    selectedPersona: 0,
    username: 'Debug Echo Layout User',
    loadouts: [],
    loreBook: [],
    modules: [],
    plugins: [],
    pluginCustomStorage: {},
    language: 'en',
    loreBookToken: 8000,
    mainPrompt: '',
    maxContext: 100_000,
    maxResponse: 100,
    fixedChatTextarea: true,
    useStreaming: true,
    requestRetrys: 0,
    applyAdditionalParamsToAll: true,
    additionalParams: [['delayMs', '10000']],
  }
}
