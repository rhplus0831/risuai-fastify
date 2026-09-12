import { randomUUID } from 'node:crypto'
import { safeTranslationError } from './messageTranslationJobs.js'

export type GreetingTranslationJobStatus = 'running' | 'succeeded' | 'failed'

export interface GreetingTranslationJob {
  characterId: string
  chatId: string
  greetingIndex: number
  settingsHash: string
  jobId: string
  status: GreetingTranslationJobStatus
  error?: string
  completedAt?: number
}

interface ActiveGreetingTranslationEntry extends GreetingTranslationJob {
  status: 'running'
  token: string
}

export interface GreetingTranslationJobHandle {
  jobId: string
  isCurrent(): boolean
  succeed(): void
  fail(error: unknown): void
}

const TERMINAL_RETENTION_MS = 10 * 60_000
const MAX_TERMINAL_JOBS = 128

function targetKey(
  target: Pick<GreetingTranslationJob, 'characterId' | 'chatId' | 'greetingIndex' | 'settingsHash'>,
): string {
  return JSON.stringify([target.characterId, target.chatId, target.greetingIndex, target.settingsHash])
}

/** Detached greeting translations plus bounded terminal reattachment history. */
export class GreetingTranslationJobRegistry {
  private readonly activeByTarget = new Map<string, ActiveGreetingTranslationEntry>()
  private readonly terminalByTarget = new Map<string, GreetingTranslationJob>()

  private lineage: string | undefined

  constructor(private readonly readLineage?: () => string) {
    this.lineage = readLineage?.()
  }

  private retireReplacedLineage(): void {
    const lineage = this.readLineage?.()
    if (lineage === this.lineage) return
    this.lineage = lineage
    this.activeByTarget.clear()
    this.terminalByTarget.clear()
  }

  register(
    input: Pick<GreetingTranslationJob, 'characterId' | 'chatId' | 'greetingIndex' | 'settingsHash'> & {
      jobId?: string
    },
  ): GreetingTranslationJobHandle {
    this.retireReplacedLineage()
    const key = targetKey(input)
    const token = randomUUID()
    const jobId = input.jobId ?? randomUUID()
    this.terminalByTarget.delete(key)
    this.activeByTarget.set(key, {
      characterId: input.characterId,
      chatId: input.chatId,
      greetingIndex: input.greetingIndex,
      settingsHash: input.settingsHash,
      jobId,
      status: 'running',
      token,
    })
    return {
      jobId,
      isCurrent: () => {
        this.retireReplacedLineage()
        return this.activeByTarget.get(key)?.token === token
      },
      succeed: () => this.complete(key, token, { status: 'succeeded' }),
      fail: (error) => this.complete(key, token, { status: 'failed', error: safeTranslationError(error) }),
    }
  }

  translations(): GreetingTranslationJob[] {
    this.retireReplacedLineage()
    this.pruneTerminalJobs()
    return [
      ...[...this.activeByTarget.values()].map(({ token: _token, ...job }) => job),
      ...this.terminalByTarget.values(),
    ]
  }

  invalidateAlternateMutation(
    characterId: string,
    operation: { type: 'delete'; index: number } | { type: 'swap'; firstIndex: number; secondIndex: number },
  ): void {
    for (const [key, job] of this.activeByTarget) {
      if (job.characterId !== characterId || job.greetingIndex < 0) continue
      const affected =
        operation.type === 'delete'
          ? job.greetingIndex >= operation.index
          : job.greetingIndex === operation.firstIndex || job.greetingIndex === operation.secondIndex
      if (affected) this.activeByTarget.delete(key)
    }
  }

  private complete(
    key: string,
    token: string,
    terminal: { status: 'succeeded' } | { status: 'failed'; error: string },
  ): void {
    this.retireReplacedLineage()
    const active = this.activeByTarget.get(key)
    if (!active || active.token !== token) return
    this.activeByTarget.delete(key)
    this.terminalByTarget.set(key, {
      characterId: active.characterId,
      chatId: active.chatId,
      greetingIndex: active.greetingIndex,
      settingsHash: active.settingsHash,
      jobId: active.jobId,
      ...terminal,
      completedAt: Date.now(),
    })
    this.pruneTerminalJobs()
  }

  private pruneTerminalJobs(): void {
    const cutoff = Date.now() - TERMINAL_RETENTION_MS
    for (const [key, job] of this.terminalByTarget) {
      if ((job.completedAt ?? 0) < cutoff) this.terminalByTarget.delete(key)
    }
    while (this.terminalByTarget.size > MAX_TERMINAL_JOBS) {
      const oldest = this.terminalByTarget.keys().next().value as string | undefined
      if (!oldest) break
      this.terminalByTarget.delete(oldest)
    }
  }
}
