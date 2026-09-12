# BardWiki Memory

Last audited: 2026-08-29.
Targeted source check: 2026-09-12 (job read ordering, rebuild/manual-document identity, and recovery).

BardWiki is the server-owned, per-chat Markdown memory system. It stores manual
and model-derived documents with stable ids, logical paths, aliases, wikilinks,
immutable versions, source provenance, and review state. The browser owns
editing intent and disposable resource projections; Fastify/SQLite remains the
authority.

## Ownership Map

| Surface | Primary owners |
| --- | --- |
| Shared wire/settings schema | `packages/protocol/src/bardWiki.ts` |
| Tables, validation, versions, links, and search projection | `server/fastify/src/bardWikiRepository.ts` |
| Targeted reads and deterministic vault export | `server/fastify/src/routes/bardWiki.ts`, `server/fastify/src/bardWikiVault.ts` |
| Revisioned settings/document/confirmation/import/rebuild commands | `server/fastify/src/routes/commands.ts`, `server/fastify/src/commands/events.ts` |
| Exact-source receipts and automatic confirmation | `server/fastify/src/bardWikiReceipts.ts`, `server/fastify/src/routes/generationChat.ts` |
| Transcript-mutation receipt invalidation | `server/fastify/src/bardWikiInvalidation.ts`, called by `server/fastify/src/messageStore.ts` |
| Background model work | `server/fastify/src/bardWikiWorker.ts`, `bardWikiApplyTurnHandler.ts`, `bardWikiReconcileHandler.ts`, `bardWikiRebuildHandler.ts` |
| Prompt selection/injection | `server/fastify/src/prompt/bardWikiSelection.ts`, `server/fastify/src/prompt/memory.ts`, `prompt/assemble.ts`, `prompt/budgetFinalize.ts` |
| Browser resources/commands/status | `src/ts/server/bardWikiResource.ts`, `bardWikiCommands.ts`, `bardWikiJobEvents.ts`, `src/ts/process/request/serverBardWikiJobs.ts` |
| Global settings and chat workspace | `src/lib/Setting/Pages/BardWikiSettings.svelte`, `src/lib/ChatScreens/BardWikiWorkspace.svelte` |

## Data And Resource Contract

The authoritative tables are `bardwiki_chat_settings`, `bardwiki_documents`,
`bardwiki_document_versions`, `bardwiki_turn_receipts`,
`bardwiki_document_sources`, `bardwiki_links`, and
`bardwiki_change_manifest`. `bardwiki_jobs` and `bardwiki_rebuild_staging` are
restart-safe operational state. `bardwiki_document_search` is derived and is
rebuilt from current documents after restore/import recovery.

Current document rows are soft-deleted; immutable version rows retain the exact
kind, path, aliases, context/review state, Markdown, content hash, actor, reason,
receipt/job provenance, and command revision. Normalized live paths are unique
within one chat. Links are parsed from Markdown and resolved against normalized
paths and aliases. Routine chat-index reads omit Markdown bodies; a selected
document and its bounded version page load lazily.

`GET /api/v1/bardwiki/chats/:chatId` returns effective/global/chat settings,
the current eligible explicit-confirmation source identity (ids and hashes,
never source text), body-free document indexes, receipts, and sanitized job
summaries. Document, version, receipt, and deterministic ZIP reads are separate
authenticated resources. Every response is private/no-cache or private/no-store
as appropriate.

## Settings And Workspace

The standalone BardWiki page under Settings > Tools & Extensions is available at
`/settings/bardwiki`. It chooses default enablement, Hypa/BardWiki/Hybrid mode,
model and prompt owners, automatic and canonical update policy, total/partition
token budgets, selected-document cap, link hops, and recent-query depth. The UI
groups these controls by default behavior, reply-time retrieval, and background
updates; it hides retrieval controls that do not affect the selected mode,
previews effective hybrid budget clamping, and reports autosave settlement. New
chats inherit globals; the workspace can persist nullable per-chat overrides.
When Settings was opened from a chat, the global page can return directly to
that chat's BardWiki workspace.

The active-chat overflow menu opens the lazy, focus-trapped workspace. It owns:

- manual create/edit/soft-delete with version/hash conflict fences and retained
  drafts;
- explicit current-turn confirmation, receipt/job state, cancel/retry, and
  visible review/error states;
- resumable full or missing-only rebuild preview and confirmation;
- deterministic vault export plus dry-run skip/rename/replace import;
- lazy document bodies/version history and responsive desktop/mobile layout.

With zero documents, the workspace presents one guided state: Create first
document, Import vault, and Build from chat enter the existing fenced flows.
Inherited controls label the server-provided effective value but keep the
stored draft nullable. Compact layout is list-then-detail with a Back to
documents action and retained unsaved drafts; desktop remains split-pane.
Lifecycle copy leads with Start fresh/Fill missing and Import vault outcomes,
while hashes, replacement counts, sources, and conflict strategy stay in
Technical details.

The activity disclosure summarizes running, attention, and failed counts.
Newly actionable work opens it, but unchanged or resolved work does not reopen
a disclosure the user closed. Confirmation, Retry, Cancel, and refreshed job
results share one live announcement owner. The modal uses the established
70%-black scrim, inert/hidden background branches, body scroll lock, a
44-pixel Close action, top-modal Escape ownership, and opener restoration.

Visible help text states that confirmation, automatic updates, and rebuilds can
call the configured provider in the background. Full rebuild warns that it
replaces derived documents while preserving user-authored documents. Vault
replace warns that only previewed version/hash fences may be overwritten.
English is complete in `src/lang/en.ts`; Korean has matching BardWiki strings in
`src/lang/ko.ts`.

## Confirmation And Background Jobs

Explicit confirmation accepts only the current active adjacent `user -> char`
tail with exact message ids and SHA-256 hashes. Automatic confirmation is
inserted by successful send finalization for the preceding accepted pair; first
send, continue, regenerate, failed/cancelled sends, alternates, comments, and
disabled boundaries do not schedule it. One exact source tuple maps to at most
one receipt/change-set identity.

`bardwiki_jobs` is an isolated fair lane, separate from Hypa `memory_jobs`.
Payloads are identifier/hash/configuration metadata only and are capped at
16 KiB. Claims, retries, cancellation, restart recovery, retention, and rebuild
checkpoints are durable. Provider calls happen outside revision transactions;
the handler rereads source/settings before work and rechecks source/document
fences in the final short transaction. One repair is allowed for invalid model
output. A canonical conflict gets one fresh-snapshot recompilation. The event
document, canonical H3 changes, versions, links/search, provenance, manifest,
receipt, revision, and command event commit together or not at all.

Source edit/delete/truncate/alternate replacement obsoletes pending work. An
applied receipt is safely inverted only while every affected document still
matches its recorded after-hash; otherwise the receipt/documents become
`needs_review`. Job SSE contains only bounded status/progress/error summaries.
Targeted reads remain authoritative after reconnect. Chat reads also carry a
per-chat request epoch: job transitions can share a domain revision, so an older
read must not replace a newer terminal status merely because their revisions match.
The same epoch covers workspace reads and invalidation refreshes.

Full rebuilds preserve user-edited documents, documents awaiting review, and
their version history. This includes imported manual content whose latest
version was written by system reconciliation to set `needs_review`. If a prior
rebuild event identity is already owned by a preserved or deleted document, the
new derived event gets a separate ID; later rebuilds reuse that new event through
its receipt. Cancellation remains terminal for that job. A fresh preview/build is
the supported successor after cancelling a rebuild or changing its checkpointed
source; retrying an unchanged stale checkpoint does not accept changed source.

## Prompt Retrieval

At the memory bridge, BardWiki builds a bounded lexical query from the current
input and recent active transcript, scores the derived search projection,
expands resolved wikilinks within the configured hop/document limits, and emits
deterministically ordered `<bardwiki-reference>` system rows. Pinned documents
must fit or assembly fails with `bardwiki_pinned_budget_exceeded`; other rows are
selected whole and never misleadingly truncated.

Mode behavior is explicit:

- `hypa`: existing Hypa behavior; no BardWiki rows.
- `bardwiki`: BardWiki uses at most the total memory budget; no Hypa rows.
- `hybrid`: independent Hypa/BardWiki caps are clamped to the total, reducing
  BardWiki first if their sum exceeds it.

Preview, prompt SSE metadata, and provider dispatch share the same selection.
Retrieval performs no provider call or durable write and never waits for pending
jobs. The representative 2,000-document timing case lives in
`server/fastify/__tests__/bardWikiSelection.test.ts`; it records diagnostics
without enforcing a flaky wall-clock threshold. Deterministic prompt coverage
also lives in `bardWikiPrompt.test.ts`, `memory.test.ts`, and `assemble.test.ts`.

## Lifecycle, Interchange, And Recovery

Chat/character deletion physically cascades all BardWiki domain/job/search/
staging rows. Transcript mutations trigger receipt invalidation. A chat fork
copies the chosen transcript only and starts with no BardWiki rows; the user can
run an explicit rebuild over the retained messages. Portable chat/save import
does not silently merge BardWiki.

The BardWiki vault is an Obsidian-compatible stored/deflated ZIP with
`manifest.json` and one Markdown file per live document. Export is deterministic
(stable ordering, timestamps, names, frontmatter, and bytes) and excludes raw
message sources. Import limits are 16 MiB compressed, 64 MiB expanded, and 2,000
documents. It rejects ZIP64/multidisk/encrypted/unsupported entries, symlinks,
path traversal, absolute/backslash/control/invalid-UTF-8/duplicate paths,
manifest/frontmatter mismatches, and content-hash failures. A dry run classifies
every create/replace/noop/skip/rename; apply revalidates all fences and commits
the complete plan in one revision or rolls it all back.

Server backup/restore includes authoritative and resumable BardWiki tables,
excludes the derived search projection, and rebuilds links/search after restore.
Interrupted rebuild staging is invisible to prompt retrieval and resumes in
oldest-first batches; final publication is one atomic revision/event. Full mode
replaces latest model/system event and canonical documents while preserving
latest user-authored documents.

## Security And Verification

All reads require authentication. Revisioned writes require the active writer,
base revision, request limits, and narrow field/version/hash validation.
Operational cancel/retry also requires the active writer but does not pretend to
be a domain revision. Model requests inherit existing credential masking,
provider deadlines/abort, and private request-history boundaries. Routine
metrics, status events, and jobs contain no credentials, prompt bodies, source
text, document Markdown, or provider output.

Owning server tests are every `server/fastify/__tests__/bardWiki*.test.ts` plus
commands, backups, route protection, generation chat/operations, prompt
assembly/memory, repository, memory worker/events/jobs, and request-history
tests. Owning browser/client tests include the BardWiki protocol, settings,
workspace/lazy boundary, command/resource/invalidation/job adapters, language
packs, and `server/fastify/browser-smoke/bardWikiLifecycle.spec.ts`.

Apply-turn and rebuild provider continuations check their captured database
lineage before publication. Worker completion/retry callbacks cannot alter a
restored job with the same ID, and the next tick recovers snapshot-running jobs.
Vault import remains a per-chat document transaction: it neither rotates whole
state lineage nor rewrites the source transcript. Exact replacement fences and
normal source reconciliation protect imported edits.
