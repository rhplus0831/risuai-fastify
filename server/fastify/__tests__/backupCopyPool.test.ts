import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupCopyPool } from '../src/backupCopyPool.js'
import {
  BACKUP_COPY_BATCH_SIZE,
  BACKUP_HASH_BUFFER_BYTES,
  type BackupCopyEntry,
  type BackupCopyRequest,
  type BackupCopyResponse,
} from '../src/backupCopyProtocol.js'
import { BackupAssetError, copyBackupAssets, copyBackupDirectory } from '../src/backupFiles.js'
import type { PersistedAsset } from '../src/repository.js'

let root: string
let source: string
let target: string
let pools: BackupCopyPool[]
let releases: Array<() => void>

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'risu-backup-workers-'))
  source = path.join(root, 'source')
  target = path.join(root, 'target')
  fs.mkdirSync(source)
  fs.mkdirSync(target)
  pools = []
  releases = []
})

afterEach(async () => {
  releases.forEach((release) => release())
  await Promise.all(pools.map((pool) => pool.close()))
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

function pool(signal = new AbortController().signal): BackupCopyPool {
  const result = new BackupCopyPool(signal)
  pools.push(result)
  return result
}

function asset(bytes: Buffer): PersistedAsset {
  const id = createHash('sha256').update(bytes).digest('hex')
  fs.writeFileSync(path.join(source, `${id}.bin`), bytes)
  return { id, ext: 'bin', size: bytes.length, contentType: 'application/octet-stream' }
}

function entry(name: string): BackupCopyEntry {
  fs.writeFileSync(path.join(source, name), name)
  return { kind: 'file', from: path.join(source, name), to: path.join(target, name), symbolicLink: false }
}

function copyAssets(
  assets: Iterable<PersistedAsset> | AsyncIterable<PersistedAsset>,
  required = new Set<string>(),
  options: { signal?: AbortSignal; fallback?: string; copyPool?: BackupCopyPool } = {},
) {
  const signal = options.signal ?? new AbortController().signal
  return copyBackupAssets({
    from: source,
    to: target,
    assets,
    requiredIds: required,
    signal,
    pool: options.copyPool ?? pool(signal),
    restoreFallbackDir: options.fallback,
  })
}

/** Delay an acknowledgement after the real native worker has finished copying.
 * This leaves its slot occupied without mocking filesystem work or the entry. */
function holdAcknowledgements() {
  const acknowledgements: Array<() => void> = []
  const workers = new Set<Worker>()
  const exits = new Set<Worker>()
  const original = Worker.prototype.emit
  let released = false
  vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event, ...args) {
    if (event === 'message' && args[0]?.kind === 'copied' && !released) {
      workers.add(this)
      this.once('exit', () => exits.add(this))
      acknowledgements.push(() => original.call(this, event, ...args))
      return true
    }
    return original.call(this, event, ...args)
  })
  const release = () => {
    released = true
    acknowledgements.splice(0).forEach((acknowledge) => acknowledge())
  }
  releases.push(release)
  return { acknowledgements, workers, exits, release }
}

describe('native backup copy workers', () => {
  it('uses two bounded workers across verified assets, directory extras, symlinks and saves', async () => {
    const small = asset(Buffer.from('required small asset'))
    const large = asset(Buffer.alloc(256 * 1024 + 7, 42))
    const extra = entry('unindexed-extra')
    fs.mkdirSync(path.join(source, 'nested'))
    fs.writeFileSync(path.join(source, 'nested', 'extra'), 'nested extra')
    fs.symlinkSync('../unindexed-extra', path.join(source, 'nested', 'link'))
    const remaining = Array.from({ length: 70 }, (_, index) => asset(Buffer.from(`asset ${index}`)))
    const saves = path.join(root, 'save')
    fs.mkdirSync(saves)
    fs.writeFileSync(path.join(saves, 'database.risudat'), 'compatibility save')
    const workers = new Set<Worker>()
    const sizes: number[] = []
    const original = Worker.prototype.postMessage
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message: BackupCopyRequest) {
      if (message.kind === 'copy') {
        workers.add(this)
        sizes.push(message.entries.length)
        for (const descriptor of message.entries) expect(Object.values(descriptor).some(Buffer.isBuffer)).toBe(false)
      }
      return original.call(this, message)
    })
    // These spies affect only the API isolate. The real entry must execute
    // under native Node, without inheriting mocks or depending on TS loaders.
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('main-thread copy')
    })
    vi.spyOn(fs.promises, 'copyFile').mockRejectedValue(new Error('main-thread copy'))
    const signal = new AbortController().signal
    const copyPool = pool(signal)
    await copyAssets([small, large, ...remaining], new Set([small.id, large.id]), { signal, copyPool })
    await copyBackupDirectory(saves, path.join(root, 'saved-copy'), signal, copyPool)
    await copyPool.close()
    copyPool.throwIfFailed()
    expect(workers.size).toBe(2)
    expect(Math.max(...sizes)).toBe(BACKUP_COPY_BATCH_SIZE)
    expect(fs.readFileSync(path.join(target, `${large.id}.bin`))).toEqual(Buffer.alloc(large.size, 42))
    expect(fs.readFileSync(extra.to, 'utf8')).toBe('unindexed-extra')
    expect(fs.readFileSync(path.join(target, 'nested', 'extra'), 'utf8')).toBe('nested extra')
    expect(fs.readlinkSync(path.join(target, 'nested', 'link'))).toBe('../unindexed-extra')
    expect(fs.readFileSync(path.join(root, 'saved-copy', 'database.risudat'), 'utf8')).toBe('compatibility save')
  })

  it('rejects oversized batches and a third concurrent batch without queueing', async () => {
    const copyPool = pool()
    const first = entry('first')
    const second = entry('second')
    await expect(copyPool.runBatch(Array(17).fill(first))).rejects.toThrow('backup_copy_batch_limit_exceeded')
    const held = holdAcknowledgements()
    const pending = [copyPool.runBatch([first]), copyPool.runBatch([second])]
    await expect(copyPool.runBatch([first])).rejects.toThrow('backup_copy_pool_busy')
    await vi.waitFor(() => expect(held.acknowledgements).toHaveLength(2))
    expect(fs.readFileSync(first.to, 'utf8')).toBe('first')
    held.release()
    await Promise.all(pending)
  })

  it('waits for every active acknowledgement and worker exit before close settles', async () => {
    const copyPool = pool()
    const held = holdAcknowledgements()
    const pending = [copyPool.runBatch([entry('first')]), copyPool.runBatch([entry('second')])]
    await vi.waitFor(() => expect(held.acknowledgements).toHaveLength(2))
    let closed = false
    const closing = copyPool.close().then(() => {
      closed = true
    })
    await nextTurn()
    expect(closed).toBe(false)
    expect(held.exits.size).toBe(0)
    await expect(copyPool.runBatch([])).rejects.toThrow('backup_copy_pool_closed')
    held.release()
    await Promise.all(pending)
    await closing
    expect(held.exits.size).toBe(2)
    expect(copyPool.close()).toBe(copyPool.close())
  })

  it.each(['size', 'hash'] as const)(
    'fails closed on incorrect required %s without using a fallback',
    async (damage) => {
      const bytes = Buffer.from('required immutable bytes')
      const item = asset(bytes)
      const fallback = path.join(root, 'fallback')
      fs.mkdirSync(fallback)
      fs.writeFileSync(path.join(fallback, `${item.id}.bin`), bytes)
      fs.writeFileSync(
        path.join(source, `${item.id}.bin`),
        damage === 'size' ? Buffer.from('bad') : Buffer.alloc(bytes.length),
      )
      await expect(copyAssets([item], new Set([item.id]), { fallback })).rejects.toBeInstanceOf(BackupAssetError)
    },
  )

  it('preserves damaged optional orphan bytes and permits missing optional files', async () => {
    const damaged = asset(Buffer.from('original'))
    const missing = asset(Buffer.from('missing orphan'))
    fs.writeFileSync(path.join(source, `${damaged.id}.bin`), 'damage')
    fs.rmSync(path.join(source, `${missing.id}.bin`))
    await copyAssets([damaged, missing])
    expect(fs.readFileSync(path.join(target, `${damaged.id}.bin`), 'utf8')).toBe('damage')
    expect(fs.existsSync(path.join(target, `${missing.id}.bin`))).toBe(false)
  })

  it.each(['optional', 'required', 'fallback'] as const)(
    'rejects a %s metadata asset symlink before copying private bytes',
    async (kind) => {
      const item = asset(Buffer.from('ordinary indexed asset'))
      const privateFile = path.join(root, 'private-key')
      fs.writeFileSync(privateFile, 'PRIVATE_DIAGNOSTIC_KEY_CANARY')
      const filename = `${item.id}.bin`
      fs.rmSync(path.join(source, filename))
      const fallback = path.join(root, 'fallback')
      fs.mkdirSync(fallback)
      fs.symlinkSync(privateFile, path.join(kind === 'fallback' ? fallback : source, filename))
      await expect(
        copyAssets([item], kind === 'optional' ? new Set() : new Set([item.id]), { fallback }),
      ).rejects.toBeInstanceOf(BackupAssetError)
      expect(fs.existsSync(path.join(target, filename))).toBe(false)
    },
  )

  it.each(['none', 'missing', 'size', 'hash', 'valid'] as const)(
    'uses a missing-live fallback only when verified: %s',
    async (state) => {
      const bytes = Buffer.from('captured live bytes')
      const item = asset(bytes)
      fs.rmSync(path.join(source, `${item.id}.bin`))
      const fallback = state === 'none' ? undefined : path.join(root, 'fallback')
      if (fallback) {
        fs.mkdirSync(fallback)
        if (state !== 'missing')
          fs.writeFileSync(
            path.join(fallback, `${item.id}.bin`),
            state === 'size' ? Buffer.from('bad') : state === 'hash' ? Buffer.alloc(bytes.length) : bytes,
          )
      }
      const copying = copyAssets([item], new Set([item.id]), { fallback })
      if (state === 'valid') {
        await copying
        expect(fs.readFileSync(path.join(target, `${item.id}.bin`))).toEqual(bytes)
      } else await expect(copying).rejects.toBeInstanceOf(BackupAssetError)
      expect(fs.existsSync(path.join(source, `${item.id}.bin`))).toBe(false)
    },
  )

  it('propagates a real native copy failure and drains its peer', async () => {
    const copyPool = pool()
    const good = entry('valid')
    const bad: BackupCopyEntry = {
      kind: 'file',
      from: path.join(source, 'absent'),
      to: path.join(target, 'absent'),
      symbolicLink: false,
    }
    const results = await Promise.allSettled([copyPool.runBatch([bad]), copyPool.runBatch([good])])
    expect(results.some((result) => result.status === 'rejected' && result.reason.code === 'ENOENT')).toBe(true)
    await copyPool.close()
    await expect(copyPool.runBatch([good])).rejects.toThrow('backup_copy_pool_closed')
  })

  it('rejects cancellation after native work and still awaits both acknowledgements before draining', async () => {
    const controller = new AbortController()
    const copyPool = pool(controller.signal)
    const held = holdAcknowledgements()
    const pending = Promise.allSettled([copyPool.runBatch([entry('first')]), copyPool.runBatch([entry('second')])])
    await vi.waitFor(() => expect(held.acknowledgements).toHaveLength(2))
    controller.abort()
    let closed = false
    const closing = copyPool.close().then(() => {
      closed = true
    })
    await nextTurn()
    expect(closed).toBe(false)
    held.release()
    const results = await pending
    expect(results.every((result) => result.status === 'rejected' && result.reason.name === 'AbortError')).toBe(true)
    await closing
    expect(held.exits.size).toBe(2)
  })

  it('checks shared cancellation inside the native entry before copying a queued batch', async () => {
    const cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    const worker = new Worker(new URL('../src/backupCopyWorker.ts', import.meta.url), {
      execArgv: [],
      workerData: {
        cancellation: cancellation.buffer,
        batchSize: BACKUP_COPY_BATCH_SIZE,
        hashBufferBytes: BACKUP_HASH_BUFFER_BYTES,
      },
    })
    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()))
    try {
      await new Promise((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
      })
      Atomics.store(cancellation, 0, 1)
      const result = new Promise<BackupCopyResponse>((resolve) => worker.once('message', resolve))
      const item = entry('cancelled')
      worker.postMessage({ kind: 'copy', entries: [item] } satisfies BackupCopyRequest)
      expect(await result).toMatchObject({ kind: 'copied', error: { name: 'AbortError' } })
      expect(fs.existsSync(item.to)).toBe(false)
    } finally {
      worker.postMessage({ kind: 'close' } satisfies BackupCopyRequest)
      await exited
    }
  })

  it('observes cancellation during native copy/hash before starting the next file', async () => {
    const large = asset(Buffer.alloc(64 * 1024 * 1024, 42))
    const controller = new AbortController()
    const copyPool = pool(controller.signal)
    const next = entry('must-not-copy')
    const name = `${large.id}.bin`
    const watcher = fs.watch(target, (_event, filename) => {
      // File creation is observed while the native worker copies or verifies
      // the large file. Cancellation is shared even while its port is busy.
      if (String(filename) === name) controller.abort()
    })
    try {
      await expect(
        copyPool.runBatch([
          {
            kind: 'asset',
            from: path.join(source, name),
            to: path.join(target, name),
            id: large.id,
            size: large.size,
            required: true,
          },
          next,
        ]),
      ).rejects.toMatchObject({ name: 'AbortError' })
      await copyPool.close()
      expect(controller.signal.aborted).toBe(true)
      expect(fs.existsSync(path.join(target, name))).toBe(true)
      expect(fs.existsSync(next.to)).toBe(false)
    } finally {
      watcher.close()
    }
  })

  it('stops discovery and settles a peer batch before returning an iterator failure', async () => {
    const copyPool = pool()
    const held = holdAcknowledgements()
    const items = Array.from({ length: 32 }, (_, index) => asset(Buffer.from(`asset ${index}`)))
    const failure = new Error('metadata iteration failed')
    async function* metadata() {
      yield* items
      throw failure
    }
    let finished = false
    const copying = copyAssets(metadata(), new Set(), { copyPool }).finally(() => {
      finished = true
    })
    const rejected = expect(copying).rejects.toBe(failure)
    await vi.waitFor(() => expect(held.acknowledgements).toHaveLength(2))
    held.acknowledgements.shift()!()
    await nextTurn()
    expect(finished).toBe(false)
    held.release()
    await rejected
    await copyPool.close()
    expect(held.exits.size).toBe(2)
  })

  it('fails and drains if a native worker exits without acknowledging its batch', async () => {
    const copyPool = pool()
    const original = Worker.prototype.postMessage
    let crashed = false
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message: BackupCopyRequest) {
      if (!crashed && message.kind === 'copy') {
        crashed = true
        // Simulates a process/worker failure; production never terminates a
        // worker to cancel in-flight native filesystem work.
        void this.terminate()
        return
      }
      return original.call(this, message)
    })
    await expect(copyPool.runBatch([entry('crashed')])).rejects.toThrow('exited unexpectedly')
    await copyPool.close()
  })
})
