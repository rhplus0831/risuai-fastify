import { availableParallelism } from 'node:os'

const localWorkerUtilization = 0.75
// Each worker runs both Chromium and a Fastify/SQLite harness. Leave capacity
// for those processes when the direct-link batches repeatedly boot the app.
const localWorkerCeiling = 4

export interface BrowserSmokeWorkerOptions {
  availableWorkers?: number
  ci?: boolean
  override?: string
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, received ${JSON.stringify(value)}`)
  }
  return value
}

export function resolveBrowserSmokeWorkers(options: BrowserSmokeWorkerOptions = {}): number {
  if (options.override !== undefined) {
    const override = options.override.trim()
    if (!/^\d+$/.test(override)) {
      throw new Error(
        `RISU_BROWSER_SMOKE_WORKERS must be a positive integer, received ${JSON.stringify(options.override)}`,
      )
    }
    return positiveInteger(Number(override), 'RISU_BROWSER_SMOKE_WORKERS')
  }

  if (options.ci ?? Boolean(process.env.CI)) return 1

  const availableWorkers = positiveInteger(
    options.availableWorkers ?? availableParallelism(),
    'available browser-smoke workers',
  )
  return Math.min(localWorkerCeiling, Math.max(1, Math.ceil(availableWorkers * localWorkerUtilization)))
}
