# Assets And Saves

Last audited: 2026-08-30.
Targeted source checks: 2026-09-12 (bounded backup workers, inlay reader/migration authority, and browser backup fencing).

Fastify owns binary persistence, save import/export, Realm import, and backup
snapshots. Browser code should use server asset URLs and server save routes
instead of writing runtime state directly.

Static app assets are a separate source boundary from persisted runtime assets:
`public/` is Vite-served static input, `resources/` retains currently
unconsumed packaging artwork, and `src/etc/` mixes live bundled media/tokenizer
data with unreferenced legacy payloads. Save/import/export and user-upload flows
should use server asset ids and `/api/v1/assets/:id` URLs, not static `/public`
paths.

## Storage Usage

Backup & Restore displays `src/lib/Setting/Pages/StorageUsage.svelte`, backed by
the authenticated, read-only storage-usage route in
`server/fastify/src/routes/storageUsage.ts`. Its shared contract lives in
`packages/protocol/src/storageUsage.ts`; the browser adapter is
`src/ts/server/storageUsage.ts`.

`server/fastify/src/storageUsage.ts` asynchronously measures file lengths under
the configured data directory, grouped into database, database working files,
assets, backups, compatibility files, trace logs, and other files. It streams
directory entries and never loads database or asset contents. Hard links count
once, with live files preferred over backups; child symlinks and unreadable or
disappearing files yield an explicitly partial estimate. The configured root
itself can be a symlink. File lengths are not allocated disk blocks or an atomic
snapshot. Capacity is reported separately for the data root's filesystem, so
files on other mounted volumes are never subtracted from that capacity.

The card loads on mount, offers manual refresh, and retains the last result
with a failure message when refresh fails. Missing filesystem-capacity support
does not hide file totals. Requests are rate limited and concurrent scans are
coalesced; completed results are not cached. Cancellation on server shutdown
stops the scan. Coverage lives in
`server/fastify/__tests__/storageUsage.test.ts`, the route-protection suite, and
`src/lib/Setting/Pages/StorageUsage.svelte.test.ts`.

## Assets

| Path | Role |
| --- | --- |
| `server/fastify/src/routes/assets.ts` | `/api/v1/assets`, `/api/v1/assets/bulk`, immutable `GET`/`HEAD`, existence probe. |
| `server/fastify/src/repository.ts` | Asset id validation, sha256 dedupe, SQLite metadata, file paths, missing-asset checks. |
| `server/fastify/src/assetGc.ts` | Cooperative asset discovery and transactionally fenced reclamation. |
| `server/fastify/src/assetReferenceScan.ts` | Shared backup/GC reference projection with paged sources and disposable SQLite membership. |
| `server/fastify/src/risuSave/assetReferences.ts` | Known-field asset-reference walker for import/export/GC reports. |
| `src/ts/server/assets.ts`, `src/ts/globalApi.svelte.ts` | Browser upload/read adapters, asset URL normalization, and bulk-upload existence probing. |
| `src/ts/server/inlayCatalog.ts` | Browser catalog projection validation and revision-aware acknowledgement application. |
| `src/ts/server/commands.ts`, `src/ts/process/files/inlays.ts` | Catalog commands plus the upload/register/migrate/read/delete inlay workflow. |
| `src/ts/server/settingsMediaAssetUpload.ts`, `src/ts/process/stableDiff.ts` | Durable image-setting asset references and lazy provider-request base64 materialization. |

Asset ids are lowercase sha256 hex strings. Metadata lives in SQLite `assets`;
bytes live at `data/assets/<sha256>.<ext>`. Supported content types are defined
by `CONTENT_TYPE_EXTENSIONS` and mirrored by content type in
`SERVER_ASSET_CONTENT_TYPES`; the client also accepts `jpeg` as an upload alias
for the server's canonical `jpg` extension.
`POST /api/v1/assets` accepts raw supported asset bytes;
`POST /api/v1/assets/bulk` accepts compact binary framing for browser bulk
uploads and keeps JSON/base64 batch compatibility for legacy callers.
`saveAssets()` limits browser hashing to four concurrent assets, deduplicates
ids within the call, fills the existence endpoint's 1,024-id capacity, and
packs missing bytes toward 32-asset/32 MiB upload targets. A single asset larger
than the byte target remains a single-item batch instead of being split. Asset
requests time out after five minutes; transient rate-limit responses honor
`Retry-After` and retry the affected request up to three times. These contracts
are named by the `SERVER_ASSET_*` constants in `src/ts/globalApi.svelte.ts` and
guarded by `src/ts/globalApi.saveAssets.test.ts`.
Callers that supply `saveAssets()` progress reporting opt into independently
acknowledged missing-asset uploads with the same four-worker bound. Progress
counts an input only after its id is confirmed by an existence probe or its
upload response, so module-import progress cannot get ahead of persistence in
an opaque bulk request. Callers without a progress callback retain the compact
bulk-upload path.
Uploads are authenticated and active-writer guarded. Asset metadata is outside
the revisioned application-resource domain: uploads return the current domain
revision but do not bump it or emit a command event. Re-uploading existing
bytes is idempotent and can heal a missing file. Browser upload helpers request
`Prefer: return=minimal`; compact single and bulk acknowledgements return
`{ assetId, revision }` and `{ assetIds, revision }` respectively, while callers
that omit the preference retain the fuller compatibility response. A dedup hit
also refreshes the existing file's mtime on a best-effort basis, restarting the
GC grace window before the upload's later reference mutation commits.

`GET` and `HEAD /api/v1/assets/:id` are public immutable reads for ids present
in metadata and on disk. `POST /api/v1/assets/exists` is a public read-only POST
that checks metadata only; it does not prove the corresponding file remains on
disk. A direct re-upload can heal missing bytes, but a browser bulk helper can
skip that repair when metadata already exists.

NovelAI I2I/character-reference and WaveSpeed reference-image uploads store
only the durable server asset id and remove the duplicated legacy inline-base64
field. `src/ts/process/stableDiff.ts` reads and encodes the asset only while
constructing the provider request. Imported base64-only settings and inline
fallbacks for an unreadable imported asset reference remain supported.

`runAssetGc()` asynchronously scans known asset-reference fields through
`assetReferenceScan.ts` and the shared save-report walker. Its projection covers
root and nested image settings (including NovelAI I2I,
NovelAI character reference, and WaveSpeed reference image), module assets,
persona icons, bot/model/prompt preset images, character/chat reference fields,
and inlay tokens in character-rendered text. Column-only scans add active and
durable alternate `messages.data` inlays, pending generation-finalization
message/alternate payloads, and `inlay_catalog` membership. Plugin custom
storage is the deliberate arbitrary-JSON exception: GC loads only its
`value_json` columns and deeply scans strings, while the shared walker applies
the same sha256-id/`assets/<id>.<ext>` validation used everywhere else.

The shared walker is authoritative for current portable-save and GC database
fields. Portable discovery and legacy `.bin` rewriting consume the declarative
owner vocabulary in `server/fastify/src/risuSave/assetOwnerCatalog.ts`; their
shape-specific handlers remain separate and are exercised against the same
positive corpus plus an arbitrary-JSON negative. Operational-only references
(pending finalization rows and catalog membership) are included by maintenance
discovery because they must survive backups and GC, even though they are not
part of an exported database. A grace window protects
upload-then-reference races. If any valid asset file is newer than that grace
window, GC treats upload/import staging as active and defers every orphan and
stray-file reclamation for the sweep; ordinary aging makes later sweeps
converge. GC remains revision-free and emits no command events.

Discovery finalizes each primary iterator before yielding, pages at most 64
rows, and yields after 256 KiB or 4 ms of projected work. Distinct reference and
chat IDs spill to a disposable SQLite file with a 2 MiB cache. One oversized
existing field or native legacy JSON projection can exceed a slice;
`largestRowBytes` reports that residual. Scratch files are removed on completion,
cancellation or failure and recovered at the next attempt after a crash.

Only one sweep owns a directory. Before each batch of at most 16 candidates,
GC checks SQLite total changes, external-connection data version, lineage, and
maintenance/upload activity captured before discovery. A changed fence stops
the sweep conservatively. Metadata is revalidated and deleted inside a SQLite
transaction; canonical file removal follows successful commit in the same JS
turn, with no asynchronous unlink tail. Failed commits retain bytes, and failed
unlinks remain retryable strays. Deduplicated uploads also advance the activity
fence even when only file mtime changes. Results retain at most 1,024 deleted
IDs/names plus full counts and a completed/skipped/stale/cancelled status.
The upload-grace pass performs at most four asynchronous file-age reads at
once. All started reads settle before cancellation can release the lease.

### Inlay Catalog

`inlay_catalog` is revisioned metadata over authoritative `assets` rows. Each
entry is keyed by `asset_id` and stores a display name, optional dimensions,
and aliases; the read joins in extension, size, and the derived
image/audio/video/signature type. `GET /api/v1/inlay-assets` returns the complete
authenticated catalog. `PUT /api/v1/commands/inlay-assets/:assetId` and
`DELETE /api/v1/commands/inlay-assets/:assetId` emit `inlayCatalog.upserted` or
`inlayCatalog.deleted` and update only this targeted table. The browser keeps
the catalog outside the aggregate compatibility database and refreshes it as a
fourth root resource. See
[Server Resources And Hydration](server-resources-and-bridges.md#bootstrap-and-initial-resources)
for reconciliation behavior. Persistence and client projection behavior are
guarded by `server/fastify/__tests__/inlayCatalog.test.ts` and
`src/ts/server/inlayCatalog.test.ts`.

`src/ts/process/files/inlays.ts` owns browser ingestion and compatibility
migration. New decoded-image ingestion rejects sources above 16 Mi-pixels and
`writeInlayImage()` downsizes accepted images above 1 Mi-pixel before uploading
PNG bytes; audio/video bytes and signature JSON use their own content types.
Readers ensure and fetch the server catalog without attempting local migration.
With writer authority, listing first migrates usable browser-local entries and
aliases into the server catalog and removes metadata ghosts with no bytes/asset
id. Catalog reads remain available to readers; migration, registration, and
deletion require a current writer. Browser-local reads remain only as a legacy
fallback. Deletion removes the revisioned catalog row and matching local aliases;
immutable bytes remain subject to server asset GC.

## `.risu` And Bundle Routes

| Path | Role |
| --- | --- |
| `server/fastify/src/routes/save.ts` | Save import/export and device-backup bundle routes. |
| `server/fastify/src/risuSave/importSnapshot.ts` | Envelope decode, validation, and import normalization. |
| `server/fastify/src/risuSave/exportSnapshot.ts` | Repository export into block or legacy envelopes. |
| `server/fastify/src/risuSave/portableMetadata.ts` | Validated versioned `__risuServerData` metadata. |
| `server/fastify/src/translation/greetingTranslationStore.ts` | Portable normalized greeting-translation extraction/replacement. |
| `server/fastify/src/risuSave/bundleExport.ts` | Zip bundle export with `.risu` bytes plus present asset files. |
| `server/fastify/src/risuSave/localBackupExport.ts` | Original Risu `.bin` local-backup export with asset records. |
| `server/fastify/src/risuSave/exportAssetIntegrity.ts` | Export-time content hash and declared-size verification. |
| `server/fastify/src/risuSave/localBackupImport.ts` | Streaming device-backup decode for `.risu.zip` and legacy `.bin`. |
| `server/fastify/src/risuSave/localBackupDatabase.ts` | Legacy `.bin` account redaction and asset-reference conversion. |
| `server/fastify/src/risuSave/importLimits.ts` | Expanded-payload guard shared by `.risu` and Realm import decoding. |
| `server/fastify/src/risuSave/boundedInflate.ts` | Streaming bounded inflate used by block and legacy envelope codecs. |
| `server/fastify/src/risuSave/blockCodec.ts` | Current `.risu` envelope codec. |
| `server/fastify/src/risuSave/legacyEnvelopeCodec.ts` | Legacy `.risu` envelope codec. |

`POST /api/v1/import/risusave` accepts multipart `.risu` uploads or JSON
database bodies. Imports normalize the database, apply it through the
repository, replace legacy Hypa V3 rows where needed, emit `state.imported`,
and return revision, command-event, database-lineage/writer ownership metadata,
and asset reports. Multipart `.risu` and bundle-style imports also return
format-specific import reports; JSON body compatibility imports omit that
`importReport` detail but retain the common ownership/event metadata and asset
report. Plain `.risu` responses expose aggregate referenced/missing/orphaned
counts, where missing means absent asset metadata rather than missing disk
bytes. They do not fetch remote/cache assets server-side.

`GET /api/v1/export/risusave` exports the current repository as a `.risu` and
supports envelope/compression query options.
`GET /api/v1/export/bundle` returns a zip with `database.risu`,
`manifest.json`, and present referenced asset files.
`GET /api/v1/export/local-backup` returns an original Risu-style `.bin` local
backup with referenced asset records and a legacy-compressed `database.risudat`
record. The embedded database omits the obsolete legacy `account` object and
rewrites known Fastify asset ids to original-Risu `assets/<sha>.<ext>` paths so
the original loader resolves the matching records. Export routes emit
`state.exported` notifications without bumping the domain revision.

Bundle and local-backup exports verify each present asset against its
content-addressed id and declared size before response bytes begin, then hash
the exact streamed bytes again to close the mutation race. A file that
disappears is reported as missing and omitted; stale or corrupt present bytes
fail the export instead of producing an archive that its importer would reject.

`POST /api/v1/import/bundle` handles the browser "Load Backup Locally" path. It
streams upload bytes to disk, bounded by `RISU_API_IMPORT_MAX_BYTES` (unlimited
by default), then sniffs ZIP magic and decodes either a `.risu.zip` bundle or
the original app's legacy `.bin` local backup. Bundle zip import reads
`manifest.json` version `1`, accepts a `.risu` database payload entry, validates
`assets/<sha>.<ext>` entries by extension and content hash, ignores unrelated
zip entries, and still caps inner `.risu` expansion even when the outer upload
limit is unlimited. Asset entries are hashed and written directly to temporary
staging files instead of being concatenated in memory; the embedded database is
the only large entry retained for the existing envelope decoder, and its
buffering is guarded by that same inner `.risu` ceiling. Legacy `.bin` import
streams recognized media records plus all hash-named supported asset records,
including ONNX, CSS, and inlay-signature JSON, while seeking past unrelated
non-media/cold-storage records without allocating their payloads. Original-Risu
asset paths in the embedded database are canonicalized back to server asset ids
before persistence, including custom or fallback non-sha256 media filenames.
Legacy record names are capped at 1,024 bytes, and a second
`database.risudat` record is rejected rather than selecting a last writer.
`src/ts/server/backups.ts` uses the `x-risu-estimated-backup-bytes` progress
header when present; UI-facing wrappers live in `src/ts/storage/backup.ts`.

Whole-database `.risu`, bundle, and legacy `.bin` imports reject group
characters atomically with `422 unsupported-group-characters`. Block-envelope
saves that contain standalone `CHAT` blocks import all supported blocks, skip
each standalone chat block, and return its exact name and type in
`importReport.skippedBlocks`. The browser includes every skipped block in the
localized completion report. Exported whole-database saves contain raw
credential-bearing settings, including shared
provider API keys and Vertex private keys; treat these files as secrets. The
Settings UI requires the localized secret-warning confirmation before requesting
the ZIP-style local-backup export; this is guarded by
`src/lib/Setting/Pages/UserSettings.svelte.test.ts`. The separate bug-report
export masks registered secrets.

## Content Exchange

Portable formats outside whole-database saves retain browser UI/confirmation
ownership. Local character-card and module files are exceptions at the byte
boundary: the browser sends each selected file once and Fastify owns decoding,
asset registration, validation, and the final revisioned create.

| Owner | Exchange contract |
| --- | --- |
| `src/ts/storage/exportAsDataset.ts` | Dataset JSON export. |
| `src/ts/characters.ts` | Single-chat and all-chat import/export. |
| `src/ts/characterCards.ts`, `src/ts/process/processzip.ts` | Character-card export and non-picker compatibility helpers. |
| `server/fastify/src/routes/localFileImport.ts`, `server/fastify/src/localFileImport.ts` | Local character-card/module upload, decoding, assets, and create. |
| `src/ts/persona.ts` | Persona PNG import/export. |
| `src/ts/storage/database.svelte.ts` | Legacy and split preset exchange, including `.risup`. |
| `src/ts/process/lorebook.svelte.ts`, `src/ts/process/scripts.ts`, `src/ts/translator/presets.ts` | Lorebook, regex-script, and `.risutl` translator-preset exchange. |

Prompt Settings imports inspect the unmerged legacy payload. Pure prompt files
remain prompt-only without interruption. When a file carries standalone
provider/model-routing fields, a localized dialog names its primary and
auxiliary models and lets the user import both model and prompt halves, keep
only the prompt half, or cancel without writing either half.

### Character Cards

`POST /api/v1/import/character-card` accepts one multipart JSON, PNG, CharX, or
JPEG-embedded CharX file. Fastify streams the upload to a temporary file,
decodes archives server-side, stores content-addressed assets, converts the
card, and creates the character in one revisioned operation. Entries that
expand beyond 50 MiB and oversized inline data-URI assets are dropped while
readable card content is imported; the response report drives the existing
localized completion alert. Missing non-dropped assets remain hard errors.
Password and low-level-access prompts use a short-lived pending token, so a
confirmation retry sends JSON only and does not upload or unpack the file
again. The older browser `CharXImporter` remains for non-picker compatibility
callers and export-adjacent tests.

Local character-card callers can opt into an SSE response with
`Accept: text/event-stream`. The upload remains a single multipart request;
XHR upload events drive byte progress, then server `progress` frames report
reading, asset import, conversion, and saving. Archive passes report measured
bytes and saved-asset counts. The terminal `result` frame carries the ordinary
status code and JSON body, including confirmation tokens and conflicts; it is
the acceptance boundary. Callers without SSE keep the JSON response. The
browser refreshes command projections before closing its progress dialog.

Local character-card asset writes and the character mutation now run in the
same server request. Content-addressed assets written before a later validation
or revision conflict are not deleted eagerly; unreferenced bytes remain eligible
for normal grace-window GC.

Fastify generates fresh character/chat/definition identities for uploaded
cards and initializes the starter chat's `fmIndex` to `-1`, so the imported
greeting is available immediately after selection. Programmatic compatibility
imports that still enter through `importCharacterProcess()` retain the browser
identity normalizer.

Packaged-card export rewrites prebuilt-asset exclusion references together with
their asset references. Import keeps only exclusions that resolve to imported
additional assets and converts them to server asset ids; stale legacy paths are
dropped because they cannot match a character asset or satisfy Fastify's asset
reference validation.

Character-card import preserves author-supplied activation configuration on
Agent-only lore entries: Always Active, primary and secondary keys, selective
activation, and regex mode survive instead of being normalized away. Persisted
state repair accepts these imported compatibility values, while new Agent-only
command payloads keep the stricter no-activation validation. The SQLite command
side links back here from
[Data And Events](data-and-events.md#revision-contract).
Card and standalone lorebook export project Agent-only entries as inert for
Original Risu by clearing both activation-key sets and disabling Always Active.
That projection is export-only and never mutates the stored entry.

### Chats And Datasets

Dataset export strictly hydrates every chat and character lorebook before
serialization; any incomplete hydration fails the export. All-chat export
similarly hydrates the target character's chats and writes unchanged
`risuAllChats` version-2 JSON. Its download passes
`revokeObjectUrlAfterMs: null`, deliberately keeping the blob URL alive instead
of applying the helper's normal revocation timeout. Single-chat and all-chat
exports also reject a transcript whose first row is still a cold-storage
placeholder; the user must restore that archived content before export.

Chat import accepts Tavern-style JSONL, `risuChat` and `risuAllChats` JSON v1/v2,
and Risu HTML embeds. It rekeys imported chats/folders, clears unknown folder
references, normalizes chat-generation settings, and dispatches targeted
server-backed creation commands.

Only the sidebar's Export all chats action offers destructive follow-up:
after the download succeeds, two confirmations are required before a durable
command replaces that character's chats with one empty `Chat 1` and selects page
`0`. After both confirmations, the client compares the live chat IDs, counts,
and last-message identities/content hashes with the exact exported-state fence;
any mismatch aborts reset and requires a new export. Chat folders remain.
Export failure, a fence mismatch, either cancellation, or terminal command
failure leaves or restores the chats. This does not change the export bytes or
affect single-chat, dataset, character-card, `.risu`, bundle, or local-backup
exports. The client contract is guarded by
`src/ts/characters.exportChat.test.ts`,
`src/lib/SideBars/SideChatList.svelte.test.ts`, and
`src/ts/chatCommands.test.ts`. The server-side transaction, revision, and event
contract belongs to
[Data And Events](data-and-events.md#revision-contract).

Module and MCP-bearing `.risum` exchange is owned by
[Plugins And MCP](plugins-and-mcp.md#fastify-mode-limits). The remaining
dataset/chat import guards are `src/ts/storage/exportAsDataset.test.ts` and
`src/ts/characters.importChat.test.ts`.

## BardWiki Vaults

Portable `.risu`, bundle, local-backup, character-card, and chat exchange do not
silently merge per-chat BardWiki state. BardWiki has a separate authenticated,
deterministic Obsidian-compatible ZIP export and an explicit dry-run/apply
import. The importer validates compression/expansion/document limits, safe
paths, UTF-8, manifest/frontmatter/content hashes, and version/hash replace
fences before one atomic revision. See
[BardWiki Memory](bardwiki.md#lifecycle-interchange-and-recovery) for the vault,
fork, rebuild, and recovery contract.

## Realm Import

`POST /api/v1/import/realm-character` accepts JSON with a Realm id, fetches
dynamic Realm JSON cards plus referenced hub resources server-side, and handles
Realm-provided `charx`/zip packages with packaged assets. It stores resources as
content-addressed assets and appends the converted character through the command
mutation path.

Card conversion helpers live in `server/fastify/src/realmImport/`. Asset
staging/persistence, `charx` extraction, progress SSE, low-level-access
confirmation, import limits, and the command-mutation commit are owned by
`server/fastify/src/routes/realmImport.ts`. Browser request/SSE decoding lives
in `src/ts/server/realmImport.ts`; response-event reconciliation and resource
refresh live in `src/ts/server/resourceRefresh.ts`, while navigation,
low-level-access retry, and older browser fallback handling live in
`src/ts/characterCards.ts`. A successful response carries the revision,
`character.created` event, and character id. When that event is contiguous the
browser refreshes only the character list and preserves resident hydrated
bodies; a missing cursor, mismatched event, or revision gap falls back to a
complete resource refresh. Server Realm import is primary but not exclusive:
unsupported server Realm responses can fall back to the older browser path, and
local direct `charx` file import still has a browser-native path. Negotiating
`realmProgressDelta` makes the first progress frame complete and later frames
carry `percent` plus only changed fields.
Operational guards include a request deadline and client-disconnect abort,
dynamic JSON size caps, per-asset and cumulative fetched-asset caps, pending
low-level-access confirmation tokens, and temporary staging cleanup. Rollback
of newly created asset rows/files is guaranteed for both JSON-card and CharX
imports when later conversion or character commit fails; deduplicated assets
that predate the failed import are preserved. Non-SSE JSON responses include
success, low-level-access confirmation tokens, HTTP `415`
`unsupported_realm_download` fallbacks, revision conflicts, and upstream/fetch
errors.
The `/api/v1/download/dynamic/` string in the route module is an upstream Realm
path constant, not a local Fastify route.

## Legacy Storage Compatibility

`/api/v1/storage/*` remains live for compatibility and stores bytes under
`data/save/<hex-key>` through `server/fastify/src/routes/legacyStorage.ts` and
`src/ts/storage/fastifyStorage.ts`. These writes are active-writer guarded but
do not bump the domain revision. Server backup snapshots include `data/save/`;
device `.risu`/bundle/local-backup exports do not include this compatibility
store.

## Backups

| Path | Role |
| --- | --- |
| `server/fastify/src/routes/backups.ts` | Create/list/restore/delete backup routes. |
| `server/fastify/src/repository.ts` | Snapshot creation, manifest writing, SQLite table restore, file swaps. |
| `server/fastify/src/backupFiles.ts`, `maintenanceCoordinator.ts`, `maintenanceRequest.ts` | Bounded copy/verification, maintenance and live-staging leases, request cancellation. |
| `server/fastify/src/backupCopyPool.ts`, `backupCopyProtocol.ts`, `backupCopyWorker.ts` | Two private native copy/hash workers, bounded descriptor batches and acknowledged cancellation/drain. |
| `src/ts/server/backups.ts` | Browser adapter for backup/import/export routes and progress headers. |
| `src/ts/server/replacementDatabaseOwnership.ts` | Adopts replacement lineage/writer ownership before refreshing state. |
| `src/ts/storage/backup.ts`, `src/ts/globalApi.svelte.ts`, `src/lib/Setting/Pages/UserSettings.svelte` | UI-facing backup/import/export wrappers and settings flows. |

Backups live under `data/backups/<id>/`. Current backups contain
`manifest.json`, an online `node:sqlite` backup of the whole `risu.db`, assets
when present, and optional legacy `save/`; new backups do not write `db.json`.
Creation first reads the `wal_checkpoint(TRUNCATE)` result row and requires
`busy = 0` with every logged frame checkpointed after bounded retries. A busy
manual checkpoint returns `backup_wal_checkpoint_failed`; the same failure in a
safety snapshot is wrapped as `automatic_backup_failed`. Create, restore, and
delete are authenticated and active-writer guarded; list is authenticated
read-only. The durable route-policy owners are the `backup-mutations` and
`backup-list` entries in `server/fastify/src/routeManifest.ts`; behavior is
guarded by `server/fastify/__tests__/backups.test.ts`.

The browser adapter exposes backup creation/listing/deletion only while the
managed session has writer access, even though the server list route itself is
read-only. Restore is likewise unavailable to readers. Each mutating request
rechecks writer-operation freshness so a transition to reader mode prevents a
late backup or restore action from continuing under stale authority.

Backup creation holds a data-directory maintenance lease from before the SQLite
backup await through file verification and publication or failure cleanup.
Two private Node worker threads copy captured asset metadata and legacy directory
extras. Each processes one batch of at most 16 file descriptors sequentially;
there is no queued batch or transferred file payload. The pool spans assets,
extras and compatibility saves. Required references include pending-finalization, catalog
and plugin-storage owners. Missing required metadata/bytes, wrong size or wrong
hash prevents publication. A temporary manifest is renamed only after completion.
The captured SQLite database uses the same bounded reference scanner as GC;
metadata is streamed in 64-row pages while scratch membership remains open.
Directory traversal buffers 64 entries at each of at most 32 levels, and each
worker hashes with a reusable 64 KiB buffer. Deeper legacy extras fail closed. Existing optional
orphan bytes are copied when present; missing orphan files retain their missing
state. Concurrent synchronous uploads may add harmless unindexed extras, which
are not claimed to share the SQLite snapshot's precise instant.

The worker entry uses native Node 24 type stripping with no app or SQLite imports.
Shared cancellation is checked between files and hash reads. A native copy may
finish before observing cancellation; the pool waits for every active batch
acknowledgement and both worker exits before scratch cleanup, publication or
lease release. Snapshot authority, directory traversal, manifest publication
and retention remain in the main process.

The coordinator admits one exclusive backup/import/restore/delete operation and
no queued operations. Up to four compatibility-save mutations or four operations
staging live assets across awaits may run when no exclusive operation owns the
directory. Conflicts return transient `503 maintenance_busy`. Save writes/removes
hold their lease through filesystem cleanup; local/Realm live asset conversion
holds staging ownership through commit or rollback. Temporary multipart intake
does not hold a live-state lease while waiting for network bytes. Ordinary
commands and immutable synchronous uploads remain responsive; GC defers while
backup or staging protection is active. An active sweep excludes exclusive
maintenance, and staging begun during its awaits invalidates that sweep.

Import/restore owns one lease across its nested safety snapshot and destructive
transaction. A write fence captured before safety copying checks revision,
lineage, SQLite total changes and external-connection data version immediately
before replacement. A concurrent accepted write causes `maintenance_busy`,
preserving live state and the completed safety snapshot. No SQLite transaction
spans a copy await. Automatic retention reads manifests asynchronously, discards
manual/corrupt entries as it goes, and retains only the configured newest
selection plus protected source IDs; public backup listing remains unchanged.

Only restore's safety snapshot may recover missing captured-live asset bytes
from its validated, pinned restore source. The same captured hash and size must
match, and capture does not repair live files. Missing bytes in both locations
or invalid fallback bytes fail closed. This preserves recovery after live-file
loss without treating an incomplete safety snapshot as successful.

Restore reconciles the restored generation ledger and publishes `state.restored`
synchronously after commit and before post-commit retention can yield. This
prevents later commands from overtaking the restore event and prevents a late
startup reconciliation from abandoning newly accepted generation work. Existing
journaled staging/swaps and their synchronous recovery policy remain unchanged.

Before an initialized database is replaced by a `.risu`, bundle, legacy local
backup, or server-backup restore, the repository creates a fail-closed automatic
safety snapshot. These manifests use `kind: "automatic"` and the stable
`Automatic safety snapshot` label, so they remain visible and restorable through
the ordinary backup API and UI. Automatic snapshots retain the newest three by
default (`RISU_API_AUTOMATIC_BACKUP_RETENTION`); retention never counts or
deletes manual backups. First-run imports skip the snapshot only when no
`settings` row exists. Restore validates its source database payload before
creating the safety snapshot or touching restore staging directories.

Restore swaps asset/save directories and restores SQLite tables through the
`SQLITE_BACKUP_TABLES` allowlist in `server/fastify/src/repository.ts`, then emits
`state.restored` and triggers a complete browser resource refresh. Because
restore swaps tables from the copied backup DB with `ATTACH`, operational tables
can be present in the backup file but ignored on restore if they are not
allowlisted. `SQLITE_BACKUP_EXCLUDED_TABLES` names every deliberately live or
device-local table and records why it is not restored. The backup policy test in
`server/fastify/__tests__/backups.test.ts` requires every production table to
appear in exactly one of those sets, rejects stale entries and overlaps, and
requires a rationale for every exclusion. Split model/prompt preset rows and
`inlay_catalog` are included in the restore set. The SQLite-only durability
policy is explicit:

| State | Portable `.risu`, bundle, and local backup | Server backup/restore |
| --- | --- | --- |
| Generation finalization retries | Excluded: portable content transfer never resumes old operational work. | Snapshot-owned and restored. Historical queue tables use an explicit column projection; missing target snapshots default to `NULL` and missing alternates to `[]`. |
| Legacy-summary tombstones | Encoded under the validated, versioned `__risuServerData` root key and stripped before repository normalization. | Snapshot-owned and restored after `memory_summaries`, so delete-trigger side effects cannot change the selected snapshot. |
| Greeting translations | Source-valid rows are embedded per character; import validates, deduplicates, and drops stale-source rows. | `greeting_translations` is restore-allowlisted and replaced with the snapshot. |
| LLM request history | Excluded: device-local diagnostic telemetry. | The physical SQLite copy contains it, but restore does not import it and clears the live table during lineage rotation; this telemetry does not survive the replacement boundary. |
| Inlay catalog and asset store | Catalog metadata/catalog-only assets are excluded. Bundle/local formats can add portable database references and present asset files without replacing the target catalog/store. | `inlay_catalog` is restored and the asset directory is replaced. |
| Provider credentials | Included unmasked in whole-database settings; portable save files must be handled as secrets. | Restored with settings. |
| Push subscriptions | Excluded: endpoint and auth material is origin/device state. | Deliberately remains live across restore. The VAPID key file is outside every backup, so losing the live subscription table or moving origins requires users to re-enable notifications. |
| BardWiki state | Excluded: use the explicit per-chat BardWiki vault workflow for portable interchange. | Authoritative documents, versions, links, sources, receipts, jobs, settings, manifests, and rebuild staging are restored. The derived search projection is excluded and rebuilt from restored documents. |

Portable greeting-translation rows are extracted after character identity
normalization/remint, so their final character ownership is preserved. Broad
character-table rewrites use a tolerant cache snapshot: invalid stored rows are
dropped without aborting the rewrite, and their character/index/settings keys
are collected and logged while valid rows for surviving characters are
rewritten.

`database_metadata` also remains live because restore rotates lineage/writer
ownership, while lineage-scoped `command_mutation_receipts` are cleared rather
than copied across the replacement boundary.
Destructive import and restore rotate the live database lineage and clear server
mutation receipts, so a browser outbox scoped to the previous lineage cannot
replay across that boundary. Older backups containing `db.json` are restored by
importing the backup file directly inside the restore transaction; it is never
staged as a live `data/db.json`.

Each directory swap is protected by
`data/.restore-journal-<backup-id>.json`. The journal records the exact live,
staged, parked, and backup paths plus each phase before canonical directories
move. Immediately before SQLite COMMIT it also records the replacement lineage;
boot compares that marker with `database_metadata.lineage` to resolve the crash
window before the post-COMMIT phase write. `buildApp()` recovers every journal
before backfills, legacy import, routes, or workers start: a committed database
finishes forward, while an uncommitted database restores both old directories.
Recovery attempts both directory components even if one operation fails and
keeps the journal and parked copies for the next boot. Old/staged directories
are deleted only after both canonical directories are verified. A new restore
recovers a valid prior journal first and refuses unjournaled `.old`/`.tmp`
scratch paths rather than overwriting a possible sole surviving copy.

Restore and bundle import call `adoptReplacementDatabaseOwnership()` before a
complete refresh. A changed lineage/writer epoch retires the old owner state
and registered mutation settlements before the outbox admits writes against the
replacement database.
