import { AsyncResource } from 'node:async_hooks'

/** Display targets retain exclusive runtime ownership. Between targets, allow
 * newly arrived foreground work to pass queued background work and flush I/O.
 */
export class DisplaySourceQueue {
  private running = false
  private scheduled = false
  private readonly tasks: Array<{ priority: number; start(): Promise<void>; cancel(): void }> = []

  run<T>(priority: number, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const execute = AsyncResource.bind(work)
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const index = this.tasks.indexOf(task)
        if (index >= 0) this.tasks.splice(index, 1)
        signal?.removeEventListener('abort', cancel)
        reject(signal?.reason ?? new Error('Display source cancelled'))
      }
      const task = {
        priority,
        cancel,
        start: async () => {
          signal?.removeEventListener('abort', cancel)
          try {
            resolve(await execute())
          } catch (error) {
            reject(error)
          }
        },
      }
      signal?.addEventListener('abort', cancel, { once: true })
      this.tasks.push(task)
      this.drain()
    })
  }

  private drain(): void {
    if (this.running || this.scheduled || this.tasks.length === 0) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      if (this.running) return
      this.tasks.sort((a, b) => a.priority - b.priority)
      const task = this.tasks.shift()
      if (!task) return
      this.running = true
      void task.start().finally(() => {
        this.running = false
        this.drain()
      })
    })
  }
}
