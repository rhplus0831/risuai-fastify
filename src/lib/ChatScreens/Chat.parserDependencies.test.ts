import {
  setupChatTests,
  chatMocks,
  component,
  target,
  makeRows,
  seedDatabase,
  settle,
  mountHarness,
} from './Chat.testSupport'
import { describe, expect, it } from 'vitest'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'
import { ReloadChatPointer, ReloadGUIPointer, VariableReloadGUIPointer } from '../../ts/stores.svelte'

setupChatTests()

describe('Chat parser dependencies', () => {
  it('does not reparse visible rows for incidental reactive reads until explicitly reloaded', async () => {
    const rows = makeRows(4)
    seedDatabase(rows)
    // Model a parser helper reading reactive owner state. This must not turn
    // an unrelated note write into automatic work for every mounted row.
    chatMocks.risuChatParser.mockImplementation(
      (message) => `${message}|note:${getResourceDatabase().characters[0].chats[0].note}`,
    )
    mountHarness(rows)
    await settle()

    expectParsedMessages(rows.map((row) => row.data))
    const initialBodies = renderedBodies()
    expect(initialBodies).toEqual(rows.map((row) => `${row.data}|note:`))
    chatMocks.risuChatParser.mockClear()

    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].chats[0].note = 'updated note'
    })
    await settle()

    expect(chatMocks.risuChatParser).not.toHaveBeenCalled()
    expect(renderedBodies()).toEqual(initialBodies)

    ReloadGUIPointer.update((value) => value + 1)
    await settle()

    expectParsedMessages(rows.map((row) => row.data))
    expect(renderedBodies()).toEqual(rows.map((row) => `${row.data}|note:updated note`))
  })

  it.each([
    {
      prop: 'message',
      update: () => component!.updateMessage(2, 'visible message 2 changed'),
      message: 'visible message 2 changed',
      args: { chatID: 2 },
      rendered: 'parsed:visible message 2 changed:',
    },
    {
      prop: 'role',
      update: () => component!.updateRole(1, 'char'),
      message: 'visible message 1',
      args: { cbsConditions: { firstmsg: false, chatRole: 'char' } },
      rendered: 'parsed:visible message 1:{"firstmsg":false,"chatRole":"char"}',
    },
    {
      prop: 'name',
      update: () => component!.updateName(0, 'Renamed Parser Bot'),
      message: 'visible message 0',
      args: { chara: 'Renamed Parser Bot', chatID: 0 },
      rendered: 'parsed:visible message 0:',
    },
    {
      prop: 'parser index',
      update: () => component!.updateParserIndex(3, 99),
      message: 'visible message 3',
      args: { chara: 'User', chatID: 99 },
      rendered: 'parsed:visible message 3:',
    },
  ])('reparses only the affected row when its $prop changes', async ({ update, message, args, rendered }) => {
    const rows = makeRows(4)
    seedDatabase(rows)
    mountHarness(rows)
    await settle()
    chatMocks.risuChatParser.mockClear()

    update()
    await settle()

    expectParsedMessages([message])
    expect(chatMocks.risuChatParser).toHaveBeenCalledWith(message, expect.objectContaining(args))
    expect(target.textContent).toContain(rendered)
  })

  it('re-runs only synthetic greeting display parsing on variable-only reload', async () => {
    const rows = makeRows(4)
    seedDatabase(rows)
    mountHarness(rows)
    await settle()

    component!.updateParserIndex(0, -1)
    await settle()
    chatMocks.risuChatParser.mockClear()

    VariableReloadGUIPointer.update((value) => value + 1)
    await settle()

    expect(chatMocks.risuChatParser.mock.calls.map((call) => call[0])).toEqual(['visible message 0'])
    expect(chatMocks.risuChatParser.mock.calls[0][1]?.cbsConditions).toEqual({
      firstmsg: true,
      chatRole: 'char',
    })
  })

  it('re-runs only synthetic greeting display parsing when the active chat changes', async () => {
    const rows = makeRows(4)
    seedDatabase(rows)
    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].chats.push({
        id: 'parser-dependency-other-chat',
        name: 'Other Parser Dependency Chat',
        message: [],
        note: '',
        bookmarks: [],
        bookmarkNames: {},
        localLore: [],
      })
    })
    mountHarness(rows)
    await settle()

    component!.updateParserIndex(0, -1)
    await settle()
    chatMocks.risuChatParser.mockClear()

    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].chatPage = 1
    })
    await settle()

    expect(chatMocks.risuChatParser.mock.calls.map((call) => call[0])).toEqual(['visible message 0'])
    expect(chatMocks.risuChatParser.mock.calls[0][1]?.chatID).toBe(-1)
  })

  it('re-runs display parsing for the targeted reload chat index', async () => {
    const rows = makeRows(4)
    seedDatabase(rows)
    mountHarness(rows)
    await settle()

    component!.updateParserIndex(0, -1)
    await settle()
    chatMocks.risuChatParser.mockClear()

    ReloadChatPointer.update((value) => ({
      ...value,
      [-1]: (value[-1] ?? 0) + 1,
    }))
    await settle()

    expect(chatMocks.risuChatParser.mock.calls.map((call) => call[0])).toEqual(['visible message 0'])
    expect(chatMocks.risuChatParser.mock.calls[0][1]?.chatID).toBe(-1)
  })
})

function expectParsedMessages(messages: string[]) {
  expect(chatMocks.risuChatParser.mock.calls.map(([message]) => message).sort()).toEqual([...messages].sort())
}

function renderedBodies() {
  return Array.from(target.querySelectorAll('.chattext .risu-chat'), (body) => body.textContent?.trim())
}
