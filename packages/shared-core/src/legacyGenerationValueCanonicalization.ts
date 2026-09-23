type JsonRecord = Record<string, unknown>
type Scope = 'owner' | 'separate-parameter'

// Exact empty strings emitted by the original editor assert a value; deleting
// these keys would incorrectly inherit the underlying settings during preset
// composition. Numeric 1 is upstream's medium effort/verbosity, including ''.
export const LEGACY_GENERATION_EMPTY_STRING_VALUES = [
  { field: 'thinkingType', scope: 'owner', canonicalValue: 'budget' },
  { field: 'adaptiveThinkingEffort', scope: 'owner', canonicalValue: 'high' },
  { field: 'deepseekThinkingType', scope: 'owner', canonicalValue: 'off' },
  { field: 'deepseekReasoningEffort', scope: 'owner', canonicalValue: 'high' },
  { field: 'systemRoleReplacement', scope: 'owner', canonicalValue: 'user' },
  { field: 'verbosity', scope: 'owner', canonicalValue: 1 },
  { field: 'reasonEffort', scope: 'owner', canonicalValue: 1 },
  { field: 'reasoningEffort', scope: 'owner', canonicalValue: 1 },
  { field: 'thinking_type', scope: 'separate-parameter', canonicalValue: 'budget' },
  { field: 'adaptive_thinking_effort', scope: 'separate-parameter', canonicalValue: 'high' },
  { field: 'deepseek_thinking_type', scope: 'separate-parameter', canonicalValue: 'off' },
  { field: 'deepseek_reasoning_effort', scope: 'separate-parameter', canonicalValue: 'high' },
  { field: 'reasoning_effort', scope: 'separate-parameter', canonicalValue: 1 },
  { field: 'verbosity', scope: 'separate-parameter', canonicalValue: 1 },
] as const

/** Repair only documented original-editor values, cloning changed ancestors.
 * Unchanged inputs retain identity; applying this function twice is a no-op. */
export function canonicalizeLegacyGenerationValues(value: unknown): unknown {
  if (!isRecord(value)) return value
  let result = canonicalizeOwner(value)
  for (const key of ['modelPresets', 'promptPresets']) {
    const presets = result[key]
    if (!Array.isArray(presets)) continue
    const normalized = presets.map((preset: unknown) => (isRecord(preset) ? canonicalizeOwner(preset) : preset))
    if (normalized.some((preset, index) => preset !== presets[index])) result = { ...result, [key]: normalized }
  }
  return result
}

function canonicalizeOwner(value: JsonRecord): JsonRecord {
  const result = canonicalizeFields(value, 'owner')
  const parameters = result.seperateParameters
  if (!isRecord(parameters)) return result
  let normalized = parameters
  for (const slot of ['memory', 'emotion', 'translate', 'otherAx', 'scriptMain', 'scriptAux']) {
    const entry = parameters[slot]
    if (!isRecord(entry)) continue
    const canonical = canonicalizeFields(entry, 'separate-parameter')
    if (canonical !== entry) normalized = { ...normalized, [slot]: canonical }
  }
  if (isRecord(parameters.overrides)) {
    let overrides = parameters.overrides
    for (const [modelId, entry] of Object.entries(parameters.overrides)) {
      if (!isRecord(entry)) continue
      const canonical = canonicalizeFields(entry, 'separate-parameter')
      if (canonical !== entry) overrides = { ...overrides, [modelId]: canonical }
    }
    if (overrides !== parameters.overrides) normalized = { ...normalized, overrides }
  }
  return normalized === parameters ? result : { ...result, seperateParameters: normalized }
}

function canonicalizeFields(value: JsonRecord, scope: Scope): JsonRecord {
  let result = value
  for (const entry of LEGACY_GENERATION_EMPTY_STRING_VALUES) {
    if (entry.scope !== scope || !Object.hasOwn(value, entry.field) || value[entry.field] !== '') continue
    if (result === value) result = { ...value }
    result[entry.field] = entry.canonicalValue
  }
  return result
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
