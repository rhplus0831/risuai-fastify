export type FrontendVitestProject = 'frontend-node' | 'frontend-svelte-node' | 'frontend-dom'

export const frontendTestFileGlob = '**/*.test.ts'
export const svelteNodeTestFileGlob = '**/*.svelte-node.test.ts'
export const explicitDomTestFileGlobs = ['**/*.svelte.test.ts', '**/*.dom.test.ts'] as const
export const isolatedCompatibilityTestFiles = [] as const

// These pre-suffix suites are probe-backed DOM owners. Registering them
// explicitly avoids rename-only churn while still making new plain tests
// Node-default. Remove an entry when a fresh smaller-runtime probe passes or
// when its owner is renamed to an explicit DOM suffix.
export const legacyDomTestFiles = [
  'src/ts/__tests__/renderCostHarness.test.ts',
  'src/ts/__tests__/sendCloneCountProbe.test.ts',
  'src/ts/bootstrap.test.ts',
  'src/ts/characterCommands.test.ts',
  'src/ts/chatFork.test.ts',
  'src/ts/hubAdditionalHtml.test.ts',
  'src/ts/parser/tests/additionalAssetCache.test.ts',
  'src/ts/parser/tests/cbs/conditionals.test.ts',
  'src/ts/parser/tests/cbs/eachReinjection.test.ts',
  'src/ts/parser/tests/cbs/escapes.test.ts',
  'src/ts/parser/tests/cbs/history.test.ts',
  'src/ts/parser/tests/cbs/loop.test.ts',
  'src/ts/parser/tests/cbs/strings.test.ts',
  'src/ts/parser/tests/inlayBlobCache.test.ts',
  'src/ts/parser/tests/renderFastPaths.test.ts',
  'src/ts/plugins/apiV3/factory.test.ts',
  'src/ts/plugins/pluginIconSafety.test.ts',
  'src/ts/process/__tests__/buildDescription.test.ts',
  'src/ts/process/__tests__/buildHistoryWindow.test.ts',
  'src/ts/process/__tests__/buildLorebookContext.test.ts',
  'src/ts/process/__tests__/buildMemoryWindow.test.ts',
  'src/ts/process/__tests__/buildPlainPromptSections.test.ts',
  'src/ts/process/__tests__/buildStaticPromptSections.test.ts',
  'src/ts/process/__tests__/charEmotionStore.test.ts',
  'src/ts/process/__tests__/dispatchRequest.test.ts',
  'src/ts/process/__tests__/emotionFallbackEmbedding.test.ts',
  'src/ts/process/__tests__/emotionFallbackLlm.test.ts',
  'src/ts/process/__tests__/emotionFromResponse.test.ts',
  'src/ts/process/__tests__/formatHistoryMessage.test.ts',
  'src/ts/process/__tests__/igp.test.ts',
  'src/ts/process/__tests__/imggenStableDiff.test.ts',
  'src/ts/process/__tests__/nonStreamResponse.test.ts',
  'src/ts/process/__tests__/normalizeTemplate.test.ts',
  'src/ts/process/__tests__/orchestrateResponse.test.ts',
  'src/ts/process/__tests__/outputTrigger.test.ts',
  'src/ts/process/__tests__/preflightTemplateTokens.test.ts',
  'src/ts/process/__tests__/reattach.test.ts',
  'src/ts/process/__tests__/renderFinalPrompt.test.ts',
  'src/ts/process/__tests__/runStage4.test.ts',
  'src/ts/process/__tests__/sendChat.fixtures.serverBacked.test.ts',
  'src/ts/process/__tests__/sendChat.fixtures.test.ts',
  'src/ts/process/__tests__/sendChat.serverPreview.test.ts',
  'src/ts/process/__tests__/sendChatContext.test.ts',
  'src/ts/process/__tests__/sendChatErrors.test.ts',
  'src/ts/process/__tests__/sendChatPromptAssembly.lazyPromptTemplate.test.ts',
  'src/ts/process/__tests__/stage4Finalize.test.ts',
  'src/ts/process/__tests__/streamResponse.test.ts',
  'src/ts/process/dynamicutils/pdf.test.ts',
  'src/ts/process/files/multisend.test.ts',
  'src/ts/process/files/tests/inlays.test.ts',
  'src/ts/process/index.svelte.stop.test.ts',
  'src/ts/process/mcp/internalClients.test.ts',
  'src/ts/process/mcp/mcp.test.ts',
  'src/ts/process/mcp/mcplib.test.ts',
  'src/ts/process/mcp/risuaccess/tests/characters.setCharacterInfo.test.ts',
  'src/ts/process/mcp/risuaccess/tests/modules.optimisticProjection.test.ts',
  'src/ts/process/mcp/risuaccess/tests/modules.test.ts',
  'src/ts/process/processzip.test.ts',
  'src/ts/process/regexDisplayReload.test.ts',
  'src/ts/process/request/clientContext.test.ts',
  'src/ts/process/request/tests/anthropicProfileOptions.test.ts',
  'src/ts/process/request/tests/cohereHordeOobaLegacyProfileOptions.test.ts',
  'src/ts/process/request/tests/durableGeneration.test.ts',
  'src/ts/process/request/tests/google.fastify.test.ts',
  'src/ts/process/request/tests/koboldProfileOptions.test.ts',
  'src/ts/process/request/tests/modelRoleRouting.test.ts',
  'src/ts/process/request/tests/ollamaProfileOptions.test.ts',
  'src/ts/process/request/tests/openaiProfileOptions.test.ts',
  'src/ts/process/request/tests/openaiResponsesLegacyProfileOptions.test.ts',
  'src/ts/process/request/tests/pluginProviderModelId.test.ts',
  'src/ts/process/request/tests/serverChat.test.ts',
  'src/ts/process/request/tests/serverPromptAssembly.test.ts',
  'src/ts/process/rerollNavigation.chatOnly.test.ts',
  'src/ts/process/rerollNavigation.rollback.test.ts',
  'src/ts/process/rerollNavigation.test.ts',
  'src/ts/process/scriptings.test.ts',
  'src/ts/process/scripts.editdisplay.test.ts',
  'src/ts/process/scripts.importRegex.test.ts',
  'src/ts/process/scripts.regexCache.test.ts',
  'src/ts/process/serverBackedSendChat.findMessage.test.ts',
  'src/ts/process/serverGeneratedMessageTranslation.test.ts',
  'src/ts/process/triggers.clientBudget.test.ts',
  'src/ts/process/triggers.cloneCost.test.ts',
  'src/ts/process/triggers.regexMemo.test.ts',
  'src/ts/server/activeWriterSession.test.ts',
  'src/ts/server/ownerMutationLifecycle.test.ts',
  'src/ts/server/lifecycleRecovery.test.ts',
  'src/ts/storage/database.resourceState.test.ts',
  'src/ts/util.persona.test.ts',
] as const

const legacyDomTestFileSet = new Set<string>(legacyDomTestFiles)
const isolatedCompatibilityTestFileSet = new Set<string>(isolatedCompatibilityTestFiles)

export function frontendVitestProjectForFile(
  file: string,
  registeredDomFiles: ReadonlySet<string> = legacyDomTestFileSet,
): FrontendVitestProject | undefined {
  if (!file.endsWith('.test.ts')) return undefined
  if (file.startsWith('test/compat-harness/')) return undefined
  if (isolatedCompatibilityTestFileSet.has(file)) return undefined
  if (file.endsWith('.svelte-node.test.ts')) return 'frontend-svelte-node'
  if (file.endsWith('.svelte.test.ts') || file.endsWith('.dom.test.ts') || registeredDomFiles.has(file)) {
    return 'frontend-dom'
  }
  return 'frontend-node'
}
