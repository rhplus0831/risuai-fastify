import { describe, expect, it } from 'vitest'
import type { ReaderGenerationProjection } from '../../ts/server/readerGenerationTypes'
import type { Message } from '../../ts/storage/database.svelte'
import { readerGenerationRow } from './readerGenerationRows'

const projection: ReaderGenerationProjection = {
  databaseLineage: 'lineage',
  characterId: 'character',
  chatId: 'chat',
  operationId: 'operation',
  attemptNo: 2,
  jobId: 'job',
  generationId: 'job',
  projectionEpoch: 8,
  mode: 'continue',
  continueDisposition: 'extend',
  targetMessageId: 'target',
  continueBase: 'Original',
  text: 'Original plus partial',
  status: 'finalizing',
  phase: 'finalizing',
  startedAt: 1,
}
const target: Message = { role: 'char', chatId: 'target', data: 'Original' }

describe('reader generation canonical handoff', () => {
  it('keeps the existing Continue target provisional until the new generation is certified', () => {
    const messages = [target]
    expect(readerGenerationRow(messages, { ...projection, resultMessageId: target.chatId })).toEqual({
      index: 0,
      append: false,
      canonical: false,
    })
    const committed = {
      ...target,
      data: 'Authoritative output',
      generationInfo: {
        generationId: 'job',
        operationId: 'operation',
        attemptNo: 2,
      },
    }
    expect(readerGenerationRow([committed], { ...projection, resultMessageId: target.chatId })).toEqual({
      index: 0,
      append: false,
      canonical: true,
    })
    expect(messages).toEqual([{ role: 'char', chatId: 'target', data: 'Original' }])
  })

  it.each([
    { operationId: 'superseded-operation' },
    { attemptNo: 1 },
    { databaseLineage: 'replaced-database' },
    { jobId: 'superseded-job' },
    { generationId: 'superseded-generation' },
  ])('does not adopt a same-ID row carrying conflicting generation identity: %j', (conflict) => {
    expect(
      readerGenerationRow(
        [
          {
            role: 'char',
            chatId: 'job',
            data: 'Old output',
            generationInfo: {
              generationId: 'job',
              operationId: 'operation',
              attemptNo: 2,
              ...conflict,
            },
          },
        ],
        { ...projection, mode: 'send' },
      ),
    ).toEqual({ index: -1, append: true, canonical: false })
  })

  it('requires the authoritative terminal result message ID when one is supplied', () => {
    expect(
      readerGenerationRow([{ ...target, generationInfo: { generationId: 'job' } }], {
        ...projection,
        resultMessageId: 'different-message',
      }),
    ).toEqual({ index: 0, append: false, canonical: false })
  })

  it('adopts command-before-terminal generation metadata when the result message ID differs from the job ID', () => {
    expect(
      readerGenerationRow(
        [
          target,
          {
            role: 'char',
            chatId: 'appended-result',
            data: 'Persisted',
            generationInfo: { generationId: 'job', operationId: 'operation', attemptNo: 2 },
          },
        ],
        { ...projection, continueDisposition: 'append' },
      ),
    ).toEqual({ index: 1, append: true, canonical: true })
  })
})
