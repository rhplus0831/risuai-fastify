import { describe, expect, it, vi } from 'vitest'
import { AssetCollectionIndexCache, type AssetTuples } from './assetCollectionIndex'

const assets = (count: number, nameSuffix = ''): string[][] =>
  Array.from({ length: count }, (_, i) => [`name-${i}${nameSuffix}`, `path-${i}`, 'png'])

describe('shared asset collection indexes', () => {
  it('shares in-flight work and yields to an ordinary task before a large build finishes', async () => {
    let taskRan = false
    const visit = vi.fn()
    const cache = new AssetCollectionIndexCache(visit, () => 0)
    const source = assets(10_000)
    setTimeout(() => {
      taskRan = true
    }, 0)
    const first = cache.get(source, 0, 'module')
    expect(cache.get(source, 0, 'module')).toBe(first)
    const indexes = await first
    expect(taskRan).toBe(true)
    expect(indexes.exact.get('name-9999')?.get('png')).toEqual(['path-9999'])
    expect(indexes.withoutImageExtensions).toBe(true)
    expect(visit).toHaveBeenCalledTimes(10_000)
    expect(await cache.get(source, 0, 'module')).toBe(indexes)
    expect(visit).toHaveBeenCalledTimes(10_000)
  })

  it('discards a partial index when a module changes during a yield, including rollback', async () => {
    let revision = 0
    let resume!: () => void
    const paused = new Promise<void>((resolve) => {
      resume = resolve
    })
    const yieldWork = vi
      .fn()
      .mockResolvedValue(undefined)
      .mockImplementationOnce(() => paused)
    const cache = new AssetCollectionIndexCache(
      () => {},
      () => revision,
      yieldWork,
    )
    const source = assets(5_000, '.png')
    const pending = cache.get(source, revision, 'module')
    expect(yieldWork).toHaveBeenCalledOnce()
    source[0][1] = 'edited-first'
    source[4999][1] = 'edited-last'
    revision++
    resume()
    const indexes = await pending
    expect(indexes.exact.get('name-0.png')?.get('png')).toEqual(['edited-first'])
    expect(indexes.exact.get('name-4999.png')?.get('png')).toEqual(['edited-last'])
    const normalized = indexes.withoutImageExtensions
    expect(normalized).not.toBe(true)
    if (normalized === true) throw new Error('expected a normalized asset index')
    expect(normalized.get('name-0')?.get('png')).toEqual(['edited-first'])
    expect(normalized.get('name-4999')?.get('png')).toEqual(['edited-last'])
    source[0][1] = 'path-0'
    revision++
    const rebuilt = await cache.get(source, revision, 'module')
    expect(rebuilt.exact.get('name-0.png')?.get('png')).toEqual(['path-0'])
    if (rebuilt.withoutImageExtensions === true) throw new Error('expected a normalized asset index')
    expect(rebuilt.withoutImageExtensions.get('name-0')?.get('png')).toEqual(['path-0'])
  })

  it('indexes a captured character snapshot in both projections and keeps all asset types', async () => {
    const source = [
      ['PORTRAIT.JPG', 'first', 'jpg'],
      ['portrait.jpg', 'second', 'png'],
    ]
    const snapshot: AssetTuples = source.map((tuple) => [...tuple])
    const cache = new AssetCollectionIndexCache(
      () => {},
      () => 0,
    )
    source[0][1] = 'edited'
    const indexes = await cache.get(source, 'original', 'character', snapshot)
    expect([...indexes.exact.get('portrait.jpg')!.entries()]).toEqual([
      ['jpg', ['first']],
      ['png', ['second']],
    ])
    if (indexes.withoutImageExtensions === true) throw new Error('expected a normalized asset index')
    expect([...indexes.withoutImageExtensions.get('portrait')!.entries()]).toEqual([
      ['jpg', ['first']],
      ['png', ['second']],
    ])
    const rebuilt = await cache.get(source, 'edited', 'character')
    expect(rebuilt.exact.get('portrait.jpg')?.get('jpg')).toEqual(['edited'])
    if (rebuilt.withoutImageExtensions === true) throw new Error('expected a normalized asset index')
    expect(rebuilt.withoutImageExtensions.get('portrait')?.get('jpg')).toEqual(['edited'])
  })

  it('normalizes supported image suffixes while preserving exact keys and collision order', async () => {
    const cache = new AssetCollectionIndexCache(
      () => {},
      () => 0,
    )
    const indexes = await cache.get(
      [
        ['SHIORI.PNG', 'png-first', 'png'],
        ['shiori.jpg', 'jpg-second', 'jpg'],
        ['ShIoRi.JPEG', 'jpeg-third', 'jpeg'],
        ['shiori.WEBP', 'webp-fourth', 'webp'],
        ['shiori.gif', 'gif-fifth', 'gif'],
        ['shiori', 'bare-sixth', 'png'],
        ['shiori.svg', 'svg-seventh', 'svg'],
      ],
      0,
      'character',
    )

    expect(new Set(indexes.exact.keys())).toEqual(
      new Set(['shiori.png', 'shiori.jpg', 'shiori.jpeg', 'shiori.webp', 'shiori.gif', 'shiori', 'shiori.svg']),
    )
    expect(indexes.exact.get('shiori.png')).toEqual(new Map([['png', ['png-first']]]))
    expect(indexes.exact.get('shiori')).toEqual(new Map([['png', ['bare-sixth']]]))
    const withoutImageExtensions = indexes.withoutImageExtensions
    expect(withoutImageExtensions).not.toBe(true)
    if (withoutImageExtensions === true) throw new Error('expected a normalized asset index')
    expect([...withoutImageExtensions.get('shiori')!.entries()]).toEqual([
      ['png', ['png-first', 'bare-sixth']],
      ['jpg', ['jpg-second']],
      ['jpeg', ['jpeg-third']],
      ['webp', ['webp-fourth']],
      ['gif', ['gif-fifth']],
    ])
    expect(withoutImageExtensions.get('shiori.svg')).toEqual(new Map([['svg', ['svg-seventh']]]))
    expect(withoutImageExtensions.size).toBe(2)
  })
})
