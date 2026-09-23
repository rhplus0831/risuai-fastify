import { collectionsResourceState, settingsResourceState } from 'src/ts/server/resourceState.svelte'
import type { ModelPreset } from 'src/ts/storage/database.svelte'

export function selectedModelPresetId(): string | null {
  const selectedIndex = settingsResourceState.value.modelPresetsId
  const index = Number.isInteger(selectedIndex) ? (selectedIndex as number) : -1
  const presets = collectionsResourceState.values.modelPresets
  const preset = Array.isArray(presets) ? (presets[index] as ModelPreset | undefined) : undefined
  return typeof preset?.id === 'string' && preset.id.trim() ? preset.id : null
}
