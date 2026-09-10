import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runMocks = vi.hoisted(() => ({
  addText: vi.fn(),
  alertError: vi.fn(),
  generateAIImage: vi.fn(),
  processerConstructor: vi.fn(),
  similaritySearchScored: vi.fn(),
}))

vi.mock('src/ts/process/stableDiff', () => ({
  generateAIImage: runMocks.generateAIImage,
}))

vi.mock('src/ts/characters', () => ({
  createBlankChar: vi.fn(() => ({})),
}))

vi.mock('src/ts/process/memory/hypamemory', () => ({
  HypaProcesser: class {
    vectors = []
    addText = runMocks.addText
    similaritySearchScored = runMocks.similaritySearchScored

    constructor(...args: unknown[]) {
      runMocks.processerConstructor(...args)
    }
  },
}))

vi.mock('src/ts/server/settingsOwner.svelte', () => ({
  createServerBackedSettingDraft: (_key: string, fallback: unknown) => ({ value: fallback }),
}))

vi.mock('src/ts/alert', () => ({
  alertError: runMocks.alertError,
}))

vi.mock('src/ts/process/modules', () => ({
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModules: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))

import PlaygroundEmbedding from './PlaygroundEmbedding.svelte'
import PlaygroundImageGen from './PlaygroundImageGen.svelte'
import { language } from 'src/lang'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

function buttonContaining(text: string): HTMLButtonElement {
  const button = Array.from(target.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text),
  )
  if (!button) throw new Error(`button not found: ${text}`)
  return button
}

function embeddingRunButton(): HTMLButtonElement {
  const label = language.run?.toLocaleUpperCase()
  const button = Array.from(target.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`button not found: ${label}`)
  return button
}

beforeEach(() => {
  target = document.createElement('div')
  document.body.append(target)
  runMocks.addText.mockReset()
  runMocks.alertError.mockReset()
  runMocks.generateAIImage.mockReset()
  runMocks.processerConstructor.mockReset()
  runMocks.similaritySearchScored.mockReset()
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
})

describe('playground run-state recovery', () => {
  it('restores the image generation button after an unexpected failure', async () => {
    runMocks.generateAIImage.mockRejectedValue(new Error('image failed'))
    component = mount(PlaygroundImageGen, { target })

    buttonContaining(language.playground.generateImage).click()

    await vi.waitFor(() => expect(runMocks.alertError).toHaveBeenCalledWith(expect.any(Error)))
    await vi.waitFor(() => expect(buttonContaining(language.playground.generateImage).disabled).toBe(false))
    buttonContaining(language.playground.generateImage).click()
    await vi.waitFor(() => expect(runMocks.generateAIImage).toHaveBeenCalledTimes(2))
  })

  it('discards an image generation result when its submitted prompts are stale', async () => {
    let finishGeneration: ((image: string) => void) | undefined
    runMocks.generateAIImage.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishGeneration = resolve
        }),
    )
    component = mount(PlaygroundImageGen, { target })

    const [promptInput, negativePromptInput] = Array.from(target.querySelectorAll('textarea'))
    promptInput.value = 'submitted prompt'
    promptInput.dispatchEvent(new Event('input', { bubbles: true }))
    negativePromptInput.value = 'submitted negative prompt'
    negativePromptInput.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    const button = Array.from(target.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Generate'),
    )
    expect(button).toBeTruthy()
    button!.click()

    await vi.waitFor(() =>
      expect(runMocks.generateAIImage).toHaveBeenCalledWith(
        'submitted prompt',
        expect.anything(),
        'submitted negative prompt',
        'inlay',
        { signal: expect.any(AbortSignal) },
      ),
    )

    promptInput.value = 'new prompt'
    promptInput.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    finishGeneration!('data:image/png;base64,stale')

    await vi.waitFor(() => expect(target.querySelector('.loadmove')).toBeNull())
    expect(target.querySelector('img')).toBeNull()
  })

  it('aborts image generation on unmount without reporting a cancellation error', async () => {
    let generationSignal: AbortSignal | undefined
    runMocks.generateAIImage.mockImplementation(
      (_prompt, _character, _negativePrompt, _returnType, options) =>
        new Promise((_resolve, reject) => {
          generationSignal = options.signal
          generationSignal.addEventListener(
            'abort',
            () => reject(new DOMException('Image generation cancelled', 'AbortError')),
            { once: true },
          )
        }),
    )
    component = mount(PlaygroundImageGen, { target })

    const button = Array.from(target.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Generate'),
    )
    button?.click()
    await vi.waitFor(() => expect(runMocks.generateAIImage).toHaveBeenCalledOnce())
    expect(generationSignal?.aborted).toBe(false)

    const mounted = component
    component = undefined
    unmount(mounted)

    expect(generationSignal?.aborted).toBe(true)
    await Promise.resolve()
    expect(runMocks.alertError).not.toHaveBeenCalled()
  })

  it('restores the embedding run button after an embedding failure', async () => {
    runMocks.addText.mockRejectedValue(new Error('embedding failed'))
    component = mount(PlaygroundEmbedding, { target })

    embeddingRunButton().click()

    await vi.waitFor(() => expect(runMocks.alertError).toHaveBeenCalledWith(expect.any(Error)))
    await vi.waitFor(() => expect(embeddingRunButton().disabled).toBe(false))
    embeddingRunButton().click()
    await vi.waitFor(() => expect(runMocks.addText).toHaveBeenCalledTimes(2))
  })

  it('keeps an embedding run bound to its submitted inputs and discards a stale completion', async () => {
    let finishAddingText: (() => void) | undefined
    runMocks.addText.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishAddingText = resolve
        }),
    )
    runMocks.similaritySearchScored.mockResolvedValue([['stale result', 0.75]])
    component = mount(PlaygroundEmbedding, { target })

    const addButton = Array.from(target.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes(language.playground.embeddingAddData),
    )
    expect(addButton).toBeTruthy()
    addButton!.click()
    await tick()

    const [queryInput, dataInput] = Array.from(target.querySelectorAll('input'))
    queryInput.value = 'submitted query'
    queryInput.dispatchEvent(new Event('input', { bubbles: true }))
    dataInput.value = 'submitted data'
    dataInput.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    const runButton = Array.from(target.querySelectorAll('button')).at(-1)
    expect(runButton).toBeTruthy()
    runButton!.click()

    await vi.waitFor(() => expect(runMocks.addText).toHaveBeenCalledWith(['submitted data']))
    expect(runMocks.processerConstructor).toHaveBeenCalledWith(
      'MiniLM',
      '',
      expect.objectContaining({
        openAIKey: '',
        customKey: '',
        customModel: '',
        signal: expect.any(AbortSignal),
      }),
    )
    expect(target.querySelector('select')).toHaveProperty('disabled', true)
    expect(queryInput.disabled).toBe(true)
    expect(dataInput.disabled).toBe(true)
    expect(addButton!.disabled).toBe(true)
    expect(runButton!.disabled).toBe(true)

    queryInput.value = 'new query'
    queryInput.dispatchEvent(new Event('input', { bubbles: true }))
    dataInput.value = 'new data'
    dataInput.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(runMocks.addText.mock.calls[0][0]).toEqual(['submitted data'])

    finishAddingText!()
    await vi.waitFor(() => expect(runMocks.similaritySearchScored).toHaveBeenCalledWith('submitted query'))
    await vi.waitFor(() => expect(target.querySelector('.loadmove')).toBeNull())
    expect(target.textContent).not.toContain('stale result')
    expect(target.textContent).toContain('No result')
  })
})

describe('playground run control names', () => {
  it('keeps image generation fields and the loading action named', async () => {
    let finishGeneration: ((value: string) => void) | undefined
    runMocks.generateAIImage.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishGeneration = resolve
        }),
    )
    component = mount(PlaygroundImageGen, { target })

    expect(Array.from(target.querySelectorAll('textarea'), (input) => input.getAttribute('aria-label'))).toEqual([
      language.prompt,
      language.negPrompt,
    ])
    const generate = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(language.playground.generateImage),
    )
    expect(generate).toBeTruthy()

    generate!.click()
    await vi.waitFor(() => expect(runMocks.generateAIImage).toHaveBeenCalledOnce())
    expect(generate!.disabled).toBe(true)
    expect(generate!.textContent).toContain(language.playground.generateImage)
    expect(generate!.querySelector('.loadmove')?.getAttribute('aria-hidden')).toBe('true')

    finishGeneration!('')
    await vi.waitFor(() => expect(generate!.disabled).toBe(false))
  })

  it('names embedding model, query, repeated data, and the symbolic add control', async () => {
    component = mount(PlaygroundEmbedding, { target })

    const model = target.querySelector('select')
    expect(model?.getAttribute('aria-label')).toBe(language.playground.embeddingModel)
    expect(target.querySelector('input')?.getAttribute('aria-label')).toBe(language.playground.embeddingQuery)

    const add = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(language.playground.embeddingAddData),
    )
    expect(add?.querySelector('[aria-hidden="true"]')?.textContent).toBe('+')
    expect(add?.querySelector('.sr-only')?.textContent).toBe(language.playground.embeddingAddData)
    add!.click()
    await tick()
    expect(target.querySelector(`input[aria-label="${language.playground.embeddingData(1)}"]`)).toBeTruthy()
  })
})
