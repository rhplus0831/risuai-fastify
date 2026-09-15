// The original separate-parameters editor also rendered the overrides map as
// a parameter slot. Scalar parameter fields written there never identify a
// model override. Repair only that known artifact, preserving real model maps
// and unknown malformed entries for the caller's validation.
const strayParameterKeys = new Set([
  'temperature',
  'top_k',
  'repetition_penalty',
  'min_p',
  'top_a',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'reasoning_effort',
  'thinking_tokens',
  'thinking_type',
  'deepseek_thinking_type',
  'adaptive_thinking_effort',
  'deepseek_reasoning_effort',
  'outputImageModal',
  'verbosity',
])

export function repairLegacySeparateParameterOverrides<T>(value: T): T {
  if (!isRecord(value)) return value
  const stray = Object.keys(value).filter(
    (key) => strayParameterKeys.has(key) && (value[key] === null || typeof value[key] !== 'object'),
  )
  if (stray.length === 0) return value
  const repaired = { ...value }
  for (const key of stray) delete repaired[key]
  return repaired as T
}

export function repairLegacySeparateParameters<T>(value: T): T {
  if (!isRecord(value)) return value
  const overrides = repairLegacySeparateParameterOverrides(value.overrides)
  return overrides === value.overrides ? value : ({ ...value, overrides } as T)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
