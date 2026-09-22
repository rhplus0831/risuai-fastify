# Providers, Models, and Media

Provider coverage is split between mutation-proven security/wire contracts and
an extended real-adapter tier. Client model tests remain only where they are
mock-free records, resolvers, or visible state helpers.

## Provider wire and dispatch contracts

`server/fastify/__tests__/providerWireGoldens.core.test.ts` is the core wire
golden owner for Anthropic, Gemini, Ollama, Bedrock, and fixed-endpoint profile
binding. `server/fastify/__tests__/chatDispatchProfileOptions.test.ts`,
`server/fastify/__tests__/providerTransport.test.ts`, and
`server/fastify/__tests__/providerOperations.test.ts` protect dispatch, transport,
credentials, and server-owned operations.

## Adapter conformance

The retained extended adapters are `server/fastify/__tests__/openai.test.ts`,
`server/fastify/__tests__/openaiResponses.test.ts`,
`server/fastify/__tests__/anthropic.test.ts`,
`server/fastify/__tests__/gemini.test.ts`,
`server/fastify/__tests__/bedrock.test.ts`,
`server/fastify/__tests__/mistral.test.ts`,
`server/fastify/__tests__/ollama.test.ts`, and the other provider-named files in
the same directory. They drive production adapters and assert explicit requests,
streams, errors, or returned values.

## Model profiles and credentials

Core secret behavior lives in
`server/fastify/__tests__/commands.modelProfiles.test.ts`,
`server/fastify/__tests__/staleInlineModelProfileSecrets.test.ts`. Extended
client secret/state coverage remains in `src/ts/providerSecretMask.test.ts`,
`src/ts/model/modelProfileRecords.test.ts`,
`src/ts/model/modelProfileResolver.test.ts`, and
`src/ts/model/modelProfileUiState.test.ts`.

## Media and translation

Core media boundaries are `server/fastify/__tests__/imageGeneration.test.ts` and
`server/fastify/__tests__/tts.test.ts`. Extended transcription and translation
coverage remains in `server/fastify/__tests__/openAITranscription.test.ts`,
`server/fastify/__tests__/messageTranslationJobs.test.ts`, and
`server/fastify/__tests__/generationChatCompletionTranslation.test.ts`.

## Primary inventory

- Core: `server/fastify/__tests__/providerWireGoldens.core.test.ts`, `server/fastify/__tests__/providerOperations.test.ts`, `server/fastify/__tests__/imageGeneration.test.ts`, `server/fastify/__tests__/tts.test.ts`.
- Extended: `server/fastify/__tests__/generation.providerUnits.test.ts`, `server/fastify/__tests__/openAITranscription.test.ts`, `server/fastify/__tests__/stripCoTFrames.test.ts`.
