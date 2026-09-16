// Keep this inventory aligned with the files selected by the coverage:ui-map
// package script. The ordinary frontend lane excludes them only when that
// coverage lane is guaranteed to execute them.
export const uiCoverageTestFiles = [
  'src/lib/Others/GridCatalog.svelte.test.ts',
  'src/lib/Others/ChatList.svelte.test.ts',
  'src/lib/SideBars/SideChatList.svelte.test.ts',
  'src/lib/SideBars/Sidebar.charList.test.ts',
  'src/lib/ChatScreens/ChatBody.svelte.test.ts',
  'src/lib/ChatScreens/DefaultChatScreen.loadPages.test.ts',
] as const

// Keep production-facing UI coverage denominators free of test-only hosts,
// stubs, and harnesses. util/test-all.test.ts verifies that this reviewed list
// stays unique and points to files that still exist.
export const uiCoverageSupportFiles = [
  'src/lib/ChatScreens/Chat.parserDependenciesHarness.svelte',
  'src/lib/ChatScreens/Chat.testSupport.ts',
  'src/lib/ChatScreens/DefaultChatScreen.shellGreetingStub.svelte',
  'src/lib/ChatScreens/DefaultChatScreen.testChat.svelte',
  'src/lib/ChatScreens/DefaultChatScreen.testChatController.ts',
  'src/lib/ChatScreens/TransitionImage.testHost.svelte',
  'src/lib/Others/BookmarkList.testChat.svelte',
  'src/lib/Others/HypaV3Modal/tag-manager-modal.testHost.svelte',
  'src/lib/Others/QuickSettingsGUI.testState.svelte.ts',
  'src/lib/Others/QuickSettingsGUI.testStub.svelte',
  'src/lib/SideBars/AuthorNoteEditor.testHelp.svelte',
  'src/lib/SideBars/AuthorNoteEditor.testHost.svelte',
  'src/lib/SideBars/AuthorNoteEditor.testTextArea.svelte',
  'src/lib/SideBars/CharConfig.testHelp.svelte',
  'src/lib/SideBars/CharConfig.testMultiLangInput.svelte',
  'src/lib/SideBars/CharConfig.testRegexList.svelte',
  'src/lib/SideBars/CharConfig.testTextAreaInput.svelte',
  'src/lib/SideBars/CharConfig.testTriggerList.svelte',
  'src/lib/SideBars/GenerationSettingsPickerHost.testHarness.svelte',
  'src/lib/SideBars/LoreBook/LoreBookList.testHarness.svelte',
  'src/lib/SideBars/LoreBook/LoreBookSetting.test.LoreBookListStub.svelte',
  'src/lib/SideBars/Scripts/DefinitionDeleteRace.testHarness.svelte',
  'src/lib/SideBars/Scripts/RegexList.testHarness.svelte',
  'src/lib/SideBars/Scripts/TriggerList.testChild.svelte',
  'src/lib/SideBars/Scripts/TriggerList.testHarness.svelte',
  'src/lib/SideBars/Scripts/TriggerV2List.testHarness.svelte',
  'src/lib/SideBars/Scripts/TriggerV2List.testPortal.svelte',
  'src/lib/SideBars/SideChatList.testHarness.svelte',
  'src/lib/SideBars/SideChatList.testToggles.svelte',
] as const

export const excludeUiCoverageTests = process.env.RISU_TEST_EXCLUDE_UI_MAP === 'true'
