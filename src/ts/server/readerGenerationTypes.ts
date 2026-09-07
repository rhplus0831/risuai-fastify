import type { ChatGenerationPhase } from '../process/generationActivity.svelte'

/** Immutable scope of one authenticated, read-only generation viewer. */
export interface ReaderGenerationIdentity {
  databaseLineage: string
  characterId: string
  chatId: string
  operationId: string
  attemptNo: number
  jobId: string
  projectionEpoch: number
}

/** Transient presentation only. No entry is inserted into a transcript owner. */
export interface ReaderGenerationProjection extends ReaderGenerationIdentity {
  mode: 'send' | 'continue' | 'regenerate'
  targetMessageId?: string
  generationId?: string
  resultMessageId?: string
  continueDisposition?: 'append' | 'extend'
  continueBase?: string
  text: string | null
  status: 'preparing' | 'streaming' | 'finalizing' | 'interrupted'
  phase: ChatGenerationPhase
  startedAt: number
  halfStreaming?: boolean
  generatedTokens?: number
  elapsedMs?: number
  gapTruncated?: boolean
}

export interface ReaderGenerationView {
  status: 'idle' | 'watching' | 'interrupted'
  projection: ReaderGenerationProjection | null
}
