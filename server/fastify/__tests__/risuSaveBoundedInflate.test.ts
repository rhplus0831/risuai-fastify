import * as fflate from 'fflate'
import { describe, expect, it, vi } from 'vitest'

// Spy passthrough so the tests can observe the cumulative byte counts the
// bounded inflate checks while it streams. The real limit logic still runs.
vi.mock('../src/risuSave/importLimits.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/risuSave/importLimits.js')>()
  return {
    ...original,
    assertExpandedSizeWithinLimit: vi.fn(original.assertExpandedSizeWithinLimit),
  }
})

import { decompressBounded, gunzipBounded } from '../src/risuSave/boundedInflate.js'
import { assertExpandedSizeWithinLimit } from '../src/risuSave/importLimits.js'
import { decodeLegacyRisuSaveEnvelope, encodeLegacyRisuSaveEnvelope } from '../src/risuSave/legacyEnvelopeCodec.js'
import {
  decodeRisuSaveBlockEnvelope,
  encodeRisuSaveBlockEnvelope,
  RisuSaveBlockType,
} from '../src/risuSave/blockCodec.js'

const limitSpy = vi.mocked(assertExpandedSizeWithinLimit)

const MIB = 1024 * 1024

function patterned(length: number): Uint8Array {
  const data = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) data[i] = i % 251
  return data
}

describe('streaming bounded inflate', () => {
  it('produces byte-identical output to the sync decoders within the cap', () => {
    const payload = patterned(3 * MIB)
    const equalsPayload = (decoded: Uint8Array): boolean => Buffer.from(decoded).equals(Buffer.from(payload))

    const gz = fflate.gzipSync(payload)
    expect(equalsPayload(gunzipBounded(gz, { maxExpandedBytes: 4 * MIB }))).toBe(true)
    expect(equalsPayload(gunzipBounded(gz))).toBe(true)

    const zl = fflate.compressSync(payload)
    expect(equalsPayload(decompressBounded(zl, { maxExpandedBytes: 4 * MIB }))).toBe(true)
    expect(equalsPayload(decompressBounded(gz))).toBe(true)
  })

  it('aborts an oversized inflate at the cap instead of materializing the payload', { tags: 'core' }, () => {
    // 64 MiB of zeros compresses to ~64 KiB — the gzip-bomb shape. With a 1 MiB
    // cap the inflate must throw long before 64 MiB ever exists in memory.
    const bomb = fflate.gzipSync(new Uint8Array(64 * MIB))
    limitSpy.mockClear()
    expect(() => gunzipBounded(bomb, { maxExpandedBytes: MIB })).toThrow(/exceeds size limit/)

    // The streaming accumulator stops within one push-step of the cap; a
    // decode-then-check regression would observe the full 64 MiB here.
    const observed = Math.max(...limitSpy.mock.calls.map(([byteLength]) => byteLength))
    expect(observed).toBeLessThan(16 * MIB)
  })

  it('rejects malformed compressed data like the sync decoders', () => {
    expect(() => gunzipBounded(patterned(64))).toThrow()
    expect(() => gunzipBounded(new Uint8Array(0))).toThrow(/invalid gzip data/)
  })

  it('enforces the cap for legacy compressed and stream envelopes during decode', () => {
    const payload = { blob: 'x'.repeat(4 * MIB) }
    for (const kind of ['legacy-compressed', 'legacy-stream'] as const) {
      const encoded = encodeLegacyRisuSaveEnvelope(payload, kind)
      expect(() => decodeLegacyRisuSaveEnvelope(encoded, { maxExpandedBytes: MIB }), kind).toThrow(/exceeds size limit/)
      // Identical decode result with a generous cap — only the failure mode changed.
      expect(decodeLegacyRisuSaveEnvelope(encoded, { maxExpandedBytes: 64 * MIB }), kind).toEqual(payload)
      expect(decodeLegacyRisuSaveEnvelope(encoded), kind).toEqual(payload)
    }
  })

  it('enforces the cumulative cap across compressed blocks during decode', () => {
    const rootContent = JSON.stringify({ name: 'root', blob: 'y'.repeat(700 * 1024) })
    const presetContent = JSON.stringify(['z'.repeat(700 * 1024)])
    const envelope = encodeRisuSaveBlockEnvelope([
      { name: 'root', type: RisuSaveBlockType.ROOT, data: rootContent, compression: true },
      { name: 'presets', type: RisuSaveBlockType.BOTPRESET, data: presetContent, compression: true },
    ])

    // Each block alone fits under 1 MiB; together they cross it, so the second
    // block must abort while inflating against the remaining budget.
    expect(() => decodeRisuSaveBlockEnvelope(envelope, { maxExpandedBytes: MIB })).toThrow(/exceeds size limit/)

    const decoded = decodeRisuSaveBlockEnvelope(envelope, { maxExpandedBytes: 4 * MIB })
    expect(decoded.blocks.map((block) => block.content)).toEqual([rootContent, presetContent])
    expect(decodeRisuSaveBlockEnvelope(envelope).blocks).toHaveLength(2)
  })
})
