# Performance And Stability Archive

Chronological performance investigations and their closed remediation records.

| Record                                                                             | Scope                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`browser-smoke-effectiveness/`](browser-smoke-effectiveness/PLAN.md)              | Completed review of 92 browser cases, shared controls and critical journeys, with nine verified finding dispositions and final agent/full-suite evidence. [Final status](browser-smoke-effectiveness/status.md).                                       |
| [`browser-smoke-and-connected-readers.md`](browser-smoke-and-connected-readers.md) | Completed coordination of the smoke audit and connected read-only clients, including default rollout, conservative fallback, final revalidation and both archives.                                                                                     |
| [`maintainability-and-performance/`](maintainability-and-performance/PLAN.md)      | Completed ten-finding remediation: data preservation, scoped browser/generation work, scheduled maintenance, transcript residency and shared policy; [final evidence and residual owners](maintainability-and-performance/evidence/final-closeout.md). |
| [`frontend-test-architecture/`](frontend-test-architecture/README.md)              | Completed N/S/D/B frontend test capability migration, formal benchmarks, routing enforcement, and accepted final budget decision.                                                                                                                      |
| [`test-suite-effectiveness-audit/`](test-suite-effectiveness-audit/README.md)      | Completed exhaustive test-value audit, remediation record, historical manifests, retained frontend routing input, and final evidence.                                                                                                                  |
| [`frontend-performance/`](frontend-performance/README.md)                          | Frontend deep-clone and projection-write narrowing.                                                                                                                                                                                                    |
| [`stability-audits/`](stability-audits/README.md)                                  | Four chronological audit universes and their closed remediation records.                                                                                                                                                                               |
| [`chat-multitasking-regression-audit.md`](chat-multitasking-regression-audit.md)   | Closed 2026-08-10 audit of chat-scoped generation, navigation, cancellation, and transient UI state.                                                                                                                                                   |

The four stability-audit versions are intentionally not merged: repeated finding
IDs belong to different audit universes. Their retired completeness gates describe
that historical closeout process; current browser and architecture gates retain
their ownership in the live test guides and tooling.
