<script lang="ts" module>
  import { getCharacterDisplayInfo } from 'src/ts/characterDisplayName'
  import type { Database } from '../../ts/storage/database.svelte'

  export interface GridCatalogCharacter {
    chaId?: string
    image?: string
    index: number
    name: string
    desc: string
  }

  export interface GridCatalogCharacterLists {
    active: GridCatalogCharacter[]
    trash: GridCatalogCharacter[]
  }

  export function normalizeGridCatalogSearch(search: string) {
    return search.replace(/ /g, '').toLocaleLowerCase()
  }

  export function formatGridCatalogCharacterLists(db: Database, normalizedSearch: string): GridCatalogCharacterLists {
    return formatGridCatalogCharacterListsFromCharacters(db.characters, normalizedSearch)
  }

  export function formatGridCatalogCharacterListsFromCharacters(
    characters: readonly Database['characters'][number][],
    normalizedSearch: string,
  ): GridCatalogCharacterLists {
    const active: GridCatalogCharacter[] = []
    const trash: GridCatalogCharacter[] = []

    for (let i = 0; i < characters.length; i++) {
      const c = characters[i]
      const displayInfo = getCharacterDisplayInfo(c)
      if (!normalizeGridCatalogSearch(displayInfo.searchText).includes(normalizedSearch)) {
        continue
      }

      const char = {
        chaId: c.chaId,
        image: c.image,
        index: i,
        name: displayInfo.name,
        desc: c.creatorNotes ?? 'No description',
      }

      if (c.trashTime) {
        trash.push(char)
      } else {
        active.push(char)
      }
    }

    return { active, trash }
  }

  function gridCatalogCharacterKey(char: GridCatalogCharacter) {
    return char.chaId ?? `legacy-${char.index}`
  }
</script>

<script lang="ts">
  import { changeChar, getCharImage, removeChar } from '../../ts/characters'
  import {
    charactersResourceState,
    getCharacterResourceOwner,
    settingsResourceState,
  } from 'src/ts/server/resourceState.svelte'
  import CharacterCatalogView, { type CatalogDisplayRow } from '../SideBars/CharacterCatalogView.svelte'
  import { canUseClientWriteAccess, clientSessionStore } from 'src/ts/clientSession'
  const catalogActionsEnabled = $derived.by(() => {
    void $clientSessionStore
    return canUseClientWriteAccess()
  })
  import { ArrowLeft, TrashIcon, Undo2Icon } from '@lucide/svelte'
  import TextInput from '../UI/GUI/TextInput.svelte'
  import Button from '../UI/GUI/Button.svelte'
  import { language } from 'src/lang'
  import { parseMultilangString } from 'src/ts/util'
  import MobileCharacters from '../Mobile/MobileCharacters.svelte'
  import {
    currentCharacterRowSnapshot,
    dispatchUpdateCharacterScopedWithOutcome,
    type CharacterMutationOutcome,
  } from 'src/ts/characterCommands'
  import { characterRoutePath, navigate } from 'src/ts/router'
  import { prefetchCharacterRouteResource } from 'src/ts/server/routeResourceLoader'
  import { alertError, alertNormal } from 'src/ts/alert'
  import { onDestroy } from 'svelte'
  interface Props {
    endGrid?: any
  }

  let { endGrid = () => {} }: Props = $props()
  let search = $state('')
  let selected = $state(3)
  let normalizedSearch = $derived(normalizeGridCatalogSearch(search))
  let catalogCharacters = $derived(
    formatGridCatalogCharacterListsFromCharacters(readCharacterOwners(), normalizedSearch),
  )
  let selectedCharacterIndex = $derived(
    charactersResourceState.status === 'ready' ? charactersResourceState.currentChar : -1,
  )
  let selectedListKind = $derived(
    selected === 0 ? 'grid' : selected === 1 ? 'list' : selected === 2 ? 'trash' : 'simple',
  )
  let catalogCount = $derived(
    selectedListKind === 'trash' ? catalogCharacters.trash.length : catalogCharacters.active.length,
  )

  const displayRows = $derived(
    (selected === 2 ? catalogCharacters.trash : catalogCharacters.active).map((char) => ({
      key: gridCatalogRenderKey(char),
      id: char.chaId ?? '',
      index: char.index,
      name: char.name || 'Unnamed',
      description: resolveGridCatalogDescription(char.desc, readCatalogLanguage()),
      hasImage: !!char.image,
      imageStyle: getCharImage(char.image ?? '', 'css'),
      selected: isSelectedCatalogCharacter(char),
    })),
  )
  function catalogSource(row: CatalogDisplayRow): GridCatalogCharacter | undefined {
    return (selected === 2 ? catalogCharacters.trash : catalogCharacters.active).find(
      (char) => gridCatalogRenderKey(char) === row.key,
    )
  }
  type CharacterCatalogActionKind = 'remove' | 'restore' | 'delete-permanent'
  interface CharacterCatalogActionState {
    kind: CharacterCatalogActionKind
    name: string
    status: 'pending' | 'queued' | 'failed'
    reason?: string
  }
  let characterCatalogActions = $state<Record<string, CharacterCatalogActionState>>({})
  let mounted = true

  onDestroy(() => {
    mounted = false
  })

  function characterCatalogActionMessage(state: CharacterCatalogActionState): string {
    if (state.kind === 'restore') {
      if (state.status === 'pending') return language.characterRestorePending(state.name)
      if (state.status === 'queued') return language.characterRestoreQueued(state.name)
      if (state.reason === 'missing-character-id') return language.characterRestoreUnavailable(state.name)
      return language.characterRestoreFailed(state.name)
    }
    if (state.kind === 'delete-permanent') {
      if (state.status === 'pending') return language.characterPermanentDeletePending(state.name)
      if (state.status === 'queued') return language.characterPermanentDeleteQueued(state.name)
      return language.characterPermanentDeleteFailed(state.name)
    }
    if (state.status === 'pending') return language.characterRemovalPending(state.name)
    if (state.status === 'queued') return language.characterRemovalQueued(state.name)
    return language.characterRemovalFailed(state.name)
  }

  async function runCharacterCatalogAction(
    char: GridCatalogCharacter,
    kind: CharacterCatalogActionKind,
    action: () => Promise<CharacterMutationOutcome | null>,
  ): Promise<void> {
    if (!canUseClientWriteAccess()) return
    const actionId = gridCatalogCharacterKey(char)
    if (characterCatalogActions[actionId]?.status === 'pending') return
    characterCatalogActions[actionId] = { kind, name: char.name, status: 'pending' }
    try {
      const outcome = await action()
      if (!mounted || !canUseClientWriteAccess()) return
      if (!outcome) {
        delete characterCatalogActions[actionId]
        return
      }
      if (outcome.status === 'accepted') {
        delete characterCatalogActions[actionId]
        return
      }
      characterCatalogActions[actionId] = {
        kind,
        name: char.name,
        status: outcome.status,
        reason: outcome.result.status === 'error' ? outcome.result.error : undefined,
      }
      const message = characterCatalogActionMessage(characterCatalogActions[actionId])
      if (outcome.status === 'queued') alertNormal(message)
      else alertError(message)
    } catch {
      if (!mounted || !canUseClientWriteAccess()) return
      characterCatalogActions[actionId] = { kind, name: char.name, status: 'failed' }
      alertError(characterCatalogActionMessage(characterCatalogActions[actionId]))
    }
  }

  function resolveGridCatalogDescription(
    creatorNotes: string,
    preferredLanguage: string | undefined,
    fallback = 'No description',
  ) {
    const descriptions = parseMultilangString(creatorNotes)
    const languageOrder = [preferredLanguage, 'en', 'xx', ...Object.keys(descriptions)]
    const visitedLanguages = new Set<string>()

    for (const languageCode of languageOrder) {
      if (!languageCode || visitedLanguages.has(languageCode)) continue
      visitedLanguages.add(languageCode)

      const description = descriptions[languageCode]?.trim()
      if (description) return description
    }

    return fallback
  }

  function readCharacterOwners(): readonly Database['characters'][number][] {
    if (charactersResourceState.status === 'ready') {
      for (const character of charactersResourceState.characters) {
        if (!character?.chaId || getCharacterResourceOwner(character.chaId) !== character) return []
      }
      return charactersResourceState.characters
    }
    return []
  }

  function readCatalogLanguage(): string | undefined {
    if (settingsResourceState.status === 'error') return undefined
    const status = settingsResourceState.groupStatuses.language ?? 'idle'
    if (status === 'ready') return settingsResourceState.value.language as string | undefined
    return undefined
  }

  function uniqueCharacterOwner(characterId: string) {
    if (charactersResourceState.status !== 'ready') return undefined
    const character = getCharacterResourceOwner(characterId)
    const index = character ? charactersResourceState.characters.indexOf(character) : -1
    return character && index >= 0 ? { character, index } : undefined
  }

  function resolveCatalogCharacterOwner(char: GridCatalogCharacter) {
    if (char.chaId) return uniqueCharacterOwner(char.chaId)
    const character = readCharacterOwners()[char.index]
    return character && !character.chaId ? { character, index: char.index } : undefined
  }

  function gridCatalogRenderKey(char: GridCatalogCharacter): string {
    if (charactersResourceState.status === 'ready') return gridCatalogCharacterKey(char)
    return char.chaId ? `${char.chaId}:${char.index}` : gridCatalogCharacterKey(char)
  }

  function isSelectedCatalogCharacter(char: GridCatalogCharacter): boolean {
    if (char.index !== selectedCharacterIndex) return false
    return !char.chaId || uniqueCharacterOwner(char.chaId)?.index === char.index
  }

  function prefetchCatalogCharacter(char: GridCatalogCharacter): void {
    if (!canUseClientWriteAccess()) return
    const characterId = resolveCatalogCharacterOwner(char)?.character.chaId
    if (characterId) prefetchCharacterRouteResource(characterId)
  }

  function openCharacterRoute(char: GridCatalogCharacter) {
    if (!canUseClientWriteAccess()) return
    const owner = resolveCatalogCharacterOwner(char)
    if (!owner) return
    const { character, index } = owner
    if (!character.chaId) {
      changeChar(index)
      return
    }
    navigate(characterRoutePath(character.chaId, character.chats?.[character.chatPage]?.id))
  }

  async function removeCatalogCharacter(
    char: GridCatalogCharacter,
    type: 'normal' | 'permanent' = 'normal',
  ): Promise<CharacterMutationOutcome | null> {
    if (!canUseClientWriteAccess()) return null
    const owner = resolveCatalogCharacterOwner(char)
    if (!owner) return null
    return removeChar(owner.index, char.name, type)
  }

  async function restoreTrashedCharacter(char: GridCatalogCharacter): Promise<CharacterMutationOutcome | null> {
    if (!canUseClientWriteAccess()) return null
    const owner = resolveCatalogCharacterOwner(char)
    if (!owner) return null
    const { character, index } = owner

    const characterId = character.chaId
    if (!characterId) {
      return { status: 'failed', result: { status: 'error', error: 'missing-character-id' } }
    }
    const previous = currentCharacterRowSnapshot(index)
    const liveCharacter = uniqueCharacterOwner(characterId)?.character as
      | (typeof character & { trashTime?: number | null })
      | undefined
    if (!liveCharacter) return null
    liveCharacter.trashTime = null
    return (await dispatchUpdateCharacterScopedWithOutcome(characterId, { trashTime: null }, previous)) ?? null
  }
</script>

<div class="h-full w-full flex justify-center" data-risu-grid-catalog data-risu-list-kind={selectedListKind}>
  <div class="h-full p-6 bg-darkbg max-w-full w-2xl flex flex-col overflow-y-auto">
    <div class="mx-4 mb-6 flex flex-col">
      <div class="flex items-center gap-3 mb-2">
        <button
          data-risu-grid-action="back"
          class="flex items-center justify-center p-2 rounded-lg hover:bg-selected transition-colors shrink-0"
          onclick={() => endGrid()}
          title={language.goback}
          aria-label={language.goback}>
          <ArrowLeft size={20} />
        </button>
        <div class="flex-1">
          <TextInput
            placeholder={language.search}
            ariaLabel={language.search}
            bind:value={search}
            size="lg"
            autocomplete="off"
            fullwidth={true} />
        </div>
      </div>
      {#each Object.entries(characterCatalogActions).filter(([, state]) => state.status === 'failed') as [actionId, state] (actionId)}
        <p
          class="mt-2 text-sm text-textcolor2"
          data-risu-character-action-status={state.status}
          data-risu-row-id={actionId}
          role="status"
          aria-live="polite">
          {characterCatalogActionMessage(state)}
        </p>
      {/each}
      <div class="flex flex-wrap gap-2 mt-2">
        <span data-risu-grid-tab data-risu-list-kind="simple" data-risu-selected={selected === 3 ? 'true' : 'false'}>
          <Button
            selected={selected === 3}
            styled={selected === 3 ? 'primary' : 'outlined'}
            size="sm"
            onclick={() => {
              selected = 3
            }}>
            {language.simple}
          </Button>
        </span>
        <span data-risu-grid-tab data-risu-list-kind="grid" data-risu-selected={selected === 0 ? 'true' : 'false'}>
          <Button
            selected={selected === 0}
            styled={selected === 0 ? 'primary' : 'outlined'}
            size="sm"
            onclick={() => {
              selected = 0
            }}>
            {language.grid}
          </Button>
        </span>
        <span data-risu-grid-tab data-risu-list-kind="list" data-risu-selected={selected === 1 ? 'true' : 'false'}>
          <Button
            selected={selected === 1}
            styled={selected === 1 ? 'primary' : 'outlined'}
            size="sm"
            onclick={() => {
              selected = 1
            }}>
            {language.list}
          </Button>
        </span>
        <span data-risu-grid-tab data-risu-list-kind="trash" data-risu-selected={selected === 2 ? 'true' : 'false'}>
          <Button
            selected={selected === 2}
            styled={selected === 2 ? 'primary' : 'outlined'}
            size="sm"
            onclick={() => {
              selected = 2
            }}>
            {language.trash}
          </Button>
        </span>
        <div class="grow"></div>
        <span class="text-textcolor2 text-sm" data-risu-grid-catalog-count>
          {catalogCount}
          {language.character}
        </span>
      </div>
    </div>
    {#if selected !== 3}
      {#if selected === 2}<span class="text-textcolor2 text-sm mb-2">{language.trashDesc}</span>{/if}
      <CharacterCatalogView
        rows={displayRows}
        mode={selected === 0 ? 'grid' : selected === 2 ? 'trash' : 'list'}
        onOpen={(row) => {
          const char = catalogSource(row)
          if (char) openCharacterRoute(char)
        }}
        onPrefetch={(row) => {
          const char = catalogSource(row)
          if (char && selected !== 2) prefetchCatalogCharacter(char)
        }}>
        {#snippet actions(row)}
          {@const char = catalogSource(row)}
          {#if char}
            {#if selected === 2}
              <button
                type="button"
                data-risu-grid-action="restore"
                data-risu-mutation-status={characterCatalogActions[gridCatalogCharacterKey(char)]?.status ?? 'idle'}
                aria-label={language.restoreCharacter(char.name)}
                aria-busy={characterCatalogActions[gridCatalogCharacterKey(char)]?.status === 'pending'}
                disabled={!catalogActionsEnabled ||
                  characterCatalogActions[gridCatalogCharacterKey(char)]?.status === 'pending'}
                title={!catalogActionsEnabled ? language.connectedReaders.writeAccessRequired : undefined}
                class="hover:text-textcolor text-textcolor2"
                onclick={() => void runCharacterCatalogAction(char, 'restore', () => restoreTrashedCharacter(char))}
                ><Undo2Icon /></button>
            {/if}
            <button
              type="button"
              data-risu-grid-action={selected === 2 ? 'delete-permanent' : 'delete'}
              data-risu-mutation-status={characterCatalogActions[gridCatalogCharacterKey(char)]?.status ?? 'idle'}
              aria-label={selected === 2
                ? language.deleteCharacterPermanently(char.name)
                : `${language.removeCharacter}: ${char.name}`}
              aria-busy={characterCatalogActions[gridCatalogCharacterKey(char)]?.status === 'pending'}
              disabled={!catalogActionsEnabled ||
                characterCatalogActions[gridCatalogCharacterKey(char)]?.status === 'pending'}
              title={!catalogActionsEnabled ? language.connectedReaders.writeAccessRequired : undefined}
              class="hover:text-textcolor text-textcolor2"
              onclick={() =>
                void runCharacterCatalogAction(char, selected === 2 ? 'delete-permanent' : 'remove', () =>
                  removeCatalogCharacter(char, selected === 2 ? 'permanent' : 'normal'),
                )}><TrashIcon /></button>
          {/if}
        {/snippet}
      </CharacterCatalogView>
    {:else if selected === 3}
      <div class="contents" data-risu-grid-list data-risu-list-kind="simple">
        <MobileCharacters {endGrid} {search} hideTrash={true} />
      </div>
    {/if}
  </div>
</div>
