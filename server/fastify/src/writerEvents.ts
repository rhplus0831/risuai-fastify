export interface WriterEvent {
  databaseLineage: string
  sessionId: string | null
  epoch: number
}

export type WriterEventListener = (event: WriterEvent) => void

export interface WriterEventBus {
  emit(event: WriterEvent): void
  subscribe(listener: WriterEventListener): () => void
}

function emitWriterEventSafely(listener: WriterEventListener, event: WriterEvent): void {
  try {
    listener(event)
  } catch {
    // Writer changes are best-effort live notifications. The durable writer
    // metadata remains authoritative if one subscriber cannot receive them.
  }
}

export function createWriterEventBus(): WriterEventBus {
  const listeners = new Set<WriterEventListener>()
  return {
    emit(event) {
      for (const listener of listeners) {
        emitWriterEventSafely(listener, event)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
