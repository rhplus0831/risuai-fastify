export const TRANSCRIPT_WORKING_ROWS = 30
export const TRANSCRIPT_MAX_WORKING_ROWS = 60
export const TRANSCRIPT_MAX_RESIDENT_ROWS = 76
export const TRANSCRIPT_HEIGHT_ENTRIES = 2048
export const TRANSCRIPT_ESTIMATED_ROW_HEIGHT = 360
export const TRANSCRIPT_MIN_PENDING_ROW_HEIGHT = 160
export const TRANSCRIPT_MAX_PENDING_ROW_HEIGHT = 960

/** Cheap source-only estimate; display scripts and HTML parsing remain deferred. */
export function estimatePendingTranscriptRowHeight(source: string): number {
  const text = source.slice(0, 24_000)
  const explicitLines = Math.min(24, text.match(/\n|<br\s*\/?>|<\/p>|<\/div>/giu)?.length ?? 0)
  const wrappedLines = Math.ceil(text.replace(/<[^>]*>/gu, '').length / 64)
  const contentLines = Math.max(1, explicitLines + 1, wrappedLines)
  return Math.min(TRANSCRIPT_MAX_PENDING_ROW_HEIGHT, TRANSCRIPT_MIN_PENDING_ROW_HEIGHT + contentLines * 22)
}

/** Dense custom layouts can need more rows than the normal overscan target. */
export function growTranscriptWorkingRows(current: number, visibleRows: number): number {
  return visibleRows >= current - 4 ? Math.min(TRANSCRIPT_MAX_WORKING_ROWS, current + 15) : current
}

/** Geometry belongs to the displayed chat, never to the hydrated message owner. */
export class TranscriptHeightCache {
  private readonly entries = new Map<string, number>()

  get size() {
    return this.entries.size
  }

  get(id: string): number {
    return this.entries.get(id) ?? TRANSCRIPT_ESTIMATED_ROW_HEIGHT
  }

  measured(id: string): number | undefined {
    return this.entries.get(id)
  }

  set(id: string, height: number): boolean {
    if (!Number.isFinite(height) || height < 0 || id.length > 2048) return false
    const previous = this.entries.get(id)
    // Keep fractional CSS pixels; cumulative rounding otherwise moves anchors.
    this.entries.delete(id)
    this.entries.set(id, height)
    while (this.entries.size > TRANSCRIPT_HEIGHT_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value!)
    }
    return previous === undefined || Math.abs(previous - height) > 0.01
  }

  clear() {
    this.entries.clear()
  }
}

export function transcriptRowOffsets(ids: readonly string[], heights: TranscriptHeightCache): number[] {
  const offsets = [0]
  for (const id of ids) offsets.push(offsets[offsets.length - 1] + heights.get(id))
  return offsets
}

/** Coordinates increase from the newest row toward older history (reverse flex). */
export function transcriptRowAtOffset(offsets: readonly number[], offset: number): number {
  let low = 0
  let high = Math.max(0, offsets.length - 2)
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (offsets[middle + 1] <= offset) low = middle + 1
    else high = middle
  }
  return low
}

export type TranscriptResidencyEntry<T> =
  | { key: string; kind: 'row'; row: T; id: string }
  | { key: string; kind: 'spacer'; height: number; start: number; end: number }

/** Preserve keyed item signals for unchanged rows during geometry/admission updates. */
export class TranscriptResidencyEntryOwner<T> {
  private entries = new Map<string, Extract<TranscriptResidencyEntry<T>, { kind: 'row' }>>()

  get size() {
    return this.entries.size
  }

  reuse(next: TranscriptResidencyEntry<T>[], full: boolean): TranscriptResidencyEntry<T>[] {
    if (full) {
      this.clear()
      return next
    }
    const retained = new Map<string, Extract<TranscriptResidencyEntry<T>, { kind: 'row' }>>()
    const result = next.map((entry) => {
      if (entry.kind !== 'row') return entry
      const previous = this.entries.get(entry.key)
      const stable = previous && previous.row === entry.row && previous.id === entry.id ? previous : entry
      if (retained.size < TRANSCRIPT_MAX_RESIDENT_ROWS) retained.set(entry.key, stable)
      return stable
    })
    // Evicted rows are forgotten immediately; full capture never grows this owner.
    this.entries = retained
    return result
  }

  clear() {
    this.entries.clear()
  }
}

/** Replace at most one ordinary component per frame, nearest the viewport first. */
export function advanceTranscriptResidents(
  ids: readonly string[],
  previous: readonly string[],
  start: number,
  center: number,
  pinned: ReadonlySet<string>,
  workingRows = TRANSCRIPT_WORKING_ROWS,
): { ids: string[]; pending: boolean } {
  const budget = Math.max(
    0,
    Math.min(workingRows, TRANSCRIPT_MAX_WORKING_ROWS, TRANSCRIPT_MAX_RESIDENT_ROWS - pinned.size),
  )
  const first = Math.max(0, Math.min(start, ids.length - budget))
  const desired = ids.slice(first, first + budget)
  const desiredIds = new Set(desired)
  const positions = new Map(ids.map((id, index) => [id, index]))
  const distance = (id: string) => Math.abs((positions.get(id) ?? center) - center)
  const next = [...new Set(previous)].filter((id) => positions.has(id) && !pinned.has(id))
  next.sort((left, right) => distance(left) - distance(right))
  // A changed logical window or newly protected owner can require immediate
  // removal; ordinary scrolling admits and evicts just one row below.
  next.length = Math.min(next.length, budget)
  const present = new Set([...next, ...pinned])
  const missing = desired.filter((id) => !present.has(id)).sort((left, right) => distance(left) - distance(right))
  if (missing[0]) {
    if (next.length === budget) {
      // The window can be asymmetric near the history edge or when pins
      // reduce its budget. Distance alone could evict a desired row forever.
      const outside = next.findLastIndex((id) => !desiredIds.has(id))
      next.splice(outside >= 0 ? outside : next.length - 1, 1)
    }
    next.push(missing[0])
  }
  const settled = new Set([...next, ...pinned])
  return { ids: next, pending: desired.some((id) => !settled.has(id)) }
}

export function buildTranscriptResidency<T extends { key: string }>(
  rows: readonly T[],
  ids: readonly string[],
  offsets: readonly number[],
  start: number,
  pinned: ReadonlySet<string>,
  full: boolean,
  admitted?: ReadonlySet<string>,
  requestedWorkingRows = TRANSCRIPT_WORKING_ROWS,
): TranscriptResidencyEntry<T>[] {
  // Transitional generation can briefly expose old/new presentation IDs
  // together. Protected owners consume the shared row budget before the
  // working window, so that overlap never increases the hard limit.
  const workingRows = Math.max(
    0,
    Math.min(requestedWorkingRows, TRANSCRIPT_MAX_WORKING_ROWS, TRANSCRIPT_MAX_RESIDENT_ROWS - pinned.size),
  )
  const windowStart = Math.max(0, Math.min(start, rows.length - workingRows))
  const windowEnd = windowStart + workingRows
  const entries: TranscriptResidencyEntry<T>[] = []
  let gapStart = -1
  function flushGap(end: number) {
    if (gapStart < 0) return
    entries.push({
      key: `spacer:${ids[gapStart]}`,
      kind: 'spacer',
      height: offsets[end] - offsets[gapStart],
      start: gapStart,
      end,
    })
    gapStart = -1
  }
  for (let index = 0; index < rows.length; index++) {
    if (
      full ||
      (admitted ? admitted.has(ids[index]) : index >= windowStart && index < windowEnd) ||
      pinned.has(ids[index])
    ) {
      flushGap(index)
      entries.push({ key: rows[index].key, kind: 'row', row: rows[index], id: ids[index] })
    } else if (gapStart < 0) gapStart = index
  }
  flushGap(rows.length)
  return entries
}
