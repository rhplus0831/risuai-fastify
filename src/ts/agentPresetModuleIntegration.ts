import { parseModuleIntegration } from '@risuai/shared-core/module-integration'

export interface AgentPresetModuleIntegrationOption {
  value: string
  label: string
  kind: 'id' | 'namespace'
}

export function parseAgentPresetModuleIntegration(value: unknown): string[] {
  return [...new Set(parseModuleIntegration(value))]
}

export function serializeAgentPresetModuleIntegration(values: readonly string[]): string {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].join(', ')
}

export function agentPresetModuleIntegrationOptions(value: unknown): AgentPresetModuleIntegrationOption[] {
  if (!Array.isArray(value)) return []
  const options = new Map<string, AgentPresetModuleIntegrationOption>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const module = candidate as { id?: unknown; name?: unknown; namespace?: unknown }
    const id = normalizedValue(module.id)
    const name = normalizedValue(module.name) ?? id
    if (id && !options.has(id)) options.set(id, { value: id, label: name ?? id, kind: 'id' })
    const namespace = normalizedValue(module.namespace)
    if (namespace && !options.has(namespace)) {
      options.set(namespace, { value: namespace, label: name ?? namespace, kind: 'namespace' })
    }
  }
  return [...options.values()]
}

export function unknownAgentPresetModuleIntegrations(
  selected: readonly string[],
  options: readonly AgentPresetModuleIntegrationOption[],
): string[] {
  const available = new Set(options.map((option) => option.value))
  return selected.filter((value) => !available.has(value))
}

function normalizedValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}
