import { performance } from 'node:perf_hooks'
import { diagnosticsContextEnabled, recordDiagnosticEvent } from '../diagnosticContext.js'
import type { FastifyChat, FastifyMessage } from './serverTypes.js'

const MAX_ROWS = 4096
const MAX_NODES = 32_768
const MAX_TEXT_UNITS = 1_048_576
const MAX_COUNT = 1_000_000_000

type TranscriptRow = Pick<FastifyMessage, 'role' | 'data' | 'chatId' | 'name'>
type Hook = 'editInput' | 'editOutput' | 'onInput' | 'onOutput' | 'trigger' | 'unknown'

function hookCategory(mode: string): Hook {
  switch (mode) {
    case 'editInput':
    case 'editOutput':
      return mode
    case 'input':
      return 'onInput'
    case 'output':
      return 'onOutput'
    case 'start':
    case 'onButtonClick':
      return 'trigger'
    default:
      return 'unknown'
  }
}

/** Snapshots retain immutable string references only, never copies or hashes. */
function snapshotTranscript(chat: FastifyChat): TranscriptRow[] | undefined {
  if (chat.message.length > MAX_ROWS) return undefined
  const snapshot: TranscriptRow[] = []
  let textUnits = MAX_TEXT_UNITS
  for (const row of chat.message) {
    textUnits -= row.role.length + row.data.length + (row.chatId?.length ?? 0) + (row.name?.length ?? 0)
    if (textUnits < 0) return undefined
    snapshot.push({ role: row.role, data: row.data, chatId: row.chatId, name: row.name })
  }
  return snapshot
}

/**
 * Local equality has fixed work limits. An omitted changed flag means unknown,
 * not unchanged. This never serializes content or constructs an export object.
 */
function contentChanged(before: unknown, after: unknown): boolean | undefined {
  let nodes = MAX_NODES
  let textUnits = MAX_TEXT_UNITS
  const equal = (left: unknown, right: unknown, depth: number): boolean | undefined => {
    if (--nodes < 0 || depth > 8) return undefined
    if (typeof left === 'string' && typeof right === 'string') {
      if (left.length !== right.length) return false
      textUnits -= left.length
      if (textUnits < 0) return undefined
      return left === right
    }
    if (left === right) return true
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
    if (Array.isArray(left) !== Array.isArray(right)) return false
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) return false
      if (left.length > MAX_ROWS) return undefined
      for (let index = 0; index < left.length; index++) {
        const same = equal(left[index], right[index], depth + 1)
        if (same !== true) return same
      }
      return true
    }
    // Inputs are local message snapshots or parsed Lua JSON. Bound enumeration
    // too, without materializing arbitrary arrays of keys or traversing prototypes.
    let leftCount = 0
    let rightCount = 0
    let inspected = 0
    for (const key in left) {
      if (!Object.hasOwn(left, key)) continue
      if (++inspected > 32) return undefined
      // Lua edit data crosses JSON, where absent and undefined object fields
      // are equivalent. Comparing the unencoded input must preserve that fact.
      if ((left as Record<string, unknown>)[key] === undefined) continue
      leftCount++
      if (!Object.hasOwn(right, key)) return false
      const same = equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth + 1)
      if (same !== true) return same
    }
    inspected = 0
    for (const key in right) {
      if (!Object.hasOwn(right, key)) continue
      if (++inspected > 32) return undefined
      if ((right as Record<string, unknown>)[key] !== undefined) rightCount++
    }
    return leftCount === rightCount
  }
  const same = equal(before, after, 0)
  return same === undefined ? undefined : !same
}

export interface LuaDiagnosticsRun {
  hostCall(): void
  blockHostCall(): void
  touchTranscript(): void
  finish(input: { failed: boolean; output?: unknown }): void
}

/** Independent of protocol metrics and the content-bearing Lua trace collector. */
export function beginLuaDiagnostics(mode: string, chat: FastifyChat, input: unknown): LuaDiagnosticsRun | undefined {
  if (!diagnosticsContextEnabled()) return undefined
  const startedAt = performance.now()
  const hook = hookCategory(mode)
  const edit = mode === 'editInput' || mode === 'editOutput' || mode === 'editRequest' || mode === 'editDisplay'
  const beforeCount = chat.message.length
  const before = snapshotTranscript(chat)
  let allowedCalls = 0
  let blockedCalls = 0
  let transcriptTouched = false
  let finished = false
  return {
    hostCall() {
      allowedCalls = Math.min(MAX_COUNT, allowedCalls + 1)
    },
    blockHostCall() {
      // Every host entry starts allowed; a real permission/egress guard changes
      // that same call's disposition. Provider HTTP errors are not policy blocks.
      allowedCalls = Math.max(0, allowedCalls - 1)
      blockedCalls = Math.min(MAX_COUNT, blockedCalls + 1)
    },
    touchTranscript() {
      transcriptTouched = true
    },
    finish(result) {
      if (finished) return
      finished = true
      const transcriptChanged = !transcriptTouched
        ? false
        : beforeCount !== chat.message.length
          ? true
          : before
            ? contentChanged(before, snapshotTranscript(chat))
            : undefined
      const outputChanged =
        !edit || result.output === undefined || result.output === null ? false : contentChanged(input, result.output)
      recordDiagnosticEvent({
        category: 'script',
        level: result.failed ? 'warn' : 'info',
        hook,
        runtime: 'lua',
        runs: 1,
        failures: result.failed ? 1 : 0,
        durationMs: Math.min(86_400_000, Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100)),
        allowedCalls,
        blockedCalls,
        comparison: outputChanged === undefined || transcriptChanged === undefined ? 'unavailable' : 'complete',
        ...(outputChanged === undefined ? {} : { outputChanged }),
        ...(transcriptChanged === undefined ? {} : { transcriptChanged }),
      })
    },
  }
}
