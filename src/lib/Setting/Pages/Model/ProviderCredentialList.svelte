<script lang="ts">
  import { ChevronRightIcon, PlusIcon, TrashIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
  import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
  import {
    beginPendingModelMutation,
    deleteProviderCredentialDurably,
    finishPendingModelMutation,
    getPendingModelMutations,
    isPendingModelMutationProjectionApplied,
    retainPendingModelMutation,
    subscribePendingModelMutations,
  } from 'src/ts/model/modelProfileMutations'
  import {
    readProviderCredentials,
    type ProviderCredentialRecord,
    type ProviderCredentialType,
  } from 'src/ts/model/providerCredentialRecords'
  import type { ServerCommandResult } from 'src/ts/server/commands'
  import { settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import type { ModelProfileRecord } from 'src/ts/model/modelProfileRecords'
  import ProviderCredentialEditor from './ProviderCredentialEditor.svelte'

  interface Props {
    initialCreateType?: ProviderCredentialType | null
  }

  let { initialCreateType = null }: Props = $props()

  let editingId = $state<string | null>(null)
  let editingBaseline = $state<ProviderCredentialRecord | null>(null)
  let creating = $state(false)
  let credentialType = $state<ProviderCredentialType>('apiKey')
  let busy = $state(false)
  let commandError = $state('')
  let pendingMutations = $state(getPendingModelMutations('provider-credentials'))
  let initialCreateHandled = $state(false)

  let credentials = $derived(readCredentialOwners(settingsResourceState.value.providerCredentials))
  let modelProfileOwnersValid = $derived(hasUniqueModelProfileOwners(settingsResourceState.value.modelProfiles))
  let profiles = $derived(readModelProfileOwners(settingsResourceState.value.modelProfiles))
  let mutationPending = $derived(pendingMutations.length > 0)
  let editorOpen = $derived(creating || editingId !== null)
  $effect(() => {
    return subscribePendingModelMutations('provider-credentials', (pending) => {
      pendingMutations = pending
    })
  })

  $effect(() => {
    if (editorOpen) return
    for (const pending of pendingMutations) {
      if (pending.phase === 'discarded') {
        commandError = language.modelProfiles.commandReplayDiscarded
        finishPendingModelMutation(pending.token)
        continue
      }
      if (pending.phase === 'dispatching') continue
      if (
        isPendingModelMutationProjectionApplied(pending.projection, {
          providerCredentials: credentials,
        })
      ) {
        finishPendingModelMutation(pending.token)
      }
    }
  })

  $effect(() => {
    if (!initialCreateHandled && initialCreateType && !editorOpen) {
      initialCreateHandled = true
      openCreate(initialCreateType)
    }
  })

  function openCreate(type: ProviderCredentialType): void {
    if (busy || mutationPending) return
    creating = true
    editingId = null
    editingBaseline = null
    credentialType = type
    commandError = ''
  }

  function openEdit(credential: ProviderCredentialRecord): void {
    if (busy || mutationPending) return
    creating = false
    editingId = credential.id
    editingBaseline = cloneJsonValue(credential)
    credentialType = credential.type
    commandError = ''
  }

  function closeEditor(): void {
    creating = false
    editingId = null
    editingBaseline = null
  }

  function readCredentialOwners(value: unknown): ProviderCredentialRecord[] {
    try {
      return readProviderCredentials(value)
    } catch {
      return []
    }
  }

  function readModelProfileOwners(value: unknown): ModelProfileRecord[] {
    if (!hasUniqueModelProfileOwners(value)) return []
    return value as ModelProfileRecord[]
  }

  function hasUniqueModelProfileOwners(value: unknown): value is ModelProfileRecord[] {
    if (!Array.isArray(value)) return false
    const ids = new Set<string>()
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
      const id = (candidate as { id?: unknown }).id
      if (typeof id !== 'string' || id.trim() !== id || id.length === 0 || ids.has(id)) return false
      ids.add(id)
    }
    return true
  }

  function referencingProfiles(credentialId: string): ProviderCredentialReference[] {
    return profiles
      .filter((profile) => profile.providerOptions?.credentialId === credentialId)
      .map((profile) => ({ id: profile.id, name: profile.name }))
  }

  async function deleteCredential(credential: ProviderCredentialRecord): Promise<void> {
    if (busy || mutationPending || !modelProfileOwnersValid) return
    const references = referencingProfiles(credential.id)
    if (references.length > 0) {
      commandError = language.modelProfiles.credentialInUse(references.map((profile) => profile.name).join(', '))
      return
    }
    if (!window.confirm(language.modelProfiles.deleteCredentialConfirm(credential.name))) return

    busy = true
    commandError = ''
    const pendingToken = beginPendingModelMutation('provider-credentials', {
      kind: 'credential-delete',
      credentialId: credential.id,
    })
    if (!pendingToken) {
      busy = false
      return
    }
    try {
      const outcome = await deleteProviderCredentialDurably(credential.id)
      if (outcome.status === 'accepted') {
        finishPendingModelMutation(pendingToken)
      } else if (outcome.status === 'queued') {
        retainPendingModelMutation(pendingToken, outcome.mutationId)
      } else {
        finishPendingModelMutation(pendingToken)
        commandError = commandErrorMessage(outcome.result)
      }
    } catch {
      finishPendingModelMutation(pendingToken)
      commandError = language.modelProfiles.commandUnavailable
    } finally {
      busy = false
    }
  }

  function commandErrorMessage(result: Exclude<ServerCommandResult, { status: 'ok' }>): string {
    return result.status === 'conflict'
      ? language.modelProfiles.commandConflict
      : result.status === 'error'
        ? result.error
        : language.modelProfiles.commandUnavailable
  }

  function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
  }

  interface ProviderCredentialReference {
    id: string
    name: string
  }
</script>

<section class="flex flex-col gap-4">
  <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
    <div>
      <h3 class="text-lg font-semibold">{language.modelProfiles.credentialsTabTitle}</h3>
      <p class="text-sm text-textcolor2">{language.modelProfiles.credentialsTabDescription}</p>
    </div>
    <Button size="sm" disabled={busy || mutationPending || editorOpen} onclick={() => openCreate('apiKey')}>
      <span class="inline-flex items-center gap-1"><PlusIcon size={14} />{language.modelProfiles.addCredential}</span>
    </Button>
  </div>

  {#if commandError}
    <div class="rounded-md border border-draculared p-3 text-sm text-draculared">{commandError}</div>
  {/if}

  {#if editorOpen}
    {#if creating}
      <div class="flex max-w-sm flex-col gap-1">
        <span class="text-sm font-medium">{language.modelProfiles.credentialType}</span>
        <SelectInput
          size="sm"
          value={credentialType}
          ariaLabel={language.modelProfiles.credentialType}
          disabled={busy || mutationPending}
          onchange={(event) => {
            credentialType = event.currentTarget.value as ProviderCredentialType
          }}>
          <OptionInput value="apiKey">{language.modelProfiles.apiKeyCredentialType}</OptionInput>
          <OptionInput value="vertexServiceAccount">{language.modelProfiles.vertexCredentialType}</OptionInput>
        </SelectInput>
      </div>
    {/if}
    {#key editingId ?? credentialType}
      <ProviderCredentialEditor
        type={credentialType}
        credential={editingBaseline ?? undefined}
        {credentials}
        bind:saving={busy}
        onComplete={closeEditor}
        onCancel={closeEditor} />
    {/key}
  {/if}

  {#if credentials.length === 0}
    <div class="rounded-md border border-darkborderc p-4 text-sm text-textcolor2">
      {language.modelProfiles.noCredentials}
    </div>
  {:else}
    <div class="flex flex-col gap-2">
      {#each credentials as credential (credential.id)}
        {@const references = referencingProfiles(credential.id)}
        <article class="rounded-md border border-darkborderc px-3 text-sm">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 py-3 text-left"
              disabled={busy || mutationPending || editorOpen}
              onclick={() => openEdit(credential)}
              aria-label={`${language.modelProfiles.edit}: ${credential.name}`}>
              <span class="flex min-w-0 flex-1 flex-col gap-1">
                <span class="break-words font-medium">{credential.name}</span>
                <span class="text-xs text-textcolor2">
                  {credential.type === 'apiKey'
                    ? language.modelProfiles.apiKeyCredentialType
                    : language.modelProfiles.vertexCredentialType}
                </span>
              </span>
              <span class="pointer-events-none shrink-0 text-textcolor2" aria-hidden="true"
                ><ChevronRightIcon size={16} /></span>
            </button>
            <button
              type="button"
              class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-draculared hover:bg-darkbg focus:ring-2 focus:ring-borderc disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={language.modelProfiles.deleteCredentialAction(credential.name)}
              title={references.length > 0 ? language.modelProfiles.credentialInUseShort : undefined}
              disabled={busy || mutationPending || editorOpen || !modelProfileOwnersValid || references.length > 0}
              onclick={() => void deleteCredential(credential)}>
              <TrashIcon size={16} />
            </button>
          </div>
          {#if references.length === 0}
            <p class="pb-3 text-xs text-textcolor2">{language.modelProfiles.notUsedByProfiles}</p>
          {:else}
            <details class="pb-3 text-xs text-textcolor2">
              <summary class="cursor-pointer">{language.modelProfiles.credentialUsageCount(references.length)}</summary>
              <p class="mt-2 break-words">{references.map((profile) => profile.name).join(', ')}</p>
            </details>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>
