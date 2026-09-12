# Character Content, Memory, and Catalogs

Last audited: 2026-08-02.

This area covers character profile/media editing, author notes, lorebooks, regex and trigger editors, Hypa V3 memory/summary management, character catalog presentation, and Realm discovery/import/card actions. Script execution is analyzed in [Scripting, Parsing, and Automation](scripting-parsing-and-automation.md), media/import persistence in [Assets, Import, Export, and Backups](assets-import-export-and-backups.md), and chat bookmark navigation in [App Navigation and Chat](app-navigation-and-chat.md).

## Character profile, media, avatar, emotion, and voice editing

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/lib/SideBars/CharConfig.svelte.test.ts`: desktop section labels/state; media and repeated-row action names; responsive icon sizing; guarded VITS/GPT-SoVITS helpers; additional-asset, notification, VITS, and GPT-SoVITS picker-token timing; newest VITS/notification file and pending clear; Web Speech `voiceschanged`; ElevenLabs/FishSpeech catalogs; malformed VOICEVOX; identity/shared/TTS/GPT-SoVITS control names; immediate avatar rotation and one debounced patch; guarded avatar/PNG metadata; immediate emotion add/delete and stale upload; typeless character bias/greeting/regex actions; script target validation; regex import merge/owner change; background/regex/trigger visibility. | Protects the character editor’s owner identity, media assets, voice catalogs, draft-backed presentation, and script collection entry points. | Critical: a stale file or action can overwrite another character’s media/profile. |
| `src/lib/ChatScreens/CreatorQuote.svelte.test.ts`: icon-only quote removal is named. | Keeps quote removal accessible in the character profile. | Low-medium. |

## Author notes and lorebooks

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/lib/SideBars/AuthorNoteEditor.svelte.test.ts`: immediate projection/watcher baseline and unmount flush; old-chat flush before owner switch; lifecycle keepalive; earliest rollback with restaged desired note; marker-safe immediate total revert. | Prevents note loss or cross-chat writes during debounce, navigation, conflict, and teardown. | Critical data-integrity coverage. |
| `src/lib/SideBars/LoreBook/LoreBookSetting.svelte.test.ts`: loading hides list/toolbar; failed hydration has retry/no mutation; toolbar names/selected submenu; bulk always-active state for character/chat lorebooks. | Keeps users from editing incomplete lore and makes hydration failure actionable. | High. |
| `src/lib/SideBars/LoreBook/LoreBookList.svelte.test.ts`: ID-backed and cloned-folder delete after insert/reorder; id-less snapshot abort/success; detail registration cleanup/open across projections/disappearance; character resource replacement; no cross-character open/dirty transfer; selected-chat deletion; deletion superseding clean draft; stable global rows; captured global edit/delete; always-active settlement. | Preserves stable row/folder identity across live collection projection and owner changes. | Critical: wrong-row deletion or dirty-draft transfer loses authored lore. |
| `src/lib/Setting/lorepreset.svelte.test.ts`: global lorebook delete/rename remains bound after reorder; vanished target; malformed duplicate IDs render without duplicate keys; modal focus/Escape/restore. | Protects global lorebook selection and destructive actions. | High. |

## Regex, V1/V2 triggers, and editor imports

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/lib/SideBars/Scripts/DefinitionDeleteRace.svelte.test.ts`: regex/V1 delete after authoritative reorder; vanished target; expanded editor remains attached after an earlier row disappears; reordering restores when expanded row vanishes. | Prevents deleting or editing a replacement definition after live projection changes. | Critical authored-content safety. |
| `src/lib/SideBars/Scripts/RegexData.svelte.test.ts`, `src/lib/SideBars/Scripts/TriggerV1Data.svelte.test.ts`, and `src/lib/SideBars/Scripts/RegexList.svelte.test.ts`: balance expanded-row registration on external destroy; closed/repeated delete safety; names/expansion/flag state; missing legacy custom flag; deferred import owner guard. | Keeps row lifecycle, destructive actions, legacy flags, and imports scoped to the current collection. | High. |
| `src/lib/SideBars/Scripts/TriggerV2List.svelte.test.ts`: imported/edited effect text remains literal/non-executable; action and selection names; owner change clears multiselect; deferred import guard; safe array placeholders; native editable shortcuts; responsive modal focus/Escape; selected identity and anchor rebase across drag; stable trigger/effect ownership through reorder/disappearance/owner/effect-generation replacement; mobile move controls. | Protects the most complex definition editor from script injection, stale selection, and wrong-row drag/drop. | Critical security and data-integrity value. |
| `src/lib/SideBars/Scripts/TriggerList.svelte.test.ts`: confirmation requested for a mode change is discarded after the definition owner changes. | Prevents an awaited confirmation from applying an edit to a newly opened character/module trigger list. | Critical stale-owner protection. |
| `src/lib/SideBars/Scripts/triggerV2Import.test.ts`: one valid required-row structure, four malformed shapes, and malformed JSON. `src/lib/Setting/Pages/GlobalRegex.svelte.test.ts`: toolbar names and concurrent-edit import merge. | Rejects malformed definitions while preserving edits made during file selection. | High import safety. |
| `src/lib/SideBars/EditorIconActions.test.ts`: parses CharConfig, DevTool, lore, V1/V2, regex, bot-preset, and persona Svelte ASTs and rejects unnamed visual-only buttons. | Provides a broad accessibility backstop across content editors. | Medium-high breadth. |

## Hypa V3 memory and summary management

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/lib/Others/HypaV3Modal.resetRace.test.ts`: owner disappearance; reset during second confirmation/chat change; keyboard search results; named bulk/resummary/preview controls; nested focus with edit Escape; single Enter search; cancelled focus restore; stable summary delete; cancelled or stale bulk resummary/translation. | Prevents long-running memory operations from mutating a newly selected chat or deleted/replaced summary. | Critical for memory integrity. |
| `HypaV3Modal.serverReliability.test.ts`: dirty focused summary PATCH flushes before Escape; failed close-button flush keeps modal open. | Stops modal dismissal from dropping the last edit. | Critical data-loss prevention. |
| `HypaV3Modal/modal-summary-item.svelte.test.ts`: action tab order/names; nonresident connected-message hydration; cancelled reroll; external-source translation cleanup; translation/reroll rejection after edits; no old translation on replacement message. | Keeps each summary/message action bound to current source data. | High. |
| `modal-header.svelte.test.ts`, `server-memory-jobs.svelte.test.ts`, `server-summary-patch.test.ts`, and `tag-manager-modal.test.ts`. | Keeps available header/job actions tabbable, builds sparse normalized patches with `null` removals, and rejects duplicate tag rename. | Medium-high supporting coverage. |
| Hypa cases in `src/lib/Others/ownerPaths.test.ts`: server memory mounts without guarded chat initialization; live summaries load/edit through the memory API. | Proves the modal consumes server resources without illegal direct state access. | Critical architecture coverage. |

## Character catalog and relative-time presentation

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/lib/Others/GridCatalog.svelte.test.ts`: active/trash filtering, count/order; localized/fallback descriptions; search memo; restore/permanent-delete targets; names/empty search; normalized matching; mobile helper sort/trash/legacy/search/ago; every UI-language relative-time locale; rendered relative/unknown time; corpus-only recompute. | Protects the primary character discovery/trash UI and its derived list identity. | High navigation/content-management value. |
| `src/lib/Mobile/MobileCharacters.svelte.test.ts`: relative time updates while the list remains open. | Keeps visible “last interacted” text fresh. | Medium. |

## Realm catalog, import, card actions, and licenses

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/lib/UI/Realm/RealmMain.svelte.test.ts`: request failure vs valid empty/retry; latest catalog/banner; missing banner clear; abort on unmount; desktop filter announcement/page reset; mobile sort reset; import cancel/blank/malformed URL/path ID; menu focus/Escape; card-dialog Escape/backdrop. | Protects catalog request ownership, pagination, import input, and modal navigation. | High. |
| `RealmPopUp.svelte.test.ts`: projected account/stable card removal; creator requirement; one removal request and owner update; report confirmation/prompt cancellation; stable clicked ID; 401/500 localized errors; successful report/remove response once; clipboard failure; icon names; inert/focus/restore. | Prevents reporting/removing the wrong Realm card and avoids false success. | High security/account value. |
| `realmImportInput.test.ts`: nine accepted raw/query/code/HTTP/protocol-relative forms and nine rejected blank/broken/protocol/path/query forms. | Defines precisely which user-entered IDs/URLs can start an import. | High input-safety coverage. |
| `RealmLicense.svelte.test.ts`: supported license is a named native app-handled link; unsupported license has no link. | Keeps legal attribution navigation valid. | Medium. |

## Especially critical tests

- Character media latest-owner cases prevent a delayed file from overwriting another character’s asset.
- Author-note and lorebook stable-ID/lifecycle-flush tests prevent silent content loss.
- Trigger V2 literal-rendering and drag-generation guards protect both injection and wrong-row mutation.
- Hypa dirty-close and stale bulk-operation tests protect expensive long-running memory edits.
- Realm stable card/account/report tests prevent destructive actions on the wrong remote item.

## Primary inventory

| Group | Complete in-scope file inventory |
| --- | --- |
| Character/catalog | `src/lib/ChatScreens/CreatorQuote.svelte.test.ts`; `src/lib/Mobile/MobileCharacters.svelte.test.ts`; `src/lib/Others/GridCatalog.svelte.test.ts`; `src/lib/SideBars/CharConfig.svelte.test.ts` |
| Author notes/lorebooks | `src/lib/SideBars/AuthorNoteEditor.svelte.test.ts`; `src/lib/SideBars/LoreBook/LoreBookList.svelte.test.ts`; `src/lib/SideBars/LoreBook/LoreBookSetting.svelte.test.ts`; `src/lib/Setting/lorepreset.svelte.test.ts` |
| Scripts/triggers | `src/lib/Setting/Pages/GlobalRegex.svelte.test.ts`; `src/lib/SideBars/EditorIconActions.test.ts`; `src/lib/SideBars/Scripts/DefinitionDeleteRace.svelte.test.ts`; `RegexData.svelte.test.ts`; `RegexList.svelte.test.ts`; `TriggerList.svelte.test.ts`; `TriggerV1Data.svelte.test.ts`; `TriggerV2List.svelte.test.ts`; `triggerV2Import.test.ts` |
| Hypa/memory | `src/lib/Others/HypaV3Modal.resetRace.test.ts`; `HypaV3Modal.serverReliability.test.ts`; `HypaV3Modal/modal-header.svelte.test.ts`; `modal-summary-item.svelte.test.ts`; `server-memory-jobs.svelte.test.ts`; `server-summary-patch.test.ts`; `tag-manager-modal.test.ts`; `src/lib/Others/ownerPaths.test.ts` |
| Realm | `src/lib/UI/Realm/RealmLicense.svelte.test.ts`; `RealmMain.svelte.test.ts`; `RealmPopUp.svelte.test.ts`; `realmImportInput.test.ts` |
