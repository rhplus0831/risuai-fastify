import { demoteClientSession } from 'src/ts/clientSession'
import {
  beginWriterDraftCaptureTest,
  endWriterDraftCaptureTest,
  capturedWriterDrafts,
} from 'src/ts/__tests__/writerDraftCapture'
import { mount, tick, unmount } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { language } from 'src/lang'
import ModelProfileEditorDrawer from './ModelProfileEditorDrawer.svelte'
import { finishPendingModelMutation, getPendingModelMutations } from 'src/ts/model/modelProfileMutations'
import type { ProviderCredentialRecord } from 'src/ts/model/providerCredentialRecords'
import { MASKED_PROVIDER_SECRET } from 'src/ts/providerSecretMask'

const credentialMocks = vi.hoisted(() => ({ create: vi.fn() }))
const settlements = vi.hoisted(() => new Map<string, (result: 'accepted' | 'discarded') => void>())
vi.mock('src/ts/server/durableMutationDispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/ts/server/durableMutationDispatch')>()),
  registerDurableMutationSettlementListener: vi.fn(
    (id: string, listener: (result: 'accepted' | 'discarded') => void) => {
      settlements.set(id, listener)
      return () => settlements.delete(id)
    },
  ),
}))
vi.mock('src/ts/model/modelProfileMutations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/ts/model/modelProfileMutations')>()),
  createProviderCredentialDurably: credentialMocks.create,
}))

vi.mock('src/ts/model/llmgateway', () => ({
  getLLMGatewayModels: vi.fn().mockResolvedValue([]),
  toModelGridItem: (model: { id: string; name: string }) => ({
    id: model.id,
    displayName: model.name,
    providerName: 'LLM Gateway',
    description: '',
    context_length: 0,
    sortPrice: 0,
    prices: [],
  }),
}))

vi.mock('src/ts/model/neuralwatt', () => ({
  getNeuralwattModels: vi.fn(async () => []),
  toModelGridItem: (model: { id: string; name: string }) => ({
    id: model.id,
    displayName: model.name,
    providerName: 'Neuralwatt',
    description: '',
    context_length: 0,
    sortPrice: 0,
    prices: [],
  }),
}))

type MountedComponent = Parameters<typeof unmount>[0]

let target: HTMLElement
let component: MountedComponent | undefined

beforeEach(() => {
  credentialMocks.create.mockReset()
  credentialMocks.create.mockResolvedValue({
    status: 'accepted',
    result: { status: 'ok', credentialId: 'new-credential' },
  })
  for (const pending of getPendingModelMutations('provider-credentials')) finishPendingModelMutation(pending.token)
  settlements.clear()
  target = document.createElement('div')
  document.body.appendChild(target)
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  for (const pending of getPendingModelMutations('provider-credentials')) finishPendingModelMutation(pending.token)
  vi.restoreAllMocks()
})

describe('ModelProfileEditorDrawer credentials', () => {
  it('saves an explicit Strip CoT profile override', async () => {
    const onSave = vi.fn()
    const profile = {
      id: 'profile-strip-cot',
      name: 'Strip CoT Profile',
      providerId: 'debug-echo',
      modelId: 'debug-echo',
    }
    component = mount(ModelProfileEditorDrawer, {
      target,
      props: {
        mode: 'edit',
        profile,
        profiles: [profile],
        credentials: [],
        statusText: 'Ready',
        onSave,
        onCancel: vi.fn(),
      },
    })
    await tick()

    const runtimeOverrides = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(language.modelProfiles.runtimeOverridesTitle),
    )
    if (!runtimeOverrides) throw new Error('Runtime overrides accordion not found')
    runtimeOverrides.click()
    await tick()

    const stripCoT = target.querySelector<HTMLSelectElement>('[data-runtime-field="stripCoT"]')
    if (!stripCoT) throw new Error('Strip CoT override not found')
    expect(stripCoT.value).toBe('')
    stripCoT.value = 'true'
    stripCoT.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()

    const save = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(language.modelProfiles.save),
    )
    save?.click()
    await tick()

    expect(onSave).toHaveBeenCalledWith({ ...profile, runtimeOptions: { stripCoT: true } })
  })

  it('saves a credential reference without placing a secret in the profile row', async () => {
    const onSave = vi.fn()
    const profile = {
      id: 'profile-a',
      name: 'Profile A',
      providerId: 'openai',
      modelId: 'gpt-5',
      providerOptions: { credentialId: 'credential-api' },
    }
    component = mount(ModelProfileEditorDrawer, {
      target,
      props: {
        mode: 'edit',
        profile,
        profiles: [profile],
        credentials: [
          {
            id: 'credential-api',
            name: 'OpenAI',
            type: 'apiKey',
            apiKey: '__RISU_SECRET_MASKED__',
          },
        ],
        statusText: 'Ready',
        onSave,
        onCancel: vi.fn(),
      },
    })
    await tick()

    const name = target.querySelector<HTMLInputElement>('input:not([type="password"])')
    if (!name) throw new Error('Profile name input not found')
    name.value = 'Profile A renamed'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    const save = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(language.modelProfiles.save),
    )
    expect(save?.disabled).toBe(false)
    save?.click()
    await tick()

    expect(onSave).toHaveBeenCalledWith({
      id: 'profile-a',
      name: 'Profile A renamed',
      providerId: 'openai',
      modelId: 'gpt-5',
      providerOptions: { credentialId: 'credential-api' },
    })
    expect(JSON.stringify(onSave.mock.calls)).not.toContain('__RISU_SECRET_MASKED__')
  })

  it('preserves LLM Gateway request parameter selections when saving a profile', async () => {
    const onSave = vi.fn()
    const profile = {
      id: 'gateway-profile',
      name: 'Gateway Profile',
      providerId: 'llmgateway',
      modelId: 'openai/gpt-5',
      providerOptions: {
        credentialId: 'credential-api',
        llmGateway: {
          reasoningEffort: 'max' as const,
          verbosity: 'high' as const,
          serviceTier: 'priority' as const,
          routing: 'throughput' as const,
        },
      },
    }
    component = mount(ModelProfileEditorDrawer, {
      target,
      props: {
        mode: 'edit',
        profile,
        profiles: [profile],
        credentials: [
          {
            id: 'credential-api',
            name: 'LLM Gateway',
            type: 'apiKey',
            apiKey: '__RISU_SECRET_MASKED__',
          },
        ],
        statusText: 'Ready',
        onSave,
        onCancel: vi.fn(),
      },
    })
    await tick()

    Array.from(target.querySelectorAll('button'))
      .find((button) => button.textContent?.includes(language.modelProfiles.runtimeOverridesTitle))
      ?.click()
    await tick()

    expect(target.querySelector<HTMLSelectElement>('[data-llm-gateway-reasoning-effort]')?.value).toBe('max')
    expect(target.querySelector<HTMLSelectElement>('[data-llm-gateway-verbosity]')?.value).toBe('high')
    expect(target.querySelector<HTMLSelectElement>('[data-llm-gateway-service-tier]')?.value).toBe('priority')
    expect(target.querySelector<HTMLSelectElement>('[data-llm-gateway-routing]')?.value).toBe('throughput')

    const name = target.querySelector<HTMLInputElement>('input:not([type="password"])')
    if (!name) throw new Error('Profile name input not found')
    name.value = 'Gateway Profile renamed'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    const save = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(language.modelProfiles.save),
    )
    save?.click()
    await tick()

    expect(onSave).toHaveBeenCalledWith({
      ...profile,
      name: 'Gateway Profile renamed',
    })
  })
})

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await tick()
}

function clickText(label: string, within: ParentNode = target): void {
  const button = Array.from(within.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === label)
  if (!button) throw new Error(`Button not found: ${label}`)
  button.click()
}

async function input(element: HTMLInputElement, value: string): Promise<void> {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
}

async function openInlineCredential(providerId = 'openai') {
  const credentials = new SvelteMap<string, ProviderCredentialRecord[]>([['rows', []]])
  const onSave = vi.fn()
  const onCancel = vi.fn()
  const profile = {
    id: 'inline-profile',
    name: 'Original name',
    providerId,
    modelId: providerId === 'vertex' ? 'gemini-2.5-pro-vertex' : 'gpt-5',
  }
  component = mount(ModelProfileEditorDrawer, {
    target,
    props: {
      mode: 'edit',
      profile,
      profiles: [profile],
      get credentials() {
        return credentials.get('rows')!
      },
      runtimeDefaults: { maxResponse: 4096 },
      statusText: 'Incomplete',
      onSave,
      onCancel,
    },
  })
  await tick()
  const name = target.querySelector<HTMLInputElement>('[data-model-profile-editable-form] > label input')!
  await input(name, 'My edited model')
  target.querySelector<HTMLInputElement>('[data-runtime-default="maxResponse"]')!.click()
  await tick()
  await input(target.querySelector<HTMLInputElement>('[data-runtime-field="maxResponse"]')!, '8192')
  const connection = target.querySelector<HTMLDetailsElement>('[data-model-connection]')!
  connection.open = true
  connection.dispatchEvent(new Event('toggle'))
  clickText(language.modelProfiles.createNewCredential)
  await tick()
  const editor = target.querySelector<HTMLElement>('[data-provider-credential-editor]')!
  const fields = editor.querySelectorAll<HTMLInputElement>('input:not([type="password"])')
  await input(fields[0], 'Inline key')
  if (providerId === 'vertex') await input(fields[1], 'vertex@example.com')
  await input(editor.querySelector<HTMLInputElement>('input[type="password"]')!, 'test-secret-material')
  return { credentials, onSave, onCancel, name, editor }
}

describe('inline credential creation', () => {
  it.each(['openai', 'vertex'])(
    'keeps the %s model draft and selects a new credential after resource confirmation',
    async (provider) => {
      const confirm = vi.fn(() => false)
      vi.stubGlobal('confirm', confirm)
      const state = await openInlineCredential(provider)
      clickText(language.modelProfiles.credentialSaveAndUse, state.editor)
      await flush()
      expect(state.onCancel).not.toHaveBeenCalled()
      expect(confirm).not.toHaveBeenCalled()
      expect(state.name.value).toBe('My edited model')
      expect(state.editor.textContent).toContain(language.modelProfiles.credentialAwaitingProjection)
      expect(target.querySelector<HTMLSelectElement>('[data-provider-credential-picker] select')?.value).toBe('')
      expect(credentialMocks.create).toHaveBeenCalledWith(
        provider === 'vertex'
          ? {
              name: 'Inline key',
              type: 'vertexServiceAccount',
              vertex: { clientEmail: 'vertex@example.com', privateKey: 'test-secret-material' },
            }
          : { name: 'Inline key', type: 'apiKey', apiKey: 'test-secret-material' },
      )

      state.credentials.set('rows', [
        provider === 'vertex'
          ? {
              id: 'new-credential',
              name: 'Inline key',
              type: 'vertexServiceAccount',
              vertex: { clientEmail: 'vertex@example.com', privateKey: MASKED_PROVIDER_SECRET },
            }
          : { id: 'new-credential', name: 'Inline key', type: 'apiKey', apiKey: MASKED_PROVIDER_SECRET },
      ])
      await flush()
      expect(target.querySelector('[data-provider-credential-editor]')).toBeNull()
      expect(target.querySelector<HTMLSelectElement>('[data-provider-credential-picker] select')?.value).toBe(
        'new-credential',
      )
      expect(target.querySelector<HTMLInputElement>('[data-runtime-field="maxResponse"]')?.value).toBe('8192')
      clickText(language.modelProfiles.save)
      await flush()
      expect(state.onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My edited model',
          runtimeOptions: { maxResponse: 8192 },
          providerOptions: expect.objectContaining({ credentialId: 'new-credential' }),
        }),
      )
      expect(JSON.stringify(state.onSave.mock.calls)).not.toContain('test-secret-material')
      expect(JSON.stringify(state.onSave.mock.calls)).not.toContain(MASKED_PROVIDER_SECRET)
    },
  )

  it('waits for a queued credential to appear and ignores unrelated new credentials', async () => {
    credentialMocks.create.mockResolvedValue({
      status: 'queued',
      result: { status: 'unavailable' },
      mutationId: 'inline-queued',
    })
    const state = await openInlineCredential()
    clickText(language.modelProfiles.credentialSaveAndUse, state.editor)
    await flush()
    expect(state.editor.textContent).toContain(language.modelProfiles.commandQueued)
    const cancel = Array.from(state.editor.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === language.modelProfiles.cancel,
    )!
    expect(cancel.disabled).toBe(true)
    cancel.click()
    await tick()
    expect(target.querySelector('[data-provider-credential-editor]')).toBe(state.editor)
    state.credentials.set('rows', [
      { id: 'unrelated', name: 'Another key', type: 'apiKey', apiKey: MASKED_PROVIDER_SECRET },
    ])
    await flush()
    expect(target.querySelector('[data-provider-credential-editor]')).not.toBeNull()
    expect(target.querySelector<HTMLSelectElement>('[data-provider-credential-picker] select')?.value).toBe('')
    settlements.get('inline-queued')?.('accepted')
    state.credentials.set('rows', [
      ...state.credentials.get('rows')!,
      { id: 'replayed-key', name: 'Inline key', type: 'apiKey', apiKey: MASKED_PROVIDER_SECRET },
    ])
    await flush()
    expect(target.querySelector('[data-provider-credential-editor]')).toBeNull()
    expect(target.querySelector<HTMLSelectElement>('[data-provider-credential-picker] select')?.value).toBe(
      'replayed-key',
    )
    expect(state.name.value).toBe('My edited model')
    expect(getPendingModelMutations('provider-credentials')).toEqual([])
  })

  it('keeps both drafts editable after a credential save fails', async () => {
    credentialMocks.create.mockResolvedValue({
      status: 'failed',
      result: { status: 'error', error: 'Could not save key' },
    })
    const state = await openInlineCredential()
    clickText(language.modelProfiles.credentialSaveAndUse, state.editor)
    await flush()
    expect(state.editor.textContent).toContain('Could not save key')
    expect(state.name.value).toBe('My edited model')
    expect(state.onCancel).not.toHaveBeenCalled()
    expect(state.editor.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(false)
    expect(getPendingModelMutations('provider-credentials')).toEqual([])
  })

  it('releases a discarded queued key without losing the model draft', async () => {
    credentialMocks.create.mockResolvedValue({
      status: 'queued',
      result: { status: 'unavailable' },
      mutationId: 'inline-discarded',
    })
    const state = await openInlineCredential()
    clickText(language.modelProfiles.credentialSaveAndUse, state.editor)
    await flush()
    settlements.get('inline-discarded')?.('discarded')
    await flush()
    expect(state.editor.textContent).toContain(language.modelProfiles.commandReplayDiscarded)
    expect(state.editor.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(false)
    expect(state.name.value).toBe('My edited model')
    expect(state.onCancel).not.toHaveBeenCalled()
    expect(getPendingModelMutations('provider-credentials')).toEqual([])
  })
})

it('captures raw profile edits before blur, including a collapsed connection section', async () => {
  await beginWriterDraftCaptureTest()
  try {
    const profile = { id: 'profile-draft', name: 'Original', providerId: 'debug-echo', modelId: 'debug-echo' }
    const onSave = vi.fn()
    component = mount(ModelProfileEditorDrawer, {
      target,
      props: {
        mode: 'edit',
        profile,
        profiles: [profile],
        credentials: [],
        statusText: 'Ready',
        onSave,
        onCancel: vi.fn(),
      },
    })
    await tick()
    const input = target.querySelector<HTMLInputElement>('input[type="text"]')!
    input.value = 'Unsubmitted profile name'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    const draft = capturedWriterDrafts().find((draft) => draft.key === 'model-profile:profile-draft')!
    expect(draft.data).toMatchObject({ draftName: 'Unsubmitted profile name', runtimeOptions: {}, fallbacks: [] })
    expect(draft.baseline).toMatchObject({ draftName: 'Original' })
    expect(onSave).not.toHaveBeenCalled()
    await unmount(component)
    component = undefined
    expect(capturedWriterDrafts().find((draft) => draft.key === 'model-profile:profile-draft')?.data).toMatchObject({
      draftName: 'Unsubmitted profile name',
    })
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})

it('captures a new credential secret before Save without exposing it as an ordinary field', async () => {
  await beginWriterDraftCaptureTest()
  try {
    const { default: ProviderCredentialEditor } = await import('./ProviderCredentialEditor.svelte')
    component = mount(ProviderCredentialEditor, {
      target,
      props: { type: 'apiKey', credentials: [], onComplete: vi.fn(), onCancel: vi.fn() },
    })
    await tick()
    const keyInput = target.querySelector<HTMLInputElement>('input[type="password"]')!
    keyInput.value = 'draft-secret-that-was-never-saved'
    keyInput.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    const draft = capturedWriterDrafts().find((draft) => draft.key === 'provider-credential:new:apiKey')!
    expect(draft.fields).toContainEqual({
      label: language.modelProfiles.apiKeyLabel,
      value: 'draft-secret-that-was-never-saved',
      secret: true,
    })
    expect(draft.data).toMatchObject({
      apiKeyDraft: { value: 'draft-secret-that-was-never-saved', disposition: 'replace' },
    })
    expect(credentialMocks.create).not.toHaveBeenCalled()
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})

it('does not capture a clean or explicitly cancelled credential editor', async () => {
  await beginWriterDraftCaptureTest()
  try {
    const { default: ProviderCredentialEditor } = await import('./ProviderCredentialEditor.svelte')
    const cancel = vi.fn()
    component = mount(ProviderCredentialEditor, {
      target,
      props: { type: 'apiKey', credentials: [], onComplete: vi.fn(), onCancel: cancel },
    })
    await tick()
    target.querySelector<HTMLButtonElement>(`button[aria-label="${language.modelProfiles.cancel}"]`)!.click()
    await tick()
    expect(cancel).toHaveBeenCalledOnce()
    await unmount(component)
    component = undefined
    demoteClientSession()
    expect(capturedWriterDrafts()).toEqual([])
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})
