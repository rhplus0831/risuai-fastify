import { randomUUID } from 'node:crypto'

export type MessageTranslationJobStatus = 'running' | 'succeeded' | 'failed'

export interface MessageTranslationJob {
  chatId: string
  messageId: string
  jobId: string
  status: MessageTranslationJobStatus
  error?: string
  completedAt?: number
}

interface ActiveMessageTranslationEntry extends MessageTranslationJob {
  status: 'running'
  token: string
  abort?: () => void
}

export interface MessageTranslationJobHandle {
  jobId: string
  isCurrent(): boolean
  succeed(): void
  fail(error: unknown): void
}

const TERMINAL_RETENTION_MS = 10 * 60_000
const MAX_TERMINAL_JOBS = 128
const MAX_ERROR_LENGTH = 500

/** Detached raw-translation jobs plus a bounded terminal reattachment history. */
export class MessageTranslationJobRegistry {
  private readonly activeByMessage = new Map<string, ActiveMessageTranslationEntry>()
  private readonly terminalByMessage = new Map<string, MessageTranslationJob>()
  private readonly activeTasks = new Set<Promise<unknown>>()
  private readonly idleWaiters = new Set<() => void>()

  private lineage: string | undefined
  private stopping = false

  constructor(private readonly readLineage?: () => string) {
    this.lineage = readLineage?.()
  }

  private retireReplacedLineage(): void {
    const lineage = this.readLineage?.()
    if (lineage === this.lineage) return
    this.lineage = lineage
    this.activeByMessage.clear()
    this.terminalByMessage.clear()
  }

  register(
    input: Pick<MessageTranslationJob, 'chatId' | 'messageId'> & { jobId?: string; abort?: () => void },
  ): MessageTranslationJobHandle {
    if (this.stopping) {
      input.abort?.()
      throw new Error('Message translation registry is shutting down')
    }
    this.retireReplacedLineage()
    const token = randomUUID()
    const jobId = input.jobId ?? randomUUID()
    this.terminalByMessage.delete(input.messageId)
    this.activeByMessage.set(input.messageId, {
      chatId: input.chatId,
      messageId: input.messageId,
      jobId,
      status: 'running',
      token,
      ...(input.abort ? { abort: input.abort } : {}),
    })
    return {
      jobId,
      isCurrent: () => {
        this.retireReplacedLineage()
        return this.activeByMessage.get(input.messageId)?.token === token
      },
      succeed: () => this.complete(input.messageId, token, { status: 'succeeded' }),
      fail: (error) => this.complete(input.messageId, token, { status: 'failed', error: safeTranslationError(error) }),
    }
  }

  translations(): MessageTranslationJob[] {
    this.retireReplacedLineage()
    this.pruneTerminalJobs()
    return [
      ...[...this.activeByMessage.values()].map(({ token: _token, abort: _abort, ...job }) => job),
      ...this.terminalByMessage.values(),
    ]
  }

  /** Track provider/persistence continuations, including injected runners that
   * do not register their own abort handle. Shutdown waits for every tracked
   * continuation before the SQLite handle is closed. */
  track<T>(task: Promise<T>): Promise<T> {
    const tracked = Promise.resolve(task).finally(() => {
      this.activeTasks.delete(tracked)
      this.resolveIdleWaiters()
    })
    this.activeTasks.add(tracked)
    return tracked
  }

  isStopping(): boolean {
    return this.stopping
  }

  /** Reject new translations, abort cooperative providers, and drain all
   * registered/tracked continuations before application shutdown proceeds. */
  async stop(): Promise<void> {
    this.stopping = true
    for (const active of this.activeByMessage.values()) active.abort?.()
    while (this.activeByMessage.size > 0 || this.activeTasks.size > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
    }
  }

  private complete(
    messageId: string,
    token: string,
    terminal: { status: 'succeeded' } | { status: 'failed'; error: string },
  ): void {
    this.retireReplacedLineage()
    const active = this.activeByMessage.get(messageId)
    if (!active || active.token !== token) return
    this.activeByMessage.delete(messageId)
    this.terminalByMessage.set(messageId, {
      chatId: active.chatId,
      messageId: active.messageId,
      jobId: active.jobId,
      ...terminal,
      completedAt: Date.now(),
    })
    this.pruneTerminalJobs()
    this.resolveIdleWaiters()
  }

  private resolveIdleWaiters(): void {
    if (this.activeByMessage.size > 0 || this.activeTasks.size > 0) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  private pruneTerminalJobs(): void {
    const cutoff = Date.now() - TERMINAL_RETENTION_MS
    for (const [messageId, job] of this.terminalByMessage) {
      if ((job.completedAt ?? 0) < cutoff) this.terminalByMessage.delete(messageId)
    }
    while (this.terminalByMessage.size > MAX_TERMINAL_JOBS) {
      const oldest = this.terminalByMessage.keys().next().value as string | undefined
      if (!oldest) break
      this.terminalByMessage.delete(oldest)
    }
  }
}

export function safeTranslationError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const redacted = raw
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|api)[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .trim()
  return (redacted || 'Message translation failed').slice(0, MAX_ERROR_LENGTH)
}
