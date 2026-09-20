export const frontendCoreTestFiles = [
  'src/ts/bootstrap.test.ts',
  'src/ts/bootstrap.resourceEvents.dom.test.ts',
  'src/ts/process/__tests__/sendChat.fixtures.serverBacked.test.ts',
  'src/ts/process/__tests__/sendChatErrors.test.ts',
  'src/ts/process/__tests__/streamResponse.test.ts',
  'src/ts/process/request/tests/durableGeneration.test.ts',
  'src/ts/server/durableMutationDispatch.test.ts',
  'src/ts/server/pendingMutationOutbox.test.ts',
  'src/ts/server/pendingMutationReplay.test.ts',
  'src/ts/storage/database.resourceState.test.ts',
] as const

export const serverCoreTestFiles = [
  'server/fastify/__tests__/auth.test.ts',
  'server/fastify/__tests__/backups.test.ts',
  'server/fastify/__tests__/commandMutationReceipts.test.ts',
  'server/fastify/__tests__/commands.test.ts',
  'server/fastify/__tests__/databaseInitialization.test.ts',
  'server/fastify/__tests__/db.test.ts',
  'server/fastify/__tests__/durableGeneration.test.ts',
  'server/fastify/__tests__/events.test.ts',
  'server/fastify/__tests__/generation.chat.test.ts',
  'server/fastify/__tests__/generationFinalizationRetry.test.ts',
  'server/fastify/__tests__/messageStore.test.ts',
  'server/fastify/__tests__/missingDatabaseGuard.test.ts',
  'server/fastify/__tests__/providerTransport.test.ts',
  'server/fastify/__tests__/risuSaveCodec.test.ts',
  'server/fastify/__tests__/routeProtection.test.ts',
] as const

export const browserCoreTestFiles = [
  'server/fastify/browser-smoke/acceptedSendProtocol.spec.ts',
  'server/fastify/browser-smoke/durableMutationRecovery.spec.ts',
  'server/fastify/browser-smoke/fastifyBrowserSmoke.spec.ts',
  'server/fastify/browser-smoke/importRestoreRecovery.spec.ts',
] as const

export const CORE_BROWSER_TEST_TAG = '@core'
