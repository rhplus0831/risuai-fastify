import { demoteClientSession } from 'src/ts/clientSession'
import {
  beginWriterDraftCaptureTest,
  endWriterDraftCaptureTest,
  capturedWriterDrafts,
} from 'src/ts/__tests__/writerDraftCapture'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const writerAccessMocks = vi.hoisted(() => ({
  lost: false,
  report: vi.fn(() => writerAccessMocks.lost),
}))

vi.mock('src/ts/server/activeWriterSession', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/server/activeWriterSession')>()
  return { ...actual, reportWriterAccessLostMutation: writerAccessMocks.report }
})

const sidebarMocks = vi.hoisted(() => {
  type DeferredCommand = {
    input?: unknown
    promise: Promise<unknown>
    reject: (reason?: unknown) => void
    resolve: (value: unknown) => void
    settled: boolean
  }
  type ExportAllChatsResult =
    | { success: false }
    | {
        success: true
        fence: {
          chats: Array<{
            chatId: string | null
            messageCount: number
            lastMessageId: string | null
            lastMessageContentHash: string | null
          }>
        }
      }

  class SortableMock {
    static instances: SortableMock[] = []
    static create = vi.fn((element: Element, options: unknown) => new SortableMock(element, options))

    element: Element
    options: unknown
    destroy = vi.fn()

    constructor(element: Element, options: unknown) {
      this.element = element
      this.options = options
      SortableMock.instances.push(this)
    }
  }

  let serverCommandsEnabled = false
  let pendingCreateCommand: DeferredCommand | undefined
  let pendingCreateFolderCommand: DeferredCommand | undefined
  let pendingDeleteCommand: DeferredCommand | undefined
  let pendingSelectCommand: DeferredCommand | undefined
  let pendingUpdateCommand: DeferredCommand | undefined
  let pendingGenerationSettingsCommand: DeferredCommand | undefined
  let createOutcomeOverride: ((...args: any[]) => Promise<any>) | undefined
  let generationSettingsApplier:
    | ((chatId: string, generationSettings: Record<string, unknown>) => () => void)
    | undefined

  function createDeferredCommand(): DeferredCommand {
    let resolveCommand!: (value: unknown) => void
    let rejectCommand!: (reason?: unknown) => void
    const command: DeferredCommand = {
      promise: new Promise((resolve, reject) => {
        resolveCommand = resolve
        rejectCommand = reject
      }),
      reject: (reason?: unknown) => {
        command.settled = true
        rejectCommand(reason)
      },
      resolve: (value: unknown) => {
        command.settled = true
        resolveCommand(value)
      },
      settled: false,
    }
    return command
  }

  function createDeferredCreateCommand(): DeferredCommand {
    pendingCreateCommand = createDeferredCommand()
    return pendingCreateCommand
  }

  function createDeferredCreateFolderCommand(): DeferredCommand {
    pendingCreateFolderCommand = createDeferredCommand()
    return pendingCreateFolderCommand
  }

  function createDeferredDeleteCommand(): DeferredCommand {
    pendingDeleteCommand = createDeferredCommand()
    return pendingDeleteCommand
  }

  function createDeferredSelectCommand(): DeferredCommand {
    pendingSelectCommand = createDeferredCommand()
    return pendingSelectCommand
  }

  function createDeferredUpdateCommand(): DeferredCommand {
    pendingUpdateCommand = createDeferredCommand()
    return pendingUpdateCommand
  }

  function createDeferredGenerationSettingsCommand(): DeferredCommand {
    pendingGenerationSettingsCommand = createDeferredCommand()
    return pendingGenerationSettingsCommand
  }

  function okCommandResult() {
    return {
      revision: 1,
      status: 'ok',
    }
  }

  const unusedCommand = vi.fn(async () => okCommandResult())
  const currentRouteSubscribers = new Set<(value: unknown) => void>()
  let currentRouteValue: unknown = {
    kind: 'character',
    path: '/character/char-a',
    chaId: 'char-a',
  }

  const currentRoute = {
    subscribe(run: (value: unknown) => void) {
      run(currentRouteValue)
      currentRouteSubscribers.add(run)
      return () => {
        currentRouteSubscribers.delete(run)
      }
    },
  }

  function setCurrentRoute(value: unknown): void {
    currentRouteValue = value
    currentRouteSubscribers.forEach((run) => run(value))
  }

  return {
    SortableMock,
    alertChatOptions: vi.fn(),
    alertConfirm: vi.fn(async () => false),
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertSelect: vi.fn(async () => '0'),
    alertStoreSet: vi.fn(),
    appendMessageCommand: unusedCommand,
    changeChatTo: vi.fn(),
    canUseServerCommands: vi.fn(() => serverCommandsEnabled),
    createChatCommand: vi.fn((input: unknown) => {
      if (!pendingCreateCommand) {
        throw new Error('No deferred create-chat command was prepared')
      }
      pendingCreateCommand.input = input
      return pendingCreateCommand.promise
    }),
    createDeferredCreateCommand,
    createDeferredCreateFolderCommand,
    createDeferredDeleteCommand,
    createDeferredSelectCommand,
    createDeferredUpdateCommand,
    createDeferredGenerationSettingsCommand,
    createChatCopyName: vi.fn((name: string, suffix: string) => `${name} ${suffix}`),
    currentRoute,
    createChatFolderCommand: vi.fn((input: unknown) => {
      if (!pendingCreateFolderCommand) {
        throw new Error('No deferred create-folder command was prepared')
      }
      pendingCreateFolderCommand.input = input
      return pendingCreateFolderCommand.promise
    }),
    deleteChatCommand: vi.fn((input: unknown) => {
      if (!pendingDeleteCommand) {
        throw new Error('No deferred delete-chat command was prepared')
      }
      pendingDeleteCommand.input = input
      return pendingDeleteCommand.promise
    }),
    deleteChatFolderCommand: unusedCommand,
    deleteMessageCommand: unusedCommand,
    dispatchDeleteChatFolderWithOutcome: vi.fn(async (..._args: any[]) => ({
      status: 'accepted',
      result: okCommandResult(),
    })),
    dispatchForkChatWithOutcome: vi.fn(async (..._args: any[]) => ({
      status: 'accepted',
      result: okCommandResult(),
    })),
    dispatchReorderChatFoldersAndChatsByIdsWithOutcome: vi.fn(async (..._args: any[]) => ({
      status: 'accepted',
      result: okCommandResult(),
    })),
    dispatchReorderChatsByIdsWithOutcome: vi.fn(async (..._args: any[]) => ({
      status: 'accepted',
      result: okCommandResult(),
    })),
    dispatchResetChatsWithOutcome: vi.fn(async (..._args: any[]) => ({
      status: 'accepted',
      result: okCommandResult(),
    })),
    dispatchSaveChatGenerationSettingsWithOutcome: vi.fn(
      (chatId: string, generationSettings: Record<string, unknown>) => {
        const rollback = generationSettingsApplier?.(chatId, generationSettings) ?? (() => undefined)
        const deferred = pendingGenerationSettingsCommand
        if (!deferred) {
          return { settlement: Promise.resolve({ status: 'accepted' as const }) }
        }
        deferred.input = { chatId, generationSettings }
        const settlement = deferred.promise.then((result) => {
          if ((result as { status?: string }).status === 'failed') rollback()
          return result
        })
        return { settlement }
      },
    ),
    dispatchChatMetadataPatchWithOutcome: vi.fn(async (..._args: any[]) => ({
      status: 'accepted',
      result: okCommandResult(),
    })),
    dispatchChatFolderMetadataPatchWithOutcome: vi.fn(
      async (..._args: any[]): Promise<any> => ({
        status: 'accepted',
        result: okCommandResult(),
      }),
    ),
    ensureAllChatsHydrated: vi.fn(async () => undefined),
    exportAllChats: vi.fn(async (): Promise<ExportAllChatsResult> => ({ success: false })),
    exportChat: vi.fn(),
    forkChatCommand: unusedCommand,
    hydrateChatMessages: vi.fn(async (_chatId: string, _options?: { strict?: boolean }) => undefined),
    importChat: vi.fn(),
    matchesAllChatsExportFence: vi.fn(
      (
        chats: Array<{ id?: string; message: Array<{ chatId?: string }> }>,
        fence: {
          chats: Array<{
            chatId: string | null
            messageCount: number
            lastMessageId: string | null
            lastMessageContentHash: string | null
          }>
        },
      ) => {
        if (chats.length !== fence.chats.length) return false
        const fencedChats = new Map(fence.chats.map((chat) => [chat.chatId, chat]))
        if (fencedChats.size !== fence.chats.length) return false
        const liveChatIds = new Set<string | null>()
        for (const chat of chats) {
          const chatId = chat.id ?? null
          if (liveChatIds.has(chatId)) return false
          liveChatIds.add(chatId)
          const fencedChat = fencedChats.get(chatId)
          const lastMessage = chat.message.at(-1)
          if (
            !fencedChat ||
            chat.message.length !== fencedChat.messageCount ||
            (lastMessage?.chatId ?? null) !== fencedChat.lastMessageId ||
            (lastMessage ? JSON.stringify(lastMessage) : null) !== fencedChat.lastMessageContentHash
          ) {
            return false
          }
        }
        return true
      },
    ),
    navigate: vi.fn(),
    patchChatScriptstateCommand: unusedCommand,
    reorderChatFoldersCommand: unusedCommand,
    reorderChatsCommand: unusedCommand,
    resetChatsCommand: unusedCommand,
    replaceMessagesCommand: unusedCommand,
    resetCommandHarness: () => {
      pendingCreateCommand = undefined
      pendingCreateFolderCommand = undefined
      pendingDeleteCommand = undefined
      pendingSelectCommand = undefined
      pendingUpdateCommand = undefined
      pendingGenerationSettingsCommand = undefined
      createOutcomeOverride = undefined
      SortableMock.instances = []
      serverCommandsEnabled = false
      setCurrentRoute({
        kind: 'character',
        path: '/character/char-a',
        chaId: 'char-a',
      })
    },
    runServerCommand: vi.fn(
      async (input: {
        command: (baseRevision: number) => Promise<any>
        rollback?: () => void
        failureRollbackDisposition?: (failure: any) => 'retain' | 'rollback'
      }) => {
        if (!serverCommandsEnabled) return { status: 'unavailable' }
        try {
          const result = await input.command(10)
          if (result.status !== 'ok' && (input.failureRollbackDisposition?.(result) ?? 'rollback') === 'rollback') {
            input.rollback?.()
          }
          return result
        } catch (error) {
          const result = {
            error: error instanceof Error ? error.message : String(error),
            status: 'error',
          }
          if ((input.failureRollbackDisposition?.(result) ?? 'rollback') === 'rollback') input.rollback?.()
          return result
        }
      },
    ),
    setServerCommandsEnabled: (enabled: boolean) => {
      serverCommandsEnabled = enabled
    },
    setCreateOutcomeOverride: (override: ((...args: any[]) => Promise<any>) | undefined) => {
      createOutcomeOverride = override
    },
    setGenerationSettingsApplier: (
      applier: (chatId: string, generationSettings: Record<string, unknown>) => () => void,
    ) => {
      generationSettingsApplier = applier
    },
    dispatchCreateChatWithOutcome: (...args: any[]) => createOutcomeOverride?.(...args),
    setCurrentRoute,
    truncateMessagesCommand: unusedCommand,
    updateChatCommand: vi.fn((input: unknown) => {
      if ((input as { select?: boolean }).select) {
        if (!pendingSelectCommand) {
          throw new Error('No deferred select-chat command was prepared')
        }
        pendingSelectCommand.input = input
        return pendingSelectCommand.promise
      }
      if (pendingUpdateCommand) {
        pendingUpdateCommand.input = input
        return pendingUpdateCommand.promise
      }
      return okCommandResult()
    }),
    updateChatFolderCommand: unusedCommand,
    updateMessageCommand: unusedCommand,
  }
})

vi.mock('sortablejs/modular/sortable.core.esm.js', () => ({
  default: sidebarMocks.SortableMock,
}))

vi.mock('src/lang', () => ({
  language: {
    cancel: 'Cancel',
    bookmarks: 'Bookmarks',
    branch: 'Branch',
    chatDataLoadFailed: 'Chat data could not be loaded.',
    chatCreateProvisional: (name: string) => `${name} is provisional`,
    chatListCreateFolder: 'Create chat folder',
    chatListEdit: 'Edit chat list',
    chatListExportAll: 'Export all chats',
    chatListDeleteAllAfterExportConfirm: 'Download finished. Delete every chat?',
    chatListDeleteAllSecondConfirm: 'Permanently delete every chat?',
    chatListDeleteAllExportChanged: 'Chats changed since the export. Re-export them and try again.',
    chatListDeleteAllAction: 'Delete all chats',
    chatListImport: 'Import chat',
    chatStructureFailed: (action: string) => `${action} failed`,
    chatStructurePending: (action: string) => `Saving ${action}`,
    chatStructureQueued: (action: string) => `${action} queued`,
    chatOptions: 'Chat options',
    chatFolders: 'Chat folders',
    chats: 'Chats',
    chatFolderContents: (name: string) => `Chats in ${name}`,
    emptyChatFolder: (name: string) => `${name} has no chats`,
    changeFolderColor: 'Change folder color',
    createCopy: 'Create a copy',
    bindPersona: 'Bind persona',
    unbindPersona: 'Unbind persona',
    renameChat: 'Rename chat',
    renameFolder: 'Rename folder',
    organize: 'Organize',
    moreActions: 'More actions',
    doYouWantToBindCurrentPersona: 'Bind persona?',
    doYouWantToUnbindCurrentPersona: 'Unbind persona?',
    errors: { onlyOneChat: 'Only one chat' },
    edit: 'Edit',
    export: 'Export',
    goback: 'Back',
    generationReattachFailure: {
      sidebarWarning: (name: string) => `Connection lost: ${name}`,
    },
    authorNote: "Author's Note",
    help: { chatNote: 'Chat note help' },
    hotkeyDesc: { popupEditor: 'Open popup editor' },
    chooseDestinationFolder: 'Choose destination folder',
    moveDown: 'Move down',
    moveOutOfFolder: 'Move out of folder',
    moveToFolder: 'Move to folder',
    moveUp: 'Move up',
    newChat: 'New Chat',
    options: 'Options',
    personaBindedSuccess: 'Persona bound',
    personaBindingFailed: 'Persona binding failed',
    personaBindingQueued: 'Persona binding queued',
    personaUnbindedSuccess: 'Persona unbound',
    removeConfirm: 'Remove ',
    remove: 'Remove',
    showHelp: 'Show help',
    tokens: 'tokens',
  },
}))

vi.mock('src/ts/alert', () => ({
  alertChatOptions: sidebarMocks.alertChatOptions,
  alertConfirm: sidebarMocks.alertConfirm,
  alertError: sidebarMocks.alertError,
  alertNormal: sidebarMocks.alertNormal,
  alertSelect: sidebarMocks.alertSelect,
  alertStore: { set: sidebarMocks.alertStoreSet },
}))

vi.mock('src/ts/characters', () => ({
  exportAllChats: sidebarMocks.exportAllChats,
  exportChat: sidebarMocks.exportChat,
  importChat: sidebarMocks.importChat,
  matchesAllChatsExportFence: sidebarMocks.matchesAllChatsExportFence,
}))

vi.mock('src/ts/chatCommands', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/chatCommands')>()
  return {
    ...actual,
    currentChatStateSnapshot: vi.fn(actual.currentChatStateSnapshot),
    dispatchCreateChatWithOutcome: (...args: Parameters<typeof actual.dispatchCreateChatWithOutcome>) =>
      sidebarMocks.dispatchCreateChatWithOutcome(...args) ?? actual.dispatchCreateChatWithOutcome(...args),
    dispatchDeleteChatFolderWithOutcome: sidebarMocks.dispatchDeleteChatFolderWithOutcome,
    dispatchForkChatWithOutcome: sidebarMocks.dispatchForkChatWithOutcome,
    dispatchReorderChatFoldersAndChatsByIdsWithOutcome: sidebarMocks.dispatchReorderChatFoldersAndChatsByIdsWithOutcome,
    dispatchReorderChatsByIdsWithOutcome: sidebarMocks.dispatchReorderChatsByIdsWithOutcome,
    dispatchResetChatsWithOutcome: sidebarMocks.dispatchResetChatsWithOutcome,
    dispatchSaveChatGenerationSettingsWithOutcome: sidebarMocks.dispatchSaveChatGenerationSettingsWithOutcome,
    dispatchChatMetadataPatchWithOutcome: sidebarMocks.dispatchChatMetadataPatchWithOutcome,
    dispatchChatFolderMetadataPatchWithOutcome: sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome,
  }
})

vi.mock('src/ts/globalApi.svelte', () => ({
  changeChatTo: sidebarMocks.changeChatTo,
  createChatCopyName: sidebarMocks.createChatCopyName,
  downloadFile: vi.fn(),
  saveAsset: vi.fn(async () => ''),
}))

vi.mock('src/ts/process/modules', () => ({
  getModuleAssets: () => [],
  getModuleLorebooks: () => [],
  getModuleRegexScripts: () => [],
  getModules: () => [],
  getModuleTriggers: () => [],
  getModuleToggles: () => '',
  moduleUpdate: vi.fn(),
}))

vi.mock('src/ts/process/scripts', () => ({
  resetScriptCache: vi.fn(),
}))

vi.mock('src/ts/router', () => ({
  characterRoutePath: (characterId: string, chatId?: string) =>
    chatId ? `/character/${characterId}/${chatId}` : `/character/${characterId}`,
  currentRoute: sidebarMocks.currentRoute,
  navigate: sidebarMocks.navigate,
}))

vi.mock('src/ts/server/chatMessageHydration.svelte', () => ({
  applyServerChatMessagesResource: vi.fn(() => true),
  ensureAllChatsHydrated: sidebarMocks.ensureAllChatsHydrated,
  hydrateActiveChat: vi.fn(async () => undefined),
  hydrateChatMessages: sidebarMocks.hydrateChatMessages,
  resetChatHydration: vi.fn(),
}))

vi.mock('src/ts/server/commands', () => ({
  appendMessageCommand: sidebarMocks.appendMessageCommand,
  canUseServerCommands: sidebarMocks.canUseServerCommands,
  createChatCommand: sidebarMocks.createChatCommand,
  createChatFolderCommand: sidebarMocks.createChatFolderCommand,
  deleteChatCommand: sidebarMocks.deleteChatCommand,
  deleteChatFolderCommand: sidebarMocks.deleteChatFolderCommand,
  deleteMessageCommand: sidebarMocks.deleteMessageCommand,
  forkChatCommand: sidebarMocks.forkChatCommand,
  patchChatScriptstateCommand: sidebarMocks.patchChatScriptstateCommand,
  reorderChatFoldersCommand: sidebarMocks.reorderChatFoldersCommand,
  reorderChatsCommand: sidebarMocks.reorderChatsCommand,
  resetChatsCommand: sidebarMocks.resetChatsCommand,
  replaceMessagesCommand: sidebarMocks.replaceMessagesCommand,
  runServerCommand: sidebarMocks.runServerCommand,
  truncateMessagesCommand: sidebarMocks.truncateMessagesCommand,
  updateChatCommand: sidebarMocks.updateChatCommand,
  updateChatFolderCommand: sidebarMocks.updateChatFolderCommand,
  updateMessageCommand: sidebarMocks.updateMessageCommand,
}))

const togglesLoaderMocks = vi.hoisted(() => ({
  load: vi.fn(),
  resolved: vi.fn(),
  pending: undefined as Promise<void> | undefined,
}))

vi.mock('./Toggles.svelte', async () => {
  togglesLoaderMocks.load()
  await togglesLoaderMocks.pending
  const mock = await import('./SideChatList.testToggles.svelte')
  togglesLoaderMocks.resolved()
  return { default: mock.default }
})

import { currentChatStateSnapshot } from 'src/ts/chatCommands'
import SideChatListHarness from './SideChatList.testHarness.svelte'
import { popupStore, selectedCharID } from 'src/ts/stores.svelte'

import { charactersResourceState, replaceResourceDatabase as setDatabaseLite } from 'src/ts/server/resourceState.svelte'
import type { Chat, ChatFolder, character } from 'src/ts/storage/database.svelte'
import { language } from 'src/lang'
import { generationJobLifecycles } from 'src/ts/process/reattach'
import { markChatUnread, resetChatUnreadForTests, unreadChatIds } from 'src/ts/process/chatUnread.svelte'
import { get } from 'svelte/store'
import { getResourceDatabase as getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

let target: HTMLElement
let component: MountedComponent | undefined

function makeChat(id: string, name: string, folderId: string | null = null): Chat {
  return {
    id,
    name,
    folderId,
    message: [],
    localLore: [],
    fmIndex: -1,
    note: '',
  } as Chat
}

function successfulExport(chats: Chat[]) {
  return {
    success: true as const,
    fence: {
      chats: chats.map((chat) => {
        const lastMessage = chat.message.at(-1)
        return {
          chatId: chat.id ?? null,
          messageCount: chat.message.length,
          lastMessageId: lastMessage?.chatId ?? null,
          lastMessageContentHash: lastMessage ? JSON.stringify(lastMessage) : null,
        }
      }),
    },
  }
}

function seedSidebarDatabase(): character {
  const chara = {
    chaId: 'char-a',
    name: 'Harness Character',
    chatPage: 1,
    chats: [
      makeChat('chat-root-a', 'Root Chat A'),
      makeChat('chat-foldered', 'Foldered Chat', 'folder-a'),
      makeChat('chat-root-b', 'Root Chat B'),
    ],
    chatFolders: [{ id: 'folder-a', name: 'Pinned Folder', folded: false }],
    firstMessage: '',
    desc: '',
    notes: '',
    viewScreen: 'none',
    bias: [],
    emotionImages: [],
    globalLore: [],
    sdData: [],
    customscript: [],
    triggerscript: [],
    utilityBot: false,
    exampleMessage: '',
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    tags: [],
    creator: '',
    characterVersion: '',
    personality: '',
    scenario: '',
    firstMsgIndex: 0,
  } as character

  selectedCharID.set(0)
  setDatabaseLite({
    characters: [chara],
    currentChar: 0,
    customPromptTemplateToggle: '',
    customSidebarItems: [],
    enabledModules: [],
    hypaV3: false,
    jailbreak: '',
    modules: [],
    personas: [{ id: 'persona-selected', name: 'Selected Persona', icon: '', personaPrompt: '', note: '' }],
    promptTemplate: [],
    personaPrompt: '',
    selectedPersonaId: 'persona-selected',
    selectedPersona: 0,
    userIcon: '',
    userNote: '',
    username: 'User',
  } as never)

  return getDatabase().characters[0]
}

function appendCharacterCopy(source: character, characterId: string): character {
  const copy = JSON.parse(JSON.stringify(source)) as character
  copy.chaId = characterId
  copy.name = `Copy ${characterId}`
  getDatabase().characters.push(copy)
  return getDatabase().characters.at(-1)!
}

function sidebarRoot(): HTMLElement {
  const root = target.querySelector<HTMLElement>('[data-risu-chat-list="sidebar"]')
  expect(root, 'sidebar chat list root').toBeTruthy()
  return root!
}

function chatRows(): HTMLElement[] {
  return Array.from(sidebarRoot().querySelectorAll<HTMLElement>('[data-risu-chat-idx][data-risu-chat-id]'))
}

function rowByChatId(chatId: string): HTMLElement {
  const row = chatRows().find((candidate) => candidate.dataset.risuChatId === chatId)
  expect(row, `chat row ${chatId}`).toBeTruthy()
  return row!
}

function selectButtonForRow(row: HTMLElement): HTMLButtonElement {
  const button = row.querySelector<HTMLButtonElement>('[data-risu-chat-action="select"]')
  expect(button, 'select chat button').toBeTruthy()
  return button!
}

function createButton(): HTMLButtonElement {
  const action = sidebarRoot().querySelector<HTMLElement>('[data-risu-chat-action="create"]')
  const button = action instanceof HTMLButtonElement ? action : action?.querySelector<HTMLButtonElement>('button')
  expect(button, 'create chat button').toBeTruthy()
  return button!
}

function createFolderButton(): HTMLButtonElement {
  const button = sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="create-folder"]')
  expect(button, 'create folder button').toBeTruthy()
  return button!
}

function backToChatListButton(): HTMLButtonElement {
  const button = sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="back-to-chat-list"]')
  expect(button, 'back to chat list button').toBeTruthy()
  return button!
}

function rowActionButton(row: HTMLElement, actionKind: string): HTMLElement {
  const action = row.querySelector<HTMLElement>(`[data-risu-chat-action="${actionKind}"]`)
  expect(action, `${actionKind} chat action`).toBeTruthy()
  return action!
}

function editButtonForRow(row: HTMLElement): HTMLElement {
  return rowActionButton(row, 'edit')
}

function deleteButtonForRow(row: HTMLElement): HTMLElement {
  return rowActionButton(row, 'delete')
}

function folderHeader(folder: HTMLElement): HTMLButtonElement {
  const header = folder.querySelector<HTMLButtonElement>(
    ':scope > [data-risu-chat-folder-header] > [data-risu-chat-action="toggle-folder"]',
  )
  expect(header, 'folder header').toBeTruthy()
  return header!
}

function folderHeaderContainer(folder: HTMLElement): HTMLElement {
  const header = folder.querySelector<HTMLElement>(':scope > [data-risu-chat-folder-header]')
  expect(header, 'folder header container').toBeTruthy()
  return header!
}

function folderElementById(folderId: string): HTMLElement {
  const folder = Array.from(
    sidebarRoot().querySelectorAll<HTMLElement>('[data-risu-chat-folder-idx][data-risu-chat-folder-id]'),
  ).find((candidate) => candidate.dataset.risuChatFolderId === folderId)
  expect(folder, `folder row ${folderId}`).toBeTruthy()
  return folder!
}

function folderPanelById(folderId: string): HTMLElement {
  const panel = sidebarRoot().querySelector<HTMLElement>(`[data-risu-chat-folder-panel-id="${folderId}"]`)
  expect(panel, `folder panel ${folderId}`).toBeTruthy()
  return panel!
}

function inputIn(element: HTMLElement, description: string): HTMLInputElement {
  const input = element.querySelector<HTMLInputElement>('input')
  expect(input, description).toBeTruthy()
  return input!
}

function expectRowSelected(chatId: string, selected: boolean): void {
  expect(rowByChatId(chatId).dataset.risuChatSelected).toBe(selected ? 'true' : 'false')
}

function sortableForElement(element: Element): { options: { onEnd: (event: { to: HTMLElement }) => Promise<void> } } {
  const sortable = sidebarMocks.SortableMock.instances.find((instance) => instance.element === element)
  expect(sortable, 'sortable instance').toBeTruthy()
  return sortable as unknown as { options: { onEnd: (event: { to: HTMLElement }) => Promise<void> } }
}

function activeSortablesForElement(element: Element): Array<{ destroy: ReturnType<typeof vi.fn> }> {
  return sidebarMocks.SortableMock.instances.filter(
    (instance) => instance.element === element && instance.destroy.mock.calls.length === 0,
  )
}

async function setTextInputValue(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
}

function selectedCharacter(): character {
  return getDatabase().characters[0]
}

function removeCharacterId(chara: character): void {
  ;(chara as { chaId?: string }).chaId = undefined
}

async function flushCommandWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await tick()
}

describe('SideChatList DOM contract harness', () => {
  beforeEach(() => {
    writerAccessMocks.lost = false
    target = document.createElement('div')
    document.body.appendChild(target)
    sidebarMocks.resetCommandHarness()
    sidebarMocks.setGenerationSettingsApplier((chatId, generationSettings) => {
      const chat = getDatabase()
        .characters.flatMap((character) => character.chats)
        .find((candidate) => candidate.id === chatId)
      const hadGenerationSettings = Object.prototype.hasOwnProperty.call(chat ?? {}, 'generationSettings')
      const previous =
        chat?.generationSettings === undefined ? undefined : JSON.parse(JSON.stringify(chat.generationSettings))
      withTestDatabaseWrite(() => {
        if (chat) chat.generationSettings = JSON.parse(JSON.stringify(generationSettings)) as never
      })
      return () => {
        withTestDatabaseWrite(() => {
          if (!chat) return
          if (hadGenerationSettings) chat.generationSettings = previous as never
          else delete chat.generationSettings
        })
      }
    })
    vi.clearAllMocks()
    generationJobLifecycles.set({})
    resetChatUnreadForTests()
    popupStore.children = null
    popupStore.openId = 0
    popupStore.trigger = null
  })

  afterEach(() => {
    expect(currentChatStateSnapshot).not.toHaveBeenCalled()
    if (component) {
      unmount(component)
      component = undefined
    }
    target.remove()
    document.body.innerHTML = ''
    selectedCharID.set(-1)
    setDatabaseLite({} as never)
    generationJobLifecycles.set({})
    resetChatUnreadForTests()
    popupStore.children = null
    popupStore.openId = 0
    popupStore.trigger = null
  })

  it('renders seeded root and folder chat rows with selected and folder selectors', async () => {
    seedSidebarDatabase()

    component = mount(SideChatListHarness, { target })
    await tick()

    expect(chatRows().map((row) => row.dataset.risuChatId)).toEqual(['chat-foldered', 'chat-root-a', 'chat-root-b'])
    expect(rowByChatId('chat-foldered').dataset.risuChatIdx).toBe('1')
    expect(rowByChatId('chat-foldered').dataset.risuChatFolderId).toBe('folder-a')
    expect(rowByChatId('chat-root-a').dataset.risuChatFolderId).toBe('')
    expect(rowByChatId('chat-root-b').dataset.risuChatFolderId).toBe('')
    expect(folderElementById('folder-a').dataset.risuChatFolderFolded).toBe('false')
    expectRowSelected('chat-foldered', true)
    expectRowSelected('chat-root-a', false)
    expectRowSelected('chat-root-b', false)
    expect(sidebarRoot().dataset.risuChatOpen).toBe('false')
    expect(target.querySelector('[data-testid="side-chat-list-toggles-stub"]')).toBeNull()
  })

  it('exposes target-named secondary actions in a keyboard menu with a separated danger section', async () => {
    seedSidebarDatabase()

    component = mount(SideChatListHarness, { target })
    await tick()

    const row = rowByChatId('chat-root-a')
    const trigger = rowActionButton(row, 'more-actions') as HTMLButtonElement
    expect(trigger.getAttribute('aria-label')).toBe(`${language.moreActions}: Root Chat A`)
    expect(trigger.classList.contains('min-h-11')).toBe(true)
    expect(trigger.classList.contains('min-w-11')).toBe(true)

    trigger.click()
    await flushCommandWork()

    const menu = target.querySelector<HTMLElement>('[role="menu"]')
    expect(menu).toBeTruthy()
    const actions = Array.from(menu!.querySelectorAll<HTMLButtonElement>('[data-risu-chat-menu-action]'))
    expect(actions.map((action) => action.dataset.risuChatMenuAction)).toEqual([
      'copy',
      'persona',
      'rename',
      'export',
      'organize',
      'delete',
    ])
    expect(actions.every((action) => action.getAttribute('role') === 'menuitem')).toBe(true)
    expect(actions.every((action) => action.getAttribute('aria-label')?.includes('Root Chat A'))).toBe(true)
    expect(menu!.querySelector('[data-risu-danger-menu-section] [data-risu-chat-menu-action="delete"]')).toBe(
      actions.at(-1),
    )

    actions[0].dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End' }))
    expect(document.activeElement).toBe(actions.at(-1))
    actions.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
    await flushCommandWork()
    expect(target.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('presents folders as disclosed nested groups with explicit empty-state text', async () => {
    const character = seedSidebarDatabase()
    withTestDatabaseWrite(() => {
      character.chatFolders.push({ id: 'folder-empty', name: 'Empty Folder', folded: false })
    })

    component = mount(SideChatListHarness, { target })
    await tick()

    const folderList = sidebarRoot().querySelector<HTMLElement>('[role="list"][aria-label="Chat folders"]')
    const folder = folderElementById('folder-empty')
    const disclosure = folderHeader(folder)
    const panel = folderPanelById('folder-empty')
    expect(folderList).toBeTruthy()
    expect(folder.getAttribute('role')).toBe('listitem')
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(disclosure.querySelector('svg')).toBeTruthy()
    expect(panel.getAttribute('role')).toBe('group')
    expect(panel.getAttribute('aria-label')).toBe(language.chatFolderContents('Empty Folder'))
    expect(panel.textContent).toContain(language.emptyChatFolder('Empty Folder'))
  })

  it('renders chat names from the hydrated owner when aggregate metadata conflicts', async () => {
    const aggregate = seedSidebarDatabase()
    charactersResourceState.characters = [
      {
        ...aggregate,
        chats: aggregate.chats.map((chat) => (chat.id === 'chat-root-a' ? { ...chat, name: 'Owner Chat A' } : chat)),
      },
    ]

    component = mount(SideChatListHarness, { target })
    await tick()

    expect(selectButtonForRow(rowByChatId('chat-root-a')).textContent).toContain('Owner Chat A')
    expect(selectButtonForRow(rowByChatId('chat-root-a')).textContent).not.toContain('Root Chat A')
    const ownerRow = rowByChatId('chat-root-a')
    expect(rowActionButton(ownerRow, 'options').getAttribute('aria-label')).toBe(
      `${language.chatOptions}: Owner Chat A`,
    )
    expect(rowActionButton(ownerRow, 'edit').getAttribute('aria-label')).toBe(`${language.edit}: Owner Chat A`)
    expect(rowActionButton(ownerRow, 'export').getAttribute('aria-label')).toBe(`${language.export}: Owner Chat A`)
    expect(rowActionButton(ownerRow, 'delete').getAttribute('aria-label')).toBe(`${language.remove}: Owner Chat A`)
  })

  it('fails closed instead of selecting the first duplicate ready character owner', async () => {
    const owner = seedSidebarDatabase()
    charactersResourceState.characters = [owner, JSON.parse(JSON.stringify(owner))]

    component = mount(SideChatListHarness, { target })
    await tick()

    expect(target.querySelector('[data-risu-chat-list="sidebar"]')).toBeNull()
    expect(sidebarMocks.navigate).not.toHaveBeenCalled()
  })

  it('waits for character owner readiness before rendering', async () => {
    seedSidebarDatabase()
    charactersResourceState.status = 'loading'

    component = mount(SideChatListHarness, { target })
    await tick()
    expect(target.querySelector('[data-risu-chat-list="sidebar"]')).toBeNull()

    charactersResourceState.status = 'ready'
    await tick()
    expect(target.querySelector('[data-risu-chat-list="sidebar"]')).toBeTruthy()
  })

  it('fails closed for duplicate ready chat IDs across navigation and export actions', async () => {
    const owner = seedSidebarDatabase()
    owner.chats[2].id = 'chat-root-a'

    component = mount(SideChatListHarness, { target })
    await tick()

    const duplicateRows = chatRows().filter((row) => row.dataset.risuChatId === 'chat-root-a')
    expect(duplicateRows).toHaveLength(2)
    selectButtonForRow(duplicateRows[0]).click()
    rowActionButton(duplicateRows[0], 'export').click()
    await tick()

    expect(sidebarMocks.navigate).not.toHaveBeenCalled()
    expect(sidebarMocks.changeChatTo).not.toHaveBeenCalled()
    expect(sidebarMocks.exportChat).not.toHaveBeenCalled()
  })

  it('marks only the exact chat whose observer is exhausted with an accessible warning', async () => {
    seedSidebarDatabase()
    generationJobLifecycles.set({
      'job-foldered': {
        chatId: 'chat-foldered',
        jobId: 'job-foldered',
        status: 'exhausted-dead',
        reattachAttempts: 4,
        lastError: 'offline',
        updatedAt: 1,
      },
    })

    component = mount(SideChatListHarness, { target })
    await tick()

    const warningRow = rowByChatId('chat-foldered')
    const warning = warningRow.querySelector<HTMLElement>('[data-risu-generation-indicator="warning"]')
    expect(warningRow.dataset.risuChatReattachWarning).toBe('true')
    expect(warningRow.classList).toContain('ring-yellow-500')
    expect(warning?.getAttribute('role')).toBe('status')
    expect(warning?.getAttribute('aria-label')).toBe('Connection lost: Foldered Chat')
    expect(rowByChatId('chat-root-a').dataset.risuChatReattachWarning).toBeUndefined()
    expect(rowByChatId('chat-root-a').querySelector('[data-risu-generation-indicator]')).toBeNull()
  })

  it('marks unread root and folder chats and clears the exact chat when it is opened', async () => {
    seedSidebarDatabase()
    markChatUnread('chat-foldered')
    markChatUnread('chat-root-b')

    component = mount(SideChatListHarness, { target })
    await tick()

    const folderedRow = rowByChatId('chat-foldered')
    const rootRow = rowByChatId('chat-root-b')
    const folderedIndicator = folderedRow.querySelector<HTMLElement>('[data-risu-unread-indicator]')
    expect(folderedRow.dataset.risuChatUnread).toBe('true')
    expect(rootRow.dataset.risuChatUnread).toBe('true')
    expect(folderedIndicator?.getAttribute('role')).toBe('status')
    expect(folderedIndicator?.getAttribute('aria-label')).toBe(`${language.newMessage}: Foldered Chat`)
    expect(rowByChatId('chat-root-a').dataset.risuChatUnread).toBeUndefined()
    expect(rowByChatId('chat-root-a').querySelector('[data-risu-unread-indicator]')).toBeNull()

    selectButtonForRow(rootRow).click()
    await tick()

    expect(get(unreadChatIds)).toEqual(new Set(['chat-foldered']))
    expect(rootRow.dataset.risuChatUnread).toBeUndefined()
    expect(rootRow.querySelector('[data-risu-unread-indicator]')).toBeNull()
  })

  it('renders a chat with an orphaned folder reference in the root list', async () => {
    const chara = seedSidebarDatabase()
    chara.chats.push(makeChat('chat-orphan', 'Recovered Chat', 'missing-folder'))

    component = mount(SideChatListHarness, { target })
    await tick()

    expect(chatRows().map((row) => row.dataset.risuChatId)).toEqual([
      'chat-foldered',
      'chat-root-a',
      'chat-root-b',
      'chat-orphan',
    ])
    expect(rowByChatId('chat-orphan').dataset.risuChatIdx).toBe('3')
    expect(selectButtonForRow(rowByChatId('chat-orphan')).textContent).toContain('Recovered Chat')
  })

  it('renders legacy chat rows when the character has no chatFolders array', async () => {
    const chara = seedSidebarDatabase()
    delete (chara as unknown as { chatFolders?: unknown[] }).chatFolders

    component = mount(SideChatListHarness, { target })
    await tick()

    expect(chatRows().map((row) => row.dataset.risuChatId)).toEqual(['chat-root-a', 'chat-foldered', 'chat-root-b'])
    expect(selectButtonForRow(rowByChatId('chat-foldered')).textContent).toContain('Foldered Chat')
  })

  it('keeps sortable sidebar lists outside transcript custom-style hooks', async () => {
    seedSidebarDatabase()
    component = mount(SideChatListHarness, { target })
    await tick()

    expect(sidebarRoot().querySelectorAll('[data-risu-sidebar-chat-sortable-list]')).toHaveLength(2)
    expect(sidebarRoot().querySelector('.risu-chat')).toBeNull()
  })

  it('gives every icon-only chat and folder action a specific accessible name', async () => {
    seedSidebarDatabase()
    component = mount(SideChatListHarness, { target })
    await tick()

    const rootChat = rowByChatId('chat-root-a')
    expect(rowActionButton(rootChat, 'options').getAttribute('aria-label')).toBe(`${language.chatOptions}: Root Chat A`)
    expect(rowActionButton(rootChat, 'edit').getAttribute('aria-label')).toBe(`${language.edit}: Root Chat A`)
    expect(rowActionButton(rootChat, 'export').getAttribute('aria-label')).toBe(`${language.export}: Root Chat A`)
    expect(rowActionButton(rootChat, 'delete').getAttribute('aria-label')).toBe(`${language.remove}: Root Chat A`)

    const folder = folderElementById('folder-a')
    expect(rowActionButton(folder, 'folder-options').getAttribute('aria-label')).toBe(
      `${language.options}: Pinned Folder`,
    )
    expect(rowActionButton(folder, 'folder-edit').getAttribute('aria-label')).toBe(`${language.edit}: Pinned Folder`)
    expect(rowActionButton(folder, 'folder-delete').getAttribute('aria-label')).toBe(
      `${language.remove}: Pinned Folder`,
    )

    const footerActions = {
      'export-all': language.chatListExportAll,
      import: language.chatListImport,
      'edit-list': language.chatListEdit,
      branches: language.branch,
      bookmarks: language.bookmarks,
      'create-folder': language.chatListCreateFolder,
    }
    for (const [action, expectedName] of Object.entries(footerActions)) {
      expect(
        sidebarRoot().querySelector<HTMLElement>(`[data-risu-chat-action="${action}"]`)?.getAttribute('aria-label'),
      ).toBe(expectedName)
    }
  })

  it('does not open a stale branch graph after its character owner leaves during hydration', async () => {
    seedSidebarDatabase()
    let resolveHydration!: () => void
    sidebarMocks.ensureAllChatsHydrated.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveHydration = resolve
        }),
    )
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="branches"]')!.click()
    await tick()
    expect(sidebarMocks.ensureAllChatsHydrated).toHaveBeenCalledWith({ strict: true })

    charactersResourceState.currentChar = -1
    resolveHydration()
    await flushCommandWork()

    expect(sidebarMocks.alertStoreSet).not.toHaveBeenCalled()
  })

  it('reorders chats through keyboard-accessible organizer actions', async () => {
    const chara = seedSidebarDatabase()
    sidebarMocks.changeChatTo.mockImplementation((index: number) => {
      chara.chatPage = index
    })
    sidebarMocks.alertSelect.mockResolvedValueOnce('0')
    component = mount(SideChatListHarness, { target })
    await tick()

    const editList = sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="edit-list"]')!
    editList.click()
    await tick()
    expect(editList.getAttribute('aria-pressed')).toBe('true')

    const organizer = rowActionButton(rowByChatId('chat-root-b'), 'organize') as HTMLButtonElement
    expect(organizer.getAttribute('aria-label')).toBe(`${language.options}: Root Chat B`)
    organizer.focus()
    organizer.click()
    await flushCommandWork()

    expect(chara.chats.map((chat) => chat.id)).toEqual(['chat-foldered', 'chat-root-b', 'chat-root-a'])
    expect(chatRows().map((row) => row.dataset.risuChatId)).toEqual(['chat-foldered', 'chat-root-b', 'chat-root-a'])
    expect(sidebarMocks.changeChatTo).toHaveBeenCalledWith(0)
    expect(sidebarMocks.dispatchReorderChatsByIdsWithOutcome).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(rowActionButton(rowByChatId('chat-root-b'), 'organize'))
  })

  it('moves a chat into a folder through organizer choices', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.alertSelect.mockResolvedValueOnce('1').mockResolvedValueOnce('0')
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="edit-list"]')!.click()
    await tick()
    rowActionButton(rowByChatId('chat-root-a'), 'organize').click()
    await flushCommandWork()

    expect(sidebarMocks.alertSelect).toHaveBeenNthCalledWith(2, ['Pinned Folder'], language.chooseDestinationFolder)
    expect(sidebarMocks.dispatchReorderChatsByIdsWithOutcome).toHaveBeenCalledWith(
      'char-a',
      ['chat-foldered', 'chat-root-a', 'chat-root-b'],
      {
        'chat-foldered': 'folder-a',
        'chat-root-a': 'folder-a',
        'chat-root-b': null,
      },
      expect.anything(),
      'chat-foldered',
    )
  })

  it('reorders chat folders through their native options button', async () => {
    const chara = seedSidebarDatabase()
    chara.chatFolders.push({ id: 'folder-b', name: 'Second Folder', folded: false } as ChatFolder)
    chara.chats.push(makeChat('chat-second-foldered', 'Second Foldered Chat', 'folder-b'))
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.alertSelect.mockResolvedValueOnce('0')
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="edit-list"]')!.click()
    await tick()
    const organizer = rowActionButton(folderElementById('folder-b'), 'folder-options') as HTMLButtonElement
    organizer.focus()
    organizer.click()
    await flushCommandWork()

    expect(sidebarMocks.dispatchReorderChatFoldersAndChatsByIdsWithOutcome).toHaveBeenCalledWith(
      'char-a',
      ['folder-b', 'folder-a'],
      ['chat-second-foldered', 'chat-foldered', 'chat-root-a', 'chat-root-b'],
      {
        'chat-foldered': 'folder-a',
        'chat-root-a': null,
        'chat-root-b': null,
        'chat-second-foldered': 'folder-b',
      },
      expect.anything(),
      'chat-foldered',
    )
    expect(document.activeElement).toBe(organizer)
  })

  it('keeps local chat order and selection aligned when organizing folders', async () => {
    const chara = seedSidebarDatabase()
    chara.chatFolders.push({ id: 'folder-b', name: 'Second Folder', folded: false } as ChatFolder)
    chara.chats.push(makeChat('chat-second-foldered', 'Second Foldered Chat', 'folder-b'))
    chara.chatPage = 3
    sidebarMocks.changeChatTo.mockImplementation((index: number) => {
      chara.chatPage = index
    })
    sidebarMocks.alertSelect.mockResolvedValueOnce('0')
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="edit-list"]')!.click()
    await tick()
    const organizer = rowActionButton(folderElementById('folder-b'), 'folder-options') as HTMLButtonElement
    organizer.focus()
    organizer.click()
    await flushCommandWork()

    expect(chara.chatFolders.map((folder) => folder.id)).toEqual(['folder-b', 'folder-a'])
    expect(chara.chats.map((chat) => chat.id)).toEqual([
      'chat-second-foldered',
      'chat-foldered',
      'chat-root-a',
      'chat-root-b',
    ])
    expect(sidebarMocks.changeChatTo).toHaveBeenCalledWith(0)
    expect(chara.chats[chara.chatPage]?.id).toBe('chat-second-foldered')
    expect(chatRows().map((row) => row.dataset.risuChatId)).toEqual([
      'chat-second-foldered',
      'chat-foldered',
      'chat-root-a',
      'chat-root-b',
    ])
    expect(document.activeElement).toBe(rowActionButton(folderElementById('folder-b'), 'folder-options'))
  })

  it('moves a chat into a folded folder and restores focus to its visible folder action', async () => {
    const chara = seedSidebarDatabase()
    chara.chatFolders[0].folded = true
    sidebarMocks.alertSelect.mockResolvedValueOnce('1').mockResolvedValueOnce('0')
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="edit-list"]')!.click()
    await tick()
    const organizer = rowActionButton(rowByChatId('chat-root-a'), 'organize') as HTMLButtonElement
    organizer.focus()
    organizer.click()
    await flushCommandWork()

    expect(chara.chats.find((chat) => chat.id === 'chat-root-a')?.folderId).toBe('folder-a')
    expect(folderPanelById('folder-a').hidden).toBe(true)
    expect(document.activeElement).toBe(rowActionButton(folderElementById('folder-a'), 'folder-options'))
  })

  it('supports within-folder moves and moving a chat back to the root list', async () => {
    const chara = seedSidebarDatabase()
    chara.chats.push(makeChat('chat-foldered-second', 'Second Foldered Chat', 'folder-a'))
    sidebarMocks.alertSelect.mockResolvedValueOnce('0').mockResolvedValueOnce('1')
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="edit-list"]')!.click()
    await tick()
    rowActionButton(rowByChatId('chat-foldered-second'), 'organize').click()
    await flushCommandWork()

    expect(chara.chats.map((chat) => chat.id)).toEqual([
      'chat-foldered-second',
      'chat-foldered',
      'chat-root-a',
      'chat-root-b',
    ])

    rowActionButton(rowByChatId('chat-foldered-second'), 'organize').click()
    await flushCommandWork()

    expect(chara.chats.find((chat) => chat.id === 'chat-foldered-second')?.folderId).toBeNull()
    expect(chara.chats.map((chat) => chat.id)).toEqual([
      'chat-foldered',
      'chat-root-a',
      'chat-root-b',
      'chat-foldered-second',
    ])
  })

  it('rebuilds organizer moves from current chats after an async choice', async () => {
    const chara = seedSidebarDatabase()
    let resolveSelection!: (selection: string) => void
    sidebarMocks.alertSelect.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveSelection = resolve
        }),
    )
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="edit-list"]')!.click()
    await tick()
    rowActionButton(rowByChatId('chat-root-b'), 'organize').click()
    await Promise.resolve()
    chara.chats.push(makeChat('chat-added', 'Added Chat'))
    resolveSelection('0')
    await flushCommandWork()

    expect(chara.chats.map((chat) => chat.id)).toEqual(['chat-foldered', 'chat-root-b', 'chat-root-a', 'chat-added'])
  })

  it('does not finish a pending chat move after the selected character changes', async () => {
    const original = seedSidebarDatabase()
    let resolveFolderSelection!: (selection: string) => void
    sidebarMocks.alertSelect.mockResolvedValueOnce('1').mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFolderSelection = resolve
        }),
    )
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="edit-list"]')!.click()
    await tick()
    rowActionButton(rowByChatId('chat-root-a'), 'organize').click()
    await Promise.resolve()
    await tick()
    expect(sidebarMocks.alertSelect).toHaveBeenCalledTimes(2)

    const replacement = appendCharacterCopy(original, 'char-b')
    selectedCharID.set(1)
    await tick()
    resolveFolderSelection('0')
    await flushCommandWork()

    expect(original.chats.map((chat) => [chat.id, chat.folderId])).toEqual([
      ['chat-root-a', null],
      ['chat-foldered', 'folder-a'],
      ['chat-root-b', null],
    ])
    expect(replacement.chats.map((chat) => [chat.id, chat.folderId])).toEqual([
      ['chat-root-a', null],
      ['chat-foldered', 'folder-a'],
      ['chat-root-b', null],
    ])
    expect(sidebarMocks.dispatchReorderChatsByIdsWithOutcome).not.toHaveBeenCalled()
  })

  it('does not finish a pending folder color change for a newly selected character', async () => {
    const original = seedSidebarDatabase()
    let resolveColorSelection!: (selection: string) => void
    sidebarMocks.alertSelect.mockResolvedValueOnce('0').mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveColorSelection = resolve
        }),
    )
    component = mount(SideChatListHarness, { target })
    await tick()

    rowActionButton(folderElementById('folder-a'), 'folder-options').click()
    await Promise.resolve()
    await tick()
    expect(sidebarMocks.alertSelect).toHaveBeenCalledTimes(2)

    const replacement = appendCharacterCopy(original, 'char-b')
    selectedCharID.set(1)
    await tick()
    resolveColorSelection('0')
    await flushCommandWork()

    expect(original.chatFolders[0].color).toBeUndefined()
    expect(replacement.chatFolders[0].color).toBeUndefined()
    expect(sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome).not.toHaveBeenCalled()
  })

  it('omits all reorder actions when a chat id is incomplete', async () => {
    const chara = seedSidebarDatabase()
    ;(chara.chats[0] as { id?: string }).id = undefined
    chara.chatFolders.push({ id: 'folder-b', name: 'Second Folder', folded: false } as ChatFolder)
    sidebarMocks.alertSelect.mockResolvedValueOnce(null)
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="edit-list"]')!.click()
    await tick()

    expect(sidebarRoot().querySelector('[data-risu-chat-action="organize"]')).toBeNull()
    rowActionButton(folderElementById('folder-b'), 'folder-options').click()
    await flushCommandWork()
    expect(sidebarMocks.alertSelect).toHaveBeenNthCalledWith(
      1,
      [language.changeFolderColor],
      `${language.options}: Second Folder`,
    )
    expect(sidebarMocks.dispatchReorderChatFoldersAndChatsByIdsWithOutcome).not.toHaveBeenCalled()
    expect(chara.chats).toHaveLength(3)
  })

  it('fails closed when organizer ids are duplicated', async () => {
    const chara = seedSidebarDatabase()
    chara.chats[0].id = 'chat-foldered'
    chara.chatFolders.push({ id: 'folder-a', name: 'Duplicate Folder', folded: false } as ChatFolder)
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="edit-list"]')!.click()
    await tick()

    expect(sidebarRoot().querySelector('[data-risu-chat-action="organize"]')).toBeNull()
    rowActionButton(folderElementById('folder-a'), 'folder-options').click()
    await flushCommandWork()
    expect(sidebarMocks.alertSelect).not.toHaveBeenCalled()
    expect(sidebarMocks.dispatchReorderChatFoldersAndChatsByIdsWithOutcome).not.toHaveBeenCalled()
    expect(chara.chats).toHaveLength(3)
  })

  it('uses native sibling buttons for chat and folder actions', async () => {
    const chara = seedSidebarDatabase()
    component = mount(SideChatListHarness, { target })
    await tick()

    const chatExport = rowActionButton(rowByChatId('chat-root-a'), 'export')
    expect(chatExport).toBeInstanceOf(HTMLButtonElement)
    chatExport.click()
    await vi.waitFor(() => expect(sidebarMocks.exportChat).toHaveBeenCalledTimes(1))
    rowActionButton(rowByChatId('chat-foldered'), 'export').click()
    await vi.waitFor(() => expect(sidebarMocks.exportChat).toHaveBeenCalledTimes(2))
    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="export-all"]')!.click()
    chara.chats.reverse()
    await vi.waitFor(() => {
      expect(sidebarMocks.exportAllChats).toHaveBeenCalledOnce()
    })

    expect(sidebarMocks.exportChat.mock.calls).toEqual([
      [{ characterId: 'char-a', chatId: 'chat-root-a' }],
      [{ characterId: 'char-a', chatId: 'chat-foldered' }],
    ])
    expect(sidebarMocks.exportAllChats).toHaveBeenCalledWith('char-a')

    const folderDelete = rowActionButton(folderElementById('folder-a'), 'folder-delete')
    expect(folderDelete).toBeInstanceOf(HTMLButtonElement)
    folderDelete.click()
    await flushCommandWork()

    expect(sidebarMocks.alertConfirm).toHaveBeenCalledWith('Remove Pinned Folder')
    expect(sidebarRoot().querySelector('button button, button input, button [role="button"]')).toBeNull()
  })

  it.each([
    { name: 'failed download', exportSucceeded: false, confirmations: [] as boolean[], expectedConfirmations: 0 },
    { name: 'first cancellation', exportSucceeded: true, confirmations: [false], expectedConfirmations: 1 },
    { name: 'second cancellation', exportSucceeded: true, confirmations: [true, false], expectedConfirmations: 2 },
  ])('does not reset chats after a $name', async ({ exportSucceeded, confirmations, expectedConfirmations }) => {
    const chara = seedSidebarDatabase()
    sidebarMocks.exportAllChats.mockResolvedValueOnce(
      exportSucceeded ? successfulExport(chara.chats) : { success: false },
    )
    for (const confirmed of confirmations) sidebarMocks.alertConfirm.mockResolvedValueOnce(confirmed)
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="export-all"]')!.click()
    await flushCommandWork()

    expect(sidebarMocks.alertConfirm).toHaveBeenCalledTimes(expectedConfirmations)
    expect(sidebarMocks.dispatchResetChatsWithOutcome).not.toHaveBeenCalled()
    expect(chara.chats.map((chat) => chat.name)).toEqual(['Root Chat A', 'Foldered Chat', 'Root Chat B'])
  })

  it('resets every chat to an empty Chat 1 only after two confirmations', async () => {
    const chara = seedSidebarDatabase()
    sidebarMocks.exportAllChats.mockResolvedValueOnce(successfulExport(chara.chats))
    sidebarMocks.alertConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true)
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="export-all"]')!.click()
    await flushCommandWork()

    expect(sidebarMocks.alertConfirm.mock.calls).toEqual([
      [language.chatListDeleteAllAfterExportConfirm],
      [language.chatListDeleteAllSecondConfirm],
    ])
    expect(sidebarMocks.dispatchResetChatsWithOutcome).toHaveBeenCalledOnce()
    const [characterId, replacementChat, previous] = sidebarMocks.dispatchResetChatsWithOutcome.mock.calls[0]
    expect(characterId).toBe('char-a')
    expect(replacementChat).toMatchObject({ name: 'Chat 1', message: [], note: '', localLore: [], fmIndex: -1 })
    expect(previous).toMatchObject({ kind: 'chat-reset', characterId: 'char-a', chatPage: 1 })
    expect(previous).not.toHaveProperty('characters')
    expect(previous.chats.map((chat: Chat) => chat.name)).toEqual(['Root Chat A', 'Foldered Chat', 'Root Chat B'])
    expect(chara.chats).toEqual([replacementChat])
    expect(chara.chatPage).toBe(0)
    expect(chara.chatFolders).toEqual([{ id: 'folder-a', name: 'Pinned Folder', folded: false }])
    expect(sidebarMocks.navigate).toHaveBeenCalledWith(`/character/char-a/${replacementChat.id}`, { replace: true })
  })

  it('aborts reset when a message is appended after the export fence is captured', async () => {
    const chara = seedSidebarDatabase()
    chara.chats[0].message = [{ role: 'user', data: 'exported message', chatId: 'message-1' }]
    sidebarMocks.exportAllChats.mockResolvedValueOnce(successfulExport(chara.chats))
    sidebarMocks.alertConfirm.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      chara.chats[0].message.push({ role: 'char', data: 'arrived after export', chatId: 'message-2' })
      return true
    })
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="export-all"]')!.click()
    await flushCommandWork()

    expect(sidebarMocks.alertError).toHaveBeenCalledWith(language.chatListDeleteAllExportChanged)
    expect(sidebarMocks.dispatchResetChatsWithOutcome).not.toHaveBeenCalled()
    expect(chara.chats).toHaveLength(3)
    expect(chara.chats[0].message.map((message) => message.data)).toEqual(['exported message', 'arrived after export'])
  })

  it.each(['added', 'removed'] as const)('aborts reset when a chat is %s after export', async (drift) => {
    const chara = seedSidebarDatabase()
    sidebarMocks.exportAllChats.mockResolvedValueOnce(successfulExport(chara.chats))
    sidebarMocks.alertConfirm.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      if (drift === 'added') chara.chats.push(makeChat('chat-new', 'New Chat'))
      else chara.chats.splice(0, 1)
      return true
    })
    component = mount(SideChatListHarness, { target })
    await tick()

    sidebarRoot().querySelector<HTMLButtonElement>('[data-risu-chat-action="export-all"]')!.click()
    await flushCommandWork()

    expect(sidebarMocks.alertError).toHaveBeenCalledWith(language.chatListDeleteAllExportChanged)
    expect(sidebarMocks.dispatchResetChatsWithOutcome).not.toHaveBeenCalled()
    expect(chara.chats.map((chat) => chat.name)).toEqual(
      drift === 'added'
        ? ['Root Chat A', 'Foldered Chat', 'Root Chat B', 'New Chat']
        : ['Foldered Chat', 'Root Chat B'],
    )
  })

  it('remints copied message ids before dispatching a server-backed chat copy', async () => {
    const chara = seedSidebarDatabase()
    chara.chats[0].message = [
      { chatId: 'root-message-0', data: 'first root message', role: 'user' },
      {
        chatId: 'root-message-1',
        data: 'second root message',
        role: 'char',
        generationInfo: { generationId: 'root-message-1' },
      },
    ]
    chara.chats[0].bookmarks = ['root-message-0']
    chara.chats[0].bookmarkNames = { 'root-message-0': 'Opening' }
    chara.chats[0].hypaV3Data = {
      summaries: [{ chatMemos: ['root-message-0', 'root-message-1'] }],
    } as Chat['hypaV3Data']
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.alertChatOptions.mockResolvedValueOnce(0)

    component = mount(SideChatListHarness, { target })
    await tick()

    rowActionButton(rowByChatId('chat-root-a'), 'options').click()
    await flushCommandWork()

    expect(sidebarMocks.dispatchForkChatWithOutcome).toHaveBeenCalledOnce()
    const [sourceChatId, , payload] = sidebarMocks.dispatchForkChatWithOutcome.mock.calls[0] as [
      string,
      unknown,
      { chat: Chat },
    ]
    expect(sourceChatId).toBe('chat-root-a')
    expect(payload.chat.name).toBe('Root Chat A Copy')
    expect(payload.chat.id).not.toBe('chat-root-a')
    expect(payload.chat.message.map((message) => ({ data: message.data, role: message.role }))).toEqual([
      { data: 'first root message', role: 'user' },
      { data: 'second root message', role: 'char' },
    ])
    expect(payload.chat.message.map((message) => message.chatId)).not.toContain('root-message-0')
    expect(payload.chat.message.map((message) => message.chatId)).not.toContain('root-message-1')
    expect(new Set(payload.chat.message.map((message) => message.chatId)).size).toBe(payload.chat.message.length)
    const [firstForkedMessageId, secondForkedMessageId] = payload.chat.message.map((message) => message.chatId)
    expect(payload.chat.bookmarks).toEqual([firstForkedMessageId])
    expect(payload.chat.bookmarkNames).toEqual({ [firstForkedMessageId!]: 'Opening' })
    expect(payload.chat.message[1].generationInfo?.generationId).toBe(secondForkedMessageId)
    expect(payload.chat.hypaV3Data?.summaries?.[0]?.chatMemos).toEqual([firstForkedMessageId, secondForkedMessageId])
    expect(chara.chats[0].message.map((message) => message.chatId)).toEqual(['root-message-0', 'root-message-1'])
    expect(chara.chats[0].bookmarks).toEqual(['root-message-0'])
  })

  it('hydrates an unopened chat before dispatching a server-backed copy', async () => {
    const chara = seedSidebarDatabase()
    chara.chats[0].message = []
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.alertChatOptions.mockResolvedValueOnce(0)
    sidebarMocks.hydrateChatMessages.mockImplementationOnce(async () => {
      withTestDatabaseWrite(() => {
        chara.chats[0].message = [
          { chatId: 'server-message-0', data: 'loaded from server', role: 'user' },
          { chatId: 'server-message-1', data: 'complete history', role: 'char' },
        ]
      })
    })

    component = mount(SideChatListHarness, { target })
    await tick()

    rowActionButton(rowByChatId('chat-root-a'), 'options').click()
    await flushCommandWork()

    expect(sidebarMocks.hydrateChatMessages).toHaveBeenCalledWith('chat-root-a', { strict: true })
    const payload = sidebarMocks.dispatchForkChatWithOutcome.mock.calls[0]?.[2] as { chat: Chat }
    expect(payload.chat.message.map((message) => message.data)).toEqual(['loaded from server', 'complete history'])
    expect(payload.chat.message.map((message) => message.chatId)).not.toContain('server-message-0')
  })

  it('does not copy an unopened chat when strict hydration fails', async () => {
    seedSidebarDatabase().chats[0].message = []
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.alertChatOptions.mockResolvedValueOnce(0)
    sidebarMocks.hydrateChatMessages.mockRejectedValueOnce(new Error('offline'))

    component = mount(SideChatListHarness, { target })
    await tick()

    rowActionButton(rowByChatId('chat-root-a'), 'options').click()
    await flushCommandWork()

    expect(sidebarMocks.dispatchForkChatWithOutcome).not.toHaveBeenCalled()
    expect(sidebarMocks.alertError).toHaveBeenCalledWith('Chat data could not be loaded.')
  })

  it('does not request generation toggles when the mounted character is a reader', async () => {
    await beginWriterDraftCaptureTest()
    try {
      seedSidebarDatabase()
      sidebarMocks.setCurrentRoute({
        kind: 'character',
        path: '/character/char-a/chat-foldered',
        chaId: 'char-a',
        chatId: 'chat-foldered',
      })
      demoteClientSession()
      component = mount(SideChatListHarness, { target })
      await flushCommandWork()
      expect(togglesLoaderMocks.load).not.toHaveBeenCalled()
      expect(target.querySelector('[data-risu-lazy-surface="chat-generation-toggles"]')).toBeNull()
      expect(target.querySelector('[data-testid="side-chat-list-toggles-stub"]')).toBeNull()
    } finally {
      if (component) {
        await unmount(component)
        component = undefined
      }
      await endWriterDraftCaptureTest()
    }
  })

  it('does not mount generation toggles after their pending import loses writer authority', async () => {
    let resolveToggles!: () => void
    togglesLoaderMocks.pending = new Promise<void>((resolve) => {
      resolveToggles = resolve
    })
    await beginWriterDraftCaptureTest()
    try {
      seedSidebarDatabase()
      sidebarMocks.setCurrentRoute({
        kind: 'character',
        path: '/character/char-a/chat-foldered',
        chaId: 'char-a',
        chatId: 'chat-foldered',
      })
      component = mount(SideChatListHarness, { target })
      await vi.waitFor(() => expect(togglesLoaderMocks.load).toHaveBeenCalledOnce())
      expect(
        target
          .querySelector('[data-risu-lazy-surface="chat-generation-toggles"]')
          ?.getAttribute('data-risu-lazy-state'),
      ).toBe('pending')
      demoteClientSession()
      await tick()
      resolveToggles()
      await vi.waitFor(() => expect(togglesLoaderMocks.resolved).toHaveBeenCalledOnce())
      await flushCommandWork()
      expect(target.querySelector('[data-risu-lazy-surface="chat-generation-toggles"]')).toBeNull()
      expect(target.querySelector('[data-testid="side-chat-list-toggles-stub"]')).toBeNull()
    } finally {
      resolveToggles()
      togglesLoaderMocks.pending = undefined
      if (component) {
        await unmount(component)
        component = undefined
      }
      await endWriterDraftCaptureTest()
    }
  })

  it('shows active-chat controls instead of the chat list on a chat route', async () => {
    seedSidebarDatabase()
    sidebarMocks.setCurrentRoute({
      kind: 'character',
      path: '/character/char-a/chat-foldered',
      chaId: 'char-a',
      chatId: 'chat-foldered',
    })

    component = mount(SideChatListHarness, { target })
    await tick()

    expect(sidebarRoot().dataset.risuChatOpen).toBe('true')
    expect(chatRows()).toEqual([])
    expect(target.querySelector('[data-risu-chat-author-note]')).toBeTruthy()
    await vi.waitFor(() => expect(target.querySelector('[data-testid="side-chat-list-toggles-stub"]')).toBeTruthy())

    backToChatListButton().click()
    await tick()

    expect(sidebarMocks.navigate).toHaveBeenCalledWith('/character/char-a')
  })

  it('keeps foldered chat row indexes tied to original chat positions', async () => {
    const chara = seedSidebarDatabase()
    chara.chats.push(makeChat('chat-foldered-second', 'Second Foldered Chat', 'folder-a'))

    component = mount(SideChatListHarness, { target })
    await tick()

    expect(
      chatRows().map((row) => ({
        id: row.dataset.risuChatId,
        index: row.dataset.risuChatIdx,
      })),
    ).toEqual([
      { id: 'chat-foldered', index: '1' },
      { id: 'chat-foldered-second', index: '3' },
      { id: 'chat-root-a', index: '0' },
      { id: 'chat-root-b', index: '2' },
    ])
  })

  it('dispatches combined folder and chat reorder helper for server-backed folder drag', async () => {
    const chara = seedSidebarDatabase()
    chara.chatFolders.push({ id: 'folder-b', name: 'Second Folder', folded: false } as any)
    chara.chats.push(makeChat('chat-second-foldered', 'Second Foldered Chat', 'folder-b'))
    sidebarMocks.setServerCommandsEnabled(true)

    component = mount(SideChatListHarness, { target })
    await tick()

    const folderA = folderElementById('folder-a')
    const folderB = folderElementById('folder-b')
    const folderContainer = folderA.parentElement
    expect(folderContainer, 'folder container').toBeTruthy()
    folderContainer!.insertBefore(folderB, folderA)

    const folderSortable = sidebarMocks.SortableMock.create.mock.results.at(-1)?.value as {
      options: { onEnd: (event: { to: HTMLElement }) => Promise<void> }
    }
    await folderSortable.options.onEnd({ to: folderContainer! })

    expect(sidebarMocks.dispatchReorderChatFoldersAndChatsByIdsWithOutcome).toHaveBeenCalledOnce()
    const [characterId, folderIds, chatIds, folderByChatId, previous, selectedChatId] =
      sidebarMocks.dispatchReorderChatFoldersAndChatsByIdsWithOutcome.mock.calls[0]
    expect(characterId).toBe('char-a')
    expect(folderIds).toEqual(['folder-b', 'folder-a'])
    expect(chatIds).toEqual(['chat-second-foldered', 'chat-foldered', 'chat-root-a', 'chat-root-b'])
    expect(folderByChatId).toEqual({
      'chat-foldered': 'folder-a',
      'chat-root-a': null,
      'chat-root-b': null,
      'chat-second-foldered': 'folder-b',
    })
    expect(previous).toEqual({
      kind: 'chat-order',
      selectedCharID: 0,
      characterId: 'char-a',
      previousFolderIds: ['folder-a', 'folder-b'],
      previousIds: ['chat-root-a', 'chat-foldered', 'chat-root-b', 'chat-second-foldered'],
      previousFolderByChatId: {
        'chat-root-a': { previous: null, previousHadValue: true },
        'chat-foldered': { previous: 'folder-a', previousHadValue: true },
        'chat-root-b': { previous: null, previousHadValue: true },
        'chat-second-foldered': { previous: 'folder-b', previousHadValue: true },
      },
    })
    expect(selectedChatId).toBe('chat-foldered')
    expect(sidebarMocks.reorderChatFoldersCommand).not.toHaveBeenCalled()
    expect(sidebarMocks.reorderChatsCommand).not.toHaveBeenCalled()
  })

  it('uses DOM chat ids instead of live indexes when chat projection changes during drag', async () => {
    const chara = seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)

    component = mount(SideChatListHarness, { target })
    await tick()

    const rootA = rowByChatId('chat-root-a')
    const rootB = rowByChatId('chat-root-b')
    const rootContainer = rootA.parentElement
    expect(rootContainer, 'root chat sortable container').toBeTruthy()
    rootContainer!.insertBefore(rootB, rootA)

    const liveChatsById = new Map(chara.chats.map((chat) => [chat.id, chat]))
    chara.chats = [
      liveChatsById.get('chat-root-b')!,
      liveChatsById.get('chat-foldered')!,
      liveChatsById.get('chat-root-a')!,
    ]

    await sortableForElement(rootContainer!).options.onEnd({ to: rootContainer! })

    expect(sidebarMocks.dispatchReorderChatsByIdsWithOutcome).toHaveBeenCalledOnce()
    const [characterId, chatIds, folderByChatId, previous, selectedChatId] =
      sidebarMocks.dispatchReorderChatsByIdsWithOutcome.mock.calls[0]
    expect(characterId).toBe('char-a')
    expect(chatIds).toEqual(['chat-foldered', 'chat-root-b', 'chat-root-a'])
    expect(folderByChatId).toEqual({
      'chat-foldered': 'folder-a',
      'chat-root-a': null,
      'chat-root-b': null,
    })
    expect(previous).toMatchObject({
      kind: 'chat-order',
      characterId: 'char-a',
      previousIds: ['chat-root-b', 'chat-foldered', 'chat-root-a'],
    })
    expect(previous).not.toHaveProperty('characters')
    expect(selectedChatId).toBe('chat-foldered')
  })

  it('uses DOM folder and chat ids when folder projection changes during drag', async () => {
    const chara = seedSidebarDatabase()
    chara.chatFolders.push({ id: 'folder-b', name: 'Second Folder', folded: false } as any)
    chara.chats.push(makeChat('chat-second-foldered', 'Second Foldered Chat', 'folder-b'))
    sidebarMocks.setServerCommandsEnabled(true)

    component = mount(SideChatListHarness, { target })
    await tick()

    const folderA = folderElementById('folder-a')
    const folderB = folderElementById('folder-b')
    const folderContainer = folderA.parentElement
    expect(folderContainer, 'folder container').toBeTruthy()
    folderContainer!.insertBefore(folderB, folderA)

    const liveFoldersById = new Map(chara.chatFolders.map((folder) => [folder.id, folder]))
    chara.chatFolders = [liveFoldersById.get('folder-b')!, liveFoldersById.get('folder-a')!]

    const liveChatsById = new Map(chara.chats.map((chat) => [chat.id, chat]))
    chara.chats = [
      liveChatsById.get('chat-root-b')!,
      liveChatsById.get('chat-second-foldered')!,
      liveChatsById.get('chat-foldered')!,
      liveChatsById.get('chat-root-a')!,
    ]

    await sortableForElement(folderContainer!).options.onEnd({ to: folderContainer! })

    expect(sidebarMocks.dispatchReorderChatFoldersAndChatsByIdsWithOutcome).toHaveBeenCalledOnce()
    const [characterId, folderIds, chatIds, folderByChatId, previous, selectedChatId] =
      sidebarMocks.dispatchReorderChatFoldersAndChatsByIdsWithOutcome.mock.calls[0]
    expect(characterId).toBe('char-a')
    expect(folderIds).toEqual(['folder-b', 'folder-a'])
    expect(chatIds).toEqual(['chat-second-foldered', 'chat-foldered', 'chat-root-a', 'chat-root-b'])
    expect(folderByChatId).toEqual({
      'chat-foldered': 'folder-a',
      'chat-root-a': null,
      'chat-root-b': null,
      'chat-second-foldered': 'folder-b',
    })
    expect(previous).toMatchObject({
      kind: 'chat-order',
      characterId: 'char-a',
      previousFolderIds: ['folder-b', 'folder-a'],
      previousIds: ['chat-root-b', 'chat-second-foldered', 'chat-foldered', 'chat-root-a'],
    })
    expect(previous).not.toHaveProperty('characters')
    expect(selectedChatId).toBe('chat-foldered')
  })

  it('fails closed and resets DOM when a live chat appears during chat drag', async () => {
    const chara = seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    component = mount(SideChatListHarness, { target })
    await tick()

    const rootA = rowByChatId('chat-root-a')
    const rootB = rowByChatId('chat-root-b')
    const rootContainer = rootA.parentElement
    expect(rootContainer, 'root chat sortable container').toBeTruthy()
    rootContainer!.insertBefore(rootB, rootA)
    chara.chats.push(makeChat('chat-added', 'Added Chat'))

    await sortableForElement(rootContainer!).options.onEnd({ to: rootContainer! })
    await tick()

    expect(sidebarMocks.dispatchReorderChatsByIdsWithOutcome).not.toHaveBeenCalled()
    expect(sidebarMocks.dispatchReorderChatFoldersAndChatsByIdsWithOutcome).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      'Ignoring stale sidebar chat reorder: current chat id "chat-added" is missing from the DOM',
    )
    expect(chatRows().map((row) => row.dataset.risuChatId)).toEqual([
      'chat-foldered',
      'chat-root-a',
      'chat-root-b',
      'chat-added',
    ])
  })

  it('hides folded folder rows without losing selected chat state', async () => {
    const chara = seedSidebarDatabase()
    chara.chatFolders[0].folded = true
    chara.chatPage = 1

    component = mount(SideChatListHarness, { target })
    await tick()

    const folder = folderElementById('folder-a')
    const folderPanel = folderPanelById('folder-a')
    const selectedRow = rowByChatId('chat-foldered')

    expect(folder.dataset.risuChatFolderFolded).toBe('true')
    expect(folderPanel.hidden).toBe(true)
    expect(chara.chatPage).toBe(1)
    expect(chara.chats[chara.chatPage]?.id).toBe('chat-foldered')
    expect(selectedRow.dataset.risuChatIdx).toBe('1')
    expect(selectedRow.dataset.risuChatFolderId).toBe('folder-a')
    expectRowSelected('chat-foldered', true)
    expectRowSelected('chat-root-a', false)
    expectRowSelected('chat-root-b', false)
  })

  it('keeps rapid chat and folder name input as drafts until their exact changes settle', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    component = mount(SideChatListHarness, { target })
    await tick()

    editButtonForRow(rowByChatId('chat-foldered')).click()
    await tick()

    const chatNameInput = inputIn(rowByChatId('chat-foldered'), 'chat name input')
    const folderNameInput = inputIn(folderElementById('folder-a'), 'folder name input')

    await setTextInputValue(chatNameInput, 'h')
    await setTextInputValue(chatNameInput, 'he')
    await setTextInputValue(chatNameInput, 'hello')
    await setTextInputValue(folderNameInput, 'f')
    await setTextInputValue(folderNameInput, 'fo')
    await setTextInputValue(folderNameInput, 'folder')

    expect(selectedCharacter().chats[1].name).toBe('Foldered Chat')
    expect(selectedCharacter().chatFolders[0].name).toBe('Pinned Folder')
    expect(chatNameInput.value).toBe('hello')
    expect(folderNameInput.value).toBe('folder')

    chatNameInput.dispatchEvent(new Event('change', { bubbles: true }))
    folderNameInput.dispatchEvent(new Event('change', { bubbles: true }))
    await flushCommandWork()

    expect(selectedCharacter().chats[1].name).toBe('hello')
    expect(selectedCharacter().chatFolders[0].name).toBe('folder')
    expect(sidebarMocks.dispatchChatMetadataPatchWithOutcome).toHaveBeenCalledWith(
      {
        selectedCharID: 0,
        characterId: 'char-a',
        chatId: 'chat-foldered',
        metadata: { name: 'Foldered Chat' },
        attempted: { name: 'hello' },
      },
      expect.any(Function),
    )
    expect(sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome).toHaveBeenCalledWith(
      {
        selectedCharID: 0,
        characterId: 'char-a',
        folderId: 'folder-a',
        metadata: { name: 'Pinned Folder' },
        attempted: { name: 'folder' },
      },
      expect.any(Function),
    )
    expect(currentChatStateSnapshot).not.toHaveBeenCalled()
  })

  it('keeps folder rename as a draft when writer loss revokes server commands', async () => {
    seedSidebarDatabase()
    component = mount(SideChatListHarness, { target })
    await tick()
    editButtonForRow(rowByChatId('chat-foldered')).click()
    await tick()
    writerAccessMocks.lost = true
    const input = inputIn(folderElementById('folder-a'), 'folder name input')
    await setTextInputValue(input, 'Unsaved folder draft')
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(selectedCharacter().chatFolders[0].name).toBe('Pinned Folder')
    expect(input.value).toBe('Unsaved folder draft')
    expect(writerAccessMocks.report).toHaveBeenCalled()
    expect(sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome).not.toHaveBeenCalled()
    expect(currentChatStateSnapshot).not.toHaveBeenCalled()
  })

  it('keeps folder, foldered-chat, and unfiled-chat rename inputs enabled while saves are pending', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    const folderedRename = sidebarMocks.createDeferredUpdateCommand()
    const unfiledRename = sidebarMocks.createDeferredUpdateCommand()
    const folderRename = sidebarMocks.createDeferredUpdateCommand()
    sidebarMocks.dispatchChatMetadataPatchWithOutcome
      .mockImplementationOnce(() => folderedRename.promise as Promise<any>)
      .mockImplementationOnce(() => unfiledRename.promise as Promise<any>)
    sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome.mockImplementationOnce(
      () => folderRename.promise as Promise<any>,
    )

    component = mount(SideChatListHarness, { target })
    await tick()
    editButtonForRow(rowByChatId('chat-foldered')).click()
    await tick()

    const folderedInput = inputIn(rowByChatId('chat-foldered'), 'foldered chat name input')
    const unfiledInput = inputIn(rowByChatId('chat-root-a'), 'unfiled chat name input')
    const folderInput = inputIn(folderElementById('folder-a'), 'folder name input')
    for (const [input, value] of [
      [folderedInput, 'Pending Foldered Chat'],
      [unfiledInput, 'Pending Root Chat'],
      [folderInput, 'Pending Folder'],
    ] as const) {
      await setTextInputValue(input, value)
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await tick()
      expect(input.disabled).toBe(false)
      input.focus()
      expect(document.activeElement).toBe(input)
    }

    expect(sidebarMocks.dispatchChatMetadataPatchWithOutcome).toHaveBeenCalledTimes(2)
    expect(sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome).toHaveBeenCalledOnce()

    folderedRename.resolve({ status: 'accepted', result: { revision: 1, status: 'ok' } })
    unfiledRename.resolve({ status: 'accepted', result: { revision: 2, status: 'ok' } })
    folderRename.resolve({ status: 'accepted', result: { revision: 3, status: 'ok' } })
    await flushCommandWork()
  })

  it('supersedes pending chat and folder renames while preserving the latest draft on an older failure', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    const firstChatRename = sidebarMocks.createDeferredUpdateCommand()
    const finalChatRename = sidebarMocks.createDeferredUpdateCommand()
    const firstFolderRename = sidebarMocks.createDeferredUpdateCommand()
    sidebarMocks.dispatchChatMetadataPatchWithOutcome
      .mockImplementationOnce(async (previous, rollback) => {
        const outcome = (await firstChatRename.promise) as any
        if (outcome.status === 'failed') {
          rollback(previous)
        }
        return outcome
      })
      .mockImplementationOnce(() => finalChatRename.promise as Promise<any>)
    sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome
      .mockImplementationOnce(() => firstFolderRename.promise as Promise<any>)
      .mockResolvedValueOnce({ status: 'accepted', result: { revision: 4, status: 'ok' } })

    component = mount(SideChatListHarness, { target })
    await tick()
    editButtonForRow(rowByChatId('chat-root-a')).click()
    await tick()

    const chatInput = inputIn(rowByChatId('chat-root-a'), 'chat name input')
    await setTextInputValue(chatInput, 'First Sidebar Rename')
    chatInput.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    await setTextInputValue(chatInput, 'Final Sidebar Rename')
    chatInput.dispatchEvent(new Event('change', { bubbles: true }))

    const folderInput = inputIn(folderElementById('folder-a'), 'folder name input')
    await setTextInputValue(folderInput, 'First Folder Rename')
    folderInput.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    await setTextInputValue(folderInput, 'Final Folder Rename')
    folderInput.dispatchEvent(new Event('change', { bubbles: true }))
    await flushCommandWork()

    expect(sidebarMocks.dispatchChatMetadataPatchWithOutcome.mock.calls.map((call) => call[0].attempted)).toEqual([
      { name: 'First Sidebar Rename' },
      { name: 'Final Sidebar Rename' },
    ])
    expect(sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome.mock.calls.map((call) => call[0].attempted)).toEqual(
      [{ name: 'First Folder Rename' }, { name: 'Final Folder Rename' }],
    )

    firstChatRename.resolve({ status: 'failed', result: { status: 'error', error: 'rename failed' } })
    firstFolderRename.resolve({ status: 'accepted', result: { revision: 3, status: 'ok' } })
    await flushCommandWork()

    expect(selectedCharacter().chats[0].name).toBe('Final Sidebar Rename')
    expect(selectedCharacter().chatFolders[0].name).toBe('Final Folder Rename')
    expect(inputIn(rowByChatId('chat-root-a'), 'chat name input').value).toBe('Final Sidebar Rename')
    expect(inputIn(folderElementById('folder-a'), 'folder name input').value).toBe('Final Folder Rename')
    expect(sidebarMocks.alertError).toHaveBeenCalledWith('Edit: First Sidebar Rename failed')
    expect(sidebarRoot().querySelector('[role="alert"]')?.textContent).toContain('Edit: First Sidebar Rename failed')
    expect(
      sidebarRoot().querySelectorAll(
        '[data-risu-chat-mutation][data-risu-chat-mutation-status="pending"][role="status"]',
      ),
    ).toHaveLength(0)
    expect(rowByChatId('chat-root-a').dataset.risuChatMutationStatus).toBe('pending')

    finalChatRename.resolve({ status: 'accepted', result: { revision: 2, status: 'ok' } })
    await flushCommandWork()

    expect(sidebarRoot().querySelector('[role="alert"]')).toBeNull()
    expect(
      sidebarRoot().querySelectorAll('[data-risu-chat-mutation][data-risu-chat-mutation-status="failed"]'),
    ).toHaveLength(0)
    expect(rowByChatId('chat-root-a').dataset.risuChatMutationStatus).toBe('')
  })

  it('clears failed chat and folder rename entries when later retries succeed', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    const failedChatRename = sidebarMocks.createDeferredUpdateCommand()
    const failedFolderRename = sidebarMocks.createDeferredUpdateCommand()
    sidebarMocks.dispatchChatMetadataPatchWithOutcome.mockImplementationOnce(
      () => failedChatRename.promise as Promise<any>,
    )
    sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome.mockImplementationOnce(
      () => failedFolderRename.promise as Promise<any>,
    )

    component = mount(SideChatListHarness, { target })
    await tick()
    editButtonForRow(rowByChatId('chat-root-a')).click()
    await tick()

    const chatInput = inputIn(rowByChatId('chat-root-a'), 'chat name input')
    const folderInput = inputIn(folderElementById('folder-a'), 'folder name input')
    await setTextInputValue(chatInput, 'Failed Sidebar Rename')
    chatInput.dispatchEvent(new Event('change', { bubbles: true }))
    await setTextInputValue(folderInput, 'Failed Folder Rename')
    folderInput.dispatchEvent(new Event('change', { bubbles: true }))
    failedChatRename.resolve({ status: 'failed', result: { status: 'error', error: 'chat rename failed' } })
    failedFolderRename.resolve({ status: 'failed', result: { status: 'error', error: 'folder rename failed' } })
    await flushCommandWork()

    expect(sidebarRoot().querySelectorAll('[data-risu-chat-mutation-status="failed"][role="alert"]')).toHaveLength(2)

    await setTextInputValue(chatInput, 'Successful Sidebar Retry')
    chatInput.dispatchEvent(new Event('change', { bubbles: true }))
    await setTextInputValue(folderInput, 'Successful Folder Retry')
    folderInput.dispatchEvent(new Event('change', { bubbles: true }))
    await flushCommandWork()

    expect(sidebarRoot().querySelector('[role="alert"]')).toBeNull()
    expect(
      sidebarRoot().querySelectorAll('[data-risu-chat-mutation][data-risu-chat-mutation-status="failed"]'),
    ).toHaveLength(0)
    expect(rowByChatId('chat-root-a').dataset.risuChatMutationStatus).toBe('')
    expect(folderElementById('folder-a').dataset.risuChatMutationStatus).toBe('')
  })

  it('does not clear a newer pending rename when an older attempt succeeds', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    const firstRename = sidebarMocks.createDeferredUpdateCommand()
    const secondRename = sidebarMocks.createDeferredUpdateCommand()
    sidebarMocks.dispatchChatMetadataPatchWithOutcome
      .mockImplementationOnce(() => firstRename.promise as Promise<any>)
      .mockImplementationOnce(() => secondRename.promise as Promise<any>)

    component = mount(SideChatListHarness, { target })
    await tick()
    editButtonForRow(rowByChatId('chat-root-a')).click()
    await tick()

    const input = inputIn(rowByChatId('chat-root-a'), 'chat name input')
    await setTextInputValue(input, 'Older Sidebar Rename')
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    await setTextInputValue(input, 'Newer Pending Sidebar Rename')
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()

    firstRename.resolve({ status: 'accepted', result: { revision: 1, status: 'ok' } })
    await flushCommandWork()

    expect(
      sidebarRoot().querySelectorAll(
        '[data-risu-chat-mutation][data-risu-chat-mutation-status="pending"][role="status"]',
      ),
    ).toHaveLength(0)
    expect(rowByChatId('chat-root-a').dataset.risuChatMutationStatus).toBe('pending')

    secondRename.resolve({ status: 'accepted', result: { revision: 2, status: 'ok' } })
    await flushCommandWork()
    expect(rowByChatId('chat-root-a').dataset.risuChatMutationStatus).toBe('')
  })

  it('allows folder creation and organizing chat B while a rename of chat A is pending', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    const rename = sidebarMocks.createDeferredUpdateCommand()
    const createFolder = sidebarMocks.createDeferredCreateFolderCommand()
    sidebarMocks.dispatchChatMetadataPatchWithOutcome.mockImplementationOnce(() => rename.promise as Promise<any>)

    component = mount(SideChatListHarness, { target })
    await tick()
    editButtonForRow(rowByChatId('chat-root-a')).click()
    await tick()

    const renameInput = inputIn(rowByChatId('chat-root-a'), 'chat A name input')
    await setTextInputValue(renameInput, 'Pending rename A')
    renameInput.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(sidebarMocks.dispatchChatMetadataPatchWithOutcome).toHaveBeenCalledOnce()

    const organizeB = rowActionButton(rowByChatId('chat-root-b'), 'organize') as HTMLButtonElement
    expect(organizeB.disabled).toBe(false)
    organizeB.click()
    await flushCommandWork()
    expect(sidebarMocks.dispatchReorderChatsByIdsWithOutcome).toHaveBeenCalledOnce()

    expect(createFolderButton().disabled).toBe(false)
    createFolderButton().click()
    await flushCommandWork()
    expect(createFolder.input).toMatchObject({ characterId: 'char-a' })

    createFolder.resolve({ revision: 2, status: 'ok' })
    rename.resolve({ status: 'accepted', result: { revision: 3, status: 'ok' } })
    await flushCommandWork()
  })

  it('paints folder folded toggles before dispatching with the folder stable id', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome.mockImplementationOnce(async () => {
      expect(selectedCharacter().chatFolders[0].folded).toBe(true)
      return { status: 'accepted', result: { revision: 1, status: 'ok' } }
    })

    component = mount(SideChatListHarness, { target })
    await tick()

    const folder = folderElementById('folder-a')
    const header = folderHeader(folder)
    const panel = folderPanelById('folder-a')
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(header.getAttribute('aria-controls')).toBe(panel.id)

    header.click()
    await tick()

    expect(sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome).toHaveBeenCalledWith(
      {
        selectedCharID: 0,
        characterId: 'char-a',
        folderId: 'folder-a',
        metadata: { folded: false },
        attempted: { folded: true },
      },
      expect.any(Function),
    )
    expect(selectedCharacter().chatFolders[0].folded).toBe(true)
    expect(folder.dataset.risuChatFolderFolded).toBe('true')
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(panel.hidden).toBe(true)
    expect(currentChatStateSnapshot).not.toHaveBeenCalled()
  })

  it('routes a failed direct folder toggle through the owner-scoped rollback callback', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome.mockImplementationOnce(async (previous, rollback) => {
      rollback(previous)
      return { status: 'failed', result: { error: 'failed', status: 'error' } }
    })

    component = mount(SideChatListHarness, { target })
    await tick()

    folderHeader(folderElementById('folder-a')).click()
    await tick()

    expect(sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome).toHaveBeenCalledTimes(1)
    expect(selectedCharacter().chatFolders[0].folded).toBe(false)
    expect(folderElementById('folder-a').dataset.risuChatFolderFolded).toBe('false')
  })

  it('paints a selected folder color before dispatch', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.alertSelect.mockResolvedValueOnce('0').mockResolvedValueOnce('0')
    sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome.mockImplementationOnce(async () => {
      expect(selectedCharacter().chatFolders[0].color).toBe('red')
      return { status: 'accepted', result: { revision: 1, status: 'ok' } }
    })

    component = mount(SideChatListHarness, { target })
    await tick()

    rowActionButton(folderElementById('folder-a'), 'folder-options').click()
    await flushCommandWork()

    expect(sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome).toHaveBeenCalledWith(
      {
        selectedCharID: 0,
        characterId: 'char-a',
        folderId: 'folder-a',
        metadata: {},
        attempted: { color: 'red' },
      },
      expect.any(Function),
    )
    expect(selectedCharacter().chatFolders[0].color).toBe('red')
    expect(folderHeaderContainer(folderElementById('folder-a')).classList.contains('bg-red-900')).toBe(true)
    expect(currentChatStateSnapshot).not.toHaveBeenCalled()
  })

  it('does not change a folder color when the action selection is cancelled', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.alertSelect.mockResolvedValueOnce(null)

    component = mount(SideChatListHarness, { target })
    await tick()

    rowActionButton(folderElementById('folder-a'), 'folder-options').click()
    await flushCommandWork()

    expect(sidebarMocks.alertSelect).toHaveBeenCalledWith(
      [language.changeFolderColor],
      `${language.options}: Pinned Folder`,
    )
    expect(sidebarMocks.dispatchChatFolderMetadataPatchWithOutcome).not.toHaveBeenCalled()
    expect(selectedCharacter().chatFolders[0].color).toBeUndefined()
  })

  it('keeps persona unbinding pending until failure rolls state and DOM back', async () => {
    const chara = seedSidebarDatabase()
    chara.chats[1].generationSettings = {
      configured: true,
      personaId: 'persona-a',
      jailbreakToggle: false,
      sidebarToggles: {},
    }
    chara.chats[1].bindedPersona = 'legacy-persona'
    getDatabase().personas = [
      { id: 'persona-a', name: 'Persona A' },
      { id: 'legacy-persona', name: 'Legacy Persona' },
    ] as never
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.alertChatOptions.mockResolvedValueOnce(1)
    sidebarMocks.alertConfirm.mockResolvedValueOnce(true)
    const command = sidebarMocks.createDeferredGenerationSettingsCommand()

    component = mount(SideChatListHarness, { target })
    await tick()

    const options = rowActionButton(rowByChatId('chat-foldered'), 'options')
    options.click()
    await flushCommandWork()

    expect(command.settled).toBe(false)
    expect(command.input).toMatchObject({ chatId: 'chat-foldered' })
    expect((command.input as { generationSettings: Record<string, unknown> }).generationSettings).not.toHaveProperty(
      'personaId',
    )
    expect(selectedCharacter().chats[1].generationSettings).not.toHaveProperty('personaId')
    expect(selectedCharacter().chats[1].bindedPersona).toBe('legacy-persona')
    expect(options.getAttribute('aria-busy')).toBe('true')
    expect(options.getAttribute('aria-disabled')).toBe('true')
    expect(options).toBeInstanceOf(HTMLButtonElement)
    expect((options as HTMLButtonElement).disabled).toBe(true)
    expect(sidebarMocks.alertNormal).not.toHaveBeenCalled()
    expect(sidebarMocks.alertError).not.toHaveBeenCalled()

    options.click()
    await tick()
    expect(sidebarMocks.alertChatOptions).toHaveBeenCalledOnce()

    command.resolve({ error: 'persona update failed', status: 'failed' })
    await flushCommandWork()

    expect(selectedCharacter().chats[1].generationSettings?.personaId).toBe('persona-a')
    expect(selectedCharacter().chats[1].bindedPersona).toBe('legacy-persona')
    expect(options.getAttribute('aria-busy')).toBe('false')
    expect(options.getAttribute('aria-disabled')).toBe('false')
    expect((options as HTMLButtonElement).disabled).toBe(false)
    expect(sidebarMocks.alertError).toHaveBeenCalledWith('Persona binding failed')
    expect(sidebarMocks.alertNormal).not.toHaveBeenCalled()
  })

  it('shows persona binding success only after the deferred command settles', async () => {
    seedSidebarDatabase()
    getDatabase().personas = [{ id: 'persona-selected', name: 'Selected Persona' }] as never
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.alertChatOptions.mockResolvedValueOnce(1)
    sidebarMocks.alertConfirm.mockResolvedValueOnce(true)
    const command = sidebarMocks.createDeferredGenerationSettingsCommand()

    component = mount(SideChatListHarness, { target })
    await tick()

    const options = rowActionButton(rowByChatId('chat-root-a'), 'options')
    options.click()
    await flushCommandWork()

    expect(command.settled).toBe(false)
    expect(command.input).toMatchObject({
      chatId: 'chat-root-a',
      generationSettings: {
        configured: true,
        personaId: 'persona-selected',
        jailbreakToggle: false,
      },
    })
    expect(selectedCharacter().chats[0].generationSettings?.personaId).toBe('persona-selected')
    expect(selectedCharacter().chats[0].bindedPersona).toBeUndefined()
    expect(options.getAttribute('aria-busy')).toBe('true')
    expect(sidebarMocks.alertNormal).not.toHaveBeenCalled()

    command.resolve({ status: 'accepted' })
    await flushCommandWork()

    expect(options.getAttribute('aria-busy')).toBe('false')
    expect(sidebarMocks.alertError).not.toHaveBeenCalled()
    expect(sidebarMocks.alertNormal).toHaveBeenCalledWith('Persona bound')
  })

  it('reports a retained persona binding as queued without reverting the visible state', async () => {
    seedSidebarDatabase()
    getDatabase().personas = [{ id: 'persona-selected', name: 'Selected Persona' }] as never
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.alertChatOptions.mockResolvedValueOnce(1)
    sidebarMocks.alertConfirm.mockResolvedValueOnce(true)
    const command = sidebarMocks.createDeferredGenerationSettingsCommand()

    component = mount(SideChatListHarness, { target })
    await tick()

    const options = rowActionButton(rowByChatId('chat-root-a'), 'options')
    options.click()
    await flushCommandWork()

    expect(selectedCharacter().chats[0].generationSettings?.personaId).toBe('persona-selected')
    command.resolve({ status: 'queued' })
    await flushCommandWork()

    expect(selectedCharacter().chats[0].generationSettings?.personaId).toBe('persona-selected')
    expect(sidebarMocks.alertError).not.toHaveBeenCalled()
    expect(sidebarMocks.alertNormal).toHaveBeenCalledWith('Persona binding queued')
  })

  it('navigates when selecting a sidebar row and reflects the route-applied selection', async () => {
    const chara = seedSidebarDatabase()

    component = mount(SideChatListHarness, { target })
    await tick()

    expectRowSelected('chat-foldered', true)

    selectButtonForRow(rowByChatId('chat-root-b')).click()
    await tick()

    expect(sidebarMocks.navigate).toHaveBeenCalledWith('/character/char-a/chat-root-b')
    expect(sidebarMocks.updateChatCommand).not.toHaveBeenCalled()
    expect(chara.chatPage).toBe(1)
    expectRowSelected('chat-foldered', true)
    expectRowSelected('chat-root-b', false)

    chara.chatPage = 2
    await tick()

    expectRowSelected('chat-foldered', false)
    expectRowSelected('chat-root-b', true)
  })

  it('shows a pending sidebar chat but waits for acceptance before navigating', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    const command = sidebarMocks.createDeferredCreateCommand()

    component = mount(SideChatListHarness, { target })
    await tick()

    createButton().click()
    await tick()

    const chara = selectedCharacter()
    const createdChat = chara.chats[0]
    expect(command.settled).toBe(false)
    expect(createdChat.name).toBe('New Chat 4')
    expect(chara.chatPage).toBe(0)
    expectRowSelected(createdChat.id, true)
    expect(rowByChatId(createdChat.id).dataset.risuChatMutationStatus).toBe('pending')
    expect(sidebarMocks.navigate).not.toHaveBeenCalled()
    expect(command.input).toMatchObject({
      characterId: 'char-a',
      select: true,
    })

    command.resolve({ revision: 11, status: 'ok' })
    await flushCommandWork()

    expect(sidebarMocks.navigate).toHaveBeenCalledWith(`/character/char-a/${createdChat.id}`)
  })

  it('rolls back a failed optimistic sidebar chat create in state and DOM', async () => {
    const chara = seedSidebarDatabase()
    const backgroundChat = chara.chats[0]
    backgroundChat.message.push({ role: 'char', data: 'before request', chatId: 'background-before' })
    const backgroundMessages = backgroundChat.message
    const backgroundMessage = backgroundMessages[0]
    sidebarMocks.setServerCommandsEnabled(true)
    const command = sidebarMocks.createDeferredCreateCommand()

    component = mount(SideChatListHarness, { target })
    await tick()

    createButton().click()
    await tick()

    const createdChat = selectedCharacter().chats[0]
    expectRowSelected(createdChat.id, true)
    expect(selectedCharacter().chats.map((chat) => chat.name)).toEqual([
      'New Chat 4',
      'Root Chat A',
      'Foldered Chat',
      'Root Chat B',
    ])

    backgroundMessages.push({ role: 'char', data: 'arrived while pending', chatId: 'background-pending' })
    command.resolve({ error: 'create failed', status: 'error' })
    await flushCommandWork()

    expect(chatRows().map((row) => row.dataset.risuChatId)).toEqual(['chat-foldered', 'chat-root-a', 'chat-root-b'])
    expect(selectedCharacter().chats.map((chat) => chat.name)).toEqual(['Root Chat A', 'Foldered Chat', 'Root Chat B'])
    expect(selectedCharacter().chatPage).toBe(1)
    expectRowSelected('chat-foldered', true)
    expect(sidebarMocks.navigate).not.toHaveBeenCalled()
    expect(sidebarRoot().querySelector('[data-risu-chat-mutation-status="failed"]')).toBeTruthy()
    expect(chara.chats[0]).toBe(backgroundChat)
    expect(backgroundChat.message).toBe(backgroundMessages)
    expect(backgroundMessages[0]).toBe(backgroundMessage)
    expect(backgroundMessages.map((message) => message.data)).toEqual(['before request', 'arrived while pending'])
  })

  it('labels a retained sidebar create as provisional before navigating', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    let resolveOutcome!: (outcome: any) => void
    let resolveSettlement!: (outcome: any) => void
    const settlement = new Promise((resolve) => {
      resolveSettlement = resolve
    })
    sidebarMocks.setCreateOutcomeOverride(
      () =>
        new Promise((resolve) => {
          resolveOutcome = resolve
        }),
    )

    component = mount(SideChatListHarness, { target })
    await tick()

    createButton().click()
    await tick()
    const createdChat = selectedCharacter().chats[0]
    expect(sidebarMocks.navigate).not.toHaveBeenCalled()

    resolveOutcome({
      status: 'queued',
      result: { status: 'unavailable' },
      mutationIds: ['queued-sidebar-create'],
      settlement,
    })
    await flushCommandWork()

    expect(selectedCharacter().chats[0].id).toBe(createdChat.id)
    expect(sidebarMocks.alertNormal).toHaveBeenCalledWith(`${createdChat.name} is provisional`)
    expect(sidebarMocks.navigate).toHaveBeenCalledWith(`/character/char-a/${createdChat.id}`)
    expect(sidebarRoot().querySelector('[data-risu-chat-mutation][data-risu-chat-mutation-status="queued"]')).toBeNull()

    resolveSettlement({ status: 'accepted' })
    await flushCommandWork()
    expect(sidebarRoot().querySelector('[data-risu-chat-mutation-status="queued"]')).toBeNull()
  })

  it('recovers the sidebar route when a queued provisional create is finally discarded', async () => {
    const chara = seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    let resolveSettlement!: (outcome: any) => void
    const settlement = new Promise((resolve) => {
      resolveSettlement = resolve
    })
    sidebarMocks.setCreateOutcomeOverride(async () => ({
      status: 'queued',
      result: { status: 'unavailable' },
      mutationIds: ['rejected-sidebar-create'],
      settlement,
    }))

    component = mount(SideChatListHarness, { target })
    await tick()
    createButton().click()
    await flushCommandWork()
    const provisionalChatId = chara.chats[0].id
    sidebarMocks.setCurrentRoute({
      kind: 'character',
      path: `/character/char-a/${provisionalChatId}`,
      chaId: 'char-a',
      chatId: provisionalChatId,
    })

    chara.chats.splice(0, 1)
    chara.chatPage = chara.chats.findIndex((chat) => chat.id === 'chat-foldered')
    resolveSettlement({ status: 'failed', result: { status: 'error', error: 'rejected' } })
    await flushCommandWork()

    expect(sidebarMocks.navigate).toHaveBeenLastCalledWith('/character/char-a/chat-foldered', { replace: true })
  })

  it('does not let an older accepted sidebar create hijack a newer route selection', async () => {
    const chara = seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    const command = sidebarMocks.createDeferredCreateCommand()

    component = mount(SideChatListHarness, { target })
    await tick()

    createButton().click()
    await tick()
    chara.chatPage = chara.chats.findIndex((chat) => chat.id === 'chat-root-b')
    sidebarMocks.setCurrentRoute({
      kind: 'character',
      path: '/character/char-a/chat-root-b',
      chaId: 'char-a',
      chatId: 'chat-root-b',
    })
    await tick()

    command.resolve({ revision: 11, status: 'ok' })
    await flushCommandWork()

    expect(sidebarMocks.navigate).not.toHaveBeenCalled()
  })

  it('shows a newly created sidebar folder before the command resolves', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    const command = sidebarMocks.createDeferredCreateFolderCommand()

    component = mount(SideChatListHarness, { target })
    await tick()
    const initialSortables = [...sidebarMocks.SortableMock.instances]

    createFolderButton().click()
    await flushCommandWork()

    const createdFolder = selectedCharacter().chatFolders[0]
    expect(command.settled).toBe(false)
    expect(createdFolder.name).toBe('New Folder 2')
    expect(folderElementById(createdFolder.id).textContent).toContain('New Folder 2')
    expect(selectedCharacter().chatFolders.map((folder) => folder.name)).toEqual(['New Folder 2', 'Pinned Folder'])
    expect(command.input).toMatchObject({
      characterId: 'char-a',
      folder: {
        id: createdFolder.id,
        name: 'New Folder 2',
        folded: false,
      },
    })
    expect(initialSortables.every((sortable) => sortable.destroy.mock.calls.length === 1)).toBe(true)
    expect(activeSortablesForElement(folderPanelById(createdFolder.id))).toHaveLength(1)

    command.resolve({ revision: 12, status: 'ok' })
    await flushCommandWork()
  })

  it('rolls back a failed optimistic sidebar folder create in state and DOM', async () => {
    seedSidebarDatabase()
    sidebarMocks.setServerCommandsEnabled(true)
    const command = sidebarMocks.createDeferredCreateFolderCommand()

    component = mount(SideChatListHarness, { target })
    await tick()

    createFolderButton().click()
    await flushCommandWork()

    const createdFolderId = selectedCharacter().chatFolders[0].id
    const createdFolderPanel = folderPanelById(createdFolderId)
    const [createdFolderSortable] = activeSortablesForElement(createdFolderPanel)
    expect(createdFolderSortable).toBeTruthy()
    expect(folderElementById(createdFolderId).textContent).toContain('New Folder 2')
    expect(selectedCharacter().chatFolders.map((folder) => folder.name)).toEqual(['New Folder 2', 'Pinned Folder'])

    command.resolve({ error: 'create folder failed', status: 'error' })
    await flushCommandWork()

    expect(selectedCharacter().chatFolders.map((folder) => folder.name)).toEqual(['Pinned Folder'])
    expect(sidebarRoot().querySelector(`[data-risu-chat-folder-id="${createdFolderId}"]`)).toBeNull()
    expect(createdFolderSortable.destroy).toHaveBeenCalledOnce()
    // Svelte may recycle the panel element for the remaining keyed position;
    // its old Sortable is still destroyed and exactly one fresh listener wins.
    expect(createdFolderPanel.dataset.risuChatFolderPanelId).toBe('folder-a')
    expect(activeSortablesForElement(createdFolderPanel)).toHaveLength(1)
  })

  it('removes a confirmed root sidebar chat before the delete command resolves', async () => {
    const chara = seedSidebarDatabase()
    chara.chatPage = 2
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.alertConfirm.mockResolvedValueOnce(true)
    const command = sidebarMocks.createDeferredDeleteCommand()

    component = mount(SideChatListHarness, { target })
    await tick()

    expectRowSelected('chat-root-b', true)

    deleteButtonForRow(rowByChatId('chat-root-b')).click()
    await flushCommandWork()

    expect(command.settled).toBe(false)
    expect(command.input).toMatchObject({ chatId: 'chat-root-b' })
    expect(selectedCharacter().chats.map((chat) => chat.name)).toEqual(['Root Chat A', 'Foldered Chat'])
    expect(selectedCharacter().chatPage).toBe(1)
    expect(chatRows().map((row) => row.dataset.risuChatId)).not.toContain('chat-root-b')
    expectRowSelected('chat-foldered', true)
    expect(sidebarMocks.navigate).not.toHaveBeenCalled()

    command.resolve({ revision: 12, status: 'ok' })
    await flushCommandWork()

    expect(sidebarMocks.navigate).toHaveBeenCalledWith('/character/char-a/chat-foldered', {
      replace: true,
    })
  })

  it('keeps the chat-list route when deleting a non-selected chat', async () => {
    const chara = seedSidebarDatabase()
    chara.chatPage = 0
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.alertConfirm.mockResolvedValueOnce(true)
    const command = sidebarMocks.createDeferredDeleteCommand()

    component = mount(SideChatListHarness, { target })
    await tick()

    expectRowSelected('chat-root-a', true)
    deleteButtonForRow(rowByChatId('chat-root-b')).click()
    await flushCommandWork()

    expect(command.settled).toBe(false)
    expect(selectedCharacter().chats.map((chat) => chat.name)).toEqual(['Root Chat A', 'Foldered Chat'])
    expect(selectedCharacter().chatPage).toBe(0)
    expectRowSelected('chat-root-a', true)
    expect(sidebarMocks.navigate).not.toHaveBeenCalled()

    command.resolve({ revision: 12, status: 'ok' })
    await flushCommandWork()
  })

  it('restores a failed optimistic foldered sidebar chat delete in state and DOM', async () => {
    const chara = seedSidebarDatabase()
    const backgroundChat = chara.chats[0]
    backgroundChat.message.push({ role: 'char', data: 'before request', chatId: 'background-before' })
    const backgroundMessages = backgroundChat.message
    const backgroundMessage = backgroundMessages[0]
    sidebarMocks.setServerCommandsEnabled(true)
    sidebarMocks.alertConfirm.mockResolvedValueOnce(true)
    const command = sidebarMocks.createDeferredDeleteCommand()

    component = mount(SideChatListHarness, { target })
    await tick()

    expectRowSelected('chat-foldered', true)

    deleteButtonForRow(rowByChatId('chat-foldered')).click()
    await flushCommandWork()

    expect(command.settled).toBe(false)
    expect(command.input).toMatchObject({ chatId: 'chat-foldered' })
    expect(selectedCharacter().chats.map((chat) => chat.name)).toEqual(['Root Chat A', 'Root Chat B'])
    expect(selectedCharacter().chatPage).toBe(1)
    expect(chatRows().map((row) => row.dataset.risuChatId)).not.toContain('chat-foldered')
    expectRowSelected('chat-root-b', true)

    backgroundMessages.push({ role: 'char', data: 'arrived while pending', chatId: 'background-pending' })
    command.resolve({ error: 'delete failed', status: 'error' })
    await flushCommandWork()

    expect(selectedCharacter().chats.map((chat) => chat.name)).toEqual(['Root Chat A', 'Foldered Chat', 'Root Chat B'])
    expect(selectedCharacter().chatPage).toBe(1)
    expect(chatRows().map((row) => row.dataset.risuChatId)).toEqual(['chat-foldered', 'chat-root-a', 'chat-root-b'])
    expectRowSelected('chat-foldered', true)
    expect(sidebarMocks.navigate).not.toHaveBeenCalled()
    expect(chara.chats[0]).toBe(backgroundChat)
    expect(backgroundChat.message).toBe(backgroundMessages)
    expect(backgroundMessages[0]).toBe(backgroundMessage)
    expect(backgroundMessages.map((message) => message.data)).toEqual(['before request', 'arrived while pending'])
  })

  it('reports the one-chat sidebar delete guard and leaves the row unchanged', async () => {
    const chara = seedSidebarDatabase()
    chara.chatPage = 0
    chara.chatFolders = []
    chara.chats = [makeChat('chat-only', 'Only Chat')]
    sidebarMocks.setServerCommandsEnabled(true)

    component = mount(SideChatListHarness, { target })
    await tick()

    deleteButtonForRow(rowByChatId('chat-only')).click()
    await tick()

    expect(sidebarMocks.alertError).toHaveBeenCalledWith('Only one chat')
    expect(sidebarMocks.alertConfirm).not.toHaveBeenCalled()
    expect(sidebarMocks.deleteChatCommand).not.toHaveBeenCalled()
    expect(selectedCharacter().chats.map((chat) => chat.name)).toEqual(['Only Chat'])
    expect(selectedCharacter().chatPage).toBe(0)
    expect(chatRows().map((row) => row.dataset.risuChatId)).toEqual(['chat-only'])
    expectRowSelected('chat-only', true)
  })

  it('captures chat and folder name drafts before blur', async () => {
    await beginWriterDraftCaptureTest()
    try {
      const chara = seedSidebarDatabase()
      component = mount(SideChatListHarness, { target })
      await tick()
      editButtonForRow(rowByChatId('chat-foldered')).click()
      await tick()
      const chat = inputIn(rowByChatId('chat-root-a'), 'chat name')
      const folder = inputIn(folderElementById('folder-a'), 'folder name')
      chat.value = 'Unsubmitted chat name'
      chat.dispatchEvent(new Event('input', { bubbles: true }))
      folder.value = 'Unsubmitted folder name'
      folder.dispatchEvent(new Event('input', { bubbles: true }))
      demoteClientSession()
      expect(capturedWriterDrafts().find((draft) => draft.key === `chat-names:${chara.chaId}`)?.data).toMatchObject({
        chats: { 'chat-root-a': 'Unsubmitted chat name' },
        folders: { 'folder-a': 'Unsubmitted folder name' },
      })
    } finally {
      if (component) {
        await unmount(component)
        component = undefined
      }
      await endWriterDraftCaptureTest()
    }
  })
})
