# Assets, Import/Export, and Backups

Asset and replacement coverage now favors real bytes, real SQLite, and real
browser reloads. Mocked browser import/export suites were removed in Phase 5.

## Content-addressed assets

`server/fastify/__tests__/assetGc.test.ts` and
`server/fastify/__tests__/assetGcScheduling.test.ts` are mutation-proven core
coverage for reference discovery and maintenance scheduling. Extended coverage
includes `server/fastify/__tests__/assetMetadataIndex.test.ts`,
`server/fastify/__tests__/risuSaveAssetReferences.test.ts`, and
`server/fastify/__tests__/inlayCatalog.test.ts`.

## Backups and database replacement

Core replacement contracts live in `server/fastify/__tests__/backups.test.ts`,
`server/fastify/__tests__/legacyDatabaseImport.test.ts`, and
`server/fastify/__tests__/risuSaveBundleImportRoute.test.ts`. The core
`server/fastify/browser-smoke/importRestoreRecovery.spec.ts` journey verifies
database, asset, and save bytes across restore and reload. Extended cases cover
copy pooling and local backup storage in
`server/fastify/__tests__/backupCopyPool.test.ts` and
`server/fastify/__tests__/localBackupDatabase.test.ts`.

## Save codecs and imports

`server/fastify/__tests__/risuSaveCodec.test.ts`,
`server/fastify/__tests__/risuSaveBoundedInflate.test.ts`, and
`server/fastify/__tests__/realmImport.test.ts` are core. The extended
`server/fastify/__tests__/risuSaveImportRoute.test.ts` preserves the real import
route, while `server/fastify/browser-smoke/realmProgressConfirmation.spec.ts`
protects the built-browser confirmation flow.

## Browser-side media owners

Narrow real-boundary client coverage remains in
`src/ts/server/characterEmotionUpload.test.ts`,
`src/ts/server/characterTtsAssetUpload.test.ts`, and
`src/ts/media/tests/imageType.test.ts`. Other browser import/export unit suites
were removed because they depended on own-module mocks or implementation shape.

## Primary inventory

- Core server: `server/fastify/__tests__/assetGc.test.ts`, `server/fastify/__tests__/backups.test.ts`, `server/fastify/__tests__/risuSaveCodec.test.ts`, `server/fastify/__tests__/realmImport.test.ts`.
- Core browser: `server/fastify/browser-smoke/importRestoreRecovery.spec.ts`.
- Extended: `server/fastify/__tests__/maintenanceCoordinator.test.ts`, `server/fastify/browser-smoke/realmProgressConfirmation.spec.ts`.
