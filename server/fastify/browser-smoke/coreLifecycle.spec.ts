import { expect, test, type Locator, type Page } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { closeFastBootstrapHarness, startFastBootstrapHarness } from './fastBootstrapHarness.js'

const MESSAGE_CHARACTER_ID = 'lifecycle-message-character'
const MESSAGE_CHAT_ID = 'lifecycle-message-chat'
const MESSAGE_IDS = ['lifecycle-message-first', 'lifecycle-message-middle', 'lifecycle-message-last'] as const
const EDITED_MIDDLE_TEXT = 'MIDDLE message edited through the mobile UI'
const COMPOSER_SENTINEL = 'Mobile composer remains usable after edit and delete'

test.describe('mobile message lifecycle', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test(
    'mobile message edit and delete persist by exact id while the composer remains usable',
    { tag: '@core' },
    async ({ page }) => {
      test.setTimeout(55_000)
      const harness = await startFastBootstrapHarness(messageLifecycleFixture(), {
        temporaryDirectoryPrefix: 'risu-core-message-lifecycle-',
      })
      try {
        await openChat(page, harness.baseUrl, MESSAGE_CHARACTER_ID, MESSAGE_CHAT_ID)
        await expectMessageTexts(page, [
          [MESSAGE_IDS[0], 'FIRST neighbour remains unchanged'],
          [MESSAGE_IDS[1], 'MIDDLE message before edit'],
          [MESSAGE_IDS[2], 'LAST neighbour remains unchanged'],
        ])

        const middle = messageRow(page, MESSAGE_IDS[1])
        await openMessageAction(middle, page, 'Edit')
        const editor = page.getByRole('dialog').getByRole('textbox', { name: 'Plain text editor' })
        await expect(editor).toBeVisible()
        await editor.fill(EDITED_MIDDLE_TEXT)
        await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()

        await expect
          .poll(() => persistedMessages(harness.dataDir, MESSAGE_CHAT_ID), {
            message: 'the exact middle message id must carry the edited text',
          })
          .toEqual([
            { id: MESSAGE_IDS[0], data: 'FIRST neighbour remains unchanged' },
            { id: MESSAGE_IDS[1], data: EDITED_MIDDLE_TEXT },
            { id: MESSAGE_IDS[2], data: 'LAST neighbour remains unchanged' },
          ])

        await page.reload()
        await waitForLoaded(page)
        await expectMessageTexts(page, [
          [MESSAGE_IDS[0], 'FIRST neighbour remains unchanged'],
          [MESSAGE_IDS[1], EDITED_MIDDLE_TEXT],
          [MESSAGE_IDS[2], 'LAST neighbour remains unchanged'],
        ])

        await openMessageAction(messageRow(page, MESSAGE_IDS[1]), page, 'Remove')
        await expect
          .poll(() => persistedMessages(harness.dataDir, MESSAGE_CHAT_ID), {
            message: 'message DELETE must remove the targeted id and preserve ordered neighbours',
          })
          .toEqual([
            { id: MESSAGE_IDS[0], data: 'FIRST neighbour remains unchanged' },
            { id: MESSAGE_IDS[2], data: 'LAST neighbour remains unchanged' },
          ])

        await page.reload()
        await waitForLoaded(page)
        await expect(messageRow(page, MESSAGE_IDS[1])).toHaveCount(0)
        await expectMessageTexts(page, [
          [MESSAGE_IDS[0], 'FIRST neighbour remains unchanged'],
          [MESSAGE_IDS[2], 'LAST neighbour remains unchanged'],
        ])

        await configureChatGeneration(page, MESSAGE_CHAT_ID)
        await page.getByTestId('default-chat-composer').fill(COMPOSER_SENTINEL)
        await page.getByTestId('default-chat-send-button').click()
        await expect(
          page.locator('.default-chat-screen .risu-chat').filter({ hasText: COMPOSER_SENTINEL }),
        ).toBeVisible()
        await expect
          .poll(() =>
            persistedMessages(harness.dataDir, MESSAGE_CHAT_ID).some((message) => message.data === COMPOSER_SENTINEL),
          )
          .toBe(true)
      } finally {
        await page.context().close()
        await closeFastBootstrapHarness(harness)
      }
    },
  )
})

test(
  'chat create and delete stay scoped to character A while character B moves to trash',
  { tag: '@core' },
  async ({ page }) => {
    test.setTimeout(55_000)
    const harness = await startFastBootstrapHarness(characterLifecycleFixture(), {
      temporaryDirectoryPrefix: 'risu-core-character-lifecycle-',
    })
    try {
      await openChat(page, harness.baseUrl, 'lifecycle-character-a', 'lifecycle-chat-a-keep')

      await showChatList(page)
      await page.locator('[data-risu-chat-action="create"]').click()
      await expect(page.locator('[data-risu-chat-id]').filter({ hasText: 'New Chat 3' })).toBeVisible()
      await expect
        .poll(() => chatsForCharacters(harness.dataDir), {
          message: 'the new chat must be a new row owned only by character A',
        })
        .toEqual({
          'lifecycle-character-a': [
            { id: expect.any(String), name: 'New Chat 3' },
            { id: 'lifecycle-chat-a-keep', name: 'A Keep Chat' },
            { id: 'lifecycle-chat-a-delete', name: 'A Delete Chat' },
          ],
          'lifecycle-character-b': [
            { id: 'lifecycle-chat-b-one', name: 'B First Chat' },
            { id: 'lifecycle-chat-b-two', name: 'B Second Chat' },
          ],
        })
      await expect(page).toHaveURL(/\/character\/lifecycle-character-a\/[^/]+$/)
      await showChatList(page)
      const aDeleteRow = page.locator('[data-risu-chat-id="lifecycle-chat-a-delete"]')
      await aDeleteRow.locator('[data-risu-chat-action="more-actions"]').click()
      await page.locator('#risu-popup-menu [data-risu-chat-menu-action="delete"]').click()
      await confirmYes(page)

      await expect
        .poll(() => chatsForCharacters(harness.dataDir), {
          message: 'chat DELETE must remove only the requested A chat row',
        })
        .toEqual({
          'lifecycle-character-a': [
            { id: expect.any(String), name: 'New Chat 3' },
            { id: 'lifecycle-chat-a-keep', name: 'A Keep Chat' },
          ],
          'lifecycle-character-b': [
            { id: 'lifecycle-chat-b-one', name: 'B First Chat' },
            { id: 'lifecycle-chat-b-two', name: 'B Second Chat' },
          ],
        })
      await page.reload()
      await waitForLoaded(page)
      await showChatList(page)
      await expect(page.locator('[data-risu-chat-id="lifecycle-chat-a-delete"]')).toHaveCount(0)
      await expect(page.locator('[data-risu-chat-id="lifecycle-chat-a-keep"]')).toBeVisible()

      await page.locator('[data-char-id="lifecycle-character-b"]').click()
      await expect(page).toHaveURL(/\/character\/lifecycle-character-b/)
      await page.locator('[data-risu-sidebar-tab="character"]').click()
      await expect(page.locator('[data-risu-sidebar-panel="character"]')).toBeVisible()
      await page.locator('[data-char-config-section="manage"]').click()
      await page.getByRole('button', { name: 'Remove Character', exact: true }).click()
      await confirmYes(page)
      await confirmYes(page)

      await expect
        .poll(() => persistedCharacters(harness.dataDir), {
          message: 'soft deletion must mark character B only',
        })
        .toEqual([
          { id: 'lifecycle-character-a', trashTime: null },
          { id: 'lifecycle-character-b', trashTime: expect.any(Number) },
        ])
      expect(chatsForCharacters(harness.dataDir)).toEqual({
        'lifecycle-character-a': [
          { id: expect.any(String), name: 'New Chat 3' },
          { id: 'lifecycle-chat-a-keep', name: 'A Keep Chat' },
        ],
        'lifecycle-character-b': [
          { id: 'lifecycle-chat-b-one', name: 'B First Chat' },
          { id: 'lifecycle-chat-b-two', name: 'B Second Chat' },
        ],
      })

      await page.reload()
      await waitForLoaded(page)
      await expect(page.locator('[data-char-id="lifecycle-character-b"]')).toHaveCount(0)
      await expect(page.locator('[data-char-id="lifecycle-character-a"]')).toBeVisible()
    } finally {
      await page.context().close()
      await closeFastBootstrapHarness(harness)
    }
  },
)

test(
  'v2 chat import re-keys colliding chat and message ids without changing the existing chat',
  { tag: '@core' },
  async ({ page }) => {
    test.setTimeout(55_000)
    const harness = await startFastBootstrapHarness(chatImportFixture(), {
      temporaryDirectoryPrefix: 'risu-core-chat-import-',
    })
    try {
      const before = rawPersistedChat(harness.dataDir, 'lifecycle-import-collision')
      await openChat(page, harness.baseUrl, 'lifecycle-import-character', 'lifecycle-import-collision')
      await showChatList(page)

      const importFile = {
        type: 'risuChat',
        ver: 2,
        data: {
          id: 'lifecycle-import-collision',
          name: 'Imported Collision Copy',
          note: 'Imported note must remain separate',
          localLore: [],
          fmIndex: -1,
          message: [
            {
              role: 'user',
              data: 'IMPORTED user text with a colliding id',
              chatId: 'lifecycle-import-message-user',
            },
            {
              role: 'char',
              data: 'IMPORTED character text with a colliding id',
              chatId: 'lifecycle-import-message-char',
            },
          ],
        },
      }
      const chooserPromise = page.waitForEvent('filechooser')
      await page.locator('[data-risu-chat-action="import"]').click()
      const chooser = await chooserPromise
      await chooser.setFiles({
        name: 'colliding-chat.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(importFile)),
      })

      await expect
        .poll(() => importedChatState(harness.dataDir), {
          message: 'the imported chat and every imported message must receive fresh ids',
        })
        .toMatchObject({
          chatId: expect.not.stringMatching(/^lifecycle-import-collision$/),
          messageIds: [
            expect.not.stringMatching(/^lifecycle-import-message-user$/),
            expect.not.stringMatching(/^lifecycle-import-message-char$/),
          ],
          messageTexts: ['IMPORTED user text with a colliding id', 'IMPORTED character text with a colliding id'],
        })
      expect(rawPersistedChat(harness.dataDir, 'lifecycle-import-collision')).toEqual(before)
      await page.getByRole('button', { name: 'OK', exact: true }).click()

      await page.reload()
      await waitForLoaded(page)
      await showChatList(page)
      const existingRow = page.locator('[data-risu-chat-id="lifecycle-import-collision"]')
      const importedRow = page.locator('[data-risu-chat-id]').filter({ hasText: 'Imported Collision Copy' })
      await expect(existingRow).toBeVisible()
      await expect(importedRow).toBeVisible()

      await importedRow.locator('[data-risu-chat-action="select"]').click()
      await expect(page.locator('.default-chat-screen')).toContainText('IMPORTED user text with a colliding id')
      await expect(page.locator('.default-chat-screen')).toContainText('IMPORTED character text with a colliding id')
      await showChatList(page)
      await page
        .locator('[data-risu-chat-id="lifecycle-import-collision"]')
        .locator('[data-risu-chat-action="select"]')
        .click()
      await expect(page.locator('.default-chat-screen')).toContainText('EXISTING user bytes stay unchanged')
      await expect(page.locator('.default-chat-screen')).toContainText('EXISTING character bytes stay unchanged')
      expect(rawPersistedChat(harness.dataDir, 'lifecycle-import-collision')).toEqual(before)
    } finally {
      await page.context().close()
      await closeFastBootstrapHarness(harness)
    }
  },
)

async function waitForLoaded(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__?.isLoaded() ?? false), { timeout: 15_000 })
    .toBe(true)
}

async function openChat(page: Page, baseUrl: string, characterId: string, chatId: string): Promise<void> {
  await page.goto(`${baseUrl}/character/${characterId}/${chatId}`)
  await waitForLoaded(page)
  await expect(page.locator('.default-chat-screen')).toBeVisible({ timeout: 15_000 })
}

async function showChatList(page: Page): Promise<void> {
  const create = page.locator('[data-risu-chat-action="create"]')
  const back = page.locator('[data-risu-chat-action="back-to-chat-list"]').first()
  await expect.poll(async () => (await create.isVisible()) || (await back.isVisible())).toBe(true)
  if (await back.isVisible()) await back.click()
  await expect(create).toBeVisible()
}

function messageRow(page: Page, messageId: string): Locator {
  return page.locator(`.default-chat-screen .risu-chat[data-risu-message-id="${messageId}"]`)
}

async function expectMessageTexts(page: Page, expected: Array<readonly [string, string]>): Promise<void> {
  for (const [id, text] of expected)
    await expect(messageRow(page, id).locator('.chat-message-body')).toContainText(text)
}

async function openMessageAction(row: Locator, page: Page, action: 'Edit' | 'Remove'): Promise<void> {
  if (action !== 'Remove') {
    await row.getByRole('button', { name: action, exact: true }).click()
    return
  }
  await row.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.locator('#risu-popup-menu').getByRole('menuitem', { name: action, exact: true }).click()
}

async function confirmYes(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'YES', exact: true }).click()
}

async function configureChatGeneration(page: Page, chatId: string): Promise<void> {
  const result = await page.evaluate(async (targetChatId) => {
    const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
    const bootstrap = await fetch('/api/v1/bootstrap', { headers })
    const { revision } = (await bootstrap.json()) as { revision: number }
    const response = await fetch(`/api/v1/commands/chats/${encodeURIComponent(targetChatId)}/generation-settings`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: revision,
        generationSettings: {
          configured: true,
          personaId: 'lifecycle-persona',
          modelPresetId: 'lifecycle-model-preset',
          promptPresetId: 'lifecycle-prompt-preset',
          jailbreakToggle: false,
          sidebarToggles: {},
        },
      }),
    })
    return { status: response.status, body: await response.json() }
  }, chatId)
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  await expect
    .poll(() =>
      page.evaluate((targetChatId) => {
        const snapshot = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
        return snapshot.characters
          ?.flatMap((character) => character.chats ?? [])
          .find((chat) => chat.id === targetChatId)?.generationSettings?.configured
      }, chatId),
    )
    .toBe(true)
}

function persistedMessages(dataDir: string, chatId: string): Array<{ id: string; data: string }> {
  const database = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    return database
      .prepare('SELECT uid AS id, data FROM messages WHERE chat_id = ? AND alternate = 0 ORDER BY seq')
      .all(chatId) as Array<{ id: string; data: string }>
  } finally {
    database.close()
  }
}

function chatsForCharacters(dataDir: string): Record<string, Array<{ id: string; name: string }>> {
  const database = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    const rows = database
      .prepare(
        'SELECT id, character_id AS characterId, data_json AS dataJson FROM chats ORDER BY character_id, position',
      )
      .all() as Array<{ id: string; characterId: string; dataJson: string }>
    const grouped: Record<string, Array<{ id: string; name: string }>> = {}
    for (const row of rows) {
      const data = JSON.parse(row.dataJson) as { name?: unknown }
      grouped[row.characterId] ??= []
      grouped[row.characterId].push({ id: row.id, name: typeof data.name === 'string' ? data.name : '' })
    }
    return grouped
  } finally {
    database.close()
  }
}

function persistedCharacters(dataDir: string): Array<{ id: string; trashTime: number | null }> {
  const database = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    const rows = database.prepare('SELECT id, data_json AS dataJson FROM characters ORDER BY position').all() as Array<{
      id: string
      dataJson: string
    }>
    return rows.map((row) => {
      const data = JSON.parse(row.dataJson) as { trashTime?: unknown }
      return { id: row.id, trashTime: typeof data.trashTime === 'number' ? data.trashTime : null }
    })
  } finally {
    database.close()
  }
}

function rawPersistedChat(dataDir: string, chatId: string): { chat: string; messages: string[] } {
  const database = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    const chat = database.prepare('SELECT data_json AS dataJson FROM chats WHERE id = ?').get(chatId) as
      | { dataJson: string }
      | undefined
    const messages = database
      .prepare('SELECT json FROM messages WHERE chat_id = ? AND alternate = 0 ORDER BY seq')
      .all(chatId) as Array<{ json: string }>
    return { chat: chat?.dataJson ?? '', messages: messages.map((message) => message.json) }
  } finally {
    database.close()
  }
}

function importedChatState(dataDir: string): { chatId: string; messageIds: string[]; messageTexts: string[] } | null {
  const database = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    const chat = database
      .prepare("SELECT id FROM chats WHERE json_extract(data_json, '$.name') = 'Imported Collision Copy'")
      .get() as { id: string } | undefined
    if (!chat) return null
    const messages = database
      .prepare('SELECT uid, data FROM messages WHERE chat_id = ? AND alternate = 0 ORDER BY seq')
      .all(chat.id) as Array<{ uid: string; data: string }>
    return {
      chatId: chat.id,
      messageIds: messages.map((message) => message.uid),
      messageTexts: messages.map((message) => message.data),
    }
  } finally {
    database.close()
  }
}

function messageLifecycleFixture(): Record<string, unknown> {
  return baseFixture([
    character(MESSAGE_CHARACTER_ID, 'Message Lifecycle Character', [
      chat(
        MESSAGE_CHAT_ID,
        'Message Lifecycle Chat',
        [
          message(MESSAGE_IDS[0], 'user', 'FIRST neighbour remains unchanged'),
          message(MESSAGE_IDS[1], 'char', 'MIDDLE message before edit'),
          message(MESSAGE_IDS[2], 'user', 'LAST neighbour remains unchanged'),
        ],
        true,
      ),
    ]),
  ])
}

function characterLifecycleFixture(): Record<string, unknown> {
  return baseFixture([
    character('lifecycle-character-a', 'Lifecycle Character A', [
      chat('lifecycle-chat-a-keep', 'A Keep Chat'),
      chat('lifecycle-chat-a-delete', 'A Delete Chat'),
    ]),
    character('lifecycle-character-b', 'Lifecycle Character B', [
      chat('lifecycle-chat-b-one', 'B First Chat'),
      chat('lifecycle-chat-b-two', 'B Second Chat'),
    ]),
  ])
}

function chatImportFixture(): Record<string, unknown> {
  return baseFixture([
    character('lifecycle-import-character', 'Lifecycle Import Character', [
      chat('lifecycle-import-collision', 'Existing Collision Chat', [
        message('lifecycle-import-message-user', 'user', 'EXISTING user bytes stay unchanged'),
        message('lifecycle-import-message-char', 'char', 'EXISTING character bytes stay unchanged'),
      ]),
    ]),
  ])
}

function baseFixture(characters: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    version: 1,
    didFirstSetup: true,
    formatversion: 5,
    currentChar: 0,
    selectedCharID: 0,
    characterOrder: characters.map((entry) => entry.chaId),
    characters,
    formatingOrder: ['main', 'description', 'chats'],
    promptSettings: {
      assistantPrefill: '',
      postEndInnerFormat: '',
      sendChatAsSystem: false,
      sendName: false,
      utilOverride: false,
    },
    modelPresets: [{ id: 'lifecycle-model-preset', name: 'Lifecycle Model Preset' }],
    promptPresets: [{ id: 'lifecycle-prompt-preset', name: 'Lifecycle Prompt Preset', promptTemplate: [] }],
    loadouts: [],
    modules: [],
    username: 'Lifecycle User',
    selectedPersona: 0,
    personas: [
      {
        id: 'lifecycle-persona',
        name: 'Lifecycle User',
        icon: '',
        largePortrait: false,
        personaPrompt: '',
      },
    ],
    plugins: [],
    pluginCustomStorage: {},
    botPresets: [],
    language: 'en',
    loreBookToken: 8000,
    mainPrompt: 'LIFECYCLE MAIN PROMPT',
    maxContext: 100_000,
    maxResponse: 100,
    aiModel: 'echo_model',
    useStreaming: true,
    removeIncompleteResponse: false,
    useSayNothing: false,
    requestRetrys: 0,
    echoMessage: 'Lifecycle echo reply',
    echoDelay: 0,
    fixedChatTextarea: true,
    askRemoval: false,
    instantRemove: false,
    autoAcquireDisconnectedWriter: false,
  }
}

function character(id: string, name: string, chats: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    chaId: id,
    type: 'character',
    name,
    desc: `${name} distinctive description`,
    chats,
    chatFolders: [],
    chatPage: 0,
    customscript: [],
    firstMessage: '',
    globalLore: [],
    viewScreen: 'none',
    emotionImages: [],
  }
}

function chat(
  id: string,
  name: string,
  messages: Array<Record<string, unknown>> = [],
  configured = false,
): Record<string, unknown> {
  return {
    id,
    name,
    note: '',
    localLore: [],
    message: messages,
    ...(configured
      ? {
          generationSettings: {
            configured: true,
            personaId: 'lifecycle-persona',
            modelPresetId: 'lifecycle-model-preset',
            promptPresetId: 'lifecycle-prompt-preset',
            jailbreakToggle: false,
            sidebarToggles: {},
          },
        }
      : {}),
  }
}

function message(id: string, role: 'user' | 'char', data: string): Record<string, unknown> {
  return { chatId: id, role, data }
}
