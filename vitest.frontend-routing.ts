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
  'src/ts/plugins/apiV3/factory.test.ts',
  'src/ts/plugins/pluginIconSafety.test.ts',
  'src/ts/process/__tests__/sendChat.fixtures.serverBacked.test.ts',
  'src/ts/process/__tests__/sendChatErrors.test.ts',
  'src/ts/process/__tests__/streamResponse.test.ts',
  'src/ts/process/mcp/risuaccess/tests/characters.setCharacterInfo.test.ts',
  'src/ts/process/mcp/risuaccess/tests/modules.optimisticProjection.test.ts',
  'src/ts/process/request/tests/durableGeneration.test.ts',
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
