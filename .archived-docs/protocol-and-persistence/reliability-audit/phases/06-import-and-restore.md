# Phase 06 — Import and Restore Lifecycle Boundaries

State: **Complete.** Uses [the common audit method](../PLAN.md#audit-method).
Every fixture uses disposable data. Entry baseline: `6731c2aa2`, clean worktree;
that commit records completed Phase 05 before this phase began.

## Bounded Entry and Commit Map

Guides: [assets and saves](../../../../docs/structure/assets-and-saves.md),
[BardWiki lifecycle](../../../../docs/structure/bardwiki.md), and
[import/backup tests](../../../../docs/tests/assets-import-export-and-backups.md).

- `routes/save.ts` accepts JSON or multipart `.risu`, ZIP bundles and legacy `.bin`.
  Upload/decode/staging precede the exclusive publication lease. Temporary bundle
  files share an upload directory that drains before lease release. Ownership is
  captured at route admission and checked after asynchronous intake. `applyImport`
  makes a safety snapshot, rechecks the write fence/cancellation, then atomically
  replaces domain rows, legacy memory and bundled assets, rotates lineage, clears
  receipts/accepted-send operations and persists `state.imported` in SQLite.
  File rollback removes only newly copied files; cleanup failures remain logged,
  unreferenced strays eligible for later cleanup. Post-commit asset reporting and
  event delivery do not roll back committed state.
- `routes/backups.ts` calls `repository.restoreBackup`. An exclusive lease protects
  validation, safety copying and the directory journal. The write fence covers
  writer metadata changes during safety copying. Directory installation and SQLite
  replacement occur synchronously; after commit, cleanup must finish forward.
  Restore keeps live writer metadata/push registrations, rotates lineage and
  clears receipts/request history. Snapshot-owned tables follow the explicit
  allowlist. Durable generation rows receive the new lineage and startup-style
  reconciliation; memory/BardWiki running jobs recover on the next worker tick.
- `UserSettings.svelte` drives native upload and server snapshot selection through
  `storage/backup.ts`, `globalApi.svelte.ts` and `server/backups.ts`. Confirmed
  acceptance precedes ownership adoption and full refresh. The local operation
  gate holds its matching SSE replacement event behind response handling.
  Writer-generation checks protect adoption, progress and terminal alerts.
  Encrypted outbox intent/registered settlements retire by existing lineage scope;
  old editor/resource callbacks retain the fences audited in Phases 03–04.
- BardWiki vault import is a per-chat document command through `routes/commands.ts`
  and `bardWikiVault.ts`. Decode/plan precede the revisioned transaction; exact
  target version/hash fences guard replacement. It does not replace the transcript
  or database lineage. Imported content is user-authored and source reconciliation
  can mark it for review. Full rebuild preserves that review state and content.

## Acceptance and Evidence Matrix

All cooperating storage and coordination owners below are real. Provider output,
network delivery and filesystem failure schedules are controlled at their boundary.
Existing cases are retained; no coverage was removed or consolidated.

<!-- prettier-ignore -->
| ID | Executable evidence and oracle | Disposition / boundary |
| --- | --- | --- |
| I1 | `risuSaveImportRoute.test.ts`: malformed/decode/oversize/group and command-event failure leave old state; `risuSaveBundleImportRoute.test.ts`: asset rollback, malformed payload cleanup, actual HTTP disconnect during held intake, three stale-ownership upload schedules; `backupMaintenance.test.ts`: cancel/takeover during safety copying; `maintenanceCoordinator.test.ts` and `maintenanceStaging.test.ts`: admission, draining and cleanup. Native invalid ZIP then explicit successful picker retry asserts unchanged state on rejection and one later committed event. | Retained and strengthened. HTTP disconnect is real TCP closure; staging and SQLite fault injection use isolated files. No success/new lineage before commit. |
| I2 | `backups.test.ts`: post-commit DETACH, cleanup and journal-marker failures preserve committed state; `backupMaintenance.test.ts`: publication precedes retention; browser helper tests qualify accepted replacements after thrown ownership preparation or failed refresh. Native picker tests lose a committed response or fail resource reads, then reload to the exact persisted setting with one import event and one upload. | Added ownership-exception and native recovery checks. A lost response remains an unknown network outcome; it is never automatically re-imported. |
| I3 | `serverMessageTranslation.test.ts`: both translation families across actual import and restore with identical IDs/text; memory embed/summary and BardWiki apply/rebuild tests restore running jobs with identical IDs, hold old providers, reject late output/status mutations and execute current recovery. `durableGeneration.test.ts`: modern and compatibility HTTP generations cross import/restore with identical source IDs and preserve the replacement transcript. Existing native `visibleStateRecovery.spec.ts` and Phase 03/04 fences cover old commands, optimistic state and resources. | Added real replacement compositions. Registries retire old translation projections. Worker callbacks retain lineage independently of job IDs; current work resumes on the next tick after existing provider work drains. |
| I4 | `backups.test.ts`: all BardWiki tables survive both deleted and retained live parents; exact asset/save round trips; backward recovery between renames, forward recovery after commit, missing post-commit journal marker and DETACH failure. Existing schema/lineage/receipt/exclusion checks remain. New worker and translation fixtures use actual SQLite snapshots/restores. | Strengthened graph restoration. Existing crash fixtures throw at real filesystem/SQLite stages and reopen the app; they do not kill an external process or simulate power loss. |
| I5 | Bundle route holds upload while writer changes, changes away/back, or another replacement commits; rejected intake leaves state, lineage, revision, assets, events and backups unchanged. Restore safety-copy takeover remains rejected by its existing write fence. Helper/adoption generation fences and stale-result wrapper tests prevent old authority/alerts. Native held accepted response plus actual writer takeover leaves the tab reading; reload shows imported character data without composer controls. | Added three server schedules, wrapper checks and native writer transition. API acceptance is retained separately from current browser authority. |
| I6 | `bardWikiVault.test.ts` and `bardWikiRoutes.test.ts`: decode/plan, exact target fences, multi-document rollback and one revisioned publication. New `bardWikiLifecycle.test.ts` case encodes/decodes a vault, imports replacement content through the real targeted transaction while source reconciliation is queued, executes reconciliation then full rebuild, and compares the exact preserved reviewed document. | Added composition proving the vault's distinct policy. No periodic rebuild capability is implied; rebuild execution is explicit. |

## Reproduced Findings and Repairs

1. **Upload ownership changed before publication.** A bundle admitted by writer A
   could publish after writer B took over, after A returned, or after another
   import completed. Both whole-save routes now compare the captured lineage,
   writer session and epoch before taking the publication lease. All three old
   schedules returned HTTP 200 instead of rejection. Evidence:
   `/tmp/phase06-upload-ownership-all-reproduction.log`.
2. **Restore cascades deleted newly restored children.** Interleaving table DELETE
   and INSERT erased restored BardWiki children when matching live parents were
   deleted later. Restore now deletes the entire old graph before inserting any
   snapshot table. Deferred foreign keys alone do not defer cascades. The original
   table round trip removed its live chat first; the expanded retained-parent case
   closes that blind spot. Evidence: `/tmp/phase06-restore-cascade-reproduction.log`.
3. **Translation results crossed database lineage.** Both message and greeting
   output could persist after import/restore with identical targets and text.
   Both owners now check captured lineage before persistence; application registries
   retire old running/terminal projections. Four old cases failed:
   `/tmp/phase06-translation-lineage-reproduction.log`.
4. **Old workers changed restored jobs or published output.** A restored job can
   retain both logical ID and instance ID, so those identities are insufficient.
   Memory and BardWiki handlers/callbacks now check lineage; the next tick recovers
   snapshot-running work. Late success/failure tests exercise real restored rows.
   Evidence: `/tmp/phase06-worker-lineage-reproduction.log`. After fixing the graph
   copy, a controlled run restored the previous BardWiki worker/handlers temporarily:
   all three selected analysis/rebuild cases failed; files were restored afterward.
   `/tmp/phase06-bardwiki-lineage-controlled-reproduction.log` records this layered
   reproduction, not an unchanged-baseline result.
5. **Accepted replacement lost its qualification on adoption exception.** A thrown
   outbox preparation error escaped the helper even though the server committed.
   Restore/import now return their existing accepted-but-refresh-failed result
   through the whole adoption/refresh boundary. Evidence:
   `/tmp/phase06-adoption-error-reproduction.log`.
6. **A stale local import published a terminal alert.** The selected-file wrapper
   previously displayed old success/error after writer replacement. It now fences
   picker continuation and result presentation with its initiating generation.
   Evidence: `/tmp/phase06-stale-alert-reproduction.log` and the native held response.
7. **Rebuild deleted imported content awaiting review.** Source reconciliation
   writes a system-authored `needs_review` version, hiding the preceding user/import
   actor from a latest-actor check. Full rebuild now preserves reviewed documents
   as well as direct user edits. The real vault/reconcile/rebuild composition lost
   its document before repair: `/tmp/phase06-vault-review-reproduction.log`.
8. **Server backup selection was blocked by progress.** The Settings progress alert
   remained visible while the result-bearing selection waited for an empty alert
   slot. The server-restore prepare transition now clears its progress before
   selection. The native journey timed out twice on the visible selection step
   before repair: `/tmp/phase06-browser-targeted.log`; all five new native cases
   then passed in `/tmp/phase06-browser-fixed.log`.

Related paths were checked: JSON/multipart/ZIP/legacy imports share publication;
message/greeting share provider and registry contracts; single/batch memory and
apply/rebuild worker completions share the lineage issue. Synchronous BardWiki
reconciliation has no provider await. Modern/compatibility generation already
rejected replaced-state finalization in the new four-case composition and needed
no runtime change. Restore writer takeover already changes the safety write fence;
its new test passes without a second writer-specific mechanism.

## Research and Candidate Disposition

The parallel Luna skill ran four read-only workers. Browser adoption, restore and
vault workers completed; save-publication timed out after 420 seconds. The parent
inspected the save route/repository directly and reproduced the upload issue.
Aggregate evidence: `/tmp/phase06-luna-results.json` and progress log alongside it.
Worker suggestions were candidates, not proof.

- Cancellation after the last asynchronous safety-copy boundary cannot interrupt
  the synchronous directory/SQLite commit turn through a network callback. Existing
  committed-forward recovery defines the later failure contract; no extra mid-turn
  request cancellation check was inferred from an artificial synchronous hook.
- Modern/compatibility generation retain their prior finalization/quarantine
  semantics. The exact-source import/restore tests found no new transcript leak.
- A rebuild queued before any checkpoint enumerates the current stable source when
  execution begins. Count-stable edits before analysis are not treated as a defect;
  checkpointed/provider-captured source changes remain fenced. No periodic rebuild
  scheduler is promised by this phase.
- Post-commit report/event/cleanup failure can make HTTP acceptance ambiguous.
  Durable state, lineage and persisted events remain authoritative; native recovery
  verifies reload without another import. This phase does not invent durable
  import-operation receipts or automatic destructive retries.

## Validation Record

The nine initial focused owners passed; paths, exits and logs are recorded in
`/tmp/phase06-baseline-results.json`. Focused repaired owners passed, including
actual restore cancellation/takeover, full graph copy, provider lineage, vault
review preservation and accepted/stale UI outcomes. The native five-case suite
passed against a fresh smoke build after fixing the selection deadlock.

Early fixture corrections were kept separate from defects: error alerts use
`alertdialog`; takeover needs the disconnect-confirmation header; the custom
checkbox uses keyboard activation; reader startup uses projection readiness rather
than the writer-only background milestone; generation import needed its writer
header. One added analysis test initially omitted its `vi` import. No requirement
was removed to accommodate these corrections.

Final validation ran after implementation and self-review on the Phase 06 patch
above `6731c2aa2`. Shared SQLite graph replacement, worker lifecycle and browser
adoption/UI changes justified `pnpm test:agent`. All seven lanes passed, including
**9,554 frontend tests** across 729 files and **4,419 server tests** across 232
files; each suite retains three existing skips outside required I1–I6 evidence.
Frontend checks report zero errors/warnings. The architecture inventory and
browser-smoke build also passed. Log: `/tmp/phase06-agent.log`.

Executed final browser commands used that build with
`VITE_FASTIFY_BROWSER_SMOKE=TRUE`:

```sh
pnpm exec playwright test -c playwright.fastify-smoke.config.ts server/fastify/browser-smoke/importRestoreRecovery.spec.ts server/fastify/browser-smoke/backgroundJobRecovery.spec.ts server/fastify/browser-smoke/visibleStateRecovery.spec.ts
pnpm exec playwright test -c playwright.fastify-smoke.config.ts server/fastify/browser-smoke/fastifyBrowserSmoke.spec.ts --grep 'authored settings survive local backup restore and a full reload'
```

All **14 selected Chromium journeys passed** (13 plus the retained `.bin` round
trip). Logs: `/tmp/phase06-browser-final.log` and
`/tmp/phase06-browser-bin-final.log`. Assertions inspect visible controls, exact
persisted settings/transcripts/documents, event counts, reload, and current writer
presentation; provider/network faults are controlled at the actual boundary.

Focused runs used `pnpm test -- <one-owner-file>` or explicit Vitest selections;
the broad run subsequently executed all repaired owners without name filtering.
Final focused counts include bundle import 45, backups 55, maintenance 24,
translation 16, memory summary 31, embed 33, BardWiki analysis 13, rebuild 10,
vault lifecycle 9, browser backup helper 23, and selected-file wrapper 10.
The generation replacement selection passed four cases; all 83 owner cases then
ran in the broad suite. Existing nine-owner baseline and old-behavior reproduction
logs above distinguish pre-existing results from repaired behavior.

Current-document validation passed for 51 files. Explicit validation of the eight
archived plan documents and the plan index passed for nine files. Scoped Prettier
and `git diff --check` passed after archive link rewriting. `pnpm test:all` was
not requested or run.

## Completion Limits and Closeout

All required I1–I6 acceptance work and final validation are complete; no unresolved
in-scope finding or required evidence gap remains.
No production or human database is used. The scope covers supported replacement,
recovery and representative source-bound work, not exhaustive codec compatibility.

Optional depth follow-ups are explicit: external-process kill/power-loss at each
journal phase (process-recovery follow-up), physical device suspension/non-Chromium
(device follow-up), external provider behavior and the complete scale/performance
matrix (provider/performance follow-up). Next action for the process follow-up is
an isolated subprocess journal-stage harness; current exception/reopen fixtures do
not establish that result. Existing provider deadlines/draining remain in force;
this change does not run a second worker while an old provider is still draining.

All six phases are complete. This package is archived under
`.archived-docs/protocol-and-persistence/reliability-audit`; the active-plan index
records completion. No required follow-on phase remains.
Phase 06 was validated on `6731c2aa2` plus its implementation patch. The user then
requested committing the completed implementation and archive together.

<!-- prettier-ignore -->
| Optional follow-up | Impact and evidence limit | Next verification action |
| --- | --- | --- |
| Process recovery | Exception injection/reopen proves the implemented recovery choices, but not abrupt process death or filesystem durability under power loss. | Add a disposable subprocess harness that kills the server at each journal phase, reopens it, and checks database/asset/save coherence. |
| Device recovery | Chromium lifecycle and viewport exercises do not establish mobile OS suspension or other browser behavior. | Repeat writer promotion, late-response, reload and job-recovery journeys on physical mobile devices and a selected non-Chromium browser. |
| Provider and performance depth | Deterministic providers isolate orchestration; model behavior and the full scale/performance matrix are not certified. | Run the existing provider/compatibility and scale matrices with representative disposable fixtures and selected provider integrations. |
