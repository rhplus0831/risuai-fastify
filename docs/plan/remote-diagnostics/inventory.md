# Remote Diagnostics Source Inventory

Opening source: `5dc64f6f239b6dc1c95cd3f86d3c05b8802831d5`.

This is a bounded planning map. Recheck it in Phase 0 and add overlooked
in-scope owners. Entries identify current source or proposed work; they do not
claim that a test proves the future feature. Progress belongs in [status](status.md).

| ID  | Boundary and current owners                                                                                                                                                                                                                                                                                                                                               | Planned disposition                                                                                                                                             | Primary phase |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| D01 | [Shared diagnostic schema](../../../packages/protocol/src/diagnostics.ts), [protocol rules](../../../packages/protocol/README.md)                                                                                                                                                                                                                                         | Preserve v1; add exact remote envelope and event-family/version contracts                                                                                       | 0–2           |
| D02 | [Server collector and existing route](../../../server/fastify/src/clientDiagnostics.ts), [metric subscribers](../../../server/fastify/src/protocolMetrics.ts)                                                                                                                                                                                                             | Reuse safe snapshots first; add bounded durable storage and explicit metric adapters/correlation                                                                | 1–2           |
| D03 | [Auth state](../../../server/fastify/src/auth.ts), [ordinary auth guard](../../../server/fastify/src/http.ts), [configuration](../../../server/fastify/src/config.ts)                                                                                                                                                                                                     | Separate diagnostics verifier/lifecycle; do not widen application authentication or inherit bypass                                                              | 0–1           |
| D04 | [App composition](../../../server/fastify/src/app.ts), [server route policy](../../../server/fastify/src/routeManifest.ts), [shared route catalog](../../../packages/protocol/src/routeOperation.ts)                                                                                                                                                                      | Register dedicated GET and later upload policy, rate/body limits, exclusions, and catalog parity                                                                | 1, 3          |
| D05 | [Request tracing](../../../server/fastify/src/requestTrace.ts), [generation sidecars](../../../server/fastify/src/generation/generationTraceSidecar.ts), [request history](../../../server/fastify/src/requestHistory.ts)                                                                                                                                                 | Keep content-bearing surfaces inaccessible; exclude diagnostic transport bodies; derive new safe request facts without reading retained artifacts               | 1–2           |
| D06 | [Generation routing/finalization](../../../server/fastify/src/routes/generationChat.ts), [command metrics](../../../server/fastify/src/commands/mutations.ts)                                                                                                                                                                                                             | Verify/fix missing request association, background correlation, timer gating, and discarded persistence phase/status fields                                     | 2             |
| D07 | [Prompt summaries](../../../server/fastify/src/prompt/promptSummary.ts), [provider summaries](../../../server/fastify/src/generation/providerBodySummary.ts), [OpenAI](../../../server/fastify/src/generation/openai.ts), [Gemini](../../../server/fastify/src/generation/gemini.ts), [Lua trace collector](../../../server/fastify/src/prompt/luaPostGenerationTrace.ts) | Reuse selected structural calculations through new allowlists; omit hashes, custom strings, bodies, and Lua values; map remaining adapters by the same contract | 2             |
| D08 | [Browser collection](../../../src/ts/diagnostics.ts), [startup publisher](../../../src/ts/server/startupTelemetry.ts), [startup receiver](../../../server/fastify/src/routes/startupTelemetry.ts)                                                                                                                                                                         | Use existing opt-in/limit patterns for general sanitized upload; prevent loops and maintain reader access                                                       | 3             |
| D09 | [Report builder](../../../src/ts/server/clientDiagnostics.ts), [Diagnostics panel](../../../src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte), [bootstrap](../../../src/ts/bootstrap.ts)                                                                                                                                                                            | Preserve manual export and old/new negotiation; deduplicate uploaded/local browser events; show coverage honestly                                               | 2–3           |
| D10 | [Local scripts](../../../package.json), [development sandbox](../../../server/fastify/src/agentDataSandbox.ts), [dev runner](../../../util/agent-dev.ts)                                                                                                                                                                                                                  | Add fixed-origin fetch/provisioning tooling without frontend secrets; synthetic verification uses fresh data                                                    | 1, 4          |
| D11 | [Observability guide](../../structure/development-and-observability.md), [backend map](../../structure/backend.md), [API test guide](../../tests/api-security-and-runtime.md), [generation test guide](../../tests/prompting-generation-and-streaming.md)                                                                                                                 | Update shipped behavior, operators' limits, and test discovery as code lands                                                                                    | 1–4           |

## Existing Focused Test Owners

- Route admission and public exceptions: [live route protection](../../../server/fastify/__tests__/routeProtection.test.ts).
- Server collector/privacy: [client diagnostics](../../../server/fastify/__tests__/clientDiagnostics.test.ts).
- Auth/configuration: [auth](../../../server/fastify/__tests__/auth.test.ts),
  [configuration](../../../server/fastify/__tests__/config.test.ts).
- Route operation vocabulary: [shared catalog tests](../../../packages/protocol/src/routeOperation.test.ts).
- Raw trace separation: [request tracing](../../../server/fastify/__tests__/requestTrace.test.ts),
  [generation sidecars](../../../server/fastify/__tests__/generationTraceSidecar.test.ts).
- Persistence/recovery: [finalization retry](../../../server/fastify/__tests__/generationFinalizationRetry.test.ts).
- Browser collection/export: [collector DOM tests](../../../src/ts/diagnostics.dom.test.ts),
  [panel tests](../../../src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte.test.ts).
- Upload/negotiation patterns: [server startup telemetry](../../../server/fastify/__tests__/startupTelemetry.test.ts),
  [browser startup telemetry](../../../src/ts/server/startupTelemetry.test.ts),
  [browser startup protocol](../../../src/ts/server/startupTelemetryProtocol.test.ts).

New support-credential, journal, helper, event-schema, browser-upload, and focused
browser-smoke coverage is required; these are proposed tests, not existing
owners. Phase 0 chooses their exact paths and verifies normal test discovery.

## Companion Owners Confirmed by Cross-Check

- D04: [Route rate-limit presets](../../../server/fastify/src/routeRateLimits.ts)
  and the late static/SPA registration in `app.ts` require explicit support-route
  treatment. Include HEAD/method handling and API fallback in admission tests.
- D06: [Generation operation dispatch markers](../../../server/fastify/src/generationOperations.ts)
  distinguish not dispatched, provider may have run, and completed dispatch.
  Export approved facts, not the underlying operation/domain records.
- D09: [Server bootstrap advertisement](../../../server/fastify/src/routes/bootstrap.ts),
  [browser bootstrap parsing](../../../src/ts/server/bootstrap.ts), and
  [auth-loss projection cleanup](../../../src/ts/observerProjectionLifecycle.ts)
  are the narrow owners for opt-in and upload lifecycle fencing.

## Known Checks to Resolve

1. `clientDiagnostics.ts` filters on an app-local set of 2,000 request UIDs;
   background events and long operations can fall outside it. Preserve
   isolation while adding operation context; do not bypass the guard globally.
2. Persistence emits `phase`, commit flags, and status values that the current
   generic adapter/schema cannot represent. Some producers omit request UID,
   so schema expansion alone cannot restore those events.
3. Generation prompt assembly initializes a metric timer conditionally on
   protocol metrics, while the Diagnostics subscriber can run independently.
   Prove duration semantics under both flag states before trusting the field.
4. Prompt/provider/Lua summaries contain ordinary SHA-256 content fingerprints
   and sometimes arbitrary identifiers/strings. Do not spread summary objects
   into the safe schema.
5. App logger hooks forward original log arguments after making a safe copy.
   Sanitizing Diagnostics does not sanitize the operator's normal log sink.
6. The global rate-limit plugin is registered with `global: false`; new support
   routes need their own effective limits.
7. Existing startup telemetry omits its request body from raw traces, including
   rejected content-bearing submissions. Apply equivalent protection to the
   new diagnostic transport without turning on full protocol logging.
8. The default current-document validator does not discover plan directories.
   Explicitly validate the plan package in addition to `pnpm check:docs`.
9. Post-generation Lua tracing forces the sidecar's full-prompt option on and
   captures chat before/after values when protocol metrics enable its collector.
   Add independent safe counters; do not enable that content-bearing collector
   as a shortcut for diagnostics-only Lua visibility.
