import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { character } from '../storage/database.svelte'

const image = vi.hoisted(() => ({
  generate: vi.fn(),
  write: vi.fn(),
}))

vi.mock('./stableDiff', () => ({ generateAIImage: image.generate }))
vi.mock('./files/inlays', () => ({ writeInlayImage: image.write }))

import { inlayScreenRequiresFinalization, renderInlayScreenTextWithoutProviders, runInlayScreen } from './inlayScreen'

const character = {
  inlayViewScreen: true,
  viewScreen: 'imggen',
  newGenData: {
    prompt: 'best quality, {{slot}}',
    negative: 'bad quality',
  },
} as character

beforeEach(() => {
  image.generate.mockReset()
  image.write.mockReset()
})

afterEach(() => vi.unstubAllGlobals())

describe('image inlay failure settlement', () => {
  it('renders ImgGen text for TTS without dispatching a provider', () => {
    expect(renderInlayScreenTextWithoutProviders(character, 'Reply <ImgGen="happy cat">')).toBe('Reply [Generating...]')
    expect(image.generate).not.toHaveBeenCalled()
    expect(image.write).not.toHaveBeenCalled()
  })

  it('preserves the source obligation when the provider cannot produce an image', async () => {
    image.generate.mockResolvedValueOnce(false)

    const result = runInlayScreen(character, 'Reply <ImgGen="happy cat">')

    expect(result.text).toBe('Reply [Generating...]')
    const settled = await result.promise!
    expect(settled).toBe('Reply <ImgGen="happy cat">')
    expect(inlayScreenRequiresFinalization(character, settled)).toBe(true)
    expect(image.write).not.toHaveBeenCalled()
  })

  it('forwards post-provider cancellation and fences a late asset resolution', async () => {
    vi.stubGlobal(
      'Image',
      class {
        src = ''
      },
    )
    image.generate.mockResolvedValueOnce('data:image/png;base64,AA==')
    let resolveUpload!: (assetId: string) => void
    image.write.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveUpload = resolve
      }),
    )
    const controller = new AbortController()
    const settlementController = new AbortController()
    const settlePostProviderSpy = vi.fn()
    const settlePostProvider = <T>(settle: (signal?: AbortSignal) => Promise<T>): Promise<T> => {
      settlePostProviderSpy(settle)
      return settle(settlementController.signal)
    }

    const result = runInlayScreen(character, 'Reply <ImgGen="happy cat">', {
      signal: controller.signal,
      settlePostProvider,
    })
    await vi.waitFor(() => expect(image.write).toHaveBeenCalledOnce())
    expect(settlePostProviderSpy).toHaveBeenCalledOnce()
    expect(image.generate).toHaveBeenCalledWith('best quality, happy cat', character, 'bad quality', 'inlay', {
      signal: controller.signal,
    })
    expect(image.write).toHaveBeenCalledWith(expect.anything(), { signal: settlementController.signal })

    settlementController.abort(new Error('settlement superseded'))
    resolveUpload('late-asset')
    await expect(result.promise).rejects.toThrow('settlement superseded')
  })

  it('settles every returned image independently across both ImgGen syntaxes', async () => {
    vi.stubGlobal(
      'Image',
      class {
        src = ''
      },
    )
    image.generate.mockResolvedValueOnce('data:image/png;base64,ZmFzdA==')
    image.generate.mockResolvedValueOnce('data:image/png;base64,c2xvdw==')
    image.write.mockResolvedValueOnce('fast-asset').mockResolvedValueOnce('slow-asset')
    const providerController = new AbortController()
    const settlementSignals: AbortSignal[] = []
    const settlePostProviderSpy = vi.fn()
    const settlePostProvider = <T>(settle: (signal?: AbortSignal) => Promise<T>): Promise<T> => {
      settlePostProviderSpy(settle)
      const controller = new AbortController()
      settlementSignals.push(controller.signal)
      return settle(controller.signal)
    }

    const result = runInlayScreen(character, 'First <ImgGen="fast"> then {{ImgGen="slow"}}', {
      signal: providerController.signal,
      settlePostProvider,
    })

    await expect(result.promise).resolves.toBe('First {{inlay::fast-asset}} then {{inlay::slow-asset}}')
    expect(image.generate).toHaveBeenNthCalledWith(1, 'best quality, fast', character, 'bad quality', 'inlay', {
      signal: providerController.signal,
    })
    expect(image.generate).toHaveBeenNthCalledWith(2, 'best quality, slow', character, 'bad quality', 'inlay', {
      signal: providerController.signal,
    })
    expect(settlePostProviderSpy).toHaveBeenCalledTimes(2)
    expect(settlementSignals).toHaveLength(2)
    expect(settlementSignals[0]).not.toBe(settlementSignals[1])
    expect(image.write).toHaveBeenNthCalledWith(1, expect.anything(), { signal: settlementSignals[0] })
    expect(image.write).toHaveBeenNthCalledWith(2, expect.anything(), { signal: settlementSignals[1] })
  })
})
