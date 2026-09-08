import { describe, expect, it } from 'vitest'
import {
  advanceTranscriptResidents,
  buildTranscriptResidency,
  estimatePendingTranscriptRowHeight,
  growTranscriptWorkingRows,
  TranscriptResidencyEntryOwner,
  TranscriptHeightCache,
  TRANSCRIPT_HEIGHT_ENTRIES,
  TRANSCRIPT_MAX_PENDING_ROW_HEIGHT,
  TRANSCRIPT_MAX_RESIDENT_ROWS,
  TRANSCRIPT_MIN_PENDING_ROW_HEIGHT,
  transcriptRowAtOffset,
  transcriptRowOffsets,
} from './transcriptResidency'

describe('transcript residency geometry', () => {
  it('uses a deterministic bounded source-only estimate for first-mounted pending rows', () => {
    expect(estimatePendingTranscriptRowHeight('')).toBeGreaterThanOrEqual(TRANSCRIPT_MIN_PENDING_ROW_HEIGHT)
    expect(estimatePendingTranscriptRowHeight('short')).toBe(estimatePendingTranscriptRowHeight('short'))
    expect(estimatePendingTranscriptRowHeight(`${'wrapped words '.repeat(2_000)}\n`.repeat(40))).toBe(
      TRANSCRIPT_MAX_PENDING_ROW_HEIGHT,
    )
  })

  it('uses thirty rows normally and grows sticky overscan only for dense visible layouts', () => {
    expect(growTranscriptWorkingRows(30, 4)).toBe(30)
    expect(growTranscriptWorkingRows(30, 25)).toBe(30)
    expect(growTranscriptWorkingRows(30, 26)).toBe(45)
    expect(growTranscriptWorkingRows(45, 2)).toBe(45)
    expect(growTranscriptWorkingRows(45, 41)).toBe(60)
    expect(growTranscriptWorkingRows(60, 1000)).toBe(60)
  })

  it('keeps unchanged keyed row signals stable while replacing changed data and spacer geometry', () => {
    const rows = Array.from({ length: 180 }, (_, index) => ({ key: `id-${index}`, text: `message ${index}` }))
    const ids = rows.map((row) => row.key)
    const heights = new TranscriptHeightCache()
    const owner = new TranscriptResidencyEntryOwner<(typeof rows)[number]>()
    const build = () => buildTranscriptResidency(rows, ids, transcriptRowOffsets(ids, heights), 30, new Set(), false)
    const first = owner.reuse(build(), false)
    heights.set(ids[0], 123.5)
    rows[40] = { ...rows[40], text: 'accepted edit' }
    const next = owner.reuse(build(), false)
    for (const entry of next) {
      const previous = first.find((candidate) => candidate.key === entry.key)!
      if (entry.kind === 'row' && entry.id !== ids[40]) expect(entry).toBe(previous)
      else expect(entry).not.toBe(previous)
    }
    expect(next.find((entry) => entry.kind === 'row' && entry.id === ids[40])).toMatchObject({
      row: { text: 'accepted edit' },
    })
    expect(next[0]).toMatchObject({ kind: 'spacer', height: 29 * 360 + 123.5 })
  })

  it('forgets evicted row entries and clears bounded identity reuse on full materialization and chat reset', () => {
    const rows = Array.from({ length: 600 }, (_, index) => ({ key: `id-${index}` }))
    const ids = rows.map((row) => row.key)
    const offsets = transcriptRowOffsets(ids, new TranscriptHeightCache())
    const owner = new TranscriptResidencyEntryOwner<(typeof rows)[number]>()
    const build = (start: number, full = false) => buildTranscriptResidency(rows, ids, offsets, start, new Set(), full)
    const first = owner.reuse(build(0), false)[0]
    for (let start = 60; start < rows.length; start += 60) {
      owner.reuse(build(start), false)
      expect(owner.size).toBeLessThanOrEqual(76)
    }
    const returned = owner.reuse(build(0), false)[0]
    expect(returned).not.toBe(first)
    expect(owner.reuse(build(0, true), true)).toHaveLength(600)
    expect(owner.size).toBe(0)
    expect(owner.reuse(build(0), false)[0]).not.toBe(returned)
    owner.clear()
    expect(owner.size).toBe(0)
  })

  it('admits the nearest missing row every frame without reconstructing intermediate windows', () => {
    const ids = Array.from({ length: 600 }, (_, index) => `id-${index}`)
    const pins = new Set([ids[0], ids[500]])
    let previous = ids.slice(0, 30)
    for (let frame = 0; frame < 30; frame++) {
      const center = frame < 10 ? 100 + frame * 20 : 400
      const next = advanceTranscriptResidents(ids, previous, center - 15, center, pins)
      expect(next.ids.filter((id) => !previous.includes(id))).toHaveLength(1)
      expect(previous.filter((id) => !next.ids.includes(id) && !pins.has(id)).length).toBeLessThanOrEqual(1)
      expect(next.ids).toContain(ids[center])
      expect(next.ids.length + pins.size).toBeLessThanOrEqual(76)
      previous = next.ids
    }
    let settled = advanceTranscriptResidents(ids, previous, 385, 400, pins)
    for (let frame = 0; settled.pending && frame < 60; frame++) {
      settled = advanceTranscriptResidents(ids, settled.ids, 385, 400, pins)
    }
    expect(settled.pending).toBe(false)
    for (const id of ids.slice(385, 415)) expect(settled.ids).toContain(id)
  })

  it('drops obsolete chat rows and makes room for new protected owners before admission', () => {
    const ids = Array.from({ length: 600 }, (_, index) => `id-${index}`)
    const pins = new Set(ids.slice(0, 18))
    const previous = [...ids.slice(100, 160), 'deleted-message']
    const next = advanceTranscriptResidents(ids, previous, 300, 330, pins, 60)
    expect(next.ids).toHaveLength(58)
    expect(next.ids).not.toContain('deleted-message')
    const rows = ids.map((key) => ({ key }))
    const entries = buildTranscriptResidency(
      rows,
      ids,
      transcriptRowOffsets(ids, new TranscriptHeightCache()),
      300,
      pins,
      false,
      new Set(next.ids),
      60,
    )
    expect(entries.filter((entry) => entry.kind === 'row')).toHaveLength(76)
    for (const id of pins) expect(entries.some((entry) => entry.kind === 'row' && entry.id === id)).toBe(true)
    expect(previous).toHaveLength(61)
  })

  it('settles an asymmetric pin-reduced window without alternating its boundary rows', () => {
    const ids = Array.from({ length: 200 }, (_, index) => `id-${index}`)
    const pins = new Set(ids.slice(0, 18))
    const next = advanceTranscriptResidents(ids, ids.slice(71, 129), 70, 100, pins, 60)
    expect(next.pending).toBe(false)
    expect(new Set(next.ids)).toEqual(new Set(ids.slice(70, 128)))
    const repeated = advanceTranscriptResidents(ids, next.ids, 70, 100, pins, 60)
    expect(repeated.pending).toBe(false)
    expect(new Set(repeated.ids)).toEqual(new Set(next.ids))
  })

  it('bounds ordinary traversal independently of history and accounts for every omitted pixel', () => {
    for (const count of [30, 180, 600, 10000]) {
      const rows = Array.from({ length: count }, (_, index) => ({ key: `row-${index}` }))
      const ids = rows.map((row) => row.key)
      const heights = new TranscriptHeightCache()
      ids.slice(0, 600).forEach((id, index) => heights.set(id, 20.125 + (index % 700)))
      const offsets = transcriptRowOffsets(ids, heights)
      for (const start of [0, 60, 155, 550, 9950]) {
        const pins = new Set(ids.slice(0, 16))
        const entries = buildTranscriptResidency(rows, ids, offsets, start, pins, false)
        const resident = entries.filter((entry) => entry.kind === 'row')
        expect(resident.length).toBeLessThanOrEqual(TRANSCRIPT_MAX_RESIDENT_ROWS)
        expect(new Set(resident.map((entry) => entry.id)).size).toBe(resident.length)
        for (const id of pins) expect(resident.some((entry) => entry.id === id)).toBe(true)
        expect(
          entries.reduce((sum, entry) => sum + (entry.kind === 'row' ? heights.get(entry.id) : entry.height), 0),
        ).toBe(offsets.at(-1))
      }
    }
  })

  it('absorbs overlapping old/new generation identities within the same hard row budget', () => {
    const rows = Array.from({ length: 600 }, (_, index) => ({ key: `id-${index}` }))
    const ids = rows.map((row) => row.key)
    const offsets = transcriptRowOffsets(ids, new TranscriptHeightCache())
    const pins = new Set(ids.slice(0, 18))
    const entries = buildTranscriptResidency(rows, ids, offsets, 100, pins, false)
    const resident = entries.filter((entry) => entry.kind === 'row')
    expect(resident).toHaveLength(48)
    for (const id of pins) expect(resident.some((entry) => entry.id === id)).toBe(true)
    expect(resident.filter((entry) => !pins.has(entry.id))).toHaveLength(30)
  })

  it('keeps a finite measurement cache and restores estimates on width/chat reset', () => {
    const heights = new TranscriptHeightCache()
    for (let index = 0; index < TRANSCRIPT_HEIGHT_ENTRIES + 10; index++) heights.set(`${index}`, index + 0.125)
    expect(heights.size).toBe(TRANSCRIPT_HEIGHT_ENTRIES)
    expect(heights.get('0')).toBe(360)
    expect(heights.get('10')).toBe(10.125)
    expect(heights.set('invalid', NaN)).toBe(false)
    expect(heights.set('invalid', -1)).toBe(false)
    heights.clear()
    expect(heights.size).toBe(0)
    expect(heights.get('10')).toBe(360)
  })

  it('locates reverse-flow rows at fractional boundaries and clamps out-of-range offsets', () => {
    const offsets = [0, 20.125, 400.5, 400.5, 701.25]
    expect(transcriptRowAtOffset(offsets, -100)).toBe(0)
    expect(transcriptRowAtOffset(offsets, 20.124)).toBe(0)
    expect(transcriptRowAtOffset(offsets, 20.125)).toBe(1)
    expect(transcriptRowAtOffset(offsets, 400.5)).toBe(3)
    expect(transcriptRowAtOffset(offsets, 10000)).toBe(3)
  })

  it('materializes capture explicitly and returns to the ordinary bound with the same stable row keys', () => {
    const rows = Array.from({ length: 600 }, (_, index) => ({ key: `id-${index}` }))
    const ids = rows.map((row) => row.key)
    const offsets = transcriptRowOffsets(ids, new TranscriptHeightCache())
    const capture = buildTranscriptResidency(rows, ids, offsets, 100, new Set(), true)
    expect(capture.map((entry) => entry.key)).toEqual(ids)
    const restored = buildTranscriptResidency(rows, ids, offsets, 100, new Set(), false)
    expect(restored.filter((entry) => entry.kind === 'row').map((entry) => entry.key)).toEqual(ids.slice(100, 130))
  })
})
