import {
  ValidationError,
  persistStagedAssetsInTransaction,
  cleanupCopiedStagedAssetFiles,
  type StagedAssetLiveFileCopy,
} from './repository.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getMaintenanceCoordinator } from './maintenanceCoordinator.js'

/** Reads framed records without retaining already consumed upload chunks. */
export class StreamBytes {
  private iterator: AsyncIterator<Uint8Array>
  private chunk: Uint8Array = new Uint8Array()
  private offset = 0
  private ended = false
  constructor(
    source: AsyncIterable<Uint8Array>,
    private signal?: AbortSignal,
  ) {
    this.iterator = source[Symbol.asyncIterator]()
  }
  private async available(): Promise<boolean> {
    this.signal?.throwIfAborted()
    while (this.offset === this.chunk.length && !this.ended) {
      const next = await this.iterator.next()
      this.signal?.throwIfAborted()
      this.ended = next.done === true
      this.chunk = next.value ?? new Uint8Array()
      this.offset = 0
    }
    return this.offset < this.chunk.length
  }
  async read(size: number, limit = 50 * 1024 * 1024): Promise<Buffer> {
    if (!Number.isSafeInteger(size) || size < 0 || size > limit)
      throw new ValidationError('Import entry exceeds size limit')
    const output = Buffer.allocUnsafe(size)
    let position = 0
    while (position < size) {
      if (!(await this.available())) throw new ValidationError('Import file ended unexpectedly')
      const count = Math.min(size - position, this.chunk.length - this.offset)
      output.set(this.chunk.subarray(this.offset, this.offset + count), position)
      this.offset += count
      position += count
    }
    return output
  }
  /** Drain ignored payloads without allocating a buffer proportional to their size. */
  async skip(size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0) throw new ValidationError('Invalid import entry size')
    while (size > 0) {
      if (!(await this.available())) throw new ValidationError('Import file ended unexpectedly')
      const count = Math.min(size, this.chunk.length - this.offset)
      this.offset += count
      size -= count
    }
  }
  async rest(limit: number): Promise<Buffer> {
    const chunks: Buffer[] = []
    let size = 0
    while (await this.available()) {
      const chunk = this.chunk.subarray(this.offset)
      size += chunk.length
      if (size > limit) throw new ValidationError('Import metadata exceeds size limit')
      chunks.push(Buffer.from(chunk))
      this.offset = this.chunk.length
    }
    return Buffer.concat(chunks, size)
  }
  async finish(): Promise<void> {
    if (await this.available()) throw new ValidationError('Import file contains trailing bytes')
  }
}

/** Reconstructs PNG image bytes on disk while skipping card/asset tEXt chunks.
 * The complete upload and complete image are never allocated in memory. */
export class StreamedPngImage {
  private dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-png-image-'))
  private file = path.join(this.dir, 'image')
  private fd: number | undefined = fs.openSync(this.file, 'wx')
  private hash = createHash('sha256')
  private size = 0
  write(bytes: Uint8Array): void {
    this.hash.update(bytes)
    this.size += bytes.length
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(this.fd!, bytes, offset, bytes.length - offset)
  }
  register(db: DatabaseSync, dataDir: string): string {
    fs.closeSync(this.fd!)
    this.fd = undefined
    const id = this.hash.digest('hex')
    const copied: StagedAssetLiveFileCopy[] = []
    getMaintenanceCoordinator(dataDir).noteAssetActivity()
    db.exec('BEGIN IMMEDIATE')
    try {
      persistStagedAssetsInTransaction(
        db,
        dataDir,
        [{ id, size: this.size, contentType: 'image/png', filePath: this.file }],
        copied,
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      cleanupCopiedStagedAssetFiles(copied)
      throw error
    }
    return id
  }
  dispose(): void {
    if (this.fd !== undefined) {
      fs.closeSync(this.fd)
      this.fd = undefined
    }
    fs.rmSync(this.dir, { recursive: true, force: true })
  }
}
