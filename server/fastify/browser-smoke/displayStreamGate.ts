import type { Page } from '@playwright/test'

/** Delay individual delivered results while exercising the real batch endpoint.
 * Playwright route.fulfill buffers bodies, so it cannot prove incremental UI.
 */
export async function gateDisplayStreamResults(
  page: Page,
  hold: (result: {
    index: number
    priority: boolean
    status: string
    reason?: string
    targetCount: number
  }) => Promise<void>,
): Promise<void> {
  await page.exposeFunction('__risuHoldDisplayResult', hold)
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString()
      const response = await originalFetch(input, init)
      if (
        !url.includes('/display-sources') ||
        !response.ok ||
        !response.body ||
        !response.headers.get('content-type')?.includes('text/event-stream')
      )
        return response
      const request = JSON.parse(String(init?.body)) as {
        priorityKeys?: string[]
        targets: Array<{ index: number; requestKey: string }>
      }
      const priorities = new Set(request.priorityKeys ?? [])
      const targets = new Map(request.targets.map((target) => [target.requestKey, target]))
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      let buffer = ''
      let cancelled = false
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const deliveries: Promise<void>[] = []
          try {
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) break
              buffer += decoder.decode(chunk.value, { stream: true })
              let end = buffer.indexOf('\n\n')
              while (end >= 0) {
                const frame = buffer.slice(0, end)
                buffer = buffer.slice(end + 2)
                if (frame.startsWith('event: result\n')) {
                  const value = JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as {
                    entry: { requestKey: string; status: string; reason?: string }
                  }
                  const target = targets.get(value.entry.requestKey)!
                  const delivery = (async () => {
                    await (
                      window as unknown as { __risuHoldDisplayResult(result: unknown): Promise<void> }
                    ).__risuHoldDisplayResult({
                      index: target.index,
                      priority: priorities.has(target.requestKey),
                      status: value.entry.status,
                      reason: value.entry.reason,
                      targetCount: request.targets.length,
                    })
                    if (!cancelled) controller.enqueue(encoder.encode(`${frame}\n\n`))
                  })().catch((error) => {
                    if (!cancelled) {
                      cancelled = true
                      controller.error(error)
                    }
                  })
                  deliveries.push(delivery)
                } else {
                  // Completion cannot pass intentionally delayed result frames.
                  await Promise.all(deliveries)
                  if (!cancelled) controller.enqueue(encoder.encode(`${frame}\n\n`))
                }
                end = buffer.indexOf('\n\n')
              }
            }
            await Promise.all(deliveries)
            if (!cancelled) controller.close()
          } catch (error) {
            if (!cancelled) controller.error(error)
          }
        },
        cancel(reason) {
          cancelled = true
          return reader.cancel(reason)
        },
      })
      return new Response(stream, { status: response.status, headers: response.headers })
    }
  })
}
