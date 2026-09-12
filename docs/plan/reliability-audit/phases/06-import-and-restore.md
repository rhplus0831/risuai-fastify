# Phase 06 — Import and Restore Lifecycle Boundaries

State: **Not started; follows phase 05.** Use [the common audit method](../PLAN.md#audit-method).
All execution fixtures must use disposable data.

## Scope and Source Map

Audit whole-database save/bundle import and backup restore from submission
through publication, lineage adoption, and refreshed UI. Check interactions
with old commands, resources, generation, and background jobs. This phase covers
replacement/atomicity/recovery; it is not an exhaustive codec or asset-format
compatibility audit. BardWiki vault import has a different transaction and
scope: assess its source/job invalidation contract separately, reusing phase 05
evidence and never inferring it from whole-database replacement.

Guides: [assets and saves](../../../structure/assets-and-saves.md),
[BardWiki lifecycle](../../../structure/bardwiki.md), and
[import/backup tests](../../../tests/assets-import-export-and-backups.md).

<!-- prettier-ignore -->
| Boundary | Source owners | Existing tests |
| --- | --- | --- |
| Upload, decode, asset staging, atomic publication | `server/fastify/src/routes/save.ts`: `applyImportedDatabase`; `server/fastify/src/repository.ts`: `applyImport`; `server/fastify/src/maintenanceCoordinator.ts` | `server/fastify/__tests__/risuSaveImportRoute.test.ts`, `server/fastify/__tests__/risuSaveBundleImportRoute.test.ts`, `server/fastify/__tests__/maintenanceCoordinator.test.ts` |
| Backup replacement and crash recovery | `server/fastify/src/routes/backups.ts`, `server/fastify/src/repository.ts`: `restoreBackup`, `server/fastify/src/maintenanceRequest.ts` | `server/fastify/__tests__/backups.test.ts`, `server/fastify/__tests__/backupMaintenance.test.ts` |
| Browser acceptance, adoption, refresh and qualification | `src/ts/server/backups.ts` | `src/ts/server/backups.svelte-node.test.ts` |
| Connected replacement and stale callback isolation | Phase 01/03/04/05 ownership contracts and actual importing UI | `server/fastify/browser-smoke/visibleStateRecovery.spec.ts`, `server/fastify/browser-smoke/startupRecoveryIntegrationMatrix.spec.ts` |

Existing server tests exercise restore round trips, directory/database crash
points, post-commit failure, and publication ordering. Browser-helper tests
distinguish server acceptance from failed refresh. Inspect the actual route and
maintenance implementation before using these tests to define commit boundaries.

## Required Acceptance and Candidate Schedules

<!-- prettier-ignore -->
| ID | Schedule | Observable acceptance |
| --- | --- | --- |
| I1 | Abort/fail upload, decode, staging, or the transaction before commit. | Prior authoritative database/assets remain consistent; temporary work is cleaned/drained according to the actual boundary; no success or adopted new lineage is shown. |
| I2 | Commit succeeds; response/cleanup/refresh fails or client disconnects. | Server's committed replacement remains authoritative; UI accurately qualifies accepted replacement versus incomplete resync and can recover without blind re-import. |
| I3 | Old command, resource read, generation/job result, or editor rollback arrives after replacement. | Old ownership/lineage work cannot publish into or overwrite replaced state. Retained outbox/drafts are accounted for by their existing scope policy. |
| I4 | Restart/reopen at the supported directory/SQLite commit stages. | Recovery selects a coherent database/assets state; revision, lineage, dependent-table policy, and job retirement remain consistent. |
| I5 | Writer changes while import/restore response or adoption is pending. | Stale browser operation cannot adopt authority or expose write controls; the current session can refresh the real committed outcome. |
| I6 | Selected BardWiki vault import overlaps source-bound work. | Vault publication obeys its own atomic/source/document policy and invalidates or reconciles only eligible work; whole-database assumptions are not applied. |

## Execution and Validation

First locate the concrete import, backup, maintenance, UI, and vault owners and
map commit points to I1–I6. Keep real Fastify routes, SQLite, staged files,
maintenance coordination, and browser adoption for the relevant compositions.
Use existing failure seams, disposable directories, and provider/network fault
injection. Do not mutate human data or production to establish acceptance.

Run focused server/helper owners and explicit browser replacement/import
journeys. A helper-level import or API-triggered replacement may establish
server behavior while leaving user-selected upload, visible result, and retry
unverified; add/strengthen the smallest appropriate browser path if needed.
Apply the broader validation policy for shared persistence/lineage changes.

## Execution Record and Overall Closeout

Assessment: not started. Findings: none confirmed. Validation: not run.
Populate I1–I6 with actual owners, boundaries, named cases, and evidence.
Outstanding planning limits: full upload-to-visible-result interruption coverage
and exact external-process crash behavior require assessment.

Once this phase and all prior phases meet
[the completion rules](../PLAN.md#phase-completion-and-handoff), summarize verified
contracts and remaining platform/depth limits, ensure current guides reflect
shipped behavior, and archive the plan package with updated index links.
