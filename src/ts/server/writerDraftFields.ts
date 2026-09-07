import type { WriterDraftCapture } from './writerDraftRecovery'

function containsSecret(value: unknown, key = ''): boolean {
  if (/api.?key|password|secret|access.?token|refresh.?token|authorization/i.test(key)) return true
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([name, child]) => containsSecret(child, name))
}

/** Readable changed fields; retain structured values separately for manual recovery. */
export function writerDraftValueFields(
  value: Record<string, unknown>,
  baseline: Record<string, unknown>,
  labels: Record<string, string> = {},
): WriterDraftCapture['fields'] {
  return [...new Set([...Object.keys(value), ...Object.keys(baseline)])]
    .filter((key) => JSON.stringify(value[key]) !== JSON.stringify(baseline[key]))
    .map((key) => ({
      label: labels[key] ?? key,
      value: typeof value[key] === 'string' ? value[key] : (JSON.stringify(value[key], null, 2) ?? ''),
      ...(containsSecret(value[key], key) ? { secret: true } : {}),
    }))
}
