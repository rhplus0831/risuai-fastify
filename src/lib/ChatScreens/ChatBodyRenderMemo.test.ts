import { describe, expect, it, vi } from 'vitest'
import { createChatBodyRenderMemo } from './ChatBodyRenderMemo'

describe('finalized chat HTML memo', () => {
  it('reuses a finalized body after an intervening empty body', () => {
    const finalize = vi.fn((html: string) => `finalized:${html}`)
    const render = createChatBodyRenderMemo(finalize)

    expect(render('body', 'model-a', 'visible')).toBe('finalized:body')
    expect(render('', 'model-a', 'visible')).toBe('finalized:')
    finalize.mockClear()

    expect(render('body', 'model-a', 'visible')).toBe('finalized:body')
    expect(finalize).not.toHaveBeenCalled()
  })

  it.each([
    { dependency: 'content', html: 'edited', model: 'model-a', policy: 'visible' },
    { dependency: 'model metadata', html: 'body', model: 'model-b', policy: 'visible' },
    { dependency: 'display policy', html: 'body', model: 'model-a', policy: 'hidden' },
  ])('finalizes fresh output when $dependency changes', ({ html, model, policy }) => {
    const finalize = vi.fn().mockReturnValueOnce('original output').mockReturnValueOnce('updated output')
    const render = createChatBodyRenderMemo(finalize)
    expect(render('body', 'model-a', 'visible')).toBe('original output')
    finalize.mockClear()

    expect(render(html, model, policy)).toBe('updated output')
    expect(finalize).toHaveBeenCalledExactlyOnceWith(html, model)
    expect(render(html, model, policy)).toBe('updated output')
    expect(finalize).toHaveBeenCalledTimes(1)
  })

  it('evicts older bodies when their combined strings exceed the per-body memory budget', () => {
    const finalize = vi.fn((html: string) => html)
    const render = createChatBodyRenderMemo(finalize)
    // Each input/output pair is ~800 KB in UTF-16: individually cacheable,
    // but together larger than the documented 1 MiB budget, regardless of entry count.
    const first = 'a'.repeat(200_000)
    const second = 'b'.repeat(200_000)
    expect(render(first, '', '')).toBe(first)
    finalize.mockClear()
    expect(render(first, '', '')).toBe(first)
    expect(finalize).not.toHaveBeenCalled()

    expect(render(second, '', '')).toBe(second)
    finalize.mockClear()
    expect(render(second, '', '')).toBe(second)
    expect(finalize).not.toHaveBeenCalled()
    expect(render(first, '', '')).toBe(first)
    expect(finalize).toHaveBeenCalledExactlyOnceWith(first, '')
  })

  it('returns oversized output without retaining it or discarding an existing cached body', () => {
    const large = 'a'.repeat(600_000)
    const finalize = vi.fn((html: string) => (html === 'large' ? large : `finalized:${html}`))
    const render = createChatBodyRenderMemo(finalize)
    expect(render('small', '', '')).toBe('finalized:small')
    expect(render('large', '', '')).toBe(large)
    finalize.mockClear()

    expect(render('small', '', '')).toBe('finalized:small')
    expect(finalize).not.toHaveBeenCalled()
    expect(render('large', '', '')).toBe(large)
    expect(finalize).toHaveBeenCalledExactlyOnceWith('large', '')
  })
})
