export type AssetTuples = readonly (readonly string[])[]
export type AssetNameIndex = Map<string, Map<string | undefined, string[]>>
export interface AssetCollectionIndexes {
  exact: AssetNameIndex
  /** `true` means stripping image extensions did not change any indexed name. */
  withoutImageExtensions: AssetNameIndex | true
}
export type AssetCollectionKind = 'character' | 'module'

const knownImageExtensionRegex = /\.(?:webp|png|jpe?g|gif)$/i

export function stripKnownImageExtension(name: string): string {
  return name.replace(knownImageExtensionRegex, '')
}

async function yieldAssetWork(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (scheduler?.yield) await scheduler.yield()
  else await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** Reuse collection indexes across chats without retaining removed collections. */
export class AssetCollectionIndexCache {
  private entries = new WeakMap<AssetTuples, { version: string | number; promise: Promise<AssetCollectionIndexes> }>()
  private sliceStart = performance.now()

  constructor(
    private visit: (kind: AssetCollectionKind) => void,
    private moduleRevision: () => number,
    private yieldWork: () => Promise<void> = yieldAssetWork,
  ) {}

  clear() {
    this.entries = new WeakMap()
  }

  get(
    source: AssetTuples,
    version: string | number,
    kind: AssetCollectionKind,
    snapshot = source,
  ): Promise<AssetCollectionIndexes> {
    const cached = this.entries.get(source)
    if (cached?.version === version) return cached.promise
    const promise = this.build(snapshot, kind, version).then((index) => {
      // Discard mixed versions after an edit/rollback during a suspended build.
      const currentVersion = kind === 'module' ? this.moduleRevision() : version
      return currentVersion === version ? index : this.get(source, currentVersion, kind)
    })
    const entry = { version, promise }
    this.entries.set(source, entry)
    void promise.catch(() => {
      if (this.entries.get(source) === entry) this.entries.delete(source)
    })
    return promise
  }

  private async build(
    source: AssetTuples,
    kind: AssetCollectionKind,
    version: string | number,
  ): Promise<AssetCollectionIndexes> {
    const exact: AssetNameIndex = new Map()
    const withoutImageExtensions: AssetNameIndex = new Map()
    let imageExtensionRemoved = false
    for (let i = 0; i < source.length; i++) {
      if (i % 256 === 0 && ((i > 0 && i % 2048 === 0) || performance.now() - this.sliceStart >= 4)) {
        await this.yieldWork()
        if (kind === 'module' && version !== this.moduleRevision()) {
          return completedIndexes(exact, withoutImageExtensions, imageExtensionRemoved)
        }
        this.sliceStart = performance.now()
      }
      const asset = source[i]
      this.visit(kind)
      const name = asset[0].toLocaleLowerCase()
      const nameWithoutImageExtension = stripKnownImageExtension(name)
      imageExtensionRemoved ||= nameWithoutImageExtension !== name
      addAsset(exact, name, asset)
      addAsset(withoutImageExtensions, nameWithoutImageExtension, asset)
    }
    return completedIndexes(exact, withoutImageExtensions, imageExtensionRemoved)
  }
}

function completedIndexes(
  exact: AssetNameIndex,
  withoutImageExtensions: AssetNameIndex,
  imageExtensionRemoved: boolean,
): AssetCollectionIndexes {
  return { exact, withoutImageExtensions: imageExtensionRemoved ? withoutImageExtensions : true }
}

function addAsset(index: AssetNameIndex, name: string, asset: readonly string[]): void {
  let extensions = index.get(name)
  if (!extensions) index.set(name, (extensions = new Map()))
  let paths = extensions.get(asset[2])
  if (!paths) extensions.set(asset[2], (paths = []))
  paths.push(asset[1])
}
