<script lang="ts">
  import { onDestroy } from 'svelte'
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import { SaveIcon, XIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
  import {
    beginPendingModelMutation,
    createProviderCredentialDurably,
    finishPendingModelMutation,
    getPendingModelMutations,
    isPendingModelMutationProjectionApplied,
    providerCredentialProjectionFingerprint,
    retainPendingModelMutation,
    subscribePendingModelMutations,
    updateProviderCredentialDurably,
    type PendingModelMutationProjection,
  } from 'src/ts/model/modelProfileMutations'
  import { createModelProfileSecretDraft, modelProfileSecretValueForSave } from 'src/ts/model/modelProfileSecrets'
  import type { ProviderCredentialRecord, ProviderCredentialType } from 'src/ts/model/providerCredentialRecords'
  import type { ProviderCredentialSnapshot, ServerCommandResult } from 'src/ts/server/commands'
  import SecretField from './SecretField.svelte'

  interface Props {
    type: ProviderCredentialType
    credential?: ProviderCredentialRecord
    credentials: ProviderCredentialRecord[]
    waitForProjection?: boolean
    hasChanges?: boolean
    saving?: boolean
    onComplete: (result: { status: 'accepted'; credentialId: string } | { status: 'queued' }) => void
    onCancel: () => void
  }

  let {
    type,
    credential,
    credentials,
    waitForProjection = false,
    hasChanges = $bindable(false),
    saving = $bindable(false),
    onComplete,
    onCancel,
  }: Props = $props()

  // The editor is keyed by its owner; preserve the opening snapshot for conflict checks.
  // svelte-ignore state_referenced_locally
  const baseline = credential ? (JSON.parse(JSON.stringify(credential)) as ProviderCredentialRecord) : undefined
  // svelte-ignore state_referenced_locally
  const credentialType = type
  const initialName =
    baseline?.name ??
    (credentialType === 'apiKey'
      ? language.modelProfiles.newApiCredentialName
      : language.modelProfiles.newVertexCredentialName)
  let name = $state(initialName)
  let apiKeyDraft = $state(createModelProfileSecretDraft(baseline?.apiKey))
  let clientEmail = $state(baseline?.vertex?.clientEmail ?? '')
  let privateKeyDraft = $state(createModelProfileSecretDraft(baseline?.vertex?.privateKey))
  let commandError = $state('')
  let pendingMutations = $state(getPendingModelMutations('provider-credentials'))
  let waiting = $state<{
    token: string
    projection: Extract<PendingModelMutationProjection, { kind: 'credential-create' }>
    acceptedId?: string
  } | null>(null)
  const initialDraft = JSON.stringify({
    name: initialName,
    apiKeyDraft: createModelProfileSecretDraft(baseline?.apiKey),
    clientEmail: baseline?.vertex?.clientEmail ?? '',
    privateKeyDraft: createModelProfileSecretDraft(baseline?.vertex?.privateKey),
  })
  let secretReady = $derived(
    credentialType === 'apiKey'
      ? modelProfileSecretValueForSave(apiKeyDraft) !== undefined
      : clientEmail.trim() !== '' && modelProfileSecretValueForSave(privateKeyDraft) !== undefined,
  )
  let canSave = $derived(!saving && !waiting && pendingMutations.length === 0 && name.trim() !== '' && secretReady)

  $effect(() => {
    hasChanges = JSON.stringify({ name, apiKeyDraft, clientEmail, privateKeyDraft }) !== initialDraft
  })

  $effect(() =>
    subscribePendingModelMutations('provider-credentials', (pending) => {
      pendingMutations = pending
    }),
  )

  $effect(() => {
    if (saving) return
    for (const pending of pendingMutations) {
      if (pending.token === waiting?.token || pending.phase === 'dispatching') continue
      if (pending.phase === 'discarded') {
        commandError = language.modelProfiles.commandReplayDiscarded
        finishPendingModelMutation(pending.token)
      } else if (isPendingModelMutationProjectionApplied(pending.projection, { providerCredentials: credentials })) {
        finishPendingModelMutation(pending.token)
      }
    }
  })

  $effect(() => {
    if (!waiting || saving) return
    const pending = pendingMutations.find((entry) => entry.token === waiting?.token)
    if (pending?.phase === 'discarded') {
      finishPendingModelMutation(pending.token)
      waiting = null
      commandError = language.modelProfiles.commandReplayDiscarded
      return
    }
    const attempt = waiting
    const created = credentials.find((candidate) =>
      attempt.acceptedId
        ? candidate.id === attempt.acceptedId
        : !attempt.projection.baselineIds.includes(candidate.id) &&
          providerCredentialProjectionFingerprint(candidate, true) === attempt.projection.attemptedFingerprint,
    )
    if (!created) return
    finishPendingModelMutation(attempt.token)
    waiting = null
    clearSecretDrafts()
    onComplete({ status: 'accepted', credentialId: created.id })
  })

  function clearSecretDrafts(): void {
    apiKeyDraft = createModelProfileSecretDraft(undefined)
    privateKeyDraft = createModelProfileSecretDraft(undefined)
  }

  function requestCancel(): void {
    if (saving || waiting) return
    if (hasChanges && !window.confirm(language.modelProfiles.credentialDiscardChangesConfirm)) return
    clearSecretDrafts()
    onCancel()
  }

  function credentialForSave(): ProviderCredentialSnapshot | null {
    if (!name.trim()) return null
    if (credentialType === 'apiKey') {
      const apiKey = modelProfileSecretValueForSave(apiKeyDraft)
      return apiKey ? { name: name.trim(), type: 'apiKey', apiKey } : null
    }
    const privateKey = modelProfileSecretValueForSave(privateKeyDraft)
    return privateKey && clientEmail.trim()
      ? { name: name.trim(), type: 'vertexServiceAccount', vertex: { clientEmail: clientEmail.trim(), privateKey } }
      : null
  }

  function errorMessage(result: Exclude<ServerCommandResult, { status: 'ok' }>): string {
    return result.status === 'conflict'
      ? language.modelProfiles.commandConflict
      : result.status === 'error'
        ? result.error
        : language.modelProfiles.commandUnavailable
  }

  async function saveCredential(): Promise<void> {
    const snapshot = credentialForSave()
    if (!snapshot || !canSave) return
    const createProjection = {
      kind: 'credential-create' as const,
      baselineIds: credentials.map((candidate) => candidate.id),
      attemptedFingerprint: providerCredentialProjectionFingerprint(snapshot, true),
    }
    const token = beginPendingModelMutation(
      'provider-credentials',
      baseline
        ? {
            kind: 'credential-update',
            credentialId: baseline.id,
            attemptedFingerprint: providerCredentialProjectionFingerprint({ ...snapshot, id: baseline.id }),
          }
        : createProjection,
    )
    if (!token) return
    saving = true
    commandError = ''
    try {
      const outcome = baseline
        ? await updateProviderCredentialDurably(baseline.id, snapshot, baseline)
        : await createProviderCredentialDurably(snapshot)
      if (outcome.status === 'accepted') {
        finishPendingModelMutation(token)
        if (waitForProjection && !baseline) {
          waiting = { token, projection: createProjection, acceptedId: outcome.result.credentialId }
        } else {
          clearSecretDrafts()
          onComplete({ status: 'accepted', credentialId: outcome.result.credentialId })
        }
      } else if (outcome.status === 'queued') {
        retainPendingModelMutation(token, outcome.mutationId)
        if (waitForProjection && !baseline) waiting = { token, projection: createProjection }
        else {
          clearSecretDrafts()
          onComplete({ status: 'queued' })
        }
      } else {
        finishPendingModelMutation(token)
        commandError = errorMessage(outcome.result)
      }
    } catch {
      finishPendingModelMutation(token)
      commandError = language.modelProfiles.commandUnavailable
    } finally {
      saving = false
    }
  }

  onDestroy(
    registerWriterDraftCapture(() => {
      const data = { name, apiKeyDraft, clientEmail, privateKeyDraft }
      if (JSON.stringify(data) === initialDraft) return null
      return $state.snapshot({
        key: `provider-credential:${baseline?.id ?? `new:${credentialType}`}`,
        label: name || initialName,
        fields: [
          { label: language.modelProfiles.credentialName, value: name },
          { label: language.modelProfiles.apiKeyLabel, value: apiKeyDraft.value, secret: true },
          { label: language.modelProfiles.vertexClientEmail, value: clientEmail, secret: true },
          { label: language.modelProfiles.vertexPrivateKey, value: privateKeyDraft.value, secret: true },
        ],
        data,
        baseline: JSON.parse(initialDraft),
      })
    }),
  )
</script>

<section class="flex flex-col gap-3 rounded-md border border-darkborderc bg-darkbg p-3" data-provider-credential-editor>
  <div class="flex items-center justify-between gap-2">
    <h4 class="text-sm font-semibold">
      {baseline
        ? language.modelProfiles.editCredential
        : credentialType === 'apiKey'
          ? language.modelProfiles.createApiCredential
          : language.modelProfiles.createVertexCredential}
    </h4>
    <button
      type="button"
      class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md hover:bg-selected"
      aria-label={language.modelProfiles.cancel}
      disabled={saving || waiting !== null}
      onclick={requestCancel}><XIcon size={18} /></button>
  </div>
  {#if commandError}
    <p role="alert" class="text-sm text-draculared">{commandError}</p>
  {/if}
  {#if waiting}
    <p role="status" class="text-sm text-textcolor2">
      {waiting.acceptedId ? language.modelProfiles.credentialAwaitingProjection : language.modelProfiles.commandQueued}
    </p>
  {:else if pendingMutations.length > 0 && !saving}
    <p role="status" class="text-sm text-textcolor2">
      {pendingMutations.some((pending) => pending.phase !== 'dispatching')
        ? language.modelProfiles.commandQueued
        : language.modelProfiles.saving}
    </p>
  {/if}
  <fieldset
    class="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
    disabled={saving || waiting !== null}
    aria-busy={saving}>
    <label class="flex flex-col gap-1 text-sm">
      <span>{language.modelProfiles.credentialName}</span>
      <TextInput size="sm" fullwidth bind:value={name} />
    </label>
    {#if credentialType === 'apiKey'}
      <SecretField
        label={language.modelProfiles.apiKeyLabel}
        bind:value={apiKeyDraft}
        placeholder={language.modelProfiles.savedSecretPlaceholder} />
    {:else}
      <label class="flex flex-col gap-1 text-sm">
        <span>{language.modelProfiles.vertexClientEmail}</span>
        <TextInput size="sm" fullwidth bind:value={clientEmail} />
      </label>
      <SecretField
        label={language.modelProfiles.vertexPrivateKey}
        bind:value={privateKeyDraft}
        placeholder={language.modelProfiles.savedSecretPlaceholder} />
    {/if}
  </fieldset>
  <div class="flex flex-wrap justify-end gap-2">
    <Button size="sm" styled="outlined" disabled={saving || waiting !== null} onclick={requestCancel}>
      {language.modelProfiles.cancel}
    </Button>
    <Button size="sm" disabled={!canSave} onclick={saveCredential}>
      <span class="inline-flex items-center gap-1"
        ><SaveIcon size={14} />
        {saving
          ? language.modelProfiles.saving
          : waitForProjection
            ? language.modelProfiles.credentialSaveAndUse
            : language.modelProfiles.save}
      </span>
    </Button>
  </div>
</section>
