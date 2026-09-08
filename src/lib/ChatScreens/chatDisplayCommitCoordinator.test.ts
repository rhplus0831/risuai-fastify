import { describe, expect, it } from 'vitest'
import { createChatDisplayCommitCoordinator } from './chatDisplayCommitCoordinator'

function harness(batchSize = 2) {
  let idle: (() => void) | undefined
  const frames: Array<() => void> = []
  const batches: string[][] = []
  const coordinator = createChatDisplayCommitCoordinator({
    batchSize,
    applyBatch(commits) {
      const batch: string[] = []
      commits.forEach((commit) => {
        const previous = currentBatch
        currentBatch = batch
        commit()
        currentBatch = previous
      })
      batches.push(batch)
    },
    scheduleIdle(run) {
      idle = run
      return () => {
        if (idle === run) idle = undefined
      }
    },
    scheduleFrame(run) {
      frames.push(run)
      return () => {
        const index = frames.indexOf(run)
        if (index >= 0) frames.splice(index, 1)
      }
    },
  })
  let currentBatch: string[] | undefined
  const commit = (key: string, signal?: AbortSignal) =>
    coordinator.commit(
      key,
      () => {
        currentBatch?.push(key)
      },
      signal,
    )
  return {
    coordinator,
    batches,
    commit,
    idle() {
      const run = idle
      idle = undefined
      run?.()
    },
    frame() {
      frames.shift()?.()
    },
  }
}

describe('chat display commit coordinator', () => {
  it('holds off-screen completions through interaction, promotes visible rows, and flushes bounded idle batches', () => {
    const h = harness()
    h.coordinator.noteInteraction()
    for (const key of ['a', 'b', 'c', 'd', 'e']) h.commit(key)
    expect(h.batches).toEqual([])
    expect(h.coordinator.pending).toBe(5)

    h.coordinator.setVisible(['c'])
    h.frame()
    expect(h.batches).toEqual([['c']])
    expect(h.coordinator.pending).toBe(4)

    h.idle()
    h.frame()
    expect(h.batches).toEqual([['c'], ['a', 'b']])
    h.frame()
    expect(h.batches).toEqual([['c'], ['a', 'b'], ['d', 'e']])
    expect(h.coordinator.pending).toBe(0)
  })

  it('replaces superseded rows and drops aborted, reset, and destroyed commits', () => {
    const h = harness()
    h.coordinator.noteInteraction()
    h.commit('superseded')
    h.commit('superseded')
    const aborted = new AbortController()
    h.commit('aborted', aborted.signal)
    aborted.abort()
    expect(h.coordinator.pending).toBe(1)
    h.coordinator.reset()
    h.idle()
    h.frame()
    expect(h.batches).toEqual([])

    h.commit('immediate')
    h.frame()
    expect(h.batches).toEqual([['immediate']])
    h.coordinator.destroy()
    h.commit('destroyed')
    expect(h.batches).toEqual([['immediate']])
  })
})
