# Settings, Profiles, and Extensions

Phase 5 removed the settings component suites because they relied on own-module
mocks or source/implementation assertions. Durable settings, profile, module,
plugin, loadout, and Agent Preset behavior remains covered at record, command,
and built-browser boundaries.

## Settings and drafts

`src/ts/server/settingsDraftAcknowledgement.test.ts`,
`src/ts/server/writerDraftFields.test.ts`, and
`src/ts/setting/botSettingsParamsData.test.ts` retain narrow input/output
coverage. Fastify defaults are exercised by
`server/fastify/__tests__/databaseDefaults.test.ts`.

## Model profiles and credentials

Core persistence and masking live in
`server/fastify/__tests__/commands.modelProfiles.test.ts`,
`server/fastify/__tests__/staleInlineModelProfileSecrets.test.ts`. Extended
client secret/state owners are `src/ts/providerSecretMask.test.ts`,
`src/ts/model/modelProfileRecords.test.ts`,
`src/ts/model/modelProfileResolver.test.ts`, and
`src/ts/model/modelProfileUiState.test.ts`.

## Agents, modules, and loadouts

Agent Preset coverage remains in `src/ts/agentPresetRecords.test.ts`,
`src/ts/agentPresetResolver.test.ts`, and
`server/fastify/__tests__/agentPresetExecution.test.ts`. Module and loadout
behavior remains in `src/ts/moduleActivation.test.ts`,
`src/ts/moduleOrganization.test.ts`, `src/ts/server/loadoutCanonical.test.ts`,
and `server/fastify/__tests__/loadouts.test.ts`.

## Built-browser settings coverage

`server/fastify/browser-smoke/uiUxImprovementBaseline.spec.ts` retains the
extended integrated settings/navigation journey. Core rollback and recovery are
covered by `server/fastify/browser-smoke/durableMutationRecovery.spec.ts` and
`server/fastify/browser-smoke/visibleStateRecovery.spec.ts`. There is no longer a
component-unit inventory for settings controls.

## Primary inventory

- Core: `server/fastify/__tests__/commands.modelProfiles.test.ts`, `server/fastify/__tests__/staleInlineModelProfileSecrets.test.ts`, `server/fastify/browser-smoke/durableMutationRecovery.spec.ts`.
- Extended: `src/ts/providerSecretMask.test.ts`, `server/fastify/__tests__/agentPresetExecution.test.ts`, `server/fastify/__tests__/loadouts.test.ts`, `server/fastify/browser-smoke/uiUxImprovementBaseline.spec.ts`.
