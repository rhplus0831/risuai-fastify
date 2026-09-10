import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const conversionMocks = vi.hoisted(() => ({
  detectPromptJSONType: vi.fn(),
  promptConvertion: vi.fn(),
  selectMultipleFile: vi.fn(),
}))

vi.mock('src/ts/filePicker', () => ({
  selectMultipleFile: conversionMocks.selectMultipleFile,
}))

vi.mock('src/ts/process/prompt', () => ({
  detectPromptJSONType: conversionMocks.detectPromptJSONType,
  promptConvertion: conversionMocks.promptConvertion,
}))

import ToolConversion from './ToolConversion.svelte'

type MountedComponent = Parameters<typeof unmount>[0]

let target: HTMLElement
let component: MountedComponent | undefined

function buttonByText(text: string) {
  const button = Array.from(target.querySelectorAll('button')).find((candidate) => candidate.textContent === text)
  if (!button) throw new Error(`button not found: ${text}`)
  return button
}

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  conversionMocks.detectPromptJSONType.mockReset()
  conversionMocks.promptConvertion.mockReset()
  conversionMocks.selectMultipleFile.mockReset()
  conversionMocks.detectPromptJSONType.mockImplementation((text: string) =>
    text.includes('context') ? 'STCONTEXT' : 'PARAMETERS',
  )
  conversionMocks.selectMultipleFile.mockResolvedValue([
    {
      data: new TextEncoder().encode('context file'),
      name: 'context.json',
    },
    {
      data: new TextEncoder().encode('sampler file'),
      name: 'sampler.json',
    },
  ])
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
})

describe('ToolConversion file list', () => {
  it('does not run until at least one supported file is present', async () => {
    conversionMocks.detectPromptJSONType.mockReturnValue('NOTSUPPORTED')
    component = mount(ToolConversion, { target })

    expect(buttonByText('Run').disabled).toBe(true)
    buttonByText('Add').click()
    await vi.waitFor(() => expect(target.textContent).toContain('context.json'))

    expect(buttonByText('Run').disabled).toBe(true)
    buttonByText('Run').click()
    expect(conversionMocks.promptConvertion).not.toHaveBeenCalled()
  })

  it('removes deleted files before running conversion', async () => {
    component = mount(ToolConversion, { target })

    buttonByText('Add').click()
    await vi.waitFor(() => {
      expect(target.textContent).toContain('context.json')
      expect(target.textContent).toContain('sampler.json')
    })
    expect(buttonByText('Run').disabled).toBe(false)

    const firstDelete = Array.from(target.querySelectorAll('button')).find((button) => button.textContent === 'Delete')
    expect(firstDelete).toBeTruthy()
    firstDelete!.click()
    await tick()

    expect(target.textContent).not.toContain('context.json')
    expect(target.textContent).toContain('sampler.json')

    buttonByText('Run').click()
    expect(conversionMocks.promptConvertion).toHaveBeenCalledWith([
      {
        content: 'sampler file',
        name: 'sampler.json',
        type: 'PARAMETERS',
      },
    ])
  })
})
