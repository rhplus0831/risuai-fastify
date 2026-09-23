import { normalizeLegacySeperateModels, normalizeModelRoleOverrides } from '@risuai/shared-core/model-roles'
import type { Database } from 'src/ts/storage/database.svelte'

type LegacyModelSettings = Partial<
  Pick<Database, 'aiModel' | 'subModel' | 'modelRoles' | 'seperateModelsForAxModels' | 'seperateModels'>
>

function nonBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

export function hasLegacyModelFields(settings: LegacyModelSettings): boolean {
  if (nonBlank(settings.aiModel) || nonBlank(settings.subModel)) return true

  const roleOverrides = normalizeModelRoleOverrides(settings.modelRoles)
  if (Object.values(roleOverrides).some(nonBlank)) return true

  if (settings.seperateModelsForAxModels) {
    const separateModels = normalizeLegacySeperateModels(settings.seperateModels)
    if (Object.values(separateModels).some(nonBlank)) return true
  }

  return false
}
